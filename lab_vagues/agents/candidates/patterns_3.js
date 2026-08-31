// Double mèche 5m consécutive au même niveau (deux rejets successifs du même prix) : on joue le rebond depuis le niveau défendu.
module.exports = {
  instId: "HUMA-USDT-SWAP",
  exits: { tp: 1.00, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const P = 20, WICK = 1.5, TOL = 0.25, n = c5.length;
    const tr = new Array(n).fill(0), atr = new Array(n).fill(null);
    for (let i = 1; i < n; i++) tr[i] = Math.max(c5[i][2] - c5[i][3], Math.abs(c5[i][2] - c5[i - 1][4]), Math.abs(c5[i][3] - c5[i - 1][4]));
    let s = 0;
    for (let i = 1; i < n; i++) { s += tr[i]; if (i > P) s -= tr[i - P]; if (i >= P) atr[i] = s / P; }
    const lw = j => Math.min(c5[j][1], c5[j][4]) - c5[j][3];
    const uw = j => c5[j][2] - Math.max(c5[j][1], c5[j][4]);
    const bd = j => Math.abs(c5[j][4] - c5[j][1]);
    const out = [];
    for (let i = 22; i < n; i++) {
      if (atr[i] == null || atr[i] === 0) continue;
      if (lw(i) >= WICK * bd(i) && lw(i - 1) >= WICK * bd(i - 1) && lw(i) > 0 && lw(i - 1) > 0 &&
          Math.abs(c5[i][3] - c5[i - 1][3]) <= TOL * atr[i]) out.push({ i5: i, dir: 1 });
      else if (uw(i) >= WICK * bd(i) && uw(i - 1) >= WICK * bd(i - 1) && uw(i) > 0 && uw(i - 1) > 0 &&
          Math.abs(c5[i][2] - c5[i - 1][2]) <= TOL * atr[i]) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
