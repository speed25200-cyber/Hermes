// BERA : Fisher Transform (Ehlers, L=9 sur hl2) — RETOURNEMENT en zone extrême ±3
// avec bougie de confirmation : le fish se retourne au-delà de ±3 (cross du trigger)
// ET la bougie clôture dans le sens du retour → fade de l'excès court terme confirmé.
// Fisher exact Ehlers, aucun repaint (tout à l'index i n'utilise que [0..i]).
// Robustesse (banc 30 j) : E4 8.18 ; sans conf turn_L9_t2.5 7.06-7.10 ; L21/L55 conf 6.8-7.6
// — le voisinage entier (L, T, exits) est positif.
const L = 9, T = 3, WARM = 300;

function fisherSeries(c5, len) {
  const n = c5.length, out = new Array(n).fill(NaN);
  const hl = new Array(n);
  for (let i = 0; i < n; i++) hl[i] = (c5[i][2] + c5[i][3]) / 2;
  let v = 0, fish = 0;
  for (let i = len - 1; i < n; i++) {
    let mn = Infinity, mx = -Infinity;
    for (let k = i - len + 1; k <= i; k++) { if (hl[k] < mn) mn = hl[k]; if (hl[k] > mx) mx = hl[k]; }
    const r = mx - mn;
    v = 0.33 * 2 * (r > 0 ? (hl[i] - mn) / r - 0.5 : 0) + 0.67 * v;
    if (v > 0.99) v = 0.999; if (v < -0.99) v = -0.999;
    fish = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * fish;
    out[i] = fish;
  }
  return out;
}

module.exports = {
  instId: "BERA-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const f = fisherSeries(c5, L);
    const out = [];
    for (let i = WARM; i < c5.length; i++) {
      const o = c5[i][1], c = c5[i][4];
      if (f[i - 1] > T && f[i] < f[i - 1] && f[i - 1] >= f[i - 2] && c < o) out.push({ i5: i, dir: -1 });
      if (f[i - 1] < -T && f[i] > f[i - 1] && f[i - 1] <= f[i - 2] && c > o) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
