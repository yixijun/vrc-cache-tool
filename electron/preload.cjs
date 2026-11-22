const { contextBridge, ipcRenderer } = require('electron/renderer')

contextBridge.exposeInMainWorld('cacheTool', {
  load: () => ipcRenderer.invoke('config:load'),
  save: (form, revision) => ipcRenderer.invoke('config:save', form, revision),
  diagnose: form => ipcRenderer.invoke('cache:diagnose', form),
  pickDirectory: current => ipcRenderer.invoke('cache:pick-directory', current),
  openCache: current => ipcRenderer.invoke('cache:open', current),
  openConfig: () => ipcRenderer.invoke('config:open'),
  openDocs: () => ipcRenderer.invoke('docs:open'),
})
