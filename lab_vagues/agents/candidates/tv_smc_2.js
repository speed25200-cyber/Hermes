// ENA : sweep d'un POOL DE LIQUIDITÉ « equal lows/highs » (SMC TradingView).
// Le plus bas des 12 h précédentes (hors 2 dernières heures) doit avoir été touché au
// moins 2 fois (creux égaux à 0,3 % près = pool de stops évident) ; la bougie balaie
// SOUS le pool en mèche puis referme au-dessus -> stops pris, snap-back long.
// Symétrique sur les plus hauts égaux -> short. Extension du filon PIEVERSE/FARTCOIN :
// on n'exige plus un double creux propre, mais un pool touché 2x puis BALAYÉ.
// Voisinage robuste : t2/t2.5/t3 x G24/30/36 x W144 tous positifs (worst 4,5 a 9,2).
const W = 144, GAP = 24, TOL = 0.003;

module.exports = {
  instId: "ENA-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const out = [];
    for (let i = Math.max(100, W); i < c5.length; i++) {
      let mn = Infinity, mx = -Infinity;
      for (let k = i - W; k <= i - GAP; k++) {
        if (c5[k][3] < mn) mn = c5[k][3];
        if (c5[k][2] > mx) mx = c5[k][2];
      }
      const h = c5[i][2], l = c5[i][3], c = c5[i][4];
      if (l < mn && c > mn) {                       // balayage sous le pool + reclaim
        let t = 0;
        for (let k = i - W; k <= i - GAP; k++) if (c5[k][3] <= mn * (1 + TOL)) t++;
        if (t >= 2) out.push({ i5: i, dir: 1 });    // pool « evident » : >= 2 touches
      } else if (h > mx && c < mx) {
        let t = 0;
        for (let k = i - W; k <= i - GAP; k++) if (c5[k][2] >= mx * (1 - TOL)) t++;
        if (t >= 2) out.push({ i5: i, dir: -1 });
      }
    }
    return out;
  }
};
