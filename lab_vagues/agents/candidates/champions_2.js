// Champion GRASS (zScore-SMA48-5m |z|>2.5 -> fade, tp0.6 act0.3 12h, worst nu 7.39) + UN ingrédient : trail respirant (callback 20 % au lieu de 5 %). Courbe cb 0.05/0.15/0.20/0.25 -> worst 7.39/8.40/9.09/6.80.
module.exports = {
  instId: "GRASS-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.30, cb: 0.20, holdH: 12 },
  detect(c5) {
    const closes = c5.map(x => x[4]);
    const P = 48;
    const out = [];
    let s = 0, s2 = 0;
    const sma = new Array(closes.length).fill(null), std = new Array(closes.length).fill(null);
    for (let i = 0; i < closes.length; i++) {
      s += closes[i]; s2 += closes[i] * closes[i];
      if (i >= P) { const x = closes[i - P]; s -= x; s2 -= x * x; }
      if (i >= P - 1) { const m = s / P; sma[i] = m; std[i] = Math.sqrt(Math.max(0, s2 / P - m * m)); }
    }
    for (let i = P; i < closes.length; i++) {
      if (sma[i] == null || !std[i]) continue;
      const z = (closes[i] - sma[i]) / std[i];
      if (z > 2.5) out.push({ i5: i, dir: -1 });
      else if (z < -2.5) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
