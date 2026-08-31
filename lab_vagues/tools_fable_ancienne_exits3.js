// Grille de sorties sur la formule centrale (banc3, exécution honnête).
// decide : INV + vol>=VOLX + accord range-24h (0,5/0,5), verrou hold12h depuis l'entrée.
// Sélection sur aout_IS (esp ET wr), OOS/ep2 en juges. Usage :
//   node tools_fable_ancienne_exits3.js [VOLX]     (défaut 2)
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const VOLX = +(process.argv[2] || 2);
const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const decide = (d, s, f) => { const nd = -d; return f.volSpike >= VOLX && acc(nd, f.rangePos) ? nd : 0; };

const exs = [];
for (const tp of [0.4, 0.5, 0.6, 0.8, 1.2])
  for (const sl of [0.2, 0.3])
    for (const act of [0.15, 0.2, 0.3])
      for (const cb of [0.05, 0.1, 0.15])
        for (const holdH of [6, 12, 24])
          exs.push({ tp, sl, act, cb, holdH });

const { corpus, midAout } = chargerCorpus();
const variantes = exs.map(ex => ({
  nom: `tp${ex.tp} sl${ex.sl} act${ex.act} cb${ex.cb} h${ex.holdH}`,
  ex, exKey: JSON.stringify(ex), lockHold: true, decide
}));
const res = evaluer(corpus, midAout, variantes);

const rows = variantes.map((V, k) => {
  const a = agg(res[k].aout_IS), b = agg(res[k].aout_OOS), c = agg(res[k].epoque2);
  return { nom: V.nom, a, b, c };
});
rows.sort((x, y) => (y.a.esp || -99) - (x.a.esp || -99));
console.log(`\nvol>=${VOLX} · tri par esp aout_IS · format esp%/wr%/n`);
console.log("sortie".padEnd(30), "aout_IS".padStart(18), "aout_OOS".padStart(20), "epoque2".padStart(20));
for (const r of rows.slice(0, 40))
  console.log(r.nom.padEnd(30),
    `${r.a.esp}/${r.a.wr}/${r.a.n}`.padStart(18),
    `${r.b.esp}/${r.b.wr}/${r.b.n}`.padStart(20),
    `${r.c.esp}/${r.c.wr}/${r.c.n}`.padStart(20));
console.log("\n--- celles qui passent le cahier des charges (espIS>3, espOOS>3, wrIS>=55, wrOOS>=55) ---");
for (const r of rows)
  if (r.a.esp > 3 && r.b.esp > 3 && r.a.wr >= 55 && r.b.wr >= 55)
    console.log(r.nom.padEnd(30),
      `${r.a.esp}/${r.a.wr}/${r.a.n}`.padStart(18),
      `${r.b.esp}/${r.b.wr}/${r.b.n}`.padStart(20),
      `${r.c.esp}/${r.c.wr}/${r.c.n}`.padStart(20));
