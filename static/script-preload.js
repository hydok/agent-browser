// Preload for the hidden window that runs browser_run_script code.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__host', {
  call: (method, params) => ipcRenderer.invoke('script-call', method, params),
  log: (text) => ipcRenderer.send('script-log', text),
});
