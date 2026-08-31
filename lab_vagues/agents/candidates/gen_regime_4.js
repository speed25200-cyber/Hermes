// GÉNÉRALISATION DU FILTRE DE RÉGIME : RSI14-5m étiré (<30 / >70) fadé UNIQUEMENT dans la moitié
// favorable du range 24h — même architecture que le champion ENSO multiech_2 (RSI + régime),
// seuil élargi 30/70 car SOON atteint rarement 25/75.
// Preuve que le filtre ajoute : SOON nu (mêmes exits) worst = +1,43 -> filtré worst = +3,67 (OOS +13,32, pf 2,40).
module.exports = {
  instId: "SOON-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const closes = c5.map(x => x[4]);
    // RSI14 Wilder (aucun futur)
    const p = 14, r = new Array(closes.length).fill(null);
    let g = 0, pr = 0;
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (i <= p) { if (d > 0) g += d; else pr -= d; if (i === p) r[i] = 100 - 100 / (1 + (g / p) / ((pr / p) || 1e-12)); continue; }
      g = (g * (p - 1) + Math.max(d, 0)) / p;
      pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
      r[i] = 100 - 100 / (1 + g / (pr || 1e-12));
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
      if (r[i] == null || pos[i] == null) continue;
      if (r[i] < 30 && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
      else if (r[i] > 70 && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
