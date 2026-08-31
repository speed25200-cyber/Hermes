// ZBT : bandes STARC (Stoller Average Range Channel, Manning Stoller, reprise TradingView "STARC
// Bands") — basis = SMA(close,14) ; bande = basis ± 2,5 × ATR(14) [ATR = moyenne mobile simple du
// True Range, causal]. mode RECLAIM demandé par la famille : la clôture ÉTAIT hors de la bande au
// i-1, REVIENT dedans au i -> le débordement de volatilité vient de refluer (bande basse = support,
// fade LONG ; bande haute = résistance, fade SHORT). Cf. leçon "reclaim > touch", jamais testée sur
// STARC. Aucun repaint : SMA/ATR/bandes 100% causales (fenêtre [i-13..i]).
// ⚠️ Plateau ÉTROIT (mult=2,5 spécifiquement porteur ; mult<=2 tue l'edge, cf. journal) — à
// surveiller de près en verif90, comme SOON web_vwap_1 (bande K entière) en son temps.
const N = 14, MULT = 2.5, WARM = 320;

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
  instId: "ZBT-USDT-SWAP",
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
