// HUMA : UT Bot Alerts (QuantNomad, code exact, option "Signals from Heikin Ashi Candles")
// pris À CONTRE-SENS : le flip du stop suiveur ATR (nLoss = 3×ATR10) sur close Heikin Ashi
// = prise de stops après une poussée -> on fade le flip (mean-reversion, cohérent avec le banc).
// Version causale stricte : HA close = (o+h+l+c)/4 de la bougie CLOSE, ATR Wilder sur bougies normales.
// Robustesse : toutes les cases a2/a3/a4 × c5/10/20/30 ont un worst > 0 (fade), a3_c10 = crête.
const A = 3, C = 10;

function rmaATR(c5, p) {
  const n = c5.length, atr = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 1; i < n; i++) {
    const h = c5[i][2], l = c5[i][3], pc = c5[i - 1][4];
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (i <= p) { sum += tr; if (i === p) atr[i] = sum / p; }
    else atr[i] = (atr[i - 1] * (p - 1) + tr) / p;
  }
  return atr;
}

module.exports = {
  instId: "HUMA-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const n = c5.length, atr = rmaATR(c5, C);
    const src = c5.map(r => (r[1] + r[2] + r[3] + r[4]) / 4); // Heikin Ashi close
    const out = [];
    let stop = 0, stopPrev = 0;
    for (let i = C + 1; i < n; i++) {
      const nl = A * atr[i], cl = src[i], pc = src[i - 1];
      stopPrev = stop;
      if (cl > stopPrev && pc > stopPrev) stop = Math.max(stopPrev, cl - nl);
      else if (cl < stopPrev && pc < stopPrev) stop = Math.min(stopPrev, cl + nl);
      else if (cl > stopPrev) stop = cl - nl;
      else stop = cl + nl;
      if (i <= 600) continue;
      if (pc < stopPrev && cl > stop) out.push({ i5: i, dir: -1 });      // "buy" UT -> fade short
      else if (pc > stopPrev && cl < stop) out.push({ i5: i, dir: 1 });  // "sell" UT -> fade long
    }
    return out;
  }
};
