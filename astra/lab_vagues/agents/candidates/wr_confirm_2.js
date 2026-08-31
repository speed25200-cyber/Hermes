// LEVIER CONFIRMATION — AXS (base "5 bougies consécutives -> fade", EN_LIVE dans le panier
// profond2) + confirmation VOLUME : on exige que la bougie de signal (la 5e bougie de la série)
// ait un volume >= 3x la médiane des 288 bougies précédentes (24h, fenêtre roulante causale,
// bougie courante incluse) — un run de 5 bougies qui s'achève sur un pic de volume est un
// épuisement net plus fiable qu'un run "silencieux".
// Signal nu (test_harness) : wrIS 53,8 / wrOOS 65,6 · espIS 6,79 / espOOS 10,68 (n 39+32).
// Avec confirmation volume >=3x : wrIS 76,0 / wrOOS 70,6 · espIS 14,58 / espOOS 11,89 (n 25+17).
// -> wr >= 65 % DES DEUX côtés (le nu échouait côté IS à 53,8) ; esp > 0 des deux côtés ET
// AUGMENTE des deux côtés (pas seulement maintenue) vs le nu.
const RUN_N = 5, VOL_MULT = 3, VOL_WIN = 288;

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
  instId: "AXS-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length, vol = c5.map(x => x[5]);
    const med = rollingMedian(vol, VOL_WIN);
    const out = [];
    let run = 0, sgn = 0;
    for (let i = 1; i < n; i++) {
      const d = Math.sign(c5[i][4] - c5[i - 1][4]);
      if (d !== 0 && d === sgn) run++; else { run = 1; sgn = d; }
      if (run >= RUN_N && sgn !== 0) {
        const dir = -sgn; // fade du sens du run
        if (med[i] != null && med[i] > 0 && vol[i] >= VOL_MULT * med[i]) out.push({ i5: i, dir });
      }
    }
    return out;
  }
};
