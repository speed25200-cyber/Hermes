// MERL : squeeze de largeur Bollinger (plus étroite des 4 h) puis cassure de bande → contre-pied.
// Doc web (John Bolliger / VolatilityBox) : BandWidth au plus bas = compression ; sur ce dataset
// mean-reversion > momentum, donc la 1re cassure de bande après le squeeze est fadée.
const { BollingerBands } = require("technicalindicators");
module.exports = {
  instId: "MERL-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length, P = 20, LOOK = 48, out = [];
    const closes = c5.map(x => x[4]);
    const bb = BollingerBands.calculate({ period: P, stdDev: 2, values: closes });
    const up = new Array(n).fill(null), lo = new Array(n).fill(null), bw = new Array(n).fill(null);
    for (let i = P - 1; i < n; i++) {
      const b = bb[i - (P - 1)];
      up[i] = b.upper; lo[i] = b.lower;
      bw[i] = b.middle > 0 ? (b.upper - b.lower) / b.middle : null;
    }
    for (let i = LOOK + 30; i < n; i++) {
      // squeeze : bw au plus bas des 48 dernières bougies, constaté dans les 6 dernières
      let sq = false;
      for (let j = i - 6; j < i && !sq; j++) {
        if (bw[j] == null) continue;
        sq = true;
        for (let k = j - LOOK; k < j; k++) if (bw[k] != null && bw[k] <= bw[j]) { sq = false; break; }
      }
      if (!sq) continue;
      let d = 0;
      if (closes[i] > up[i]) d = 1; else if (closes[i] < lo[i]) d = -1;
      if (d !== 0) out.push({ i5: i, dir: -d }); // fade de la cassure
    }
    return out;
  }
};
