// ESP : reclaim de bande VWAP session (ancre jour UTC, bandes = écart-type pondéré volume).
// Même setup documenté que web_vwap_1 : l'excès au-delà de ±2σ n'est fadé qu'au retour
// À L'INTÉRIEUR de la bande (rejet confirmé), cible = retour vers le VWAP. Warm-up 3 h.
module.exports = {
  instId: "ESP-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const DAY = 86400000, WARM = 36, K = 2, out = [];
    const vwap = new Array(c5.length).fill(null), sig = new Array(c5.length).fill(null), bod = new Array(c5.length).fill(0);
    let day = -1, cv = 0, cpv = 0, cpv2 = 0, k = 0;
    for (let i = 0; i < c5.length; i++) {
      const d = Math.floor(c5[i][0] / DAY);
      if (d !== day) { day = d; cv = 0; cpv = 0; cpv2 = 0; k = 0; }
      const tp = (c5[i][2] + c5[i][3] + c5[i][4]) / 3, v = Math.max(c5[i][5], 0);
      cv += v; cpv += tp * v; cpv2 += tp * tp * v; k++;
      bod[i] = k;
      if (cv > 0) { const m = cpv / cv; vwap[i] = m; sig[i] = Math.sqrt(Math.max(cpv2 / cv - m * m, 0)); }
    }
    for (let i = 101; i < c5.length; i++) {
      const w = vwap[i], s = sig[i];
      if (w == null || !(s > 0) || bod[i] < WARM) continue;
      if (vwap[i - 1] == null || !(sig[i - 1] > 0)) continue;
      const z = (c5[i][4] - w) / s, zPrev = (c5[i - 1][4] - vwap[i - 1]) / sig[i - 1];
      if (zPrev <= -K && z > -K && z < 0) out.push({ i5: i, dir: 1 });
      else if (zPrev >= K && z < K && z > 0) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
