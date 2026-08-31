// MON : Swing Failure Pattern (SFP) sur pivots fractals — l'indicateur « sweep de swing »
// classique de TradingView, version non-repainting stricte : un pivot bas est le plus bas
// strict de 12 barres de chaque côté et n'existe qu'une fois CONFIRMÉ (12 barres après).
// Sweep : une bougie mèche SOUS ce pivot confirmé (stops des swing-traders pris) et
// referme AU-DESSUS -> long ; chaque pivot n'est joué qu'une fois, périmé après 24 h.
// Symétrique sur pivot haut -> short. Diffère du sweep d'extrême absolu : en tendance,
// on balaie le dernier higher-low/lower-high, pas le minimum de la fenêtre.
// Voisinage robuste : n9/n12/n18 x A144/288/432 tous positifs (worst 2,5 a 8,0).
const N = 12, AGE = 288;

module.exports = {
  instId: "MON-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const out = [];
    const lows = [], highs = []; // pivots confirmés {lvl, j}
    for (let i = 0; i < c5.length; i++) {
      const j = i - N;                    // pivot candidat confirmé à la bougie i
      if (j >= N) {
        let isLo = true, isHi = true;
        for (let k = j - N; k <= j + N; k++) {
          if (k === j) continue;
          if (c5[k][3] <= c5[j][3]) isLo = false;
          if (c5[k][2] >= c5[j][2]) isHi = false;
          if (!isLo && !isHi) break;
        }
        if (isLo) lows.push({ lvl: c5[j][3], j });
        if (isHi) highs.push({ lvl: c5[j][2], j });
      }
      if (i < 100) continue;
      const h = c5[i][2], l = c5[i][3], c = c5[i][4];
      for (let z = lows.length - 1; z >= 0; z--) {
        const p = lows[z];
        if (i - p.j > AGE) { lows.splice(z, 1); continue; }
        if (l < p.lvl) {                  // pivot percé en mèche...
          if (c > p.lvl) out.push({ i5: i, dir: 1 }); // ...et reclaim -> SFP long
          lows.splice(z, 1);              // percé ou balayé : niveau consommé
        }
      }
      for (let z = highs.length - 1; z >= 0; z--) {
        const p = highs[z];
        if (i - p.j > AGE) { highs.splice(z, 1); continue; }
        if (h > p.lvl) {
          if (c < p.lvl) out.push({ i5: i, dir: -1 });
          highs.splice(z, 1);
        }
      }
    }
    return out;
  }
};
