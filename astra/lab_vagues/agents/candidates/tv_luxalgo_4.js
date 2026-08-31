// UB (Unibase) : SuperTrend built-in TradingView (hl2 ± 3×ATR20, bandes portées, flip sur close),
// joué DANS le sens du flip (momentum) : le retournement du SuperTrend 20/3 sur 5 m capte les
// vrais changements de régime de ce token très directionnel. Version causale stricte.
// Robustesse : p20_f3 valide sur les 4 exits (7,35-8,00) + Chandelier Exit flips aussi positifs
// (4,1-4,7) -> deux familles de stops suiveurs d'accord sur UB.
const P = 20, F = 3;

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
  instId: "UB-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length, atr = rmaATR(c5, P);
    const out = [];
    let ub = NaN, lb = NaN, d = 1, dPrev = 1;
    for (let i = P; i < n; i++) {
      const hl2 = (c5[i][2] + c5[i][3]) / 2, cl = c5[i][4], pc = c5[i - 1][4];
      let bu = hl2 + F * atr[i], bl = hl2 - F * atr[i];
      if (!isNaN(ub)) { if (!(bu < ub || pc > ub)) bu = ub; if (!(bl > lb || pc < lb)) bl = lb; }
      dPrev = d;
      if (i === P || isNaN(ub)) d = 1;
      else if (d === -1) d = cl > bu ? 1 : -1; // baisse : flip si close > bande haute
      else d = cl < bl ? -1 : 1;               // hausse : flip si close < bande basse
      ub = bu; lb = bl;
      if (i > 600 && d !== dPrev) out.push({ i5: i, dir: d });
    }
    return out;
  }
};
