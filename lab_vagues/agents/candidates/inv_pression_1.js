// PMA — PRESSION DES MÈCHES par absorption (invention) — FARTCOIN, lecture « relâchement »
// L'indice : somme glissante SIGNÉE des mèches sur 6 bougies — s = (mècheHaute − mècheBasse)/ATRref
// pondéré par le volume relatif (cap 4×) ; mèche haute = les vendeurs absorbent chaque poussée,
// mèche basse = les acheteurs. z-score de l'indice vs ses 288 valeurs précédentes (courante exclue).
// Lecture (2 phrases) : quand le prix est encore étiré dans l'extrême du range 24 h (pos >= 0,7)
// et que le z de pression vient de REPASSER sous le seuil ±1 après un pic, l'absorption est finie :
// le camp qui absorbait a gagné → on fade l'extrême (short en haut, long en bas). Zéro look-ahead.
const W = 6;         // fenêtre de la somme glissante (30 min)
const T = 1;         // seuil z du pic de pression
const PG = 0.7;      // porte de position dans le range 24 h
const WREF = 96;     // ATR de référence + moyenne volume (bougies PRÉCÉDENTES)
const ZW = 288;      // historique du z-score
const WPOS = 288;    // range 24 h
const WARM = 600;
const VCAP = 4;

function calc(c5) {
  const n = c5.length;
  // position du close dans le range 24 h (deques monotones, causal)
  const pos = new Float64Array(n).fill(NaN);
  const qMin = [], qMax = [];
  for (let i = 0; i < n; i++) {
    while (qMin.length && c5[qMin[qMin.length - 1]][3] >= c5[i][3]) qMin.pop();
    qMin.push(i);
    while (qMax.length && c5[qMax[qMax.length - 1]][2] <= c5[i][2]) qMax.pop();
    qMax.push(i);
    const lo = i - WPOS + 1;
    while (qMin[0] < lo) qMin.shift();
    while (qMax[0] < lo) qMax.shift();
    if (i >= WPOS - 1) {
      const mn = c5[qMin[0]][3], mx = c5[qMax[0]][2];
      if (mx > mn) pos[i] = (c5[i][4] - mn) / (mx - mn);
    }
  }
  // pression signée par bougie
  const s = new Float64Array(n).fill(0);
  let sumR = 0, sumV = 0; const qR = [], qV = [];
  for (let i = 0; i < n; i++) {
    const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4], v = +c5[i][5] || 0;
    const atr = qR.length >= WREF ? sumR / qR.length : NaN;
    const vAvg = qV.length >= WREF ? sumV / qV.length : NaN;
    if (!Number.isNaN(atr) && atr > 0) {
      const wh = h - Math.max(o, c), wb = Math.min(o, c) - l;
      const pv = (!Number.isNaN(vAvg) && vAvg > 0) ? Math.min(v / vAvg, VCAP) : 1;
      s[i] = (wh - wb) / atr * pv;
    }
    qR.push(h - l); sumR += h - l; if (qR.length > WREF) sumR -= qR.shift();
    qV.push(v); sumV += v; if (qV.length > WREF) sumV -= qV.shift();
  }
  // moyenne W puis z vs 288 valeurs précédentes
  const P = new Float64Array(n).fill(NaN), Z = new Float64Array(n).fill(NaN);
  let ps = 0;
  for (let i = 0; i < n; i++) {
    ps += s[i]; if (i >= W) ps -= s[i - W];
    if (i >= W - 1) P[i] = ps / W;
  }
  let m = 0, m2 = 0, cnt = 0; const q = [];
  for (let i = 0; i < n; i++) {
    if (cnt >= ZW) {
      const mu = m / cnt, va = m2 / cnt - mu * mu;
      if (va > 1e-12 && !Number.isNaN(P[i])) Z[i] = (P[i] - mu) / Math.sqrt(va);
    }
    if (!Number.isNaN(P[i])) {
      q.push(P[i]); m += P[i]; m2 += P[i] * P[i]; cnt++;
      if (cnt > ZW) { const old = q.shift(); m -= old; m2 -= old * old; cnt--; }
    }
  }
  return { pos, Z };
}

module.exports = {
  instId: "FARTCOIN-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const { pos, Z } = calc(c5);
    const out = [];
    for (let i = WARM; i < c5.length - 2; i++) {
      const z = Z[i], zp = Z[i - 1], p = pos[i];
      if (Number.isNaN(z) || Number.isNaN(zp) || Number.isNaN(p)) continue;
      if (zp >= T && z < T && p >= PG) out.push({ i5: i, dir: -1 });
      else if (zp <= -T && z > -T && p <= 1 - PG) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
