// PIEVERSE : double bottom / double top intraday (structure de marché documentée :
// deux creux au même niveau ±0,3 % séparés d'un rebond >= 1 %, le 2e creux qui tient
// + bougie de reprise = échec du retest -> long ; symétrique en double top -> short).
// 1er extrême = min/max des 12 h précédentes (fenêtre 144 barres 5 m, écart mini 1 h).
// Robustesse : les 8 cases de la grille (tol 0.3/0.6 % × rebond 1/2 % × 2 exits) sont
// toutes valides, worst de 5,08 à 12,58 — pas un point isolé.
const W = 144, GAP = 12, TOL = 0.003, BOUNCE = 0.01;

module.exports = {
  instId: "PIEVERSE-USDT-SWAP",
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
      if (l >= mn * (1 - TOL) && l <= mn * (1 + TOL) && c > o) { // 2e creux qui tient
        let rb = -Infinity;
        for (let k = iMn + 1; k < i; k++) if (c5[k][4] > rb) rb = c5[k][4];
        if (rb >= mn * (1 + BOUNCE)) out.push({ i5: i, dir: 1 });
      }
      if (h <= mx * (1 + TOL) && h >= mx * (1 - TOL) && c < o) { // 2e sommet qui tient
        let rb = Infinity;
        for (let k = iMx + 1; k < i; k++) if (c5[k][4] < rb) rb = c5[k][4];
        if (rb <= mx * (1 - BOUNCE)) out.push({ i5: i, dir: -1 });
      }
    }
    return out;
  }
};
