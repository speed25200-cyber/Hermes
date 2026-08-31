// ACU (Acurast, vraie crypto DePIN vérifiée — perps OKX depuis 01/2026) — « EDN / RESSORT PERCÉ »
// (INVENTION, agent inv_efficacite_). Indicateur : Efficacité du Déplacement Normalisée
// EDN = (|déplacement net| / chemin parcouru en Σ|Δclose|) × √W sur W bougies 5 m — une marche
// aléatoire donne ≈ 0,8 quel que soit W, un ressort comprimé (chemin énorme pour rien) tombe sous 0,45.
// Lecture en 2 phrases : quand ACU gaspille son énergie (EDN ≤ 0,45 sur 8 h), le côté où les MÈCHES
// dominent est le côté que le marché sonde sans relâche ; un plancher (plafond) testé sans cesse finit
// par céder → on entre DANS le sens des sondes (mèches basses dominantes → short, hautes → long).
// Banc (scan 1) : worst +7,63 (IS 7,63/43 OOS 9,59/22 pf 1,74) ; voisinage E1 dense positif
// (conf 8,85 · W144 7,8 · B0.2 7,9 · sec 9,53-12,05 en n faible) — fragilité connue : E2 -0,19.
const W = 96;          // fenêtre 8 h
const EN = 0.45;       // seuil de compression (marche aléatoire ~0,8)
const B = 0.10;        // déséquilibre de mèches minimal
const PAD = 288;       // warm-up

module.exports = {
  instId: "ACU-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length, out = [];
    const pAbs = new Float64Array(n), pLow = new Float64Array(n), pUp = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4];
      pAbs[i] = (i ? pAbs[i - 1] : 0) + (i ? Math.abs(c - c5[i - 1][4]) : 0);
      pLow[i] = (i ? pLow[i - 1] : 0) + Math.max(0, Math.min(o, c) - l);
      pUp[i] = (i ? pUp[i - 1] : 0) + Math.max(0, h - Math.max(o, c));
    }
    const sq = Math.sqrt(W);
    for (let i = W + PAD; i < n; i++) {
      const chemin = pAbs[i] - pAbs[i - W];
      if (chemin <= 0) continue;
      const edn = (Math.abs(c5[i][4] - c5[i - W][4]) / chemin) * sq;
      if (!(edn <= EN)) continue;
      const mLow = pLow[i] - pLow[i - W], mUp = pUp[i] - pUp[i - W];
      if (mLow + mUp <= 0) continue;
      const biais = (mLow - mUp) / (mLow + mUp);
      if (biais >= B) out.push({ i5: i, dir: -1 });       // sondes vers le bas répétées → le plancher cède
      else if (biais <= -B) out.push({ i5: i, dir: 1 });  // sondes vers le haut répétées → le plafond cède
    }
    return out;
  }
};
