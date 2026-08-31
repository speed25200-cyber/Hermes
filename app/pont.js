"use strict";
/*
 * Le pont entre la page et le moteur.
 *
 * Dans la version Electron, preload.js exposait window.api adosse a
 * ipcRenderer. Ici il ny a pas dElectron : les memes appels passent par
 * HTTP, et les memes evenements arrivent par un flux SSE. La page ne
 * voit pas la difference — cest tout lobjet de ce fichier.
 *
 * Une remarque sur lancien preload, parce quelle explique un bogue
 * quon pourrait croire venir dici : il appelait
 * contextBridge.exposeInMainWorld("api", ...) DEUX fois. Le second
 * appel leve — on ne peut pas reexposer une cle deja posee — et il
 * etait avale par un try/catch vide. Cest donc le premier bloc qui
 * survivait, celui qui nexpose pas subscribe() ; et le second ecoutait
 * « ai:log », un canal que le moteur nemet jamais, puisquil emet
 * « ai-log ». Le flux de journal etait mort des deux cotes a la fois.
 * Ici les deux orthographes sont acceptees, et subscribe() existe.
 */

(function () {
  const ecouteurs = new Map();   // canal -> Set de fonctions
  let flux = null;
  let reconnexionMs = 1000;

  function normaliser(canal) {
    // « ai-log » et « ai:log » designent la meme chose. Accepter les
    // deux coute une ligne et evite de rejouer le bogue du preload.
    return String(canal).replace(/:/g, "-");
  }

  function surCanal(canal, charge) {
    const s = ecouteurs.get(normaliser(canal));
    if (!s) return;
    for (const fn of s) { try { fn(charge); } catch (e) { console.error("[pont]", e); } }
  }

  function ouvrirFlux() {
    try { if (flux) flux.close(); } catch {}
    flux = new EventSource("/api/flux");
    flux.onopen = () => { reconnexionMs = 1000; surCanal("pont-etat", { relie: true }); };
    flux.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        surCanal(m.canal, m.charge);
      } catch {}
    };
    flux.onerror = () => {
      surCanal("pont-etat", { relie: false });
      // Le navigateur reessaie seul, mais pas toujours vite. On force,
      // avec un recul qui double jusqua trente secondes : un moteur qui
      // redemarre ne doit pas etre martele par vingt onglets.
      try { flux.close(); } catch {}
      setTimeout(ouvrirFlux, reconnexionMs);
      reconnexionMs = Math.min(reconnexionMs * 2, 30000);
    };
  }

  async function invoke(canal, argument) {
    const rep = await fetch("/api/" + encodeURIComponent(canal), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arg: argument }),
    });
    if (rep.status === 403) throw new Error("CLE_REFUSEE");
    return rep.json();
  }

  function on(canal, fn) {
    const c = normaliser(canal);
    if (!ecouteurs.has(c)) ecouteurs.set(c, new Set());
    ecouteurs.get(c).add(fn);
    return () => ecouteurs.get(c).delete(fn);
  }

  window.api = {
    invoke,
    on,
    subscribe: (fn) => on("ai-log", fn),
    surSante: (fn) => on("health-tick", fn),
    surLien: (fn) => on("pont-etat", fn),
  };

  ouvrirFlux();
})();
