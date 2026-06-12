'use strict';

// Connect to the Neutralino native layer — must be called before any API use.
Neutralino.init();

// Maps window.electronAPI (Electron IPC interface) to Neutralino native APIs.
// This shim lets renderer/player.js run unchanged.
window.electronAPI = {

  // ── Window controls ───────────────────────────────────────────────────────
  windowMinimize:    () => Neutralino.window.minimize(),
  windowClose:       () => Neutralino.app.exit(0),
  windowMaximize:    async () => {
    const max = await Neutralino.window.isMaximized();
    return max ? Neutralino.window.unmaximize() : Neutralino.window.maximize();
  },
  windowIsMaximized: () => Neutralino.window.isMaximized(),

  // ── Platform ──────────────────────────────────────────────────────────────
  getPlatform: () => Promise.resolve(
    ({ Linux: 'linux', Darwin: 'darwin', Windows: 'win32' }[NL_OS]) || 'win32'
  ),

  // ── Open external URL ─────────────────────────────────────────────────────
  openUrl: (url) => Neutralino.os.open(url),

  // ── File picker ───────────────────────────────────────────────────────────
  showOpenDialog: async () => {
    try {
      const paths = await Neutralino.os.showOpenDialog('Open Media File', {
        filters: [
          { name: 'HLS Playlists',  extensions: ['m3u8'] },
          { name: 'DASH Manifests', extensions: ['mpd'] },
          { name: 'MP4 / CMAF',    extensions: ['mp4', 'm4s', 'm4v', 'm4a'] },
          { name: 'All Media',     extensions: ['m3u8','mpd','mp4','m4s','m4v','m4a','ts','fmp4'] },
        ],
      });
      return paths?.[0] || null;
    } catch { return null; }
  },

  // ── DRM config ────────────────────────────────────────────────────────────
  // Electron injected headers at the session/network-stack level to bypass CORS.
  // In Neutralino/WebView2 we can't intercept at the network layer, so we store
  // the config and rely entirely on Shaka's request filter (already wired in
  // player.js via netEngine.registerRequestFilter) for DRM header injection.
  updateDrmConfig: async (cfg) => {
    window._neuDrmConfig = cfg;
    return true;
  },

  // ── License server test ───────────────────────────────────────────────────
  // Uses fetch() — subject to standard CORS. Most DRM license servers either
  // allow wildcard origins or handle preflight, so this covers the common case.
  testLicenseServer: async (url, headers) => {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res  = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...headers },
        body:    new Uint8Array(0),
        signal:  ctrl.signal,
      });
      clearTimeout(tid);
      const body = await res.text().catch(() => '');
      return {
        ok:      res.status < 500,
        status:  res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body:    body.substring(0, 400),
      };
    } catch (err) {
      clearTimeout(tid);
      return {
        ok:    false,
        error: err.name === 'AbortError' ? 'Request timed out (8s)' : err.message,
      };
    }
  },

  // ── Widevine info ─────────────────────────────────────────────────────────
  // Neutralino uses WebView2 (Edge), which includes Widevine CDM on Windows.
  // We also scan Chrome's installation for informational version reporting.
  getWidevineInfo: async () => {
    // Always available via Edge CDM in WebView2
    const fallback = { available: true, version: 'Edge CDM (WebView2)', path: 'system' };

    if (NL_OS !== 'Windows') return fallback;

    const envVars = {};
    try {
      const out = await Neutralino.os.execCommand('cmd /c echo %PROGRAMFILES%|%PROGRAMFILES(X86)%|%LOCALAPPDATA%');
      const parts = (out.stdOut || '').trim().split('|');
      envVars.pf   = parts[0]?.trim();
      envVars.pf86 = parts[1]?.trim();
      envVars.la   = parts[2]?.trim();
    } catch { return fallback; }

    const bases = [
      `${envVars.pf}\\Google\\Chrome\\Application`,
      `${envVars.pf86}\\Google\\Chrome\\Application`,
      `${envVars.la}\\Google\\Chrome\\Application`,
    ].filter(Boolean);

    for (const base of bases) {
      try {
        const entries = await Neutralino.filesystem.readDirectory(base);
        const versions = entries
          .filter(e => e.type === 'DIRECTORY' && /^\d+\./.test(e.entry))
          .map(e => e.entry)
          .sort((a, b) => {
            const an = a.split('.').map(Number), bn = b.split('.').map(Number);
            for (let i = 0; i < 4; i++) {
              if ((bn[i] || 0) !== (an[i] || 0)) return (bn[i] || 0) - (an[i] || 0);
            }
            return 0;
          });

        for (const v of versions) {
          try {
            const mfText = await Neutralino.filesystem.readFile(
              `${base}\\${v}\\WidevineCdm\\manifest.json`
            );
            const mf = JSON.parse(mfText);
            if (mf.version) {
              return { available: true, version: mf.version, path: `${base}\\${v}` };
            }
          } catch { /* try next version */ }
        }
      } catch { /* base dir not found, try next */ }
    }

    return fallback;
  },
};
