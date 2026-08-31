// TRIA : double bottom / double top intraday — recette exacte du champion PIEVERSE
// (extrême des 12 h W144, retest ±0,3 % qui tient après rebond >= 1 %, bougie de reprise).
// Généralisation famille gagnante (scan 196 cryptos × W96/144 × tol 0,3/0,6 % × rb 1/2 % × 2 exits fondateurs).
// Bat le champion TRIA en place (multiech_4, worst 5,35) de peu — meilleur non-PIEVERSE du scan.
const W = 144, GAP = 12, TOL = 0.003, BOUNCE = 0.01;

module.exports = {
  instId: "TRIA-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const out = [];
    for (let i = Math.max(100, W); i < c5.length; i++) {
      let mn = Infinity, mx = -Infinity, iMn = -1, iMx = -1;
      for (let k = i - W; k <= i - GAP; k++) {
        if (c5[k][3] < mn) { mn = c5[k][3]; iMn = k; }
        if (c5[k][2] > mx) { mx = c5[k][2]; iMx = k; }
      }
      const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4];
      if (l >= mn * (1 - TOL) && l <= mn * (1 + TOL) && c > o) {
        let rb = -Infinity;
        for (let k = iMn + 1; k < i; k++) if (c5[k][4] > rb) rb = c5[k][4];
        if (rb >= mn * (1 + BOUNCE)) out.push({ i5: i, dir: 1 });
      }
      if (h <= mx * (1 + TOL) && h >= mx * (1 - TOL) && c < o) {
        let rb = Infinity;
        for (let k = iMx + 1; k < i; k++) if (c5[k][4] < rb) rb = c5[k][4];
        if (rb <= mx * (1 - BOUNCE)) out.push({ i5: i, dir: -1 });
      }
    }
    return out;
  }
};
