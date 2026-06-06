const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Commands
  startListening: () => ipcRenderer.invoke('start-listening'),
  stopListening: () => ipcRenderer.invoke('stop-listening'),
  runSimulator: () => ipcRenderer.invoke('run-simulator'),

  // Event Receivers
  onConsoleLog: (callback) => {
    const subscription = (event, text) => callback(text);
    ipcRenderer.on('console-log', subscription);
    return () => ipcRenderer.removeListener('console-log', subscription);
  },
  onStatusUpdate: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('status-update', subscription);
    return () => ipcRenderer.removeListener('status-update', subscription);
  },
  onProfileDecoded: (callback) => {
    const subscription = (event, profile) => callback(profile);
    ipcRenderer.on('profile-decoded', subscription);
    return () => ipcRenderer.removeListener('profile-decoded', subscription);
  }
});
