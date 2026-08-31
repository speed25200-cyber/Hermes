// LAB : reversion à distance % du VWAP session (ancre jour UTC). Variante documentée pour
// crypto volatile : quand le prix s'écarte de 3 % du VWAP du jour (franchissement du seuil),
// on prend le contre-pied vers le VWAP. Warm-up 3 h de session pour un VWAP crédible.
module.exports = {
  instId: "LAB-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const DAY = 86400000, WARM = 36, PC = 0.03, out = [];
    const vwap = new Array(c5.length).fill(null), bod = new Array(c5.length).fill(0);
    let day = -1, cv = 0, cpv = 0, k = 0;
    for (let i = 0; i < c5.length; i++) {
      const d = Math.floor(c5[i][0] / DAY);
      if (d !== day) { day = d; cv = 0; cpv = 0; k = 0; }
      const tp = (c5[i][2] + c5[i][3] + c5[i][4]) / 3, v = Math.max(c5[i][5], 0);
      cv += v; cpv += tp * v; k++;
      bod[i] = k;
      if (cv > 0) vwap[i] = cpv / cv;
    }
    for (let i = 101; i < c5.length; i++) {
      const w = vwap[i];
      if (w == null || bod[i] < WARM || vwap[i - 1] == null) continue;
      const dNow = c5[i][4] / w - 1, dPrev = c5[i - 1][4] / vwap[i - 1] - 1;
      if (dNow <= -PC && dPrev > -PC) out.push({ i5: i, dir: 1 });
      else if (dNow >= PC && dPrev < PC) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
