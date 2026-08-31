// LDO — « LEXIQUE-V » : l'alphabet du rythme de volatilité (INVENTION, agent inv_alphabet_).
// Même indicateur que inv_alphabet_1 (mots de 4 lettres de rythme, lexique incrémental sans futur),
// crypto LIBRE : LDO. Signal = mot (quasi) inédit + close dans l'extrême 20 % du range 24 h + bougie
// de reprise → fade de l'étirement. Warm-up lexique 1440 (5 j) — la cellule scannée.
// Banc (scan4) : worst +6,35 (IS 6,35/30 OOS 8,86/30 pf 1,70) — toute la famille k4/P0.2/conf/E1
// positive (7,08 · 5,39 · 3,12) et k3 unanimement positif (7-15) mais n trop faible.
const K = 4, RARE = 1, P = 0.20, MINH = 1440, WPOS = 288, WR = 48;

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
  instId: "LDO-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
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
          const o = c5[i][1], cl = c5[i][4];
          if (pos <= P && cl >= o) out.push({ i5: i, dir: 1 });
          else if (pos >= 1 - P && cl <= o) out.push({ i5: i, dir: -1 });
        }
      }
      cnt.set(g, c + 1);
    }
    return out;
  }
};
