const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ab', {
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  cmd: (name, arg) => ipcRenderer.send('cmd', name, arg),
});
