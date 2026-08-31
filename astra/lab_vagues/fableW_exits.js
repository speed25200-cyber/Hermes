// fableW_exits — ANGLE 1 (winrate) : grille de géométrie de sorties sur les entrées
// INCHANGÉES de la formule it1 (INV s>=2 + vol>=2 + accord range-24h + verrou 12h).
// Banc v3 (zéro look-ahead). Sélection pré-enregistrée dans fableW_NOTES.md :
//   shortlist = esp_IS >= 3 ET wr_IS >= 55 ET voisins ±1 cran esp_IS > 0 ; départage OOS/ep2.
// Usage : node fableW_exits.js
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
  variantes.push({ nom: `tp${tp} sl${sl} act${act} cb${cb} h${hold}`, ex, exKey: JSON.stringify(ex), lockHold: true, decide, _g: { tp, sl, act, cb, hold } });
}

const { corpus, midAout } = chargerCorpus();
const res = evaluer(corpus, midAout, variantes);

const rows = variantes.map((V, k) => ({
  V, IS: agg(res[k].aout_IS), OOS: agg(res[k].aout_OOS), EP2: agg(res[k].epoque2)
}));

// index par clé de grille pour le test de voisinage
const key = g => [g.tp, g.sl, g.act, g.cb, g.hold].join("|");
const byKey = new Map(rows.map(r => [key(r.V._g), r]));
const axes = { tp: TPs, sl: SLs, act: ACTs, cb: CBs, hold: HOLDs };
function voisins(g) {
  const out = [];
  for (const ax of Object.keys(axes)) {
    const arr = axes[ax], i = arr.indexOf(g[ax]);
    for (const j of [i - 1, i + 1]) if (j >= 0 && j < arr.length) {
      const g2 = { ...g, [ax]: arr[j] };
      const r = byKey.get(key(g2));
      if (r) out.push(r);
    }
  }
  return out;
}

const fmt = a => a.n ? `${String(a.esp).padStart(7)}% wr${String(a.wr).padStart(5)} n${String(a.n).padStart(4)}` : "  —";
const ligne = r => `${r.V.nom.padEnd(30)} IS ${fmt(r.IS)} | OOS ${fmt(r.OOS)} | ep2 ${fmt(r.EP2)}`;

// 1) paysage : top 25 par wr_IS puis par esp_IS (information, pas sélection)
console.log("\n--- top 25 par wr_IS (info) ---");
[...rows].sort((a, b) => (b.IS.wr || 0) - (a.IS.wr || 0) || (b.IS.esp || 0) - (a.IS.esp || 0)).slice(0, 25).forEach(r => console.log(ligne(r)));

// 2) SHORTLIST pré-enregistrée : esp_IS>=3 ET wr_IS>=55 ET voisins ±1 cran esp_IS>0
const shortlist = rows.filter(r => r.IS.n && r.IS.esp >= 3 && r.IS.wr >= 55 && voisins(r.V._g).every(v => v.IS.n && v.IS.esp > 0));
console.log(`\n--- SHORTLIST (${shortlist.length} cellules) — départage par min(esp_OOS, esp_ep2) puis min des wr ---`);
shortlist.sort((a, b) => {
  const ma = Math.min(a.OOS.esp ?? -99, a.EP2.esp ?? -99), mb = Math.min(b.OOS.esp ?? -99, b.EP2.esp ?? -99);
  if (mb !== ma) return mb - ma;
  const wa = Math.min(a.IS.wr ?? 0, a.OOS.wr ?? 0, a.EP2.wr ?? 0), wb = Math.min(b.IS.wr ?? 0, b.OOS.wr ?? 0, b.EP2.wr ?? 0);
  return wb - wa;
});
shortlist.forEach(r => console.log(ligne(r)));

// 3) référence it1 pour comparaison
const ref = byKey.get(key({ tp: 0.8, sl: 0.3, act: 0.3, cb: 0.1, hold: 12 }));
console.log("\nréférence it1 :", ligne(ref));
