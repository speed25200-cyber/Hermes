// gen_keltner_5 STABLE : reclaim du canal de Keltner EMA50 ± 3×ATR10 — généralisation du
// champion O (ti_arsenal_2) : clôture hors canal = excès, 1re clôture qui rentre = contre-pied.
// Exit familial tp80/act30/hold8.
// Grille STABLE : EMA50x3 3,79 / EMA20x3 1,85 valides, EMA20/50 x2 non valides.
// ⚠️ STABLE a déjà un champion très supérieur (tv_lazybear_1 Coral stretch-fade, worst 11,66)
// -> redondant, à écarter au registre (1 stratégie/crypto).
const ti = require("technicalindicators");
const MA = 50, MULT = 3;

module.exports = {
  instId: "STABLE-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 8 },
  detect(c5) {
    const N = c5.length, out = [];
    const h = new Array(N), l = new Array(N), c = new Array(N);
    for (let i = 0; i < N; i++) { h[i] = +c5[i][2]; l[i] = +c5[i][3]; c[i] = +c5[i][4]; }
    const kc = ti.keltnerchannels({ high: h, low: l, close: c, maPeriod: MA, atrPeriod: 10, multiplier: MULT, useSMA: false });
    const oK = N - kc.length;
    for (let i = Math.max(400, oK + 1); i < N - 2; i++) {
      const j = i - oK;
      if (c[i - 1] < kc[j - 1].lower && c[i] > kc[j].lower) out.push({ i5: i, dir: 1 });
      if (c[i - 1] > kc[j - 1].upper && c[i] < kc[j].upper) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
