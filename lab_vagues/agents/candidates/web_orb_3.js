// JTO : échec de cassure du range d'ouverture (ORB fade) sur les 6 sessions
// (00h/01h/07h/08h/13h30/16h UTC), range 15 min, fenêtre courte 2 h : si la cassure
// est reprise vite, c'était un piège -> on joue le retour, sortie rapide (hold 4 h).
// Voisins de grille (tp 0.6 / hold 8) : worst 6,4 / 6,4 / 6,3 — famille homogène.
const OPENS = [0, 60, 420, 480, 810, 960];
const RANGE_MIN = 15, WINDOW = 120;

module.exports = {
  instId: "JTO-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 4 },
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
      if (!cur || cur.key !== sess) cur = { key: sess, hi: -Infinity, lo: Infinity, n: 0, brk: 0, fired: false };
      if (rel < RANGE_MIN) {
        cur.hi = Math.max(cur.hi, c5[i][2]);
        cur.lo = Math.min(cur.lo, c5[i][3]);
        cur.n++;
        continue;
      }
      if (cur.n < RANGE_MIN / 5 || cur.fired || i < 100) continue;
      const close = c5[i][4];
      if (cur.brk === 0) {
        if (close > cur.hi) cur.brk = 1;
        else if (close < cur.lo) cur.brk = -1;
      } else if (close <= cur.hi && close >= cur.lo) {
        out.push({ i5: i, dir: -cur.brk });
        cur.fired = true;
      }
    }
    return out;
  }
};
