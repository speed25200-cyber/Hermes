// GRASS : divergence WaveTrend [LazyBear] — LE trade classique du WT (Market Cipher) :
// le prix fait un plus bas plus bas mais wt1 fait un creux plus haut en zone basse (<= -30)
// → l'élan vendeur s'épuise, long ; symétrique en zone haute. Pivots wt1 fractals ±2 barres,
// signal UNIQUEMENT à la confirmation (2 barres après le pivot) — zéro repaint.
// Formule Pine exacte : ap=hlc3, esa=ema(ap,10), d=ema(|ap-esa|,10), ci=(ap-esa)/(0.015*d),
// wt1=ema(ci,21), wt2=sma(wt1,4).
const N1 = 10, N2 = 21, ZONE = 30, SEPMAX = 60, SEPMIN = 5, WARM = 300;

module.exports = {
  instId: "GRASS-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const n = c5.length;
    const ema = (src, len) => { const o = new Array(src.length); const k = 2 / (len + 1); let e = src[0]; o[0] = e; for (let i = 1; i < src.length; i++) { e = src[i] * k + e * (1 - k); o[i] = e; } return o; };
    const ap = c5.map(x => (x[2] + x[3] + x[4]) / 3);
    const esa = ema(ap, N1);
    const d = ema(ap.map((v, i) => Math.abs(v - esa[i])), N1);
    const wt1 = ema(ap.map((v, i) => d[i] > 1e-12 ? (v - esa[i]) / (0.015 * d[i]) : 0), N2);
    const out = [], lows = [], highs = [];
    for (let i = WARM; i < n; i++) {
      const j = i - 2;
      if (j < 2) continue;
      const v = wt1[j];
      if (v < wt1[j - 1] && v < wt1[j - 2] && v < wt1[j + 1] && v < wt1[j + 2]) { // creux confirmé à i
        const px = Math.min(c5[j - 1][3], c5[j][3], c5[j + 1][3]);
        const prev = lows.length ? lows[lows.length - 1] : null;
        if (prev && v <= -ZONE && j - prev.j <= SEPMAX && j - prev.j >= SEPMIN && px < prev.px && v > prev.wt) out.push({ i5: i, dir: 1 });
        lows.push({ j, wt: v, px });
      }
      if (v > wt1[j - 1] && v > wt1[j - 2] && v > wt1[j + 1] && v > wt1[j + 2]) { // sommet confirmé à i
        const px = Math.max(c5[j - 1][2], c5[j][2], c5[j + 1][2]);
        const prev = highs.length ? highs[highs.length - 1] : null;
        if (prev && v >= ZONE && j - prev.j <= SEPMAX && j - prev.j >= SEPMIN && px > prev.px && v < prev.wt) out.push({ i5: i, dir: -1 });
        highs.push({ j, wt: v, px });
      }
    }
    return out;
  }
};
