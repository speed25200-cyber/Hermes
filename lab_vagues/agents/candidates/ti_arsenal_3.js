// BSB : Williams %R qui ressort de l'extrême, UNIQUEMENT en régime sans tendance
// (ADX14 sur bougies 15 m < 20). En marché plat, l'extrême de %R est un ressort :
// on entre quand %R referme au-dessus de -90 (long) / en dessous de -10 (short).
// Le filtre ADX<20 est ce qui crée l'edge : sans lui (adx999) le worst tombe sous +2.
// Robustesse : les 8 cellules d'exit sous ADX<20 ont un worst positif (1,7 à 6,9).
const ti = require("technicalindicators");
const ADX_MAX = 20;

module.exports = {
  instId: "BSB-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const N = c5.length, out = [];
    const h = new Array(N), l = new Array(N), c = new Array(N);
    for (let i = 0; i < N; i++) { h[i] = +c5[i][2]; l[i] = +c5[i][3]; c[i] = +c5[i][4]; }
    const wr = ti.williamsr({ high: h, low: l, close: c, period: 14 });
    const oW = N - wr.length;
    // ADX 14 sur 15 m : agrégat de 3 bougies 5 m alignées sur le quart d'heure,
    // valeur disponible seulement à la clôture de la 3e bougie (pas de futur).
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
    const adxMap = new Array(N).fill(null);
    let m = 0, cur = null;
    for (let i = 0; i < N; i++) {
      while (m < e15.length && e15[m] <= i) { const j = m - oA; if (j >= 0) cur = adxArr[j].adx; m++; }
      adxMap[i] = cur;
    }
    for (let i = Math.max(400, oW + 1); i < N - 2; i++) {
      const j = i - oW;
      if (adxMap[i] === null || adxMap[i] >= ADX_MAX) continue;
      if (wr[j - 1] < -90 && wr[j] >= -90) out.push({ i5: i, dir: 1 });
      if (wr[j - 1] > -10 && wr[j] <= -10) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
