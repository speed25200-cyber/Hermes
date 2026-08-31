// Marteau / étoile filante 5m en zone d'excès (prix à plus de 3 ATR20 de la SMA48) : rejet de l'extrême, retour vers la moyenne.
module.exports = {
  instId: "ESP-USDT-SWAP",
  exits: { tp: 1.00, sl: 0.30, act: 0.20, cb: 0.05, holdH: 12 },
  detect(c5) {
    const P = 20, SMAP = 48, K = 3, WICK = 2, n = c5.length;
    const tr = new Array(n).fill(0), atr = new Array(n).fill(null), sma = new Array(n).fill(null);
    for (let i = 1; i < n; i++) tr[i] = Math.max(c5[i][2] - c5[i][3], Math.abs(c5[i][2] - c5[i - 1][4]), Math.abs(c5[i][3] - c5[i - 1][4]));
    let s = 0;
    for (let i = 1; i < n; i++) { s += tr[i]; if (i > P) s -= tr[i - P]; if (i >= P) atr[i] = s / P; }
    let sc = 0;
    for (let i = 0; i < n; i++) { sc += c5[i][4]; if (i >= SMAP) sc -= c5[i - SMAP][4]; if (i >= SMAP - 1) sma[i] = sc / SMAP; }
    const out = [];
    for (let i = 50; i < n; i++) {
      if (sma[i] == null || atr[i] == null || atr[i] === 0) continue;
      const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4];
      const body = Math.abs(c - o), low = Math.min(o, c) - l, up = h - Math.max(o, c);
      if (sma[i] - c > K * atr[i] && low >= WICK * body && low > 0 && up <= body) out.push({ i5: i, dir: 1 });
      else if (c - sma[i] > K * atr[i] && up >= WICK * body && up > 0 && low <= body) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
