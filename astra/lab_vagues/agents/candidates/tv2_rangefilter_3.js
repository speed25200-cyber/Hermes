// CRV : Half Trend (everget, formule vérifiée sur le web : amplitude highest/lowest + SMA(high/low),
// flip causal trend 0/1 — on ignore les niveaux atrHigh/atrLow, purement visuels, non nécessaires
// au signal). Recette du pack : FADE du retournement de canal — le flip HalfTrend (achat officiel
// quand trend repasse de baisse à hausse, vente quand il repasse de hausse à baisse) est pris à
// CONTRE-SENS, pariant que le retournement affiché est une prise de stops (même lignée que UT Bot
// fadé, déjà mort, mais indicateur structurellement différent : extrêmes sur `amplitude` bougies
// + SMA, pas un stop ATR suiveur). Amplitude=4 (paramètre par défaut de l'indicateur = 2 ;
// amplitude=3/4 sont la plage robuste sur cette crypto). Version causale stricte.
// Robustesse : amp3 et amp4 tous deux positifs sur E1 ET E2, avec et sans filtre ADX15m<25
// (4,0 à 8,8) — plateau dense, ce n'est pas un pic isolé (contrairement à TURBO amp10, écarté).
// ⚠️ Bat de peu (worst +6,15) le champion CRV déjà au registre (web_structure_3.js, faux
// breakout de rond, worst +6,10) — remplacement marginal, à confirmer en vérification indépendante.
const AMPLITUDE = 4;

function sma(x, p) {
  const n = x.length, out = new Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) { s += x[i]; if (i >= p) s -= x[i - p]; if (i >= p - 1) out[i] = s / p; }
  return out;
}

module.exports = {
  instId: "CRV-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const N = c5.length, out = [];
    const high = c5.map(r => r[2]), low = c5.map(r => r[3]), close = c5.map(r => r[4]);
    const highma = sma(high, AMPLITUDE), lowma = sma(low, AMPLITUDE);
    const highPrice = new Array(N).fill(NaN), lowPrice = new Array(N).fill(NaN);
    for (let i = AMPLITUDE - 1; i < N; i++) {
      let mx = -Infinity, mn = Infinity;
      for (let k = i - AMPLITUDE + 1; k <= i; k++) { if (high[k] > mx) mx = high[k]; if (low[k] < mn) mn = low[k]; }
      highPrice[i] = mx; lowPrice[i] = mn;
    }
    const trend = new Int8Array(N).fill(0);
    let nextTrend = 0, maxLowPrice = low[0], minHighPrice = high[0], curTrend = 0;
    for (let i = 1; i < N; i++) {
      if (Number.isNaN(highPrice[i]) || Number.isNaN(highma[i]) || Number.isNaN(lowma[i])) { trend[i] = curTrend; continue; }
      if (nextTrend === 1) {
        maxLowPrice = Math.max(lowPrice[i], maxLowPrice);
        if (highma[i] < maxLowPrice && close[i] < low[i - 1]) { curTrend = 1; nextTrend = 0; minHighPrice = highPrice[i]; }
      } else {
        minHighPrice = Math.min(highPrice[i], minHighPrice);
        if (lowma[i] > minHighPrice && close[i] > high[i - 1]) { curTrend = 0; nextTrend = 1; maxLowPrice = lowPrice[i]; }
      }
      trend[i] = curTrend;
    }
    for (let i = 700; i < N - 2; i++) {
      if (trend[i] === 0 && trend[i - 1] === 1) out.push({ i5: i, dir: -1 });     // flip haussier -> fade -> short
      else if (trend[i] === 1 && trend[i - 1] === 0) out.push({ i5: i, dir: 1 }); // flip baissier -> fade -> long
    }
    return out;
  }
};
