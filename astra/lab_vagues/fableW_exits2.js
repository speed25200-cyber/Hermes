// fableW_exits2 — vue complémentaire de la même grille : top par esp_IS, et cellules
// "compromis" (esp_IS>=2.5 ET wr_IS>=52). Aucune sélection nouvelle : information pour
// constater le front esp/wr des sorties. Usage : node fableW_exits2.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const decide = (d, s, f) => { const nd = -d; return f.volSpike >= 2 && acc(nd, f.rangePos) ? nd : 0; };

const TPs = [0.4, 0.6, 0.8, 1.2];
const SLs = [0.2, 0.3];
const ACTs = [0.1, 0.2, 0.3];
const CBs = [0.05, 0.1, 0.2];
const HOLDs = [6, 12, 24];

const variantes = [];
for (const tp of TPs) for (const sl of SLs) for (const act of ACTs) for (const cb of CBs) for (const hold of HOLDs) {
  const ex = { tp, sl, act, cb, holdH: hold };
  variantes.push({ nom: `tp${tp} sl${sl} act${act} cb${cb} h${hold}`, ex, exKey: JSON.stringify(ex), lockHold: true, decide });
}

const { corpus, midAout } = chargerCorpus();
const res = evaluer(corpus, midAout, variantes);
const rows = variantes.map((V, k) => ({ V, IS: agg(res[k].aout_IS), OOS: agg(res[k].aout_OOS), EP2: agg(res[k].epoque2) }));
const fmt = a => a.n ? `${String(a.esp).padStart(7)}% wr${String(a.wr).padStart(5)} n${String(a.n).padStart(4)}` : "  —";
const ligne = r => `${r.V.nom.padEnd(30)} IS ${fmt(r.IS)} | OOS ${fmt(r.OOS)} | ep2 ${fmt(r.EP2)}`;

console.log("\n--- top 25 par esp_IS ---");
[...rows].sort((a, b) => (b.IS.esp ?? -99) - (a.IS.esp ?? -99)).slice(0, 25).forEach(r => console.log(ligne(r)));

console.log("\n--- compromis esp_IS>=2.5 ET wr_IS>=52 ---");
rows.filter(r => r.IS.n && r.IS.esp >= 2.5 && r.IS.wr >= 52)
  .sort((a, b) => (b.IS.wr ?? 0) - (a.IS.wr ?? 0)).forEach(r => console.log(ligne(r)));
