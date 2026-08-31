// mixA_1 — COAI : TRIX18 extrême (fade du momentum étiré) confirmé par un pic de volume relatif (vs
// médiane 24h). Logique en une phrase : quand le momentum lissé est déjà très étiré ET que la bougie qui
// l'a produit s'accompagne d'un volume anormal (2,5× la médiane du jour), c'est un dernier sursaut à
// contre-courant — on fade la bougie qui l'a produit.
// Réglages retenus par le scanner mix_scan_mixA.js : TRIX18 setting1 (±0,06 %) × VOLR setting1 (spike ≥2,5×).
// Autonome : tout le calcul est ici, aucune dépendance au labo (seulement "technicalindicators", npm).
const { TRIX } = require("technicalindicators");

const TRIX_LO = -0.06, TRIX_HI = 0.06; // %
const VOL_SPIKE = 2.5; // × médiane des 288 bougies (24h) précédentes, fenêtre incluant la bougie courante
const VOL_WIN = 288;

function alignEnd(n, arr) {
  const pad = n - arr.length;
  const out = new Array(Math.max(0, pad)).fill(null);
  for (let k = 0; k < arr.length; k++) out.push(arr[k]);
  return out;
}

// médiane glissante causale du volume (fenêtre triée, insertion/retrait par recherche binaire)
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
  instId: "COAI-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length;
    const close = c5.map(b => b[4]);
    const open = c5.map(b => b[1]);
    const vol = c5.map(b => b[5]);

    const trix = alignEnd(n, TRIX.calculate({ period: 18, values: close }));
    const volr = volRatioSeries(vol);

    const out = [];
    for (let i = 100; i < n; i++) {
      const t = trix[i], r = volr[i];
      if (t == null || r == null) continue;
      const spike = r >= VOL_SPIKE;
      if (!spike) continue;
      const bull = close[i] > open[i];
      const trixLong = t < TRIX_LO, trixShort = t > TRIX_HI;
      // VOLR : bougie baissière + spike -> long (capitulation) ; bougie haussière + spike -> short (blow-off)
      const volLong = !bull, volShort = bull;
      if (trixLong && volLong) out.push({ i5: i, dir: 1 });
      else if (trixShort && volShort) out.push({ i5: i, dir: -1 });
    }
    return out;
  },
};
