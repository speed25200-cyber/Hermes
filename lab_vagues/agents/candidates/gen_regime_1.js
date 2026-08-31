// GÉNÉRALISATION DU FILTRE DE RÉGIME (famille multiech gagnante) : mèche d'épuisement 5m
// (mèche >= 60 % du range + volume >= 1,5x SMA20) fadée UNIQUEMENT si le prix est dans la moitié
// favorable de son range 24h (long en moitié basse, short en moitié haute).
// Preuve que le filtre ajoute : NES nu (mêmes exits) worst = +0,72 -> filtré worst = +6,61.
module.exports = {
  instId: "NES-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    // SMA20 du volume (aucun futur)
    const vs = new Array(c5.length).fill(null);
    let s = 0;
    for (let i = 0; i < c5.length; i++) {
      s += c5[i][5];
      if (i >= 20) s -= c5[i - 20][5];
      if (i >= 19) vs[i] = s / 20;
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
      const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4], range = h - l;
      if (!(range > 0) || vs[i] == null || !(vs[i] > 0) || pos[i] == null) continue;
      const wLo = (Math.min(o, c) - l) / range, wHi = (h - Math.max(o, c)) / range, vm = c5[i][5] / vs[i];
      if (wLo >= 0.6 && vm >= 1.5 && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
      else if (wHi >= 0.6 && vm >= 1.5 && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
