// H : même logique que ti_arsenal_2 (reclaim du canal de Keltner EMA20 ± 3×ATR10),
// deuxième crypto où la famille est robuste : clôture hors canal 3 ATR = excès,
// première clôture qui rentre dans le canal = échec de l'excès -> contre-pied.
// Robustesse : 3 cellules ×3 valides (worst 5,26-6,47) + les 3 cellules ×2 positives.
const ti = require("technicalindicators");
const MULT = 3;

module.exports = {
  instId: "H-USDT-SWAP",
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
