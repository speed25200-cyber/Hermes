// MMT : fade du z-score (close vs SMA48 sur 5m, |z| >= 2), uniquement la nuit calme
// 0h-6h UTC : les extrêmes atteints sur carnet mince reviennent à la moyenne.
// Comparaison 24h/24 (mêmes exits) : worst -2,78 → la fenêtre nuit donne +6,47.
module.exports = {
  instId: "MMT-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const out = [];
    const P = 48;
    const closes = c5.map(x => x[4]);
    let sum = 0, sum2 = 0;
    for (let i = 0; i < c5.length; i++) {
      const c = closes[i];
      sum += c; sum2 += c * c;
      if (i >= P) { const o = closes[i - P]; sum -= o; sum2 -= o * o; }
      if (i < 100) continue;
      const mean = sum / P, v = Math.max(sum2 / P - mean * mean, 0), sd = Math.sqrt(v);
      if (!(sd > 0)) continue;
      const z = (c - mean) / sd;
      const dir = z <= -2 ? 1 : z >= 2 ? -1 : 0;
      if (!dir) continue;
      const h = new Date(c5[i][0]).getUTCHours();
      if (h >= 0 && h < 6) out.push({ i5: i, dir });
    }
    return out;
  }
};
