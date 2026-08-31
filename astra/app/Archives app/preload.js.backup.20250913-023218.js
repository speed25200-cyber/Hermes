try {
  const { contextBridge, ipcRenderer } = require("electron");

  const api = {
    fetchData:      () => ipcRenderer.invoke("fetch-data"),
    fetchPortfolio: () => ipcRenderer.invoke("fetch-portfolio"),
    getAIState:     () => ipcRenderer.invoke("get-ai-state"),
    toggleAI:       (on) => ipcRenderer.invoke("toggle-ai", on),
    placeOrder:     (opt) => ipcRenderer.invoke("place-order", opt),
  };

  // Si contextIsolation est activé, on expose via contextBridge.
  if (process?.contextIsolated && contextBridge?.exposeInMainWorld) {
    contextBridge.exposeInMainWorld("api", api);
  } else {
    // Sinon, on attache directement (mode DEV, nodeIntegration:true)
    // eslint-disable-next-line no-undef
    window.api = api;
  }
} catch (e) {
  try {
    // Mode très permissif (ultime fallback DEV)
    const electron = require("electron");
    // eslint-disable-next-line no-undef
    window.api = {
      fetchData:      () => electron.ipcRenderer.invoke("fetch-data"),
      fetchPortfolio: () => electron.ipcRenderer.invoke("fetch-portfolio"),
      getAIState:     () => electron.ipcRenderer.invoke("get-ai-state"),
      toggleAI:       (on) => electron.ipcRenderer.invoke("toggle-ai", on),
      placeOrder:     (opt) => electron.ipcRenderer.invoke("place-order", opt),
    };
  } catch (_) {
    console.error("preload init failed:", e);
  }
}