// Preload (CommonJS — required for sandboxed preload scripts).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("odDesktop", {
  isDesktop: true,
  pickPaths: () => ipcRenderer.invoke("od:pickPaths"),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  pickFolder: () => ipcRenderer.invoke("od:pickFolder"),
  getSettings: () => ipcRenderer.invoke("od:getSettings"),
  openFolder: () => ipcRenderer.invoke("od:openFolder"),
  showInFolder: (name) => ipcRenderer.invoke("od:showInFolder", name),
  getAppSettings: () => ipcRenderer.invoke("od:getAppSettings"),
  setAppSetting: (key, value) => ipcRenderer.invoke("od:setAppSetting", key, value),
  previewFile: (name) => ipcRenderer.invoke("od:previewFile", name),
  // Update popup (v42): main detects the update as before and sends
  // the payload; the renderer shows the designed in-app popup and
  // reports the Download tap back so main can open the link.
  onUpdateAvailable: (cb) => ipcRenderer.on("od:updateAvailable", (_e, info) => cb(info)),
  updateAction: (action) => ipcRenderer.send("od:updateAction", action),
  // v56: progress/failure of the in-app Setup download run by main.
  onUpdateProgress: (cb) => ipcRenderer.on("od:updateProgress", (_e, s) => cb(s)),
  // About-section external links (socials, Telegram, projects):
  // main validates and opens them in the default browser.
  openExternal: (url) => ipcRenderer.send("od:openExternal", url),
  // Manual "Check for Updates" (Settings) + its result.
  checkUpdate: () => ipcRenderer.send("od:checkUpdate"),
  onUpdateResult: (cb) => ipcRenderer.on("od:updateResult", (_e, r) => cb(r)),
});
