// PIPPIN : bandes STARC (Stoller Average Range Channel) — basis = SMA(close,14) ;
// bande = basis ± 3,0 × ATR(14), mode RECLAIM (cf. tv2_pivots_2.js ZBT pour la formule/logique
// détaillée). Aucun repaint. ⚠️ worst 5,96 = juste SOUS l'objectif +6 du banc, mais c'est le
// candidat le plus ROBUSTE de toute la famille tv2_pivots_ : au contraire de ZBT (plateau étroit,
// mult=2 négatif) ou de BICO (n=60 pile), la grille STARC E1 sur PIPPIN est POSITIVE quasiment
// partout — N{10,14,20,30} × mult{1,5..3} × E1 : worst 3,65 à 5,96, un seul creux isolé (N40,
// négatif). Déposé malgré le seuil manqué de justesse pour que l'orchestrateur tranche : à
// n=75 (nIS 53 + nOOS 22) l'edge est mince mais nettement moins fragile qu'un pic de grille.
const N = 14, MULT = 3.0, WARM = 320;

function rollingMean(arr, len) {
  const n = arr.length, out = new Float64Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += arr[i];
    if (i >= len) s -= arr[i - len];
    if (i >= len - 1) out[i] = s / len;
  }
  return out;
}

module.exports = {
  instId: "PIPPIN-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length;
    const high = c5.map(x => x[2]), low = c5.map(x => x[3]), close = c5.map(x => x[4]);
    const tr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      tr[i] = i === 0 ? high[i] - low[i] : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    }
    const atr = rollingMean(tr, N), sma = rollingMean(close, N);
    const upper = new Float64Array(n).fill(NaN), lower = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(sma[i]) && !Number.isNaN(atr[i])) { upper[i] = sma[i] + MULT * atr[i]; lower[i] = sma[i] - MULT * atr[i]; }
    }
    const out = [];
    for (let i = WARM; i < n; i++) {
      const lo = lower[i], loP = lower[i - 1], up = upper[i], upP = upper[i - 1];
      if (!Number.isNaN(lo) && !Number.isNaN(loP) && close[i - 1] < loP && close[i] >= lo) out.push({ i5: i, dir: 1 });
      if (!Number.isNaN(up) && !Number.isNaN(upP) && close[i - 1] > upP && close[i] <= up) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
