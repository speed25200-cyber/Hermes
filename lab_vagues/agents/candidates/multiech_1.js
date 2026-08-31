// MULTI-ÉCHELLE : excès z-score 5m (±2,5σ vs SMA48) fadé UNIQUEMENT quand le prix est aussi dans la
// moitié favorable de son range 24h (long en moitié basse, short en moitié haute) — l'excès a de la place pour revenir.
// Preuve que le filtre ajoute : GRASS nu (mêmes exits) worst=+3,19 % -> filtré worst=+9,09 %.
module.exports = {
  instId: "GRASS-USDT-SWAP",
  exits: { tp: 1.00, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const closes = c5.map(x => x[4]);
    // z-score rolling vs SMA48 (aucun futur)
    const P = 48, z = new Array(closes.length).fill(null);
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
      if (z[i] < -2.5 && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
      else if (z[i] > 2.5 && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
