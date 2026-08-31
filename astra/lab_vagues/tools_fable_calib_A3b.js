// tools_fable_calib_A3b — ITÉRATION 3, étape A3b (amendement A6) : géométrie de sorties
// HOLD/SL/ACT sur les entrées FIGÉES des 3 meilleures cellules A3. Banc3, verrou FIXE
// 12 h (lockBars 144, découplé du hold). tp 0.8 et cb 0.15 figés.
// AFFICHAGE : aout_IS (esp/wr/n) uniquement (+ comptes n_OOS/n_ep2, constants par entrée).
// Qualification : wr_IS >= 65.5 ET esp_IS >= 4.5 ET voisins ±1 cran esp_IS >= 3.
// Choix : max famMin(wr_IS), départage wr_IS puis esp_IS. Repli : barre 65.0 ; sinon
// gel cellule 12 + EXC (NOTES A6).
// Usage : node tools_fable_calib_A3b.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const { corpus, midAout } = chargerCorpus();
// features causales supplémentaires (identiques à A3)
for (const inst of Object.values(corpus)) {
  const prevR = [];
  for (const s of inst.sigs) {
    if (prevR.length >= 20) { let lt = 0; for (const v of prevR) if (v < s.f.rangePos) lt++; s.f.rangeRankPrev = lt / prevR.length; }
    else s.f.rangeRankPrev = -1;
    prevR.push(s.f.rangePos);
  }
}
const accHalf = (nd, f) => (nd > 0 && f.rangePos < 0.5) || (nd < 0 && f.rangePos > 0.5);
const accRank = (nd, f, p) => f.rangeRankPrev < 0 ? accHalf(nd, f) : ((nd > 0 && f.rangeRankPrev <= p) || (nd < 0 && f.rangeRankPrev >= 1 - p));
const contre = (nd, f) => (nd > 0 && f.ret1h <= 0) || (nd < 0 && f.ret1h >= 0);
const B = f => f.volSpike >= 2.5;

const ENTREES = [
  ["E1: ret1h+moitiés", (d, s, f) => { const nd = -d; return B(f) && accHalf(nd, f) && contre(nd, f) ? nd : 0; }],
  ["E12: cap+ret1h", (d, s, f) => { const nd = -d; return s < 2.5 && B(f) && accHalf(nd, f) && contre(nd, f) ? nd : 0; }],
  ["E4: ret1h+rangeRank p50", (d, s, f) => { const nd = -d; return B(f) && accRank(nd, f, 0.5) && contre(nd, f) ? nd : 0; }],
];
const ACTS = [0.15, 0.2, 0.25], SLS = [0.25, 0.3], HOLDS = [8, 12];

const variantes = [];
for (const [en, dec] of ENTREES)
  for (const act of ACTS)
    for (const sl of SLS)
      for (const hold of HOLDS) {
        const ex = { tp: 0.8, sl, act, cb: 0.15, holdH: hold };
        variantes.push({
          nom: `${en} act${act} sl${sl} hold${hold}`, en, act, sl, hold,
          lockBars: 144, ex, exKey: JSON.stringify(ex), decide: dec,
        });
      }

const res = evaluer(corpus, midAout, variantes);
const rows = variantes.map((V, k) => ({
  ...V, a: agg(res[k].aout_IS), nOOS: res[k].aout_OOS.length, nEp2: res[k].epoque2.length,
}));
const voisins = r => rows.filter(x => x.en === r.en && (
  (x.sl === r.sl && x.hold === r.hold && Math.abs(ACTS.indexOf(x.act) - ACTS.indexOf(r.act)) === 1) ||
  (x.act === r.act && x.hold === r.hold && x.sl !== r.sl) ||
  (x.act === r.act && x.sl === r.sl && x.hold !== r.hold)));

console.log("\n=== ÉTAPE A3b — sorties hold/sl/act sur entrées A3 figées · tp0.8 cb0.15 · verrou fixe 12h · aout_IS SEUL ===");
console.log("(qualif : wr_IS >= 65.5, esp_IS >= 4.5, voisins ±1 cran esp_IS >= 3)\n");
let enCur = "";
for (const r of rows) {
  if (r.en !== enCur) { enCur = r.en; console.log("-- " + enCur + `  (n_IS ${r.a.n} · n_OOS ${r.nOOS} · n_ep2 ${r.nEp2})`); }
  console.log(`   act${String(r.act).padEnd(4)} sl${String(r.sl).padEnd(4)} hold${String(r.hold).padEnd(2)}  esp_IS ${String(r.a.esp).padStart(7)}%  wr_IS ${String(r.a.wr).padStart(5)}`);
}
function classer(bar) {
  const q = rows.filter(r => r.a.n && r.a.wr >= bar && r.a.esp >= 4.5 && voisins(r).every(v => v.a.esp >= 3));
  for (const r of q) r.famMin = Math.min(r.a.wr, ...voisins(r).map(v => v.a.wr));
  q.sort((x, y) => y.famMin - x.famMin || y.a.wr - x.a.wr || y.a.esp - x.a.esp);
  return q;
}
let bar = 65.5, q = classer(bar);
if (!q.length) { bar = 65.0; q = classer(bar); }
console.log(`\nQUALIFIÉES (barre wr_IS >= ${bar}, classement famMin/wr/esp) :`);
for (const r of q) console.log(`  ${r.nom} · famMin ${r.famMin} · esp_IS ${r.a.esp}% wr_IS ${r.a.wr}% n_IS ${r.a.n}`);
if (!q.length) console.log("  (vide aux deux barres) -> REPLI pré-enregistré : cellule 12 + EXC (NOTES A6).");
