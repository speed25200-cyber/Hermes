// LEVIER PRIX D'ENTRÉE (retracement) appliqué à PIEVERSE (base : web_structure_1.js, EN_LIVE, record du
// banc +7,98 registre). Signal INCHANGÉ (double bottom/top intraday W144, tol 0,3 %, rebond 1 %) ; au lieu
// d'entrer au close de la bougie de signal, on place un ordre LIMITE à -0,5 % du close (long) / +0,5 %
// (short), annulé si aucune des 3 bougies suivantes ne le touche (low<=limite en long, high>=limite en
// short — jamais de futur). Logique en une phrase : sur un double creux/sommet, exiger UN CRAN d'extension
// supplémentaire avant d'entrer filtre les faux départs qui repartent aussitôt sans jamais redonner de prix.
// ⚠️ Évaluation : PAS test_harness.js (harness_lib.sim entre toujours au close) — utiliser
// `node tools/wr_retrace_verify.js candidates/wr_retrace_1.js` (simulateur dédié tools/wr_retrace_lib.js).
//
// AVANT (entrée close, node test_harness.js web_structure_1.js) : wrIS 60,8 / wrOOS 72,0 — IS SOUS 65 %.
//   espIS +12,58 / espOOS +14,94 (n 51+25).
// APRÈS (retrace -0,5 % / fenêtre 3 bougies) : wrIS 66,7 / wrOOS 70,6 — LES DEUX >= 65 %.
//   espIS +13,65 (+8,5 % vs avant) / espOOS +15,07 (+0,9 % vs avant) — espérance MEILLEURE des 2 côtés,
//   pas seulement préservée. n 36+17 (remplissage ~29 % des signaux, 71 % annulés/jamais touchés).
// Robustesse (grille -0,2/-0,3/-0,5 % x fenêtre 3/4/5/6, cf. tools/rapports/wr_retrace_scan_resultats.json) :
//   la hausse de wrIS avec le retracement est un TREND MONOTONE et cohérent sur les 4 fenêtres (retr 0,2->0,3
//   ->0,5 % : wrIS 59,6->61,9->66,7 à w3 ; 56,3->59,1->62,5 à w4 ; etc.) — pas un pic isolé, mais SEULE la
//   fenêtre la plus courte (3 bougies = rebond rapide) franchit effectivement la barre 65 % dans cette grille
//   grossière ; les fenêtres 4-6 restent juste en dessous (61-63 %) tout en gardant esp positive des 2 côtés.
const W = 144, GAP = 12, TOL = 0.003, BOUNCE = 0.01;

module.exports = {
  instId: "PIEVERSE-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 }, // inchangé vs web_structure_1
  retrace: { pct: 0.005, window: 3 }, // -0,5 % du close, annulé si non touché en 3 bougies 5m (15 min)
  detect(c5) {
    const out = [];
    for (let i = Math.max(100, W); i < c5.length; i++) {
      let mn = Infinity, mx = -Infinity, iMn = -1, iMx = -1;
      for (let k = i - W; k <= i - GAP; k++) {
        if (c5[k][3] < mn) { mn = c5[k][3]; iMn = k; }
        if (c5[k][2] > mx) { mx = c5[k][2]; iMx = k; }
      }
      const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4];
      if (l >= mn * (1 - TOL) && l <= mn * (1 + TOL) && c > o) { // 2e creux qui tient
        let rb = -Infinity;
        for (let k = iMn + 1; k < i; k++) if (c5[k][4] > rb) rb = c5[k][4];
        if (rb >= mn * (1 + BOUNCE)) out.push({ i5: i, dir: 1 });
      }
      if (h <= mx * (1 + TOL) && h >= mx * (1 - TOL) && c < o) { // 2e sommet qui tient
        let rb = Infinity;
        for (let k = iMx + 1; k < i; k++) if (c5[k][4] < rb) rb = c5[k][4];
        if (rb <= mx * (1 - BOUNCE)) out.push({ i5: i, dir: -1 });
      }
    }
    return out;
  }
};
