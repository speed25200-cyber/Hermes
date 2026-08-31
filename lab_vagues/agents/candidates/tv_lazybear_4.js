// RLS (Rayls) : Coral Trend [LazyBear] stretch-fade serré — prix à ±1 % de la ligne Coral
// (sm=21 comme l'original, cd=0.7 lissage fort) → retour à la ligne. Échantillon massif
// (n 88 IS + 94 OOS). Même formule Pine exacte que tv_lazybear_1 (qyUwc2Al).
// Robustesse RLS : s14x10 E1 7.39/E4 7.80, cf1 7.34, s10x15 E2 8.04, s21cd0.7 E4 8.50.
const SM = 21, CD = 0.7, X = 0.01, WARM = 300;

module.exports = {
  instId: "RLS-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const src = c5.map(x => x[4]);
    const di = (SM - 1) / 2 + 1, c1 = 2 / (di + 1), c2 = 1 - c1;
    const c3 = 3 * (CD * CD + CD * CD * CD), c4 = -3 * (2 * CD * CD + CD + CD * CD * CD), c5c = 3 * CD + 1 + CD * CD * CD + 3 * CD * CD;
    let i1 = src[0], i2 = src[0], i3 = src[0], i4 = src[0], i5 = src[0], i6 = src[0];
    const bfr = new Array(src.length);
    for (let i = 0; i < src.length; i++) {
      i1 = c1 * src[i] + c2 * i1; i2 = c1 * i1 + c2 * i2; i3 = c1 * i2 + c2 * i3;
      i4 = c1 * i3 + c2 * i4; i5 = c1 * i4 + c2 * i5; i6 = c1 * i5 + c2 * i6;
      bfr[i] = -CD * CD * CD * i6 + c3 * i5 + c4 * i4 + c5c * i3;
    }
    const out = [];
    for (let i = WARM; i < c5.length; i++) {
      const dist = (src[i] - bfr[i]) / bfr[i];
      if (dist <= -X) out.push({ i5: i, dir: 1 });
      if (dist >= X) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
