'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getWidevineInfo:   ()           => ipcRenderer.invoke('get-widevine-info'),
  getPlatform:       ()           => ipcRenderer.invoke('get-platform'),
  openUrl:           (url)        => ipcRenderer.invoke('open-url', url),
  showOpenDialog:    ()           => ipcRenderer.invoke('show-open-dialog'),
  updateDrmConfig:   (cfg)        => ipcRenderer.invoke('update-drm-config', cfg),
  testLicenseServer: (url, hdrs)  => ipcRenderer.invoke('test-license-server', { url, headers: hdrs }),
  // Custom window controls
  windowMinimize:    ()           => ipcRenderer.send('window-minimize'),
  windowMaximize:    ()           => ipcRenderer.send('window-maximize'),
  windowClose:       ()           => ipcRenderer.send('window-close'),
  windowIsMaximized: ()           => ipcRenderer.invoke('window-is-maximized'),
});
