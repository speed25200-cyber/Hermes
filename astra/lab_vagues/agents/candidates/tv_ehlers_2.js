// ESP : Fisher Transform (Ehlers, L=9 sur hl2) — « reclaim » de la zone extrême ±2,5
// UNIQUEMENT en régime plat (ADX14 sur 15 m composite < 25, leçon BSB : le filtre
// de régime EST l'edge) → fade du pic d'exubérance quand il n'y a pas de tendance de fond.
// Fisher exact (Ehlers) ; ADX de Wilder sur bougies 15 m recomposées à partir des 5 m,
// on n'utilise à l'index i que la DERNIÈRE bougie 15 m CLÔTURÉE (aucun look-ahead).
// Robustesse (banc 30 j) : E4 11.41 / E1 8.97 / E2 8.88 ; adx20 aussi positif — famille stable.
const L = 9, T = 2.5, ADX_MAX = 25, WARM = 300;

function fisherSeries(c5, len) {
  const n = c5.length, out = new Array(n).fill(NaN);
  const hl = new Array(n);
  for (let i = 0; i < n; i++) hl[i] = (c5[i][2] + c5[i][3]) / 2;
  let v = 0, fish = 0;
  for (let i = len - 1; i < n; i++) {
    let mn = Infinity, mx = -Infinity;
    for (let k = i - len + 1; k <= i; k++) { if (hl[k] < mn) mn = hl[k]; if (hl[k] > mx) mx = hl[k]; }
    const r = mx - mn;
    v = 0.33 * 2 * (r > 0 ? (hl[i] - mn) / r - 0.5 : 0) + 0.67 * v;
    if (v > 0.99) v = 0.999; if (v < -0.99) v = -0.999;
    fish = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * fish;
    out[i] = fish;
  }
  return out;
}

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
  instId: "ESP-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const f = fisherSeries(c5, L);
    const adx = adx15mAt5m(c5, 14);
    const out = [];
    for (let i = WARM; i < c5.length; i++) {
      if (!(adx[i] < ADX_MAX)) continue;
      if (f[i - 1] >= T && f[i] < T) out.push({ i5: i, dir: -1 });
      if (f[i - 1] <= -T && f[i] > -T) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
