const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('audioWerk', {
  chooseTrack: () => ipcRenderer.invoke('track:choose'),
  dropTrack: (file) => ipcRenderer.invoke('track:drop', webUtils.getPathForFile(file)),
  downloadUrl: (url) => ipcRenderer.invoke('track:download-url', url),
  openServiceLink: (url) => ipcRenderer.invoke('link:open-service', url),
  convert: (id, settings, durationSeconds) => ipcRenderer.invoke('track:convert', id, settings, durationSeconds),
  showOutput: (filePath) => ipcRenderer.invoke('output:show', filePath),
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  onProgress: (callback) => ipcRenderer.on('track:progress', (_event, value) => callback(value)),
  onDownloadProgress: (callback) => ipcRenderer.on('track:download-progress', (_event, value) => callback(value))
});
