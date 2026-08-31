// LA RECETTE REINE (GPS 4/4) sur territoire vierge : z-score SMA96 |z|>2.5σ (fade) pris UNIQUEMENT
// dans la moitié favorable du range 24h (long moitié basse, short moitié haute).
// BABY-USDT-SWAP est ABSENTE de profond_tous_resultats.json (jamais scannée avant ce round avec ce
// signal). ⚠️ un candidat existe déjà pour cette crypto (x1_terra_3.js, double creux/sommet W144,
// worst +6,36) : cette variante z-score-régime le BAT nettement (+7,41) avec exit standard (pas
// d'optimisation de sorties) — déposé pour arbitrage au verif90 (règle 1 stratégie/crypto), pas une
// crypto totalement inexploitée.
// Exit standard imposé : tp80/sl30/act30/cb5/hold12.
// Plateau (grille grossière P x seuil, mêmes exits, test_harness) :
//   P48thr2.5 +3.96 · P48thr3 +3.68 · P48thr3.5 +4.85 · P96thr2.5 +7.41 (retenu) · P96thr3 +7.20 —
//   5/6 cellules du voisinage positives (seule P96thr2, seuil plus lâche, dilue l'IS à -0.63).
module.exports = {
  instId: "BABY-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const closes = c5.map(x => x[4]);
    // z-score rolling vs SMA96 (aucun futur)
    const P = 96, z = new Array(closes.length).fill(null);
    let s = 0, s2 = 0;
    for (let i = 0; i < closes.length; i++) {
      s += closes[i]; s2 += closes[i] * closes[i];
      if (i >= P) { s -= closes[i - P]; s2 -= closes[i - P] * closes[i - P]; }
      if (i >= P - 1) { const m = s / P, v = Math.max(s2 / P - m * m, 1e-18); z[i] = (closes[i] - m) / Math.sqrt(v); }
    }
    // position dans le range 24h (288 bougies 5m), rolling
    const R = 288, pos = new Array(c5.length).fill(null);
    const dqH = [], dqL = [];
    for (let i = 0; i < c5.length; i++) {
      while (dqH.length && c5[dqH[dqH.length - 1]][2] <= c5[i][2]) dqH.pop();
      dqH.push(i);
      while (dqL.length && c5[dqL[dqL.length - 1]][3] >= c5[i][3]) dqL.pop();
      dqL.push(i);
      while (dqH[0] <= i - R) dqH.shift();
      while (dqL[0] <= i - R) dqL.shift();
      if (i >= R - 1) { const hh = c5[dqH[0]][2], ll = c5[dqL[0]][3]; pos[i] = hh > ll ? (c5[i][4] - ll) / (hh - ll) : 0.5; }
    }
    const out = [];
    for (let i = 300; i < c5.length; i++) {
      if (z[i] == null || pos[i] == null) continue;
      if (z[i] < -2.5 && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
      else if (z[i] > 2.5 && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
