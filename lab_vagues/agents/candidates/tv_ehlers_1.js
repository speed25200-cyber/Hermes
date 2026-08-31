// BASED : Fisher Transform (Ehlers, L=34 sur hl2) — « reclaim » de la zone extrême :
// le fish repasse SOUS +3 (ou au-dessus de -3) après un excès, AVEC bougie de
// confirmation dans le sens du retour (clôture < ouverture pour le short) → mean-reversion.
// Formule exacte (mesasoftware.com/papers/UsingTheFisherTransform.pdf + TV) :
// v = 0.33*2*((hl2-minL)/(maxH-minL)-0.5) + 0.67*v[1], borné ±0.999 ;
// fish = 0.5*ln((1+v)/(1-v)) + 0.5*fish[1]. Aucun repaint : tout à l'index i utilise [0..i].
// Robustesse (banc 30 j) : rec_L34 conf E3 14.17 / E2 11.83 / E1 11.24 ; rec_L21 conf E4 11.53,
// E3 11.25 ; rec_L14 conf 8.2-8.6 — la famille entière est positive, pas un point isolé.
const L = 34, T = 3, WARM = 300;

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
  instId: "BASED-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const f = fisherSeries(c5, L);
    const out = [];
    for (let i = WARM; i < c5.length; i++) {
      const o = c5[i][1], c = c5[i][4];
      if (f[i - 1] >= T && f[i] < T && c < o) out.push({ i5: i, dir: -1 });
      if (f[i - 1] <= -T && f[i] > -T && c > o) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
