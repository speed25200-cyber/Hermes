// fableW_voisinage — deux contrôles restants avant de figer :
//  1) cran vol3 sur l'axe volume de C3 (voisin ±1 de vol2.5 avec ret1h contre)
//  2) attribution de la fragilité h6 : la base EXB sans filtre est-elle déjà négative à h6 ?
//  3) contrôle anti-direction : ret1h AVEC (sens inverse du filtre) sur la même géométrie/vol.
// Usage : node fableW_voisinage.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const EXB = { tp: 0.8, sl: 0.3, act: 0.2, cb: 0.2, holdH: 12 };
const EXB6 = { ...EXB, holdH: 6 };
const contre = (nd, f) => (nd > 0 && f.ret1h <= 0) || (nd < 0 && f.ret1h >= 0);
const avec = (nd, f) => (nd > 0 && f.ret1h > 0) || (nd < 0 && f.ret1h < 0);

const variantes = [
  { nom: "C3 vol2.5 (candidat)", ex: EXB, exKey: "EXB", lockHold: true, decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f) ? nd : 0; } },
  { nom: "voisin vol3 + ret1h", ex: EXB, exKey: "EXB", lockHold: true, decide: (d, s, f) => { const nd = -d; return f.volSpike >= 3 && acc(nd, f.rangePos) && contre(nd, f) ? nd : 0; } },
  { nom: "base EXB h6 SANS filtre", ex: EXB6, exKey: "EXB6", lockHold: true, decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2 && acc(nd, f.rangePos) ? nd : 0; } },
  { nom: "it1 (act0.3 cb0.1) h6", ex: { tp: 0.8, sl: 0.3, act: 0.3, cb: 0.1, holdH: 6 }, exKey: "EXF6", lockHold: true, decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2 && acc(nd, f.rangePos) ? nd : 0; } },
  { nom: "anti : vol2.5 ret1h AVEC", ex: EXB, exKey: "EXB", lockHold: true, decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) && avec(nd, f) ? nd : 0; } },
];

const { corpus, midAout } = chargerCorpus();
const res = evaluer(corpus, midAout, variantes);
const fmt = a => a.n ? `${String(a.esp).padStart(7)}% wr${String(a.wr).padStart(5)} n${String(a.n).padStart(4)}` : "        —             ";
console.log("\nvariante".padEnd(28), "aout_IS".padStart(18), "aout_OOS".padStart(24), "epoque2".padStart(24));
variantes.forEach((V, k) => {
  const a = agg(res[k].aout_IS), b = agg(res[k].aout_OOS), c = agg(res[k].epoque2);
  console.log("  " + V.nom.padEnd(26), fmt(a), " |", fmt(b), " |", fmt(c));
});
