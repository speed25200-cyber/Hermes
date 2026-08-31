// CCI(20) sur 5m en zone extrême (±150) : fade immédiat de l'excès court terme.
module.exports = {
  instId: "AVNT-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const p = 20, n = c5.length;
    const tp = c5.map(x => (x[2] + x[3] + x[4]) / 3);
    const out = [];
    for (let i = 60; i < n; i++) {
      let s = 0;
      for (let k = i - p + 1; k <= i; k++) s += tp[k];
      const m = s / p;
      let md = 0;
      for (let k = i - p + 1; k <= i; k++) md += Math.abs(tp[k] - m);
      md /= p;
      const cci = md === 0 ? 0 : (tp[i] - m) / (0.015 * md);
      if (cci < -150) out.push({ i5: i, dir: 1 });
      else if (cci > 150) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
