// TAO : retournement Heikin-Ashi pur — haClose=(o+h+l+c)/4, haOpen=(haOpen1+haClose1)/2
// (formule TV exacte, sur bougies closes = 0 repaint). Après une série d'au moins
// 4 bougies HA de même couleur, la 1re bougie HA de couleur opposée = épuisement de
// la jambe → entrée dans le sens de la nouvelle couleur (mean-reversion, TAO étant
// une grosse cap qui respire en ranges intraday).
// Robustesse (banc 30 j) : M4 E3 6.51 / E2 6.03 ; M6 E3 4.39 / E2 3.87 / E1 2.80 —
// tout le cœur M×exit est positif, pas un point isolé.
const M = 4, WARM = 300;

module.exports = {
  instId: "TAO-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const n = c5.length, haO = new Array(n), haC = new Array(n), col = new Array(n);
    haO[0] = (c5[0][1] + c5[0][4]) / 2;
    haC[0] = (c5[0][1] + c5[0][2] + c5[0][3] + c5[0][4]) / 4;
    col[0] = haC[0] >= haO[0] ? 1 : -1;
    for (let i = 1; i < n; i++) {
      haC[i] = (c5[i][1] + c5[i][2] + c5[i][3] + c5[i][4]) / 4;
      haO[i] = (haO[i - 1] + haC[i - 1]) / 2;
      col[i] = haC[i] >= haO[i] ? 1 : -1;
    }
    const out = [];
    let run = 1;
    for (let i = 1; i < n; i++) {
      if (col[i] === col[i - 1]) { run++; continue; }
      if (i >= WARM && run >= M) out.push({ i5: i, dir: col[i] });
      run = 1;
    }
    return out;
  }
};
