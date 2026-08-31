// wr_exits_3 — SOON (base LIVE : gen_keltner_2.js, reclaim du canal Keltner EMA20 ± 3xATR10).
// LEVIER SORTIES SEUL : detect() intact. TP +80% -> +30% de marge, trail activé à mi-chemin
// (+15%, callback 5% inchangé), hold 8h conservé (identique au live).
// AVANT (live gen_keltner_2) tp80/act30/hold8  : wr 57,1/72,2  esp +6,24/+14,31 (worst = 6,24)
// APRÈS (wr_exits_3)         tp30/act15/hold8  : wr 69,4/81,0  esp +4,21/+5,99  (worst = 4,21, 67% de l'avant)
// Plateau : voisin tp30/act15/hold12 aussi valide (wr identique 69,4/81,0, esp 3,93/6,46) —
// insensible au hold 8h/12h à ce TP. n faible (49 IS + 21 OOS) : à confirmer sur fenêtre plus large.
const ti = require("technicalindicators");
const MA = 20, MULT = 3;

module.exports = {
  instId: "SOON-USDT-SWAP",
  exits: { tp: 0.30, sl: 0.30, act: 0.15, cb: 0.05, holdH: 8 },
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
