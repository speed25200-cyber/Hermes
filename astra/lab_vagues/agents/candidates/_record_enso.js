// Reproduction du record ENSO (contrôle du banc d'essai) : RSI14 sur 5m, <25 long / >75 short.
module.exports = {
  instId: "ENSO-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const closes = c5.map(x => x[4]);
    const p = 14, out = [];
    let g = 0, pr = 0;
    const r = new Array(closes.length).fill(null);
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (i <= p) { if (d > 0) g += d; else pr -= d; if (i === p) r[i] = 100 - 100 / (1 + (g / p) / ((pr / p) || 1e-12)); continue; }
      g = (g * (p - 1) + Math.max(d, 0)) / p;
      pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
      r[i] = 100 - 100 / (1 + g / (pr || 1e-12));
    }
    for (let i = p + 1; i < closes.length; i++) {
      if (r[i] < 25) out.push({ i5: i, dir: 1 });
      else if (r[i] > 75) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
