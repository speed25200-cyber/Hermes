// CRO (Cronos) — « EDN / RESSORT ABSORBÉ 2H » (INVENTION, agent inv_efficacite_). Indicateur :
// Efficacité du Déplacement Normalisée EDN = (|déplacement net| / chemin en Σ|Δclose|) × √W sur
// W bougies 5 m — marche aléatoire ≈ 0,8 quel que soit W ; bas = chemin énorme pour rien.
// Lecture en 2 phrases : CRO comprimé sur 2 h (EDN ≤ 0,45) avec un déséquilibre de mèches FORT
// (≥ 0,20) = un côté est sondé et systématiquement rejeté → le ressort, chargé par ce rejet répété,
// se détend du côté du rejet ; on entre quand une bougie de reprise confirme (close ≥ open pour long).
// Banc (scan 1) : worst +7,41 (IS 7,41/38 OOS 14,92/22 pf 3,35 wr 68,2) — crypto libre. Voisinage :
// brut 6,26 v · EN0.3 4,10 (OOS 15,98) · E2 1,72 v · W96 9,9-12,8 (n minuscule) — fragilité connue :
// B0.1 négatif, le déséquilibre FORT est l'edge (les demi-signaux diluent).
const W = 24;          // fenêtre 2 h
const EN = 0.45;       // seuil de compression (marche aléatoire ~0,8)
const B = 0.20;        // déséquilibre de mèches FORT exigé
const PAD = 288;       // warm-up

module.exports = {
  instId: "CRO-USDT-SWAP",
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
      if (biais >= B && c >= o) out.push({ i5: i, dir: 1 });        // rejet du bas répété + reprise haussière
      else if (biais <= -B && c <= o) out.push({ i5: i, dir: -1 }); // rejet du haut répété + reprise baissière
    }
    return out;
  }
};
