// tools_fable_calib_B — Étape B : UN co-filtre unique par-dessus les 3 bases qualifiées
// de l'étape A (s>=2, range moitiés, vol ∈ {2.5, 3, 4}). AFFICHAGE aout_IS SEULEMENT.
// (La shortlist stricte de l'étape A était vide — l'axe score effondre tout voisinage ;
//  déviation documentée : on garde les 3 cellules passant esp_IS>=4 et n_IS>=65.)
// Augmentations causales attachées aux features AVANT évaluation (aucun look-ahead) :
//   f.vert        = close > open de la bougie du signal (connue à sa clôture)
//   f.volRankPrev = fraction des volSpikes des signaux PRÉCÉDENTS du même instrument < volSpike courant
//                   (fenêtre expansive, causale ; -1 tant que < 20 observations préalables)
// Usage : node tools_fable_calib_B.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const EXF = { tp: 0.80, sl: 0.30, act: 0.25, cb: 0.15, holdH: 12 };
const { corpus, midAout } = chargerCorpus();

// ---- augmentation causale des features ----
for (const inst of Object.values(corpus)) {
  const { c5, sigs } = inst;
  const prev = []; // volSpikes des signaux déjà vus (ts croissant, vérifié trié)
  for (const s of sigs) {
    s.f.vert = c5[s.i][4] > c5[s.i][1];
    if (prev.length >= 20) {
      let lt = 0;
      for (const v of prev) if (v < s.f.volSpike) lt++;
      s.f.volRankPrev = lt / prev.length;
    } else s.f.volRankPrev = -1;
    prev.push(s.f.volSpike);
  }
}

const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const bases = [
  ["vol>=2.5", f => f.volSpike >= 2.5],
  ["vol>=3", f => f.volSpike >= 3],
  ["vol>=4", f => f.volSpike >= 4],
];
const filtres = [["ref (aucun)", () => true]];
for (const R of [40, 35, 30]) filtres.push([`rsi accord ${R}`, (f, nd) => (nd > 0 && f.rsi < R) || (nd < 0 && f.rsi > 100 - R)]);
for (const M of [0.2, 0.3, 0.4]) filtres.push([`meche accord ${M}`, (f, nd) => (nd > 0 && f.mecheBasse >= M) || (nd < 0 && f.mecheHaute >= M)]);
filtres.push(["reprise (close sens trade)", (f, nd) => (nd > 0 && f.vert) || (nd < 0 && !f.vert)]);
filtres.push(["ret1h contre", (f, nd) => (nd > 0 && f.ret1h <= 0) || (nd < 0 && f.ret1h >= 0)]);
filtres.push(["ret1h avec", (f, nd) => (nd > 0 && f.ret1h > 0) || (nd < 0 && f.ret1h < 0)]);
filtres.push(["heure 00-11 UTC", f => f.hour < 12]);
filtres.push(["heure 12-23 UTC", f => f.hour >= 12]);

const variantes = [];
for (const [bNom, bf] of bases)
  for (const [fNom, ff] of filtres)
    variantes.push({
      nom: `${bNom} + ${fNom}`, lockHold: true, ex: EXF, exKey: "EXF",
      decide: (d, s, f) => { const nd = -d; return bf(f) && acc(nd, f.rangePos) && ff(f, nd) ? nd : 0; }
    });
// branche per-crypto : percentile causal REMPLACE le seuil global de volume
for (const P of [0.7, 0.8])
  variantes.push({
    nom: `vol per-crypto p${P * 100} (fallback 2.5) + ref`, lockHold: true, ex: EXF, exKey: "EXF",
    decide: (d, s, f) => {
      const nd = -d;
      const volOK = f.volRankPrev >= 0 ? f.volRankPrev >= P : f.volSpike >= 2.5;
      return volOK && acc(nd, f.rangePos) ? nd : 0;
    }
  });

const res = evaluer(corpus, midAout, variantes);
console.log("\n=== ÉTAPE B — co-filtre unique, aout_IS SEULEMENT ===");
console.log("(adoption : wr_IS >= base+1 ET esp_IS >= 4 ET n_IS >= 60)\n");
const baseWr = {};
variantes.forEach((V, k) => {
  const a = agg(res[k].aout_IS);
  const b = V.nom.split(" + ")[0];
  if (V.nom.endsWith("ref (aucun)")) baseWr[b] = a.wr;
  const ok = a.n && baseWr[b] !== undefined && a.wr >= baseWr[b] + 1 && a.esp >= 4 && a.n >= 60;
  console.log((ok ? "* " : "  ") + V.nom.padEnd(44), a.n ? `${String(a.esp).padStart(7)}% wr${String(a.wr).padStart(5)} n${String(a.n).padStart(4)}` : "        —");
});
console.log("\n(* = qualifié étape B)");
