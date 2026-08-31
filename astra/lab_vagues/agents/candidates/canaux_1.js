// Donchian 15m fade : cassure du plus haut/bas des 24 bougies 15m (6 h) qui re-ferme DANS le canal -> on prend le contre-pied.
module.exports = {
  instId: "BASED-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    // agrégation 5m -> 15m (bougie 15m close à l'index i5fin, aucun futur)
    const period = 15 * 60 * 1000;
    const t = []; let cur = null;
    for (let i = 0; i < c5.length; i++) {
      const b = Math.floor(c5[i][0] / period);
      if (!cur || cur.b !== b) { if (cur) t.push(cur); cur = { b, i5fin: i, h: c5[i][2], l: c5[i][3], c: c5[i][4] }; }
      else { cur.h = Math.max(cur.h, c5[i][2]); cur.l = Math.min(cur.l, c5[i][3]); cur.c = c5[i][4]; cur.i5fin = i; }
    }
    if (cur) t.push(cur);
    const N = 24, out = [];
    for (let i = N + 1; i < t.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - N; j < i; j++) { hh = Math.max(hh, t[j].h); ll = Math.min(ll, t[j].l); }
      if (t[i].h > hh && t[i].c < hh) out.push({ i5: t[i].i5fin, dir: -1 });      // faux breakout haut -> short
      else if (t[i].l < ll && t[i].c > ll) out.push({ i5: t[i].i5fin, dir: 1 }); // faux breakdown bas -> long
    }
    return out;
  }
};
