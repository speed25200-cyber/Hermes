// RLS : croisement Hull MA en sur-extension — le prix est loin de sa moyenne lente
// (ALMA 96, offset 0.85, sigma 6 — formule TradingView exacte) d'au moins 1,5 %,
// et la clôture RECROISE la HMA(21) (Alan Hull : WMA(2·WMA(n/2)−WMA(n), √n)) vers
// la moyenne → le retour est enclenché, on suit le snap-back (mean-reversion).
// Aucun repaint : tout à l'index i n'utilise que des bougies closes [0..i].
// Robustesse (banc 30 j) : L21/D15 E1 12.71 · E3 12.48 · E2 12.46 ; voisins L14 9.42,
// L9 8.30, D20 9.0, W192/D30 14.13 (n<60) — toute la grille L×D×W est positive.
const L = 21, W = 96, D = 0.015, WARM = 300;

function wmaSeries(src, len) {
  const n = src.length, out = new Array(n).fill(NaN), den = len * (len + 1) / 2;
  for (let i = len - 1; i < n; i++) {
    let s = 0, ok = true;
    for (let k = 0; k < len; k++) { const v = src[i - k]; if (isNaN(v)) { ok = false; break; } s += v * (len - k); }
    if (ok) out[i] = s / den;
  }
  return out;
}
function hmaSeries(closes, len) {
  const half = Math.round(len / 2), sq = Math.round(Math.sqrt(len));
  const a = wmaSeries(closes, half), b = wmaSeries(closes, len);
  const diff = closes.map((_, i) => (isNaN(a[i]) || isNaN(b[i])) ? NaN : 2 * a[i] - b[i]);
  return wmaSeries(diff, sq);
}
function almaSeries(closes, win, offset = 0.85, sigma = 6) {
  const n = closes.length, out = new Array(n).fill(NaN);
  const m = offset * (win - 1), s = win / sigma, w = new Array(win);
  let norm = 0;
  for (let i = 0; i < win; i++) { w[i] = Math.exp(-((i - m) * (i - m)) / (2 * s * s)); norm += w[i]; }
  for (let i = win - 1; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < win; k++) sum += closes[i - win + 1 + k] * w[k];
    out[i] = sum / norm;
  }
  return out;
}

module.exports = {
  instId: "RLS-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const closes = c5.map(x => x[4]);
    const hma = hmaSeries(closes, L), alma = almaSeries(closes, W);
    const out = [];
    for (let i = WARM; i < c5.length; i++) {
      if (isNaN(hma[i]) || isNaN(hma[i - 1]) || isNaN(alma[i])) continue;
      const st = (c5[i][4] - alma[i]) / alma[i];
      const cPrev = c5[i - 1][4], c = c5[i][4];
      if (st >= D && cPrev >= hma[i - 1] && c < hma[i]) out.push({ i5: i, dir: -1 });
      if (st <= -D && cPrev <= hma[i - 1] && c > hma[i]) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
