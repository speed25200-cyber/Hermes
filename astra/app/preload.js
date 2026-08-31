const { contextBridge, ipcRenderer } = require("electron");
const allowedInvokes = new Set(["ui-auth","ui-mode","get-ai-state","fetch-data","fetch-portfolio","toggle-ai","place-order","get-health","debug-snapshot"]);
const allowedOn = new Set(["ai-log","health-tick"]);
contextBridge.exposeInMainWorld("api", {
  invoke: (channel, ...args) => {
    if (!allowedInvokes.has(channel)) return Promise.reject(new Error(`invoke non autorisé: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, listener) => {
    if (!allowedOn.has(channel)) return;
    const wrapped = (_event, ...data) => listener(...data);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});

/* === PRELOAD API START === */
(() => {
  try {
    const { contextBridge, ipcRenderer } = require("electron");
    const api = {
      // Appels IPC côté main
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      // Abonnement aux logs AI ; retourne un unsubscribe()
      subscribe: (handler) => {
        try {
          ipcRenderer.invoke("ai:log-subscribe").catch(() => {});
          const fn = (_e, payload) => { try { handler(payload); } catch {} };
          ipcRenderer.on("ai:log", fn);
          return () => ipcRenderer.removeListener("ai:log", fn);
        } catch { return () => {}; }
      }
    };
    try { contextBridge.exposeInMainWorld("api", api); } catch {}
  } catch {}
})();
/* === PRELOAD API END === */

