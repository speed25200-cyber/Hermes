// MINA : squeeze TTM (BB20,2 DANS Keltner 20,1.5·ATR — John Carter) récent + reclaim de bande → fade.
// Doc web : pendant/juste après la compression le marché est en range ; une excursion hors
// Bollinger qui referme dedans (reclaim) se fade — jamais pendant l'excursion.
const { BollingerBands } = require("technicalindicators");
module.exports = {
  instId: "MINA-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length, P = 20, LB = 24, out = [];
    const closes = c5.map(x => x[4]);
    const bb = BollingerBands.calculate({ period: P, stdDev: 2, values: closes });
    const up = new Array(n).fill(null), lo = new Array(n).fill(null);
    for (let i = P - 1; i < n; i++) { const b = bb[i - (P - 1)]; up[i] = b.upper; lo[i] = b.lower; }
    // Keltner : EMA20 ± 1.5·ATR20 (Wilder) → drapeau squeeze ON
    const on = new Array(n).fill(false), kEma = 2 / (P + 1);
    let e = null, a = null;
    for (let i = 0; i < n; i++) {
      e = e == null ? closes[i] : closes[i] * kEma + e * (1 - kEma);
      const tr = i === 0 ? c5[i][2] - c5[i][3]
        : Math.max(c5[i][2] - c5[i][3], Math.abs(c5[i][2] - closes[i - 1]), Math.abs(c5[i][3] - closes[i - 1]));
      a = a == null ? tr : (a * (P - 1) + tr) / P;
      if (up[i] != null) on[i] = up[i] < e + 1.5 * a && lo[i] > e - 1.5 * a;
    }
    for (let i = 102; i < n; i++) {
      if (up[i] == null || up[i - 1] == null) continue;
      let sq = false;
      for (let j = i - LB; j < i; j++) if (on[j]) { sq = true; break; }
      if (!sq) continue; // squeeze ON dans les 2 dernières heures
      const pOut = closes[i - 1] > up[i - 1] ? 1 : closes[i - 1] < lo[i - 1] ? -1 : 0;
      if (pOut === 0) continue;
      if (closes[i] <= up[i] && closes[i] >= lo[i]) out.push({ i5: i, dir: -pOut }); // reclaim → fade
    }
    return out;
  }
};
