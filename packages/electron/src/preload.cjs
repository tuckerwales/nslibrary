const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nslib", {
  pickFolder: () => ipcRenderer.invoke("nslib:pick-folder"),
});
