'use strict';

// Browser-compatible shim for window.electronAPI.
// Replaces bridge.js (Neutralino) when building the web version.
window.electronAPI = {

  // ── Window controls — no-op in browser ───────────────────────────────────
  windowMinimize:    () => Promise.resolve(),
  windowMaximize:    () => Promise.resolve(),
  windowClose:       () => Promise.resolve(),
  windowIsMaximized: () => Promise.resolve(false),

  // ── Platform ──────────────────────────────────────────────────────────────
  getPlatform: () => {
    const ua = navigator.userAgent;
    if (ua.includes('Win'))    return Promise.resolve('win32');
    if (ua.includes('Mac'))    return Promise.resolve('darwin');
    return                            Promise.resolve('linux');
  },

  // ── Open external URL ─────────────────────────────────────────────────────
  openUrl: (url) => { window.open(url, '_blank', 'noopener'); return Promise.resolve(); },

  // ── File picker — browser native file input ───────────────────────────────
  showOpenDialog: () => new Promise(resolve => {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = '.m3u8,.mpd,.mp4,.m4s,.m4v,.m4a,.ts,.fmp4';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      // Return a blob URL so Shaka can load local files directly
      resolve(file ? URL.createObjectURL(file) : null);
    });
    input.addEventListener('cancel', () => {
      document.body.removeChild(input);
      resolve(null);
    });
    input.click();
  }),

  // ── DRM config — store locally; Shaka's request filter does injection ─────
  updateDrmConfig: async (cfg) => { window._drmConfig = cfg; return true; },

  // ── License server test ───────────────────────────────────────────────────
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

  // ── Widevine info — EME probe ─────────────────────────────────────────────
  getWidevineInfo: async () => {
    try {
      await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
        initDataTypes:      ['cenc'],
        videoCapabilities:  [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
        audioCapabilities:  [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
      }]);
      return { available: true, version: 'Browser CDM', path: 'browser' };
    } catch {
      return { available: false };
    }
  },
};
