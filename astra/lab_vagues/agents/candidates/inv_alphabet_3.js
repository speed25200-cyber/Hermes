// PENDLE — « LEXIQUE-V » : l'alphabet du rythme de volatilité (INVENTION, agent inv_alphabet_).
// Même indicateur (lettres de rythme, lexique incrémental sans futur), crypto LIBRE : PENDLE.
// Variante courte : mots de 3 lettres, zone étirée 30 % du range 24 h, sans bougie de conf
// (le mot inédit suffit), exit E2 fondateur. Warm-up lexique 960 (~3,3 j).
// Banc (scan4) : worst +6,73 (IS 6,73/43 OOS 9,51/23 pf 2,11) — voisinage k3 unanimement positif
// (8,37 · 7,22 · 7,01 · 6,36 · 6,35, invalides seulement par n), k4 conf 6,33.
const K = 3, RARE = 1, P = 0.30, MINH = 960, WPOS = 288, WR = 48;

function lettre(c5, i, avgR) {
  const c = c5[i][4], r = c5[i][2] - c5[i][3];
  let cl;
  if (Number.isNaN(avgR) || avgR <= 0) cl = "n";
  else if (r >= 2 * avgR) cl = "G";
  else if (r >= 1.3 * avgR) cl = "g";
  else if (r >= 0.6 * avgR) cl = "n";
  else cl = "q";
  return cl + (c >= c5[i][1] ? "+" : "-");
}

module.exports = {
  instId: "PENDLE-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  detect(c5) {
    const n = c5.length, out = [];
    const L = new Array(n);
    let sumR = 0; const rq = [];
    for (let i = 0; i < n; i++) {
      const avgR = rq.length >= WR ? sumR / rq.length : NaN;
      L[i] = lettre(c5, i, avgR);
      const r = c5[i][2] - c5[i][3];
      rq.push(r); sumR += r;
      if (rq.length > WR) sumR -= rq.shift();
    }
    const cnt = new Map();
    for (let i = K - 1; i < n; i++) {
      const g = L.slice(i - K + 1, i + 1).join("|");
      const c = cnt.get(g) || 0;
      if (i >= MINH && c <= RARE && i >= WPOS - 1) {
        let mn = Infinity, mx = -Infinity;
        for (let k = i - WPOS + 1; k <= i; k++) {
          if (c5[k][3] < mn) mn = c5[k][3];
          if (c5[k][2] > mx) mx = c5[k][2];
        }
        if (mx > mn) {
          const pos = (c5[i][4] - mn) / (mx - mn);
          if (pos <= P) out.push({ i5: i, dir: 1 });
          else if (pos >= 1 - P) out.push({ i5: i, dir: -1 });
        }
      }
      cnt.set(g, c + 1);
    }
    return out;
  }
};
