// Williams %R(14) sur 5m au plancher/plafond absolu (<5 / >95 en échelle 0-100) : fade de l'extrême pur.
module.exports = {
  instId: "GPS-USDT-SWAP",
  exits: { tp: 1.00, sl: 0.30, act: 0.30, cb: 0.05, holdH: 8 },
  detect(c5) {
    const p = 14, n = c5.length, out = [];
    for (let i = 60; i < n; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let k = i - p + 1; k <= i; k++) {
        if (c5[k][2] > hh) hh = c5[k][2];
        if (c5[k][3] < ll) ll = c5[k][3];
      }
      if (hh === ll) continue;
      const wr = 100 * (c5[i][4] - ll) / (hh - ll); // 0 = plancher, 100 = plafond
      if (wr < 5) out.push({ i5: i, dir: 1 });
      else if (wr > 95) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
