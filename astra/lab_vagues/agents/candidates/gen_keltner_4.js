// gen_keltner_4 EGLD : reclaim du canal de Keltner EMA20 ± 2×ATR10 — généralisation du
// champion O (ti_arsenal_2) : clôture hors canal = excès, 1re clôture qui rentre = contre-pied.
// Exit familial tp80/act30/hold8.
// Meilleure crypto LIBRE (sans champion existant) du scan famille. Grille EGLD : EMA20x2 4,02
// valide, EMA20x3 0,36 (positif, n court), EMA50 x2 1,30 / x3 -4,23 -> l'edge vit sur l'EMA20.
// Sous la barre worst>=+5 du banc et sous la barre +6,5 post-haircut 1 m : ne pas promouvoir
// en l'état, garder comme trace de la famille.
const ti = require("technicalindicators");
const MA = 20, MULT = 2;

module.exports = {
  instId: "EGLD-USDT-SWAP",
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
