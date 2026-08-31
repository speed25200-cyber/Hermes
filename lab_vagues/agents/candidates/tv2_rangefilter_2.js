// AIXBT : SSL Channel (ErwinBeckers/prorealcode, formule vérifiée : Hlv = état ±1 selon close vs
// SMA(high,per)/SMA(low,per), permutées par Hlv pour sslUp/sslDown). Recette du pack : FADE du
// faux flip Hlv — dès que close ressort au-dessus de smaHigh après un régime bas (ou en dessous
// de smaLow après un régime haut), on prend le CONTRE-SENS, pariant sur l'échec du flip.
// Period=28 (5m), pas de filtre de régime nécessaire (contrairement à DOS) : nu, le flip fade
// est déjà l'edge sur cette crypto. Version causale stricte.
// Robustesse : per20/28/34/50 tous positifs en E1 (4,2 à 7,0), per20 positif aussi en E2 (4,8).
const PERIOD = 28;

function sma(x, p) {
  const n = x.length, out = new Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) { s += x[i]; if (i >= p) s -= x[i - p]; if (i >= p - 1) out[i] = s / p; }
  return out;
}

module.exports = {
  instId: "AIXBT-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const N = c5.length, out = [];
    const high = c5.map(r => r[2]), low = c5.map(r => r[3]), close = c5.map(r => r[4]);
    const smaHigh = sma(high, PERIOD), smaLow = sma(low, PERIOD);
    let cur = 0;
    const hlv = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      if (!Number.isNaN(smaHigh[i]) && !Number.isNaN(smaLow[i])) {
        if (close[i] > smaHigh[i]) cur = 1;
        else if (close[i] < smaLow[i]) cur = -1;
      }
      hlv[i] = cur;
    }
    for (let i = 700; i < N - 2; i++) {
      if (hlv[i] === 1 && hlv[i - 1] === -1) out.push({ i5: i, dir: -1 });      // faux flip haussier -> fade -> short
      else if (hlv[i] === -1 && hlv[i - 1] === 1) out.push({ i5: i, dir: 1 }); // faux flip baissier -> fade -> long
    }
    return out;
  }
};
