// MOODENG : range 30 min le plus étroit des 8 derniers (NR8) puis cassure → contre-pied.
// Doc web : variante intraday de Crabel ; sur memecoin la 1re cassure d'un micro-range
// est majoritairement un fake-out → on la fade vers le range.
module.exports = {
  instId: "MOODENG-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const out = [], bars = [];
    let cur = null;
    for (let i = 0; i < c5.length; i++) {
      const b = Math.floor(c5[i][0] / 1800000); // 30 min
      if (!cur || cur.b !== b) { if (cur) bars.push(cur); cur = { b, start: i, hi: c5[i][2], lo: c5[i][3] }; }
      else { if (c5[i][2] > cur.hi) cur.hi = c5[i][2]; if (c5[i][3] < cur.lo) cur.lo = c5[i][3]; }
    }
    if (cur) bars.push(cur);
    const K = 8, WIN = 12; // NR8 sur 30m · fenêtre de cassure 12×5m
    for (let bIdx = K; bIdx < bars.length; bIdx++) {
      const H = bars[bIdx - 1], rng = H.hi - H.lo;
      let nr = true;
      for (let j = bIdx - K; j < bIdx - 1; j++) if (bars[j].hi - bars[j].lo <= rng) { nr = false; break; }
      if (!nr) continue;
      const s0 = bars[bIdx].start;
      for (let i = Math.max(s0, 101); i < Math.min(s0 + WIN, c5.length); i++) {
        let d = 0;
        if (c5[i][4] > H.hi) d = 1; else if (c5[i][4] < H.lo) d = -1;
        if (d !== 0) { out.push({ i5: i, dir: -d }); break; } // fade
      }
    }
    return out;
  }
};
