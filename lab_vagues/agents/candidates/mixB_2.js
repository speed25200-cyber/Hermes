// AGENT mixB — scanner systématique de paires de primitives (tools/mix_scan_mixB.js).
// KGEN : A = Bollinger %B(20,2) — sortie des bandes PUIS RECLAIM (referme dedans) = fade.
//        B = distance à l'EMA96 en unités d'ATR14 : confirme SEULEMENT si le prix est ENCORE
//        à ≥3×ATR de sa moyenne longue au moment du reclaim (le mouvement de fond n'est pas
//        épuisé, la réaction Bollinger n'est qu'une respiration à l'intérieur d'un excès plus
//        large — double confirmation d'excès à 2 échelles de temps différentes).
// Logique en une phrase : quand une bande courte (Bollinger 20) referme APRÈS un excès alors
// que le prix reste très loin de sa moyenne longue (EMA96), les deux horizons sont d'accord —
// fade avec conviction.
// Plateau : %B plus profond (-0,1/1,1) même B +2,24 ; même A avec EMA96 seuil 2×ATR +2,50 —
// les deux voisins restent positifs.
const ti = require("technicalindicators");
const WARMUP = 300;

module.exports = {
  instId: "KGEN-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length;
    const high = new Array(n), low = new Array(n), close = new Array(n);
    for (let i = 0; i < n; i++) { high[i] = c5[i][2]; low[i] = c5[i][3]; close[i] = c5[i][4]; }

    // SMA20 + écart-type 20 (rolling causal), pour Bollinger %B.
    const sma20 = new Array(n).fill(null), std20 = new Array(n).fill(null);
    { let sum = 0, sumSq = 0;
      for (let i = 0; i < n; i++) {
        sum += close[i]; sumSq += close[i] * close[i];
        if (i >= 20) { sum -= close[i - 20]; sumSq -= close[i - 20] * close[i - 20]; }
        if (i >= 19) { sma20[i] = sum / 20; const meanSq = sumSq / 20; std20[i] = Math.sqrt(Math.max(0, meanSq - sma20[i] * sma20[i])); }
      }
    }

    const ema96arr = ti.EMA.calculate({ period: 96, values: close });
    const off96 = n - ema96arr.length, ema96 = new Array(n).fill(null);
    for (let i = 0; i < ema96arr.length; i++) ema96[off96 + i] = ema96arr[i];

    const atrArr = ti.ATR.calculate({ period: 14, high, low, close });
    const offA = n - atrArr.length, atr14 = new Array(n).fill(null);
    for (let i = 0; i < atrArr.length; i++) atr14[offA + i] = atrArr[i];

    // A = Bollinger %B, extrême = hors bandes (pctB<=0 ou >=1).
    const bLong = new Uint8Array(n), bShort = new Uint8Array(n);
    for (let i = 19; i < n; i++) {
      if (std20[i] == null) continue;
      const upper = sma20[i] + 2 * std20[i], lower = sma20[i] - 2 * std20[i];
      if (upper <= lower) continue;
      const pctB = (close[i] - lower) / (upper - lower);
      if (pctB <= 0.0) bLong[i] = 1; else if (pctB >= 1.0) bShort[i] = 1;
    }

    // B = distance EMA96 normalisée ATR14, seuil 3.
    const eLong = new Uint8Array(n), eShort = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (ema96[i] == null || atr14[i] == null || atr14[i] <= 0) continue;
      const dist = (close[i] - ema96[i]) / atr14[i];
      if (dist <= -3) eLong[i] = 1; else if (dist >= 3) eShort[i] = 1;
    }

    const out = [];
    for (let i = WARMUP; i < n; i++) {
      if (bLong[i - 1] === 1 && bLong[i] === 0 && eLong[i] === 1) out.push({ i5: i, dir: 1 });
      else if (bShort[i - 1] === 1 && bShort[i] === 0 && eShort[i] === 1) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
