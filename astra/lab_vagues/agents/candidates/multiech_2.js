// MULTI-ÉCHELLE : RSI14-5m extrême (<25 / >75) fadé UNIQUEMENT quand le prix est aussi dans la
// moitié favorable de son range 24h (long en moitié basse, short en moitié haute) — même signal que le record ENSO
// mais gardé par le régime 1h. Preuve que le filtre ajoute : nu worst=+7,64 (OOS 7,95) -> filtré worst=+7,88 (OOS 15,99).
module.exports = {
  instId: "ENSO-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
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
      if (r[i] < 25 && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
      else if (r[i] > 75 && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
