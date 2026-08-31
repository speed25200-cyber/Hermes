// fableW_filtre — ANGLE 1 (winrate) : UN filtre supplémentaire unique par-dessus la formule it1,
// testé sur 2 géométries de sorties issues de fableW_exits :
//   EXA = it1 avec cb 0.2 (act0.3)  -> même wr, esp_IS 5.71 (domine it1 en IS)
//   EXB = act0.2 cb0.2              -> wr 54/62.3/75.5, esp 4.27/7.69/15.23
// Critère pré-enregistré : wr_IS >= 55, esp > 3 partout, n aout (IS+OOS) >= 100, plateau sur
// l'axe de sévérité du filtre. Usage : node fableW_filtre.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const base = (d, s, f) => { const nd = -d; return f.volSpike >= 2 && acc(nd, f.rangePos) ? nd : 0; };

const EXA = { tp: 0.8, sl: 0.3, act: 0.3, cb: 0.2, holdH: 12 };
const EXB = { tp: 0.8, sl: 0.3, act: 0.2, cb: 0.2, holdH: 12 };

// menu de filtres uniques (chacun = une famille avec axe de sévérité)
const filtres = [];
filtres.push(["ref (aucun)", () => true]);
for (const S of [2.1, 2.2, 2.3, 2.5]) filtres.push([`score>=${S}`, (s, f) => s >= S]);
for (const V of [2.5, 3, 4]) filtres.push([`vol>=${V}`, (s, f) => f.volSpike >= V]);
for (const [nom, lo, hi] of [["rng 0.4/0.6", 0.4, 0.6], ["rng 0.3/0.7", 0.3, 0.7], ["rng 0.2/0.8", 0.2, 0.8]])
  filtres.push([`${nom}`, (s, f, nd) => (nd > 0 && f.rangePos < lo) || (nd < 0 && f.rangePos > hi)]);
for (const R of [45, 40, 35, 30]) filtres.push([`rsi accord ${R}`, (s, f, nd) => (nd > 0 && f.rsi < R) || (nd < 0 && f.rsi > 100 - R)]);
for (const M of [0.2, 0.3, 0.4]) filtres.push([`meche accord ${M}`, (s, f, nd) => (nd > 0 && f.mecheBasse >= M) || (nd < 0 && f.mecheHaute >= M)]);
filtres.push(["ret1h contre", (s, f, nd) => (nd > 0 && f.ret1h < 0) || (nd < 0 && f.ret1h > 0)]);
filtres.push(["ret1h avec", (s, f, nd) => (nd > 0 && f.ret1h > 0) || (nd < 0 && f.ret1h < 0)]);

const variantes = [];
for (const [exNom, ex] of [["EXA", EXA], ["EXB", EXB]])
  for (const [fNom, ff] of filtres)
    variantes.push({
      nom: `${exNom} + ${fNom}`, ex, exKey: exNom, lockHold: true,
      decide: (d, s, f) => { const nd = base(d, s, f); return nd && ff(s, f, nd) ? nd : 0; }
    });

const { corpus, midAout } = chargerCorpus();
const res = evaluer(corpus, midAout, variantes);
const fmt = a => a.n ? `${String(a.esp).padStart(7)}% wr${String(a.wr).padStart(5)} n${String(a.n).padStart(4)}` : "        —             ";
console.log("\nvariante".padEnd(28), "aout_IS".padStart(18), "aout_OOS".padStart(24), "epoque2".padStart(24));
variantes.forEach((V, k) => {
  const a = agg(res[k].aout_IS), b = agg(res[k].aout_OOS), c = agg(res[k].epoque2);
  const ok = a.n && b.n && c.n && a.wr >= 55 && b.wr >= 55 && c.wr >= 55 && a.esp > 3 && b.esp > 3 && c.esp > 3 && (a.n + b.n) >= 100;
  console.log((ok ? "* " : "  ") + V.nom.padEnd(26), fmt(a), " |", fmt(b), " |", fmt(c));
});
console.log("\n(* = passe le critère pré-enregistré : wr>=55 partout, esp>3 partout, n aout>=100)");
