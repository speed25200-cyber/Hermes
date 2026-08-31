// ZAMA : Opening Range Breakout classique sur les opens de session mondiaux
// (01h Tokyo / 07h Londres / 13h30 New York UTC). Range = 15 premières minutes ;
// la 1re bougie 5 m qui CLÔTURE hors du range dans les 4 h donne le sens (continuation).
// Voisins de grille (tp 0.6 / act 0.2 / R30) : worst 6,2 / 6,1 / 5,9 — famille homogène.
const OPENS = [60, 420, 810];
const RANGE_MIN = 15, WINDOW = 240;

module.exports = {
  instId: "ZAMA-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const out = [];
    let cur = null;
    for (let i = 0; i < c5.length; i++) {
      const ts = c5[i][0];
      const minOfDay = Math.floor(ts / 60000) % 1440;
      const day = Math.floor(ts / 86400000);
      let sess = null, rel = -1;
      for (const O of OPENS) {
        let r = minOfDay - O, d = day;
        if (r < 0) { r += 1440; d -= 1; }
        if (r >= 0 && r < WINDOW) { sess = d * 10000 + O; rel = r; break; }
      }
      if (sess === null) { cur = null; continue; }
      if (!cur || cur.key !== sess) cur = { key: sess, hi: -Infinity, lo: Infinity, n: 0, fired: false };
      if (rel < RANGE_MIN) {
        cur.hi = Math.max(cur.hi, c5[i][2]);
        cur.lo = Math.min(cur.lo, c5[i][3]);
        cur.n++;
        continue;
      }
      if (cur.n < RANGE_MIN / 5 || cur.fired || i < 100) continue;
      const close = c5[i][4];
      if (close > cur.hi) { out.push({ i5: i, dir: 1 }); cur.fired = true; }
      else if (close < cur.lo) { out.push({ i5: i, dir: -1 }); cur.fired = true; }
    }
    return out;
  }
};
