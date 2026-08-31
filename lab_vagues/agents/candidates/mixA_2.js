// mixA_2 — POPCAT : ROC12 étiré (fade du rendement 1h) confirmé par un pic de volume relatif (vs médiane
// 24h). Logique en une phrase : un mouvement de ±1,5 % en 1 h qui s'accompagne d'un volume ≥2,5× la
// médiane du jour est un épuisement (pas un vrai départ de tendance) — on fade la bougie qui l'a produit.
// Réglages retenus par le scanner mix_scan_mixA.js : ROC12 setting0 (±1,5 %) × VOLR setting1 (spike ≥2,5×).
// Autonome : tout le calcul est ici, aucune dépendance au labo (seulement "technicalindicators", npm).
const { ROC } = require("technicalindicators");

const ROC_LO = -1.5, ROC_HI = 1.5; // %
const VOL_SPIKE = 2.5; // × médiane des 288 bougies (24h) précédentes, fenêtre incluant la bougie courante
const VOL_WIN = 288;

function alignEnd(n, arr) {
  const pad = n - arr.length;
  const out = new Array(Math.max(0, pad)).fill(null);
  for (let k = 0; k < arr.length; k++) out.push(arr[k]);
  return out;
}

function volRatioSeries(vol) {
  const n = vol.length;
  const out = new Array(n).fill(null);
  const win = [];
  function insert(v) {
    let lo = 0, hi = win.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (win[mid] < v) lo = mid + 1; else hi = mid; }
    win.splice(lo, 0, v);
  }
  function remove(v) {
    let lo = 0, hi = win.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (win[mid] === v) { win.splice(mid, 1); return; }
      if (win[mid] < v) lo = mid + 1; else hi = mid - 1;
    }
  }
  for (let i = 0; i < n; i++) {
    insert(vol[i]);
    if (win.length > VOL_WIN) remove(vol[i - VOL_WIN]);
    if (i >= VOL_WIN - 1) {
      const m = win.length >> 1;
      const med = win.length % 2 ? win[m] : (win[m - 1] + win[m]) / 2;
      out[i] = med > 0 ? vol[i] / med : null;
    }
  }
  return out;
}

module.exports = {
  instId: "POPCAT-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  detect(c5) {
    const n = c5.length;
    const close = c5.map(b => b[4]);
    const open = c5.map(b => b[1]);
    const vol = c5.map(b => b[5]);

    const roc = alignEnd(n, ROC.calculate({ period: 12, values: close }));
    const volr = volRatioSeries(vol);

    const out = [];
    for (let i = 100; i < n; i++) {
      const rc = roc[i], r = volr[i];
      if (rc == null || r == null) continue;
      const spike = r >= VOL_SPIKE;
      if (!spike) continue;
      const bull = close[i] > open[i];
      const rocLong = rc < ROC_LO, rocShort = rc > ROC_HI;
      const volLong = !bull, volShort = bull;
      if (rocLong && volLong) out.push({ i5: i, dir: 1 });
      else if (rocShort && volShort) out.push({ i5: i, dir: -1 });
    }
    return out;
  },
};
