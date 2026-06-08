'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ── DRM config (updated by renderer when user changes DRM settings) ───────────
let drmConfig = { licenseUrl: '', headers: {} };

function applyDrmRequestHeaders(session) {
  // Remove any previous handler first
  try { session.webRequest.onBeforeSendHeaders(null); } catch {}

  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const reqHeaders = { ...details.requestHeaders };

    // Inject DRM auth headers at the network-stack level for license requests.
    // This bypasses Chromium's CORS header-stripping for cross-origin XHR.
    if (drmConfig.licenseUrl && drmConfig.licenseUrl.length > 0) {
      try {
        const licHost = new URL(drmConfig.licenseUrl).hostname;
        const reqHost = new URL(details.url).hostname;
        if (licHost && reqHost === licHost) {
          for (const [k, v] of Object.entries(drmConfig.headers)) {
            reqHeaders[k] = v;
          }
        }
      } catch { /* malformed URL — skip */ }
    }

    callback({ requestHeaders: reqHeaders });
  });
}

// ── HEVC hardware decode flags (must be set before app is ready) ──────────────
app.commandLine.appendSwitch('enable-features',
  'PlatformHEVCDecoderSupport,PlatformHEVCEncoderSupport,UseHardwareDecoding');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// ── Widevine CDM detection ────────────────────────────────────────────────────
function findWidevineCDM() {
  if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux') {
    return null;
  }

  const candidates = [];

  if (process.platform === 'win32') {
    const bases = [
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
      process.env['LOCALAPPDATA'],
    ].filter(Boolean);

    for (const base of bases) {
      candidates.push(
        path.join(base, 'Google', 'Chrome', 'Application'),
        path.join(base, 'Google', 'Chrome Beta', 'Application'),
        path.join(base, 'Google', 'Chrome Dev', 'Application'),
        path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application'),
        path.join(base, 'Microsoft', 'Edge', 'Application'),
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions',
    );
  } else {
    candidates.push(
      '/opt/google/chrome',
      '/usr/lib/chromium-browser',
    );
  }

  for (const appDir of candidates) {
    if (!fs.existsSync(appDir)) continue;

    let versions;
    try {
      versions = fs.readdirSync(appDir)
        .filter(v => /^\d+\./.test(v))
        .sort((a, b) => {
          const ap = a.split('.').map(Number);
          const bp = b.split('.').map(Number);
          for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
            if ((bp[i] || 0) !== (ap[i] || 0)) return (bp[i] || 0) - (ap[i] || 0);
          }
          return 0;
        });
    } catch { continue; }

    for (const version of versions) {
      const cdmDir = path.join(appDir, version, 'WidevineCdm');
      const manifestPath = path.join(cdmDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
      catch { continue; }

      const cdmVersion = manifest.version;

      const platformSuffix = {
        win32: path.join('_platform_specific', 'win_x64', 'widevinecdm.dll'),
        darwin: path.join('_platform_specific', 'mac_x64', 'libwidevinecdm.dylib'),
        linux: path.join('_platform_specific', 'linux_x64', 'libwidevinecdm.so'),
      }[process.platform];

      const cdmPath = path.join(cdmDir, platformSuffix);
      if (fs.existsSync(cdmPath)) {
        return { path: cdmPath, version: cdmVersion, source: appDir };
      }
    }
  }
  return null;
}

const cdmInfo = findWidevineCDM();
if (cdmInfo) {
  app.commandLine.appendSwitch('widevine-cdm-path', cdmInfo.path);
  app.commandLine.appendSwitch('widevine-cdm-version', cdmInfo.version);
}

// ── Window creation ───────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0d0f',
    // Remove the native title bar — custom controls live inside the renderer.
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
    title: 'AGPlayer — HEVC · CMAF · DRM',
    show: false,
  });

  const ses = mainWindow.webContents.session;

  // Inject DRM auth headers at the network-stack level (below CORS enforcement)
  applyDrmRequestHeaders(ses);

  // Inject CORS response headers so CDN preflight responses allow all origins.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const h = { ...(details.responseHeaders || {}) };
    h['access-control-allow-origin']  = ['*'];
    h['access-control-allow-headers'] = ['*'];
    h['access-control-allow-methods'] = ['GET, POST, PUT, DELETE, OPTIONS'];
    // For preflight responses: ensure credential-less wildcard is accepted
    delete h['access-control-allow-credentials'];
    callback({ responseHeaders: h });
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

// Renderer calls this whenever DRM settings change so main process can inject
// auth headers at the network-stack level (bypasses Chromium CORS stripping).
ipcMain.handle('update-drm-config', (_evt, config) => {
  drmConfig = { licenseUrl: config.licenseUrl || '', headers: config.headers || {} };
  if (mainWindow) applyDrmRequestHeaders(mainWindow.webContents.session);
});

// Make a raw Node.js HTTP request to the license server — no CORS, no browser
// restrictions. Used for the "Test License Server" diagnostic feature.
ipcMain.handle('test-license-server', async (_evt, { url, headers }) => {
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(url); }
    catch { return resolve({ ok: false, error: 'Invalid URL' }); }

    const lib  = parsed.protocol === 'https:' ? https : http;
    const body = Buffer.alloc(0); // empty body — server will return 4xx but we see auth status

    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/octet-stream',
        'Content-Length': '0',
        ...headers,
      },
      timeout: 8000,
    };

    const req = lib.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').substring(0, 400);
        resolve({
          ok:      res.statusCode < 500,
          status:  res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Request timed out (8s)' }); });
    req.on('error',   err => resolve({ ok: false, error: err.message }));
    req.end();
  });
});

// Custom window controls (replaces native title bar buttons)
ipcMain.on('window-minimize',    () => mainWindow?.minimize());
ipcMain.on('window-maximize',    () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window-close',       () => mainWindow?.close());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

ipcMain.handle('get-widevine-info', () => {
  return cdmInfo
    ? { available: true, version: cdmInfo.version, path: cdmInfo.path }
    : { available: false };
});

ipcMain.handle('get-platform', () => process.platform);

ipcMain.handle('open-url', (_evt, url) => {
  shell.openExternal(url);
});

ipcMain.handle('show-open-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Media File',
    filters: [
      { name: 'HLS Playlists', extensions: ['m3u8'] },
      { name: 'DASH Manifests', extensions: ['mpd'] },
      { name: 'MP4 / CMAF', extensions: ['mp4', 'm4s', 'm4v', 'm4a'] },
      { name: 'All Media', extensions: ['m3u8', 'mpd', 'mp4', 'm4s', 'm4v', 'm4a', 'ts', 'fmp4'] },
    ],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
