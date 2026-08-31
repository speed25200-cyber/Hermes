// wr_exits_1 — LIT (base LIVE : mixB_3.js, %B Bollinger + reclaim filtré porte range24h 0,1/0,9).
// LEVIER SORTIES SEUL : detect() intact, on ne touche qu'aux sorties. TP +40->80% de marge trop
// large pour cette crypto : coupé à TP +20% (au lieu de +60), trail activé à mi-chemin (+10%,
// callback 5% inchangé), hold ramené 8h->12h à 12h (pas de gain, testé aussi à 4/8h : plateau).
// AVANT (live mixB_3)  tp60/act20/hold8  : wr 70,3/66,7  esp +5,20/+4,50  (worst avant = 4,50)
// APRÈS (wr_exits_1)   tp20/act10/hold12 : wr 79,5/79,2  esp +3,73/+4,13  (worst = 3,73, 83% de l'avant)
// Plateau : 9/18 cellules du balayage (tp20-30 % x trail on/off x hold 4/8/12h) passent
// wr>=65 des 2 côtés + esp>0 + retention esp>=60% de l'avant — pas un point isolé.
const WARMUP = 300;

module.exports = {
  instId: "LIT-USDT-SWAP",
  exits: { tp: 0.20, sl: 0.30, act: 0.10, cb: 0.05, holdH: 12 },
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

    // A = Bollinger %B, extrême = hors bandes (pctB<=0 ou >=1).
    const bLong = new Uint8Array(n), bShort = new Uint8Array(n);
    for (let i = 19; i < n; i++) {
      if (std20[i] == null) continue;
      const upper = sma20[i] + 2 * std20[i], lower = sma20[i] - 2 * std20[i];
      if (upper <= lower) continue;
      const pctB = (close[i] - lower) / (upper - lower);
      if (pctB <= 0.0) bLong[i] = 1; else if (pctB >= 1.0) bShort[i] = 1;
    }

    // B = position dans le range 24h (288 bougies), deque monotone causale, porte 0,1/0,9.
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
      if (bLong[i - 1] === 1 && bLong[i] === 0 && rangePos[i] <= 0.10) out.push({ i5: i, dir: 1 });
      else if (bShort[i - 1] === 1 && bShort[i] === 0 && rangePos[i] >= 0.90) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
