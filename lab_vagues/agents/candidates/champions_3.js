// Champion SOON (zScore-SMA48-5m |z|>2.5 -> fade, tp0.8 act0.2 12h, worst nu 6.68) + UN ingrédient : distance minimale de 1 % à la SMA48 (on ne fade que les prix vraiment étirés). Dist 2 % encore meilleur (worst 8.10) mais nOOS=14 -> invalide.
module.exports = {
  instId: "SOON-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.20, cb: 0.05, holdH: 12 },
  detect(c5) {
    const closes = c5.map(x => x[4]);
    const P = 48;
    const sma = new Array(closes.length).fill(null), std = new Array(closes.length).fill(null);
    let s = 0, s2 = 0;
    for (let i = 0; i < closes.length; i++) {
      s += closes[i]; s2 += closes[i] * closes[i];
      if (i >= P) { const x = closes[i - P]; s -= x; s2 -= x * x; }
      if (i >= P - 1) { const m = s / P; sma[i] = m; std[i] = Math.sqrt(Math.max(0, s2 / P - m * m)); }
    }
    const out = [];
    for (let i = P; i < closes.length; i++) {
      if (sma[i] == null || !std[i]) continue;
      const z = (closes[i] - sma[i]) / std[i];
      const dist = Math.abs(closes[i] / sma[i] - 1);
      if (dist < 0.01) continue;
      if (z > 2.5) out.push({ i5: i, dir: -1 });
      else if (z < -2.5) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
