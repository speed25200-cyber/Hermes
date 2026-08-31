// Climax de volume : bougie 5m dont le volume dépasse 4x la médiane des 24 dernières heures -> on fade la direction de la bougie.
module.exports = {
  instId: "YGG-USDT-SWAP",
  exits: { tp: 1.00, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const W = 288, K = 4, out = [];
    for (let i = 300; i < c5.length; i++) {
      const win = c5.slice(i - W, i).map(x => x[5]).sort((a, b) => a - b);
      const med = (win[W / 2 - 1] + win[W / 2]) / 2;
      if (med <= 0) continue;
      const v = c5[i][5], o = c5[i][1], cl = c5[i][4];
      if (v > K * med && cl !== o) out.push({ i5: i, dir: cl > o ? -1 : 1 });
    }
    return out;
  }
};
