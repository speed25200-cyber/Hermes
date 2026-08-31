// TERRITOIRE VIERGE. JELLYJELLY : reclaim du canal de Keltner LARGE (EMA20 +/- 3xATR10) --
// une cloture hors du canal a 3 ATR est un exces ; la 1re cloture qui rentre a nouveau DANS
// le canal signe l'echec de l'exces -> mean-reversion (meme logique que le champion O,
// ti_arsenal_2, transplantee ici sur une crypto neuve).
// Robustesse : famille ema20-x3 positive des DEUX cotes sur 3/4 exits fondateurs
// (E2 IS+2,67/OOS+9,61 · E3 IS+7,88/OOS+10,93 · E4 IS+8,82/OOS+9,39) -- pas un pic isole.
const ti = require("technicalindicators");
const MA = 20, MULT = 3;

module.exports = {
  instId: "JELLYJELLY-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 24 },
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
