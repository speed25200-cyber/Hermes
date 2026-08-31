// LEVIER PRIX D'ENTRÉE (retracement) appliqué à MEGA (base : pattern « 5 bougies 5m consécutives (fade) »
// de profond2.js, recréé à l'identique — run>=5 dans le même sens -> fade, exits = ligne "retenue" du
// scan profond2_resultats.json). Signal INCHANGÉ ; au lieu d'entrer au close de la 5e (ou N-ième) bougie
// de la série, on place un ordre LIMITE à -0,3 % du close (long) / +0,3 % (short), annulé si aucune des
// 3 bougies suivantes ne le touche. Logique en une phrase : après une série de 5 bougies dans le même sens,
// exiger encore un peu plus d'extension avant de fader filtre les faux épuisements qui ne redonnent jamais
// de prix (le vrai épuisement, lui, laisse toujours une dernière poussée avant de se retourner).
// ⚠️ Évaluation : PAS test_harness.js (harness_lib.sim entre toujours au close) — utiliser
// `node tools/wr_retrace_verify.js candidates/wr_retrace_2.js` (simulateur dédié tools/wr_retrace_lib.js).
//
// AVANT (entrée close) : wrIS 59,2 / wrOOS 60,5 — LES DEUX SOUS 65 %. espIS +5,69 / espOOS +7,88 (n 49+43).
// APRÈS (retrace -0,3 % / fenêtre 3 bougies) : wrIS 67,6 / wrOOS 65,5 — LES DEUX >= 65 % (les 2 côtés
//   franchissent la barre, alors qu'aucun ne la franchissait avant). espIS +11,42 (+100 % vs avant) /
//   espOOS +10,37 (+32 % vs avant) — espérance largement AU-DESSUS du plancher 60 %, pas seulement dessus.
//   n 37+29 (remplissage ~40 % des signaux).
// Robustesse (grille -0,2/-0,3/-0,5 % x fenêtre 3/4/5/6, cf. tools/rapports/wr_retrace_scan_resultats.json) :
//   PRUDENCE — sur l'axe fenêtre à retr fixe 0,3 %, l'OOS reste dans une bande resserrée et cohérente
//   (w3 65,5 / w4 64,5 / w5 64,5 / w6 67,7 — jamais loin de 65) mais l'IS décroît en escalier avec la
//   fenêtre (67,6 -> 60 -> 60 -> 58,5) : seule w3 franchit les DEUX côtés simultanément dans cette grille
//   grossière. Sur l'axe retracement (à w3 fixe), 0,2 % et 0,5 % s'effondrent (wrOOS 50 et 47,4) — 0,3 %
//   est un point favorable mais pas un plateau complet 2D. À confirmer en priorité par le vérificateur
//   indépendant (n modeste, echantillon plus fragile que PIEVERSE/wr_retrace_1).
const RUN_N = 5;

module.exports = {
  instId: "MEGA-USDT-SWAP",
  exits: { tp: 0.40, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 }, // = ligne "retenue" profond2 pour MEGA
  retrace: { pct: 0.003, window: 3 }, // -0,3 % du close, annulé si non touché en 3 bougies 5m (15 min)
  detect(c5) {
    const out = [];
    let run = 0, sgn = 0;
    for (let i = 1; i < c5.length; i++) {
      const d = Math.sign(c5[i][4] - c5[i - 1][4]);
      if (d !== 0 && d === sgn) run++; else { run = 1; sgn = d; }
      if (run >= RUN_N && sgn !== 0) out.push({ i5: i, dir: -sgn }); // fade du run
    }
    return out;
  }
};
