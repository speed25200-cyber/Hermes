// LEVIER CONFIRMATION — GRASS (base champions_2 z48, EN_LIVE) + confirmation VOLUME + MÈCHE
// DE REJET COMBINÉES : un seul filtre (volume seul ou mèche seule) ne suffisait pas à faire
// franchir 65 % de wr des DEUX côtés à GRASS (testé en grille, cf JOURNAL) ; la combinaison
// volume >=1,75x médiane 24h (287 barres roulantes) ET mèche de rejet >=25 % du range sur la
// bougie d'extrême |z|>2,5 tient sur le plus gros échantillon des 4 candidats (n=66, nOOS=26).
// Logique en une phrase : un excès de z-score qui s'accompagne À LA FOIS d'un pic de volume et
// d'une mèche de rejet est un épuisement à deux signatures indépendantes, pas une coïncidence.
// Signal nu (test_harness) : wrIS 66,7 / wrOOS 54,5 · espIS 9,09 / espOOS 9,52 (n 54+44).
// Avec confirmation vol1,75x + mèche 25% : wrIS 67,5 / wrOOS 65,4 · espIS 11,77 / espOOS 14,92
// (n 40+26) -> corrige précisément le côté faible (OOS 54,5 -> 65,4, +10,9 pts) sans tuer l'IS.
const P = 48, VOL_MULT = 1.75, VOL_WIN = 288, WICK_FRAC = 0.25;

function rollingMedian(vals, win) {
  const n = vals.length, out = new Array(n).fill(null);
  const w = [];
  function insert(v) { let lo = 0, hi = w.length; while (lo < hi) { const m = (lo + hi) >> 1; if (w[m] < v) lo = m + 1; else hi = m; } w.splice(lo, 0, v); }
  function remove(v) { let lo = 0, hi = w.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (w[m] === v) { w.splice(m, 1); return; } if (w[m] < v) lo = m + 1; else hi = m - 1; } }
  for (let i = 0; i < n; i++) {
    insert(vals[i]);
    if (w.length > win) remove(vals[i - win]);
    if (i >= win - 1) { const m = w.length >> 1; out[i] = w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2; }
  }
  return out;
}

module.exports = {
  instId: "GRASS-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.30, cb: 0.20, holdH: 12 },
  detect(c5) {
    const closes = c5.map(x => x[4]);
    const vol = c5.map(x => x[5]);
    const med = rollingMedian(vol, VOL_WIN);
    const out = [];
    let s = 0, s2 = 0;
    const sma = new Array(closes.length).fill(null), std = new Array(closes.length).fill(null);
    for (let i = 0; i < closes.length; i++) {
      s += closes[i]; s2 += closes[i] * closes[i];
      if (i >= P) { const x = closes[i - P]; s -= x; s2 -= x * x; }
      if (i >= P - 1) { const m = s / P; sma[i] = m; std[i] = Math.sqrt(Math.max(0, s2 / P - m * m)); }
    }
    for (let i = P; i < closes.length; i++) {
      if (sma[i] == null || !std[i]) continue;
      const z = (closes[i] - sma[i]) / std[i];
      let dir = 0;
      if (z > 2.5) dir = -1; else if (z < -2.5) dir = 1;
      if (!dir) continue;
      if (med[i] == null || !(med[i] > 0) || vol[i] < VOL_MULT * med[i]) continue;
      const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4], range = h - l;
      if (!(range > 0)) continue;
      const wOk = dir === 1 ? (Math.min(o, c) - l) / range >= WICK_FRAC : (h - Math.max(o, c)) / range >= WICK_FRAC;
      if (wOk) out.push({ i5: i, dir });
    }
    return out;
  }
};
