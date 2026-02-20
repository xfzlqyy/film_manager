const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("filmManagerApi", {
  loadData: () => ipcRenderer.invoke("film:load-data"),
  saveData: (dataBase64) => ipcRenderer.invoke("film:save-data", dataBase64),
  pickDataFile: () => ipcRenderer.invoke("film:pick-data-file")
});
