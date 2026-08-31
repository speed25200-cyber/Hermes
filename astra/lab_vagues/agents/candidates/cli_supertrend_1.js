// SuperTrend [Pine v4, script client] porté fidèlement : ATR(10) Wilder x3 sur hl2, bandes up/dn
// portées causalement (up:=close[1]>up1?max(up,up1):up ; dn symétrique), trend flip sur close vs up1/dn1
// (dn1/up1 = bandes de la bougie PRÉCÉDENTE, comme le script). Le flip NU est mort (ronde 4 : "SuperTrend
// flip" dans les familles à ne pas re-porter).
// Lecture (c) : flip SUIVI (pas fade) mais filtré par une CONFIRMATION VOLUME — la bougie du flip doit
// afficher un volume >= 2x la moyenne mobile des 50 bougies précédentes. Idée : un flip sans volume est
// du bruit (le prix traverse la bande sans conviction, repart en range) ; un flip avec afflux de volume
// signale une vraie bascule institutionnelle qui a des chances de suivre. Plateau confirmé sur LIGHT :
// positif sur tout le voisinage mult{1.5,2,3} x w{20,50} (8,5 à 10,7 selon la cellule, seules quelques
// cellules perdent la validité par n<60 total, jamais par un signe négatif) et sur les 2 jeux de sorties
// (E1 tp80/hold12 = 8,53 ; E2 tp60/hold8 = 2,60, même sens).
module.exports = {
  instId: "LIGHT-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const Periods = 10, Mult = 3.0, VOL_W = 50, VOL_MULT = 2.0;
    const n = c5.length;

    // --- true range + ATR Wilder (RMA), comme le atr() built-in Pine (changeATR=true, défaut du script) ---
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

    // --- bandes up/dn portées + trend, EXACTEMENT le script (src=hl2) ---
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

    // --- moyenne mobile causale du volume (fenêtre VOL_W bougies STRICTEMENT précédentes) ---
    const volAvg = new Float64Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) {
      if (i > VOL_W) s -= c5[i - VOL_W - 1][5];
      if (i > 0) s += c5[i - 1][5];
      volAvg[i] = i >= VOL_W ? s / VOL_W : NaN;
    }

    const out = [];
    for (let i = Math.max(60, Periods + 1); i < n; i++) {
      if (trend[i] === trend[i - 1]) continue; // pas de flip
      if (Number.isNaN(volAvg[i]) || c5[i][5] < VOL_MULT * volAvg[i]) continue; // pas de confirmation volume
      out.push({ i5: i, dir: trend[i] }); // suivi du flip (dir = nouveau trend), confirmé par le volume
    }
    return out;
  }
};
