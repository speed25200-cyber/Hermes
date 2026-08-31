// SYRUP (Maple Finance) : COMBO 2 ingrédients validés ailleurs = double-extrême
// (retest d'un creux/sommet W96 ±0,6 % après rebond intermédiaire, ingrédient du champion
// PIEVERSE web_structure_1, ICI SANS la bougie de reprise embarquée) x volume > 2x
// (confirmation, ingrédient de la famille mèche+vol gen_regime) — jamais croisés avant.
// Le 2e creux/sommet qui tient est confirmé par un pic de volume (>= 2x SMA20) plutôt que
// par la forme de la bougie -> le volume signe l'épuisement du côté qui a tenté le retest.
// Robustesse : seule ligne valide:true du concept sur ce scan mais n=60 pile (37 IS + 23 OOS),
// pfOOS 1,57 ; crypto libre (Maple Finance, gouvernance DeFi, aucun champion au registre).
const W = 96, GAP = 12, TOL = 0.006, BOUNCE = 0.01;

module.exports = {
  instId: "SYRUP-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const out = [];
    const vs = new Array(c5.length).fill(null);
    let s = 0;
    for (let i = 0; i < c5.length; i++) {
      s += c5[i][5];
      if (i >= 20) s -= c5[i - 20][5];
      if (i >= 19) vs[i] = s / 20;
    }
    for (let i = Math.max(100, W); i < c5.length; i++) {
      let mn = Infinity, mx = -Infinity, iMn = -1, iMx = -1;
      for (let k = i - W; k <= i - GAP; k++) {
        if (c5[k][3] < mn) { mn = c5[k][3]; iMn = k; }
        if (c5[k][2] > mx) { mx = c5[k][2]; iMx = k; }
      }
      const h = c5[i][2], l = c5[i][3];
      const volOk = vs[i] != null && vs[i] > 0 && c5[i][5] >= 2 * vs[i];
      if (!volOk) continue;
      if (l >= mn * (1 - TOL) && l <= mn * (1 + TOL)) {
        let rb = -Infinity;
        for (let k = iMn + 1; k < i; k++) if (c5[k][4] > rb) rb = c5[k][4];
        if (rb >= mn * (1 + BOUNCE)) out.push({ i5: i, dir: 1 });
      }
      if (h <= mx * (1 + TOL) && h >= mx * (1 - TOL)) {
        let rb = Infinity;
        for (let k = iMx + 1; k < i; k++) if (c5[k][4] < rb) rb = c5[k][4];
        if (rb <= mx * (1 - BOUNCE)) out.push({ i5: i, dir: -1 });
      }
    }
    return out;
  }
};
