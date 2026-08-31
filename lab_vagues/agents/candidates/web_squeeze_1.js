// DOT : cassure d'heure étroite (NR4, Toby Crabel) jouée en continuation.
// Doc web : l'heure au range le plus étroit des 4 dernières = compression ; la première
// cassure 5m du range dans l'heure suivante part en expansion → on suit la cassure.
module.exports = {
  instId: "DOT-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const out = [], hours = [];
    let cur = null;
    for (let i = 0; i < c5.length; i++) {
      const h = Math.floor(c5[i][0] / 3600000);
      if (!cur || cur.h !== h) { if (cur) hours.push(cur); cur = { h, start: i, hi: c5[i][2], lo: c5[i][3] }; }
      else { if (c5[i][2] > cur.hi) cur.hi = c5[i][2]; if (c5[i][3] < cur.lo) cur.lo = c5[i][3]; }
    }
    if (cur) hours.push(cur);
    const K = 4, WIN = 12; // NR4 · cassure cherchée sur les 12 bougies 5m suivantes
    for (let hIdx = K; hIdx < hours.length; hIdx++) {
      const H = hours[hIdx - 1], rng = H.hi - H.lo;
      let nr = true;
      for (let j = hIdx - K; j < hIdx - 1; j++) if (hours[j].hi - hours[j].lo <= rng) { nr = false; break; }
      if (!nr) continue;
      const s0 = hours[hIdx].start;
      for (let i = Math.max(s0, 101); i < Math.min(s0 + WIN, c5.length); i++) {
        let d = 0;
        if (c5[i][4] > H.hi) d = 1; else if (c5[i][4] < H.lo) d = -1;
        if (d !== 0) { out.push({ i5: i, dir: d }); break; }
      }
    }
    return out;
  }
};
