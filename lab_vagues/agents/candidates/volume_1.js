// Divergence prix/volume : cassure du plus-haut/plus-bas des 24 bougies 5m SANS volume pour la soutenir
// (volume des 12 dernières bougies < 0,7x celui des 12 précédentes) -> contre-pied de la cassure.
module.exports = {
  instId: "SOON-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const out = [];
    for (let i = 300; i < c5.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - 24; j < i; j++) { hh = Math.max(hh, c5[j][2]); ll = Math.min(ll, c5[j][3]); }
      let v1 = 0, v0 = 0;
      for (let k = i - 11; k <= i; k++) v1 += c5[k][5];
      for (let k = i - 23; k <= i - 12; k++) v0 += c5[k][5];
      if (v0 <= 0) continue;
      if (c5[i][2] > hh && v1 < 0.7 * v0) out.push({ i5: i, dir: -1 });
      else if (c5[i][3] < ll && v1 < 0.7 * v0) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
