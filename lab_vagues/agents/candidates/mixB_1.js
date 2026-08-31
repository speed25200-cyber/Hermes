// AGENT mixB — scanner systématique de paires de primitives (tools/mix_scan_mixB.js).
// INIT : A = Keltner (EMA20 ± 2×ATR14) — sortie du canal PUIS RECLAIM (referme dedans) = fade.
//        B = position dans le range 24h (288 bougies) : confirme SEULEMENT si le reclaim se
//        produit du côté FAVORABLE du range (bas 20% pour un long, haut 20% pour un short) —
//        même architecture "confirmation par le range 24h" que gen_regime, généralisée ici au
//        Keltner au lieu d'une mèche d'épuisement.
// Logique en une phrase : le prix qui ressort du canal de volatilité ET qui est encore dans
// l'extrême du range journalier a de bonnes chances de rebondir vers le canal.
// Plateau (voisins positifs sur le banc 30j) : Keltner mult3 même B +0,43 ; même A avec
// range24h 10/90 +5,53 — les deux voisins restent du bon côté de zéro.
const ti = require("technicalindicators");
const WARMUP = 300;

module.exports = {
  instId: "INIT-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  detect(c5) {
    const n = c5.length;
    const high = new Array(n), low = new Array(n), close = new Array(n);
    for (let i = 0; i < n; i++) { high[i] = c5[i][2]; low[i] = c5[i][3]; close[i] = c5[i][4]; }

    const ema20arr = ti.EMA.calculate({ period: 20, values: close });
    const off20 = n - ema20arr.length, ema20 = new Array(n).fill(null);
    for (let i = 0; i < ema20arr.length; i++) ema20[off20 + i] = ema20arr[i];

    const atrArr = ti.ATR.calculate({ period: 14, high, low, close });
    const offA = n - atrArr.length, atr14 = new Array(n).fill(null);
    for (let i = 0; i < atrArr.length; i++) atr14[offA + i] = atrArr[i];

    // A = Keltner mult 2 : état "hors canal" (extrême), long=sous la bande basse, short=au-dessus.
    const kLong = new Uint8Array(n), kShort = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (ema20[i] == null || atr14[i] == null || atr14[i] <= 0) continue;
      const pos = (close[i] - ema20[i]) / (2 * atr14[i]);
      if (pos <= -1) kLong[i] = 1; else if (pos >= 1) kShort[i] = 1;
    }

    // B = position dans le range 24h (288 bougies), deque monotone causale.
    const R = 288, rangePos = new Array(n).fill(null);
    const dqH = [], dqL = [];
    for (let i = 0; i < n; i++) {
      while (dqH.length && high[dqH[dqH.length - 1]] <= high[i]) dqH.pop();
      dqH.push(i);
      while (dqL.length && low[dqL[dqL.length - 1]] >= low[i]) dqL.pop();
      dqL.push(i);
      while (dqH[0] <= i - R) dqH.shift();
      while (dqL[0] <= i - R) dqL.shift();
      if (i >= R - 1) {
        const hh = high[dqH[0]], ll = low[dqL[0]];
        rangePos[i] = hh > ll ? (close[i] - ll) / (hh - ll) : 0.5;
      }
    }

    const out = [];
    for (let i = WARMUP; i < n; i++) {
      if (rangePos[i] == null) continue;
      // Reclaim du canal Keltner : extrême à i-1, dedans à i.
      if (kLong[i - 1] === 1 && kLong[i] === 0 && rangePos[i] <= 0.20) out.push({ i5: i, dir: 1 });
      else if (kShort[i - 1] === 1 && kShort[i] === 0 && rangePos[i] >= 0.80) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
