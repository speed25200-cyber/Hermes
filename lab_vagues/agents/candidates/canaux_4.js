// Donchian 5m fade : faux breakout du canal des 96 bougies 5m (8 h) sur SSV -> contre-pied.
module.exports = {
  instId: "SSV-USDT-SWAP",
  exits: { tp: 0.40, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const N = 96, out = [];
    // canal Donchian directement sur les bougies 5m closes (aucune agrégation, aucun futur)
    for (let i = N + 1; i < c5.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - N; j < i; j++) { hh = Math.max(hh, c5[j][2]); ll = Math.min(ll, c5[j][3]); }
      if (c5[i][2] > hh && c5[i][4] < hh) out.push({ i5: i, dir: -1 });      // mèche au-dessus du canal, close dedans -> short
      else if (c5[i][3] < ll && c5[i][4] > ll) out.push({ i5: i, dir: 1 }); // mèche sous le canal, close dedans -> long
    }
    return out;
  }
};
