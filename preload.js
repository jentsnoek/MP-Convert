const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('audioWerk', {
  chooseTrack: () => ipcRenderer.invoke('track:choose'),
  dropTrack: (file) => ipcRenderer.invoke('track:drop', webUtils.getPathForFile(file)),
  convert: (id, settings, durationSeconds) => ipcRenderer.invoke('track:convert', id, settings, durationSeconds),
  showOutput: (filePath) => ipcRenderer.invoke('output:show', filePath),
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  onProgress: (callback) => ipcRenderer.on('track:progress', (_event, value) => callback(value))
});
