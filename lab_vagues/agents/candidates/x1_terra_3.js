// TERRITOIRE VIERGE. BABY : double creux / double sommet intraday (structure de marche,
// meme recette que le champion PIEVERSE web_structure_1 -- extreme des 12h precedentes
// [W144, GAP12], 2e extreme qui tient a tol pres + rebond intermediaire >= BOUNCE + bougie
// de reprise). Ici tol=0,6% et rebond=2% (le cran "large" de la grille fondatrice).
// Robustesse : la meme famille est positive des deux cotes sur 3 cases (tol0,6/bnc0,02/E1
// +6,36 · tol0,6/bnc0,02/E3 +6,23 · tol0,6/bnc0,01/E3 +4,23, OOS jusqu'a +10,62) -- plateau
// coherent, pas un pic isole.
const W = 144, GAP = 12, TOL = 0.006, BOUNCE = 0.02;

module.exports = {
  instId: "BABY-USDT-SWAP",
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
