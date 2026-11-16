// Preload for the file-preview window (CommonJS — sandboxed preload).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("odPreview", {
  getData: () => ipcRenderer.invoke("od:previewData"),
  openDefault: (p) => ipcRenderer.invoke("od:previewOpenDefault", p),
});
