// DOS : SSL Channel (ErwinBeckers, formule vérifiée sur le web : Hlv = état ±1 selon close vs
// SMA(high)/SMA(low), sslUp/sslDown = les deux SMA permutées par Hlv) — on ne trade PAS le
// franchissement affiché (croisement sslUp/sslDown) mais le flip du Hlv lui-même (close qui
// ressort au-dessus de smaHigh après un régime bas, ou en dessous de smaLow après un régime haut),
// pris à CONTRE-SENS (FADE du faux flip, recette du pack). Filtre ADX15m<25 (régime plat, même
// lecture que ti_arsenal_3/tv_ehlers_2) : SANS lui le worst tombe sous 0 (le flip SSL nu ne
// marche qu'en absence de tendance établie). Version causale stricte, SMA period=28 (5m).
// Robustesse : per28 ET per34 positifs sous ADX<25 sur E1 ET E2 (plateau dense) ; sans le filtre
// ADX toutes les cellules s'effondrent (~0 à -2) -> le filtre EST l'edge.
const ti = require("technicalindicators");
const PERIOD = 28, ADX_MAX = 25;

function sma(x, p) {
  const n = x.length, out = new Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) { s += x[i]; if (i >= p) s -= x[i - p]; if (i >= p - 1) out[i] = s / p; }
  return out;
}
// ADX 14 sur 15 m agrégé causalement depuis les bougies 5 m (valeur dispo seulement à la
// clôture du 15 m, aucun futur) — même construction que ti_arsenal_3.js / tv_ehlers_2.js.
function adxMap15(c5) {
  const N = c5.length;
  const h = c5.map(r => r[2]), l = c5.map(r => r[3]), c = c5.map(r => r[4]);
  const h15 = [], l15 = [], c15 = [], e15 = [];
  for (let i = 0; i + 2 < N; ) {
    const t0 = c5[i][0];
    if (t0 % 900000 !== 0) { i++; continue; }
    if (c5[i + 1][0] - t0 !== 300000 || c5[i + 2][0] - t0 !== 600000) { i++; continue; }
    h15.push(Math.max(h[i], h[i + 1], h[i + 2]));
    l15.push(Math.min(l[i], l[i + 1], l[i + 2]));
    c15.push(c[i + 2]); e15.push(i + 2);
    i += 3;
  }
  const adxArr = ti.adx({ high: h15, low: l15, close: c15, period: 14 });
  const oA = c15.length - adxArr.length;
  const map = new Array(N).fill(null);
  let m = 0, cur = null;
  for (let i = 0; i < N; i++) {
    while (m < e15.length && e15[m] <= i) { const j = m - oA; if (j >= 0) cur = adxArr[j].adx; m++; }
    map[i] = cur;
  }
  return map;
}

module.exports = {
  instId: "DOS-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  detect(c5) {
    const N = c5.length, out = [];
    const high = c5.map(r => r[2]), low = c5.map(r => r[3]), close = c5.map(r => r[4]);
    const smaHigh = sma(high, PERIOD), smaLow = sma(low, PERIOD);
    const adxMap = adxMap15(c5);
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
      if (adxMap[i] === null || adxMap[i] >= ADX_MAX) continue;
      if (hlv[i] === 1 && hlv[i - 1] === -1) out.push({ i5: i, dir: -1 });      // faux flip haussier -> fade -> short
      else if (hlv[i] === -1 && hlv[i - 1] === 1) out.push({ i5: i, dir: 1 }); // faux flip baissier -> fade -> long
    }
    return out;
  }
};
