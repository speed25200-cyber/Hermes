// Champion GPS (mèche épuisement 5m + vol 2x, tp0.8 act0.3 12h, worst nu 8.78) + UN ingrédient : trail respirant (callback 20 % au lieu de 5 %) — on laisse courir le fade au lieu d'étouffer les gagnants. Plateau cb 0.15/0.20/0.25 -> worst 10.91/11.45/11.35.
module.exports = {
  instId: "GPS-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.20, holdH: 12 },
  detect(c5) {
    const out = [];
    for (let i = 30; i < c5.length; i++) {
      const o = c5[i][1], h = c5[i][2], l = c5[i][3], cl = c5[i][4], v = c5[i][5];
      const corps = Math.abs(cl - o), haut = h - Math.max(o, cl), bas = Math.min(o, cl) - l;
      let mv = 0; const from = Math.max(0, i - 30);
      for (let k = from; k < i; k++) mv += c5[k][5];
      mv /= (i - from);
      if (v > 2 * mv && haut > 2 * corps && haut > 0.004 * cl) out.push({ i5: i, dir: -1 });
      if (v > 2 * mv && bas > 2 * corps && bas > 0.004 * cl) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
