// ARX : Force Index extrême (Elder) — quand le flux vendeur (ou acheteur) sur 13 barres
// dépasse 3× sa moyenne absolue des dernières 24 h et que la bougie referme déjà dans
// l'autre sens, l'excès est épuisé -> on prend le contre-pied (fade).
// FI(13) via technicalindicators, normalisé par SMA(|FI|, 288 barres) pour être sans échelle.
// Robustesse : les 8 cellules d'exit du seuil 3 sont valides (worst 5,17 à 10,52),
// le seuil 2 aussi (OOS +9 à +11) — famille, pas point isolé.
const ti = require("technicalindicators");
const T = 3, W = 288;

module.exports = {
  instId: "ARX-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 8 },
  detect(c5) {
    const N = c5.length, out = [];
    const o = new Array(N), c = new Array(N), v = new Array(N);
    for (let i = 0; i < N; i++) { o[i] = +c5[i][1]; c[i] = +c5[i][4]; v[i] = +c5[i][5]; }
    const fi = ti.forceindex({ close: c, volume: v, period: 13 });
    const oFi = N - fi.length;
    const fiNorm = new Array(fi.length).fill(null);
    let s = 0;
    for (let j = 0; j < fi.length; j++) {
      s += Math.abs(fi[j]);
      if (j >= W) s -= Math.abs(fi[j - W]);
      if (j >= W - 1) { const m = s / W; fiNorm[j] = m > 0 ? fi[j] / m : 0; }
    }
    for (let i = Math.max(400, oFi + W); i < N - 2; i++) {
      const j = i - oFi;
      if (fiNorm[j] === null) continue;
      if (fiNorm[j] < -T && c[i] > o[i]) out.push({ i5: i, dir: 1 });
      if (fiNorm[j] > T && c[i] < o[i]) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
