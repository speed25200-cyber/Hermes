// CHANTIER TF 4H/DAILY — TRIA : retournement 4H PUR. Clôture 4h à z-score <= -1,5 (ou >= +1,5)
// de sa SMA20-4h (~3,3 j) -> fade à la clôture de la bougie 4h, exécuté sur les 5m suivantes.
// Logique : l'excès de 3 jours sur bougies 4h se dégonfle ; une phrase, aucun paramètre fin.
// Plateau vérifié (scan 90 j) : N20/N42 × seuil 1,5/2/2,5 × E1/E2 TOUS positifs sur les
// 3 fenêtres (close et reclaim aussi) — mais fréquence structurellement faible : ~1 trade/j.
// ⚠️ Sur le banc 30 j le n ne peut PAS atteindre 60 (limite structurelle du 4h, pas du signal) ;
// sur 90 j : n=108, esp 60 j antérieurs +6,15 (n=82), IS +16,1 (n=12), OOS +13,9 (n=14).
// Bougie 4h close = bucket UTC terminé (le bucket suivant a commencé) — zéro futur.
module.exports = {
  instId: "TRIA-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const N = 20, TH = 1.5, MS = 4 * 3600 * 1000;
    // bougies 4h agrégées, close = clôture de la dernière 5m du bucket ; .last = i5 de cette 5m
    const A = []; let cur = null;
    for (let i = 0; i < c5.length; i++) {
      const b = Math.floor(c5[i][0] / MS);
      if (!cur || b !== cur.b) { if (cur) A.push(cur); cur = { b, c: c5[i][4], last: i }; }
      else { cur.c = c5[i][4]; cur.last = i; }
    }
    // z-score rolling N sur clôtures 4h
    const z = new Array(A.length).fill(null);
    let s = 0, s2 = 0;
    for (let k = 0; k < A.length; k++) {
      s += A[k].c; s2 += A[k].c * A[k].c;
      if (k >= N) { const o = A[k - N].c; s -= o; s2 -= o * o; }
      if (k >= N - 1) { const m = s / N, v = Math.max(s2 / N - m * m, 1e-18); z[k] = (A[k].c - m) / Math.sqrt(v); }
    }
    const out = [];
    for (let k = N + 1; k < A.length; k++) {
      if (z[k] == null) continue;
      if (z[k] <= -TH) out.push({ i5: A[k].last, dir: 1 });
      else if (z[k] >= TH) out.push({ i5: A[k].last, dir: -1 });
    }
    return out;
  }
};
