// LEVIER CONFIRMATION — PIEVERSE (base web_structure_1, EN_LIVE) + confirmation DÉCALÉE :
// le signal brut (double creux/sommet W144, 2e extrême qui tient + clôture de reprise) est
// inchangé, mais l'entrée est reportée d'UNE bougie 5m : on exige que la bougie SUIVANTE
// clôture ELLE AUSSI dans le sens du trade (2e bougie qui confirme la reprise) avant d'entrer.
// Signal nu (test_harness) : wrIS 60,8 / wrOOS 72,0 · espIS 12,58 / espOOS 14,94 (n 51+25).
// Avec confirmation décalée : wrIS 69,2 / wrOOS 68,4 · espIS 17,85 / espOOS 9,62 (n 39+19).
// -> wr >= 65 % DES DEUX côtés (le nu échouait côté IS à 60,8) ; esp > 0 des deux côtés et
// >= 60 % de l'esp nu (17,85>=7,55 ; 9,62>=8,96). Logique en une phrase : un double creux/sommet
// qui tient ET dont la bougie suivante confirme la reprise est un retournement plus fiable
// qu'un simple rebond d'une bougie.
const W = 144, GAP = 12, TOL = 0.003, BOUNCE = 0.01;

module.exports = {
  instId: "PIEVERSE-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const raw = [];
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
        if (rb >= mn * (1 + BOUNCE)) raw.push({ i5: i, dir: 1 });
      }
      if (h <= mx * (1 + TOL) && h >= mx * (1 - TOL) && c < o) {
        let rb = Infinity;
        for (let k = iMx + 1; k < i; k++) if (c5[k][4] < rb) rb = c5[k][4];
        if (rb <= mx * (1 - BOUNCE)) raw.push({ i5: i, dir: -1 });
      }
    }
    // CONFIRMATION DÉCALÉE : la bougie i+1 doit clôturer du côté du trade -> entrée à i+1.
    const out = [];
    for (const s of raw) {
      const j = s.i5 + 1;
      if (j >= c5.length - 2) continue;
      const o = c5[j][1], c = c5[j][4];
      if (s.dir === 1 ? c > o : c < o) out.push({ i5: j, dir: s.dir });
    }
    return out;
  }
};
