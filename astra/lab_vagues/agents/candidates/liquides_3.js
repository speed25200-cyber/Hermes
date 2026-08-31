// GROSSES CAPS — PUMP : repli modéré (RSI14-15m < 45) racheté par une bougie verte -> long only,
// TP modeste 0.45, trail 0.30/0.05, 12 h. Sur un gros volume en tendance, chaque respiration se rachète.
module.exports = {
  instId: "PUMP-USDT-SWAP",
  exits: { tp: 0.45, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    // agrégation 15m par horloge (blocs clos uniquement)
    const ms = 900000, bars = [], i5last = [];
    let cur = null, key = null, curI = -1;
    for (let i = 0; i < c5.length; i++) {
      const k = Math.floor(c5[i][0] / ms);
      if (k !== key) { if (cur) { bars.push(cur); i5last.push(curI); } cur = [c5[i][0], c5[i][1], c5[i][2], c5[i][3], c5[i][4], c5[i][5]]; key = k; }
      else { cur[2] = Math.max(cur[2], c5[i][2]); cur[3] = Math.min(cur[3], c5[i][3]); cur[4] = c5[i][4]; cur[5] += c5[i][5]; }
      curI = i;
    }
    const closes = bars.map(b => b[4]);
    const p = 14, r = new Array(closes.length).fill(null);
    let g = 0, pr = 0;
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (i <= p) { if (d > 0) g += d; else pr -= d; if (i === p) r[i] = 100 - 100 / (1 + (g / p) / ((pr / p) || 1e-12)); continue; }
      g = (g * (p - 1) + Math.max(d, 0)) / p;
      pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
      r[i] = 100 - 100 / (1 + g / (pr || 1e-12));
    }
    const out = [];
    for (let i = 16; i < bars.length; i++)
      if (r[i - 1] < 45 && bars[i][4] > bars[i][1]) out.push({ i5: i5last[i], dir: 1 });
    return out;
  }
};
