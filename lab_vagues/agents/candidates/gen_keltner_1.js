// gen_keltner_1 PIEVERSE : reclaim du canal de Keltner EMA50 ± 2×ATR10 — généralisation du
// champion O (ti_arsenal_2) : clôture hors canal = excès, 1re clôture qui rentre = échec de
// l'excès -> contre-pied mean-reversion. Exit familial tp80/act30/hold8.
// Grille PIEVERSE : EMA50x2 7,13 / EMA50x3 6,26 / EMA20x2 2,67 valides (3/4 cellules).
// ⚠️ PIEVERSE a déjà un champion supérieur (web_structure_1 double bottom/top, worst 12,58,
// EN LIVE) -> redondant, à écarter au registre (1 stratégie/crypto).
const ti = require("technicalindicators");
const MA = 50, MULT = 2;

module.exports = {
  instId: "PIEVERSE-USDT-SWAP",
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
