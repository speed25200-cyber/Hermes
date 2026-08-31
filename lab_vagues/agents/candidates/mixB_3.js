// AGENT mixB — scanner systématique de paires de primitives (tools/mix_scan_mixB.js).
// LIT : A = Bollinger %B(20,2) — sortie des bandes PUIS RECLAIM (referme dedans) = fade.
//        B = position dans le range 24h (288 bougies), porte STRICTE (0,1/0,9) : confirme
//        seulement si le reclaim Bollinger tombe dans le dixième extrême du range journalier.
// Logique en une phrase : le retour dans les bandes de Bollinger ne vaut la peine d'être fadé
// que si le prix est ENCORE au tout bord du range 24h — sinon ce n'est qu'un aller-retour de
// range normal, pas un excès journalier.
// Plateau : même B, %B plus profond (-0,1/1,1) +6,03 ; même A, porte range24h plus large
// (0,2/0,8) +1,14 — les deux voisins restent positifs.
const WARMUP = 300;

module.exports = {
  instId: "LIT-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
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
