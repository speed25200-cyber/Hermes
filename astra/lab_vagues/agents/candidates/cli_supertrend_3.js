// SuperTrend [Pine v4, script client] porté fidèlement : ATR(10) Wilder x3 sur hl2, bandes up/dn
// portées causalement, trend flip (voir cli_supertrend_1.js pour le détail). Même famille que
// cli_supertrend_1.js/LIGHT — lecture (c) flip SUIVI + CONFIRMATION VOLUME >= 3x moyenne 10 bougies
// (fenêtre plus courte + seuil plus strict que LIGHT, la grille CVX préfère w=10/mult=3 à w=50/mult=2 —
// signature cohérente avec une crypto plus liquide où le "sursaut" de volume se lit sur une fenêtre
// courte). Plateau CVX : mult{2,3} x w{10,20,50} systématiquement positif (2,3 à 7,2 selon la cellule,
// plusieurs perdent juste la validité par n<60, jamais par un signe négatif) ; sorties E1 tp80/hold12
// (5,63) et E2 tp60/hold8 (6,27) toutes deux positives sur cette cellule.
module.exports = {
  instId: "CVX-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  detect(c5) {
    const Periods = 10, Mult = 3.0, VOL_W = 10, VOL_MULT = 3.0;
    const n = c5.length;

    const tr = new Float64Array(n), atr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const h = c5[i][2], l = c5[i][3];
      tr[i] = i === 0 ? (h - l) : Math.max(h - l, Math.abs(h - c5[i - 1][4]), Math.abs(l - c5[i - 1][4]));
    }
    let seed = 0;
    for (let i = 0; i < Periods; i++) seed += tr[i];
    atr[Periods - 1] = seed / Periods;
    for (let i = Periods; i < n; i++) atr[i] = (atr[i - 1] * (Periods - 1) + tr[i]) / Periods;
    for (let i = 0; i < Periods - 1; i++) atr[i] = atr[Periods - 1];

    const up = new Float64Array(n), dn = new Float64Array(n), trend = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      const hl2 = (c5[i][2] + c5[i][3]) / 2;
      const rawUp = hl2 - Mult * atr[i];
      const rawDn = hl2 + Mult * atr[i];
      const up1 = i > 0 ? up[i - 1] : rawUp;
      const dn1 = i > 0 ? dn[i - 1] : rawDn;
      up[i] = (i > 0 && c5[i - 1][4] > up1) ? Math.max(rawUp, up1) : rawUp;
      dn[i] = (i > 0 && c5[i - 1][4] < dn1) ? Math.min(rawDn, dn1) : rawDn;
      const prevTrend = i > 0 ? trend[i - 1] : 1;
      trend[i] = (prevTrend === -1 && c5[i][4] > dn1) ? 1 : (prevTrend === 1 && c5[i][4] < up1) ? -1 : prevTrend;
    }

    const volAvg = new Float64Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) {
      if (i > VOL_W) s -= c5[i - VOL_W - 1][5];
      if (i > 0) s += c5[i - 1][5];
      volAvg[i] = i >= VOL_W ? s / VOL_W : NaN;
    }

    const out = [];
    for (let i = Math.max(60, Periods + 1); i < n; i++) {
      if (trend[i] === trend[i - 1]) continue;
      if (Number.isNaN(volAvg[i]) || c5[i][5] < VOL_MULT * volAvg[i]) continue;
      out.push({ i5: i, dir: trend[i] });
    }
    return out;
  }
};
