// O : reclaim du canal de Keltner large (EMA20 ± 3×ATR10) — une clôture hors du canal
// à 3 ATR est un excès ; la première clôture qui rentre à nouveau DANS le canal signe
// l'échec de l'excès -> mean-reversion dans le sens du retour (même logique « reclaim >
// touch » que le verdict VWAP du journal, mais canal volatilité au lieu de bandes VWAP).
// Robustesse : 3 cellules d'exit valides en ×3 (worst 6,36-8,30), ×2 aussi valide.
const ti = require("technicalindicators");
const MULT = 3;

module.exports = {
  instId: "O-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 8 },
  detect(c5) {
    const N = c5.length, out = [];
    const h = new Array(N), l = new Array(N), c = new Array(N);
    for (let i = 0; i < N; i++) { h[i] = +c5[i][2]; l[i] = +c5[i][3]; c[i] = +c5[i][4]; }
    const kc = ti.keltnerchannels({ high: h, low: l, close: c, maPeriod: 20, atrPeriod: 10, multiplier: MULT, useSMA: false });
    const oK = N - kc.length;
    for (let i = Math.max(400, oK + 1); i < N - 2; i++) {
      const j = i - oK;
      if (c[i - 1] < kc[j - 1].lower && c[i] > kc[j].lower) out.push({ i5: i, dir: 1 });
      if (c[i - 1] > kc[j - 1].upper && c[i] < kc[j].upper) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
