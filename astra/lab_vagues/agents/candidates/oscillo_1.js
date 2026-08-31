// CCI(20) sur 15m : fade du RETOUR depuis une zone extrême (±150) — on entre quand l'excès s'épuise (croisement de sortie de zone).
module.exports = {
  instId: "ALLO-USDT-SWAP",
  exits: { tp: 1.00, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    // agrégation 15m (par horloge), signal à l'index 5m de la DERNIÈRE bougie du bloc 15m clos
    const bars = [], i5last = [];
    let cur = null, key = null, curI = -1;
    for (let i = 0; i < c5.length; i++) {
      const k = Math.floor(c5[i][0] / 900000);
      if (k !== key) {
        if (cur) { bars.push(cur); i5last.push(curI); }
        key = k; cur = [c5[i][0], c5[i][1], c5[i][2], c5[i][3], c5[i][4], c5[i][5]]; curI = i;
      } else {
        cur[2] = Math.max(cur[2], c5[i][2]); cur[3] = Math.min(cur[3], c5[i][3]);
        cur[4] = c5[i][4]; cur[5] += c5[i][5]; curI = i;
      }
    }
    if (cur) { bars.push(cur); i5last.push(curI); }
    // CCI(20) classique sur les bougies 15m
    const p = 20, tp = bars.map(x => (x[2] + x[3] + x[4]) / 3);
    const cci = new Array(bars.length).fill(null);
    for (let j = p - 1; j < bars.length; j++) {
      let s = 0;
      for (let k = j - p + 1; k <= j; k++) s += tp[k];
      const m = s / p;
      let md = 0;
      for (let k = j - p + 1; k <= j; k++) md += Math.abs(tp[k] - m);
      md /= p;
      cci[j] = md === 0 ? 0 : (tp[j] - m) / (0.015 * md);
    }
    const out = [];
    for (let j = 60; j < bars.length; j++) {
      if (cci[j] === null || cci[j - 1] === null) continue;
      if (cci[j - 1] < -150 && cci[j] >= -150) out.push({ i5: i5last[j], dir: 1 });
      else if (cci[j - 1] > 150 && cci[j] <= 150) out.push({ i5: i5last[j], dir: -1 });
    }
    return out;
  }
};
