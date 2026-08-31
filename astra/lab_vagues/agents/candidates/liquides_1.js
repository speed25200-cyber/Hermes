// GROSSES CAPS — LINK : survente courte (RSI7-15m<30 OU RSI14-5m<30) rachetée par une bougie verte
// -> long only, TP court 0.30, trail 0.20/0.10, 6 h. Les dips de LINK sont peu profonds et se rachètent vite.
module.exports = {
  instId: "LINK-USDT-SWAP",
  exits: { tp: 0.30, sl: 0.30, act: 0.20, cb: 0.10, holdH: 6 },
  detect(c5) {
    const rsi = (closes, p) => {
      const r = new Array(closes.length).fill(null);
      let g = 0, pr = 0;
      for (let i = 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (i <= p) { if (d > 0) g += d; else pr -= d; if (i === p) r[i] = 100 - 100 / (1 + (g / p) / ((pr / p) || 1e-12)); continue; }
        g = (g * (p - 1) + Math.max(d, 0)) / p;
        pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
        r[i] = 100 - 100 / (1 + g / (pr || 1e-12));
      }
      return r;
    };
    // vue 5m : RSI14 sur les clôtures brutes
    const r5 = rsi(c5.map(x => x[4]), 14);
    // vue 15m : agrégation par horloge (blocs clos uniquement), RSI7
    const ms = 900000, bars = [], i5last = [];
    let cur = null, key = null, curI = -1;
    for (let i = 0; i < c5.length; i++) {
      const k = Math.floor(c5[i][0] / ms);
      if (k !== key) { if (cur) { bars.push(cur); i5last.push(curI); } cur = [c5[i][0], c5[i][1], c5[i][2], c5[i][3], c5[i][4], c5[i][5]]; key = k; }
      else { cur[2] = Math.max(cur[2], c5[i][2]); cur[3] = Math.min(cur[3], c5[i][3]); cur[4] = c5[i][4]; cur[5] += c5[i][5]; }
      curI = i;
    }
    const r15 = rsi(bars.map(x => x[4]), 7);
    const ok15 = new Set();
    for (let i = 9; i < bars.length; i++)
      if (r15[i - 1] < 30 && bars[i][4] > bars[i][1]) ok15.add(i5last[i]);
    const out = [];
    for (let i = 16; i < c5.length; i++) {
      const ok5 = r5[i - 1] < 30 && c5[i][4] > c5[i][1];
      if (ok5 || ok15.has(i)) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
