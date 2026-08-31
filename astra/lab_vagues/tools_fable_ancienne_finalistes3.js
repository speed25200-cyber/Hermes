// Finalistes : croisement act x cb x delay autour du plateau (vol2.5, range 0.5, verrou 12h)
// + découplage verrou/hold : hold de sortie 6/24h avec verrou FIXE 12h (lockBars=144).
// Usage : node tools_fable_ancienne_finalistes3.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const decide = (d, s, f) => {
  const nd = -d;
  return f.volSpike >= 2.5 && ((nd > 0 && f.rangePos < 0.5) || (nd < 0 && f.rangePos > 0.5)) ? nd : 0;
};
const variantes = [];
for (const act of [0.2, 0.25, 0.3])
  for (const cb of [0.1, 0.15, 0.2])
    for (const delay of [0, 1]) {
      const ex = { tp: 0.8, sl: 0.3, act, cb, holdH: 12 };
      variantes.push({ nom: `act${act} cb${cb} d${delay}`, ex, exKey: JSON.stringify(ex), lockBars: 144, delay, decide });
    }
// découplage hold de sortie (verrou fixe 12h)
for (const holdH of [6, 24]) {
  const ex = { tp: 0.8, sl: 0.3, act: 0.25, cb: 0.15, holdH };
  variantes.push({ nom: `act0.25 cb0.15 d0 holdExit${holdH}h lock12h`, ex, exKey: JSON.stringify(ex), lockBars: 144, delay: 0, decide });
}

const { corpus, midAout } = chargerCorpus();
const res = evaluer(corpus, midAout, variantes);
console.log("\nformat esp%/wr%/n · vol>=2.5 range0.5 verrou 12h fixe");
console.log("variante".padEnd(40), "aout_IS".padStart(16), "aout_OOS".padStart(18), "epoque2".padStart(18));
variantes.forEach((V, k) => {
  const a = agg(res[k].aout_IS), b = agg(res[k].aout_OOS), c = agg(res[k].epoque2);
  const f = x => x.n ? `${x.esp}/${x.wr}/${x.n}` : "—";
  const pass = a.esp > 3 && b.esp > 3 && a.wr >= 55 && b.wr >= 55 ? " <<" : "";
  console.log(V.nom.padEnd(40), f(a).padStart(16), f(b).padStart(18), f(c).padStart(18), pass);
});
