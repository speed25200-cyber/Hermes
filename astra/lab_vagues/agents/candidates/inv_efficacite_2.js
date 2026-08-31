// NES — « EDN / RESSORT ABSORBÉ » (INVENTION, agent inv_efficacite_). Indicateur : Efficacité du
// Déplacement Normalisée EDN = (|déplacement net| / chemin en Σ|Δclose|) × √W sur W bougies 5 m —
// marche aléatoire ≈ 0,8 quel que soit W ; EDN ≤ 0,30 = chemin énorme pour un déplacement quasi nul.
// Lecture en 2 phrases : NES comprimé (EDN ≤ 0,30 sur 4 h) avec des mèches basses dominantes = les
// ventes sont sondées et RACHETÉES bougie après bougie (absorption) → le ressort se détend du côté
// du rejet ; on entre au moment où une bougie de reprise confirme le sens (close ≥ open pour long).
// Banc (scan 1) : worst +7,60 (IS 7,60/39 OOS 12,09/25 pf 2,04) — bat le champion NES en place
// (gen_regime_1, 6,61). Voisinage : B0.2 10,61 et W144 7,59 (n insuffisant), EN0.45 4,92 v, brut 3,88 v,
// E2 2,12 v — fragilité connue : W24/W96 négatifs, l'échelle 4 h est LE tempo de compression de NES.
const W = 48;          // fenêtre 4 h
const EN = 0.30;       // seuil de compression (marche aléatoire ~0,8)
const B = 0.10;        // déséquilibre de mèches minimal
const PAD = 288;       // warm-up

module.exports = {
  instId: "NES-USDT-SWAP",
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
      const o = c5[i][1], c = c5[i][4];
      if (biais >= B && c >= o) out.push({ i5: i, dir: 1 });        // absorption des ventes + reprise haussière
      else if (biais <= -B && c <= o) out.push({ i5: i, dir: -1 }); // absorption des achats + reprise baissière
    }
    return out;
  }
};
