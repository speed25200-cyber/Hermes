// tools_fable_calib_A3 — ITÉRATION 3, étape A3 : 20 cellules, exits FIGÉS
// tp0.8/sl0.3/act0.2/cb0.15/hold12 (EXC), verrou 12 h, banc3 (zéro look-ahead).
// volRank EXCLU du menu (héritage it2 : achat d'IS payé en OOS). Axes neufs :
// percentiles de range PER-CRYPTO (causal), mèche de rejet, reprise, rsi accord,
// sévérité de range globale, fenêtre de score.
// AFFICHAGE : aout_IS (esp/wr/n) + COMPTES n_OOS et n_ep2 (aucune perf OOS/ep2).
// Qualification : wr_IS >= 66.0 ET esp_IS >= 4.5 ET n_IS >= 55 ET n_IS+n_OOS >= 130
// ET n_ep2 >= 60. Choix : max du MIN de wr_IS sur la famille (±1 cran), départage
// wr_IS puis esp_IS puis n_IS. Repli : même règle à 65 ; sinon cellule 12.
// Usage : node tools_fable_calib_A3.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const EXC = { tp: 0.8, sl: 0.3, act: 0.2, cb: 0.15, holdH: 12 };
const { corpus, midAout } = chargerCorpus();

// features causales supplémentaires (tout est connu à la clôture de la bougie signal)
for (const inst of Object.values(corpus)) {
  const prevR = [];
  for (const s of inst.sigs) {
    const b = inst.c5[s.i];
    s.f.corps = Math.sign(b[4] - b[1]); // close - open de la bougie signal
    if (prevR.length >= 20) { let lt = 0; for (const v of prevR) if (v < s.f.rangePos) lt++; s.f.rangeRankPrev = lt / prevR.length; }
    else s.f.rangeRankPrev = -1;
    prevR.push(s.f.rangePos);
  }
}

// briques
const accHalf = (nd, f) => (nd > 0 && f.rangePos < 0.5) || (nd < 0 && f.rangePos > 0.5);
const accBand = (nd, f, lo, hi) => (nd > 0 && f.rangePos < lo) || (nd < 0 && f.rangePos > hi);
const accRank = (nd, f, p) => f.rangeRankPrev < 0 ? accHalf(nd, f) : ((nd > 0 && f.rangeRankPrev <= p) || (nd < 0 && f.rangeRankPrev >= 1 - p));
const contre = (nd, f) => (nd > 0 && f.ret1h <= 0) || (nd < 0 && f.ret1h >= 0);
const meche = (nd, f, t) => (nd > 0 && f.mecheBasse >= t) || (nd < 0 && f.mecheHaute >= t);
const reprise = (nd, f) => (nd > 0 && f.corps > 0) || (nd < 0 && f.corps < 0);
const rsiAcc = (nd, f, t) => (nd > 0 && f.rsi < t) || (nd < 0 && f.rsi > 100 - t);

const mk = (nom, fam, dec) => ({ nom, fam, lockHold: true, ex: EXC, exKey: "EXC", decide: dec });
const B = f => f.volSpike >= 2.5; // base volume commune

const variantes = [
  // accord-range (ret1h en slot 1, pas de slot 2)
  mk("1. ret1h + moitiés (réf)",          "rgG:1", (d, s, f) => { const nd = -d; return B(f) && accHalf(nd, f) && contre(nd, f) ? nd : 0; }),
  mk("2. ret1h + range 0.4/0.6",          "rgG:2", (d, s, f) => { const nd = -d; return B(f) && accBand(nd, f, 0.4, 0.6) && contre(nd, f) ? nd : 0; }),
  mk("3. ret1h + quartiles 0.25/0.75",    "rgG:3", (d, s, f) => { const nd = -d; return B(f) && accBand(nd, f, 0.25, 0.75) && contre(nd, f) ? nd : 0; }),
  mk("4. ret1h + rangeRank p50",          "rgR:1", (d, s, f) => { const nd = -d; return B(f) && accRank(nd, f, 0.5) && contre(nd, f) ? nd : 0; }),
  mk("5. ret1h + rangeRank p40",          "rgR:2", (d, s, f) => { const nd = -d; return B(f) && accRank(nd, f, 0.4) && contre(nd, f) ? nd : 0; }),
  mk("6. ret1h + rangeRank p30",          "rgR:3", (d, s, f) => { const nd = -d; return B(f) && accRank(nd, f, 0.3) && contre(nd, f) ? nd : 0; }),
  // slot 2 sur moitiés + ret1h
  mk("7. ret1h + mèche 0.2",              "me:1",  (d, s, f) => { const nd = -d; return B(f) && accHalf(nd, f) && contre(nd, f) && meche(nd, f, 0.2) ? nd : 0; }),
  mk("8. ret1h + mèche 0.3",              "me:2",  (d, s, f) => { const nd = -d; return B(f) && accHalf(nd, f) && contre(nd, f) && meche(nd, f, 0.3) ? nd : 0; }),
  mk("9. ret1h + reprise",                "rp",    (d, s, f) => { const nd = -d; return B(f) && accHalf(nd, f) && contre(nd, f) && reprise(nd, f) ? nd : 0; }),
  mk("10. ret1h + rsi 45/55",             "rs:1",  (d, s, f) => { const nd = -d; return B(f) && accHalf(nd, f) && contre(nd, f) && rsiAcc(nd, f, 45) ? nd : 0; }),
  mk("11. ret1h + rsi 40/60",             "rs:2",  (d, s, f) => { const nd = -d; return B(f) && accHalf(nd, f) && contre(nd, f) && rsiAcc(nd, f, 40) ? nd : 0; }),
  // fenêtre de score [2,2.5) (sévérité de base)
  mk("12. cap + ret1h",                   "cp:1",  (d, s, f) => { const nd = -d; return s < 2.5 && B(f) && accHalf(nd, f) && contre(nd, f) ? nd : 0; }),
  mk("13. cap + ret1h + range 0.4/0.6",   "cp:2",  (d, s, f) => { const nd = -d; return s < 2.5 && B(f) && accBand(nd, f, 0.4, 0.6) && contre(nd, f) ? nd : 0; }),
  mk("14. cap + ret1h + rangeRank p40",   "cp:3",  (d, s, f) => { const nd = -d; return s < 2.5 && B(f) && accRank(nd, f, 0.4) && contre(nd, f) ? nd : 0; }),
  mk("15. cap + ret1h + mèche 0.2",       "cp:4",  (d, s, f) => { const nd = -d; return s < 2.5 && B(f) && accHalf(nd, f) && contre(nd, f) && meche(nd, f, 0.2) ? nd : 0; }),
  mk("16. cap + ret1h + reprise",         "cp:5",  (d, s, f) => { const nd = -d; return s < 2.5 && B(f) && accHalf(nd, f) && contre(nd, f) && reprise(nd, f) ? nd : 0; }),
  // sans ret1h (per-crypto range en substitut)
  mk("17. rangeRank p30 seul",            "nr:1",  (d, s, f) => { const nd = -d; return B(f) && accRank(nd, f, 0.3) ? nd : 0; }),
  mk("18. rangeRank p30 + mèche 0.2",     "nr:2",  (d, s, f) => { const nd = -d; return B(f) && accRank(nd, f, 0.3) && meche(nd, f, 0.2) ? nd : 0; }),
  mk("19. rangeRank p40 + reprise",       "nr:3",  (d, s, f) => { const nd = -d; return B(f) && accRank(nd, f, 0.4) && reprise(nd, f) ? nd : 0; }),
  mk("20. cap + rangeRank p30",           "nr:4",  (d, s, f) => { const nd = -d; return s < 2.5 && B(f) && accRank(nd, f, 0.3) ? nd : 0; }),
];

// familles de voisinage ±1 cran (pour le critère plateau)
const VOISINS = {
  1: [2], 2: [1, 3], 3: [2],
  4: [5], 5: [4, 6], 6: [5],
  7: [8], 8: [7],
  10: [11], 11: [10],
  12: [1], 13: [2, 12], 14: [5, 12], 15: [7, 12], 16: [9, 12],
  17: [6], 18: [17], 19: [17], 20: [17, 12],
};

const res = evaluer(corpus, midAout, variantes);
console.log("\n=== ÉTAPE A3 — 20 cellules, aout_IS SEUL + comptes n_OOS/n_ep2 · exits tp0.8/sl0.3/act0.2/cb0.15/hold12 ===");
console.log("(qualif : wr_IS >= 66.0, esp_IS >= 4.5, n_IS >= 55, n_IS+n_OOS >= 130, n_ep2 >= 60)\n");
const rows = [];
variantes.forEach((V, k) => {
  const a = agg(res[k].aout_IS);
  const nOOS = res[k].aout_OOS.length, nEp2 = res[k].epoque2.length;
  rows.push({ k: k + 1, nom: V.nom, a, nOOS, nEp2 });
});
const qualif = (r, bar) => r.a.n && r.a.wr >= bar && r.a.esp >= 4.5 && r.a.n >= 55 && r.a.n + r.nOOS >= 130 && r.nEp2 >= 60;
for (const r of rows) {
  const ok = qualif(r, 66);
  console.log((ok ? "* " : "  ") + r.nom.padEnd(36),
    r.a.n ? `esp_IS ${String(r.a.esp).padStart(7)}% wr_IS ${String(r.a.wr).padStart(5)} n_IS ${String(r.a.n).padStart(4)}` : "—".padStart(34),
    ` n_OOS ${String(r.nOOS).padStart(4)} n_ep2 ${String(r.nEp2).padStart(4)}`);
}
function classer(bar) {
  const q = rows.filter(r => qualif(r, bar));
  for (const r of q) {
    const vs = (VOISINS[r.k] || []).map(j => rows[j - 1].a.wr || 0);
    r.famMin = Math.min(r.a.wr, ...vs);
  }
  q.sort((x, y) => y.famMin - x.famMin || y.a.wr - x.a.wr || y.a.esp - x.a.esp || y.a.n - x.a.n);
  return q;
}
let q = classer(66);
let bar = 66;
if (!q.length) { q = classer(65); bar = 65; }
console.log(`\nQUALIFIÉES (barre wr_IS >= ${bar}, classement max famMin puis wr/esp/n) :`);
for (const r of q) console.log(`  ${r.nom} · famMin ${r.famMin} · esp_IS ${r.a.esp}% wr_IS ${r.a.wr}% n_IS ${r.a.n} · n_OOS ${r.nOOS} n_ep2 ${r.nEp2}`);
if (!q.length) console.log("  (vide aux deux barres) -> REPLI pré-enregistré : cellule 12 (cap + ret1h), constat honnête.");
