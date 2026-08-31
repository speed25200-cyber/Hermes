// Rejet sur climax : après un move d'au moins 1% en 30 min, bougie à volume >4x la médiane 24h qui clôture à CONTRE-sens du move -> on suit ce rejet.
module.exports = {
  instId: "RLS-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const W = 288, K = 4, LOOK = 6, MOVE = 0.01, out = [];
    for (let i = 300; i < c5.length; i++) {
      const win = c5.slice(i - W, i).map(x => x[5]).sort((a, b) => a - b);
      const med = (win[W / 2 - 1] + win[W / 2]) / 2;
      if (med <= 0 || c5[i][5] <= K * med) continue;
      const o = c5[i][1], cl = c5[i][4];
      const mv = c5[i][4] / c5[i - LOOK][4] - 1;
      if (mv > MOVE && cl < o) out.push({ i5: i, dir: -1 });
      else if (mv < -MOVE && cl > o) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
