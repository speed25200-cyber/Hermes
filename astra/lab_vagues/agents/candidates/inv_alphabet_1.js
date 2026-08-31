// NEIRO — « LEXIQUE-V » : l'alphabet du rythme de volatilité (INVENTION, agent inv_alphabet_).
// Lecture en 2 phrases : chaque bougie 5 m devient une lettre selon son RYTHME (range vs moyenne
// des 48 ranges précédents, 4 classes G/g/n/q × sens up/down = 8 lettres) ; un lexique des mots de
// 4 lettres est appris incrémentalement sur TOUT l'historique disponible à l'instant t (zéro futur).
// Signal = le mot qui vient de se former est (quasi) INÉDIT (vu <= 1 fois) ALORS QUE le close est dans
// l'extrême 20 % du range 24 h + bougie de reprise dans le sens du fade → l'anomalie de rythme en zone
// étirée = épuisement → contre-tendance.
// Banc (scan4) : worst +9,48 (IS 9,48/43 OOS 12,67/34 pf 2,13) — voisinage k4/k5 × rare0/1 × m960/1440
// positif partout (8,03 · 5,49 · 5,20 · 4,94 · 3,55…), bat le champion NEIRO en place (volprofile_1, 7,01).
const K = 4;          // longueur du mot
const RARE = 1;       // vu <= 1 fois = inédit
const P = 0.20;       // extrême du range 24 h
const MINH = 960;     // warm-up du lexique (~3,3 j)
const WPOS = 288;     // range 24 h
const WR = 48;        // moyenne des ranges pour les classes

function lettre(c5, i, avgR) {
  const o = c5[i][1], c = c5[i][4], r = c5[i][2] - c5[i][3];
  let cl;
  if (Number.isNaN(avgR) || avgR <= 0) cl = "n";
  else if (r >= 2 * avgR) cl = "G";
  else if (r >= 1.3 * avgR) cl = "g";
  else if (r >= 0.6 * avgR) cl = "n";
  else cl = "q";
  return cl + (c >= c5[i][1] ? "+" : "-");
}

module.exports = {
  instId: "NEIRO-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length, out = [];
    // lettres (causal : moyenne des 48 ranges PRÉCÉDENTS)
    const L = new Array(n);
    let sumR = 0; const rq = [];
    for (let i = 0; i < n; i++) {
      const avgR = rq.length >= WR ? sumR / rq.length : NaN;
      L[i] = lettre(c5, i, avgR);
      const r = c5[i][2] - c5[i][3];
      rq.push(r); sumR += r;
      if (rq.length > WR) sumR -= rq.shift();
    }
    // lexique incrémental + signal
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
          if (pos <= P && cl >= o) out.push({ i5: i, dir: 1 });        // mot inédit au plancher + reprise haussière
          else if (pos >= 1 - P && cl <= o) out.push({ i5: i, dir: -1 }); // mot inédit au plafond + reprise baissière
        }
      }
      cnt.set(g, c + 1);
    }
    return out;
  }
};
