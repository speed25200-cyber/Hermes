// NEIRO : retournement Heikin-Ashi en régime plat — haClose=(o+h+l+c)/4,
// haOpen=(haOpen1+haClose1)/2 (formule TV exacte, calculée sur bougies closes = 0 repaint).
// Après une série d'au moins 6 bougies HA de même couleur, la 1re bougie HA de couleur
// OPPOSÉE = épuisement du mouvement → on entre dans le sens de la nouvelle couleur,
// UNIQUEMENT si ADX14 (15 m composite, dernière bougie 15 m close) < 25 : sans tendance
// de fond, la série HA est un excès local qui se rend (leçon BSB/ESP : le filtre de
// régime plat EST l'edge). Robustesse (banc 30 j) : M6 adx25 E2 6.95 / E3 6.82 ;
// base sans filtre M6 5.6-5.8 sur les 3 exits, M8 4.7-5.1 — famille large positive.
const M = 6, ADX_MAX = 25, WARM = 300;

function adx15mAt5m(c5, len = 14) {
  const n = c5.length, bars = [];
  for (let g = 0; g + 3 <= n; g += 3) {
    let h = -Infinity, l = Infinity;
    for (let k = g; k < g + 3; k++) { if (c5[k][2] > h) h = c5[k][2]; if (c5[k][3] < l) l = c5[k][3]; }
    bars.push([c5[g][1], h, l, c5[g + 2][4], g + 2]);
  }
  const m = bars.length, adx = new Array(m).fill(NaN);
  let trS = 0, pS = 0, mS = 0, dxSum = 0, dxCnt = 0, adxV = NaN;
  for (let j = 1; j < m; j++) {
    const h = bars[j][1], l = bars[j][2], ph = bars[j - 1][1], pl = bars[j - 1][2], pc = bars[j - 1][3];
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up = h - ph, dn = pl - l;
    const pDM = (up > dn && up > 0) ? up : 0, mDM = (dn > up && dn > 0) ? dn : 0;
    if (j <= len) { trS += tr; pS += pDM; mS += mDM; }
    else { trS = trS - trS / len + tr; pS = pS - pS / len + pDM; mS = mS - mS / len + mDM; }
    if (j >= len) {
      const pDI = trS > 0 ? 100 * pS / trS : 0, mDI = trS > 0 ? 100 * mS / trS : 0;
      const dx = (pDI + mDI) > 0 ? 100 * Math.abs(pDI - mDI) / (pDI + mDI) : 0;
      if (dxCnt < len) { dxSum += dx; dxCnt++; if (dxCnt === len) adxV = dxSum / len; }
      else adxV = (adxV * (len - 1) + dx) / len;
      adx[j] = adxV;
    }
  }
  const out = new Array(n).fill(NaN);
  let j = 0;
  for (let i = 0; i < n; i++) {
    while (j < m && bars[j][4] <= i) j++;
    if (j - 1 >= 0) out[i] = adx[j - 1];
  }
  return out;
}

module.exports = {
  instId: "NEIRO-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const n = c5.length, haO = new Array(n), haC = new Array(n), col = new Array(n);
    haO[0] = (c5[0][1] + c5[0][4]) / 2;
    haC[0] = (c5[0][1] + c5[0][2] + c5[0][3] + c5[0][4]) / 4;
    col[0] = haC[0] >= haO[0] ? 1 : -1;
    for (let i = 1; i < n; i++) {
      haC[i] = (c5[i][1] + c5[i][2] + c5[i][3] + c5[i][4]) / 4;
      haO[i] = (haO[i - 1] + haC[i - 1]) / 2;
      col[i] = haC[i] >= haO[i] ? 1 : -1;
    }
    const adx = adx15mAt5m(c5, 14);
    const out = [];
    let run = 1;
    for (let i = 1; i < n; i++) {
      if (col[i] === col[i - 1]) { run++; continue; }
      if (i >= WARM && run >= M && adx[i] < ADX_MAX) out.push({ i5: i, dir: col[i] });
      run = 1;
    }
    return out;
  }
};
