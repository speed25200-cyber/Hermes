#!/usr/bin/env node
/* Rend la section « resultats » de docs/direction.md a partir de
   data/movers.json. Un rapport recopie a la main se trompe ; celui-ci
   est genere depuis le verdict, et n'ajoute aucun chiffre qui n'y soit.
   Usage : node deploy/rapport_movers.js [chemin.json] > section.md */
"use strict";
const fs = require("fs"); const path = require("path");
const f = process.argv[2] || path.join(__dirname, "..", "data", "movers.json");
const V = JSON.parse(fs.readFileSync(f, "utf8"));
const p = (x, d = 1) => x == null || !Number.isFinite(x) ? "—" : (100 * x).toFixed(d) + " %";
const n2 = (x) => x == null || !Number.isFinite(x) ? "—" : x.toFixed(2);
const pct = (x) => x == null ? "—" : Math.round(100 * x) + "e";
const L = [];
L.push(`## Résultats — mesure du ${V.genere.slice(0, 10)}`);
L.push("");
L.push(`Fenêtre ${V.fenetre.du} → ${V.fenetre.au}. ${V.instruments} instruments avec histoire, dont ${V.avecFlux} avec le flux acheteur (klines v2), ${V.avecMetrics} avec les metrics, ${V.avecBase} avec la base. Frais ${p(V.parametres.frais, 2)} et glissement ${p(V.parametres.glissement, 2)} par exécution, funding accumulé. ${V.parametres.tirages} répliques, blocs de ${V.parametres.blocBarres} bougies de 30 min. Durée ${V.duree_s} s.`);
L.push("");
const P = V.papier;
L.push("### H1 — le papier « Top 100 movers x20 »");
L.push("");
L.push("| Mesure | 88 profils, leur contrat | Profil global, movers causaux | 88 profils transportés |");
L.push("|---|---|---|---|");
L.push(`| trades | ${P.propres.n} | ${P.global.n} | ${P.transfert.n} |`);
L.push(`| taux de gain | ${p(P.propres.wr)} | ${p(P.global.wr)} | ${p(P.transfert.wr)} |`);
L.push(`| profit factor | ${n2(P.propres.pf)} | ${n2(P.global.pf)} | ${n2(P.transfert.pf)} |`);
L.push(`| brut / trade | ${p(P.propres.moyBrut, 3)} | ${p(P.global.moyBrut, 3)} | ${p(P.transfert.moyBrut, 3)} |`);
L.push(`| net / trade | ${p(P.propres.moy, 3)} | ${p(P.global.moy, 3)} | ${p(P.transfert.moy, 3)} |`);
L.push(`| t brut / t net | ${n2(P.propres.tBrut)} / ${n2(P.propres.t)} | ${n2(P.global.tBrut)} / ${n2(P.global.t)} | ${n2(P.transfert.tBrut)} / ${n2(P.transfert.t)} |`);
L.push(`| percentile du nul (t net) | ${pct(P.propres.percentileNul)} | ${pct(P.global.percentileNul)} | — |`);
L.push("");
/* La phrase depend des chiffres, pas l'inverse : si le nul produit le
   meme taux de gain que le reel, c'est la forme des sorties qui le
   fabrique ; sinon, il faut le dire aussi. */
const ecartWr = Math.abs((P.propres.wr || 0) - (P.propres.wrNulMedian || 0));
L.push(`Le papier annonce 69,25 % de gain et un PF médian de 1,52 en OOS. Ici, sur toute la fenêtre : WR ${p(P.propres.wr)}, PF ${n2(P.propres.pf)}. Le nul — mêmes règles, mêmes contrats privés de leur mémoire — donne un taux de gain médian de **${p(P.propres.wrNulMedian)}** et un PF médian de **${n2(P.propres.pfNulMedian)}**. ${ecartWr < 0.05 ? "Le hasard produit le même taux de gain : c'est la forme des sorties (stop à 1,25 %, cibles à 2–8 %) qui le fabrique, pas la prédiction." : (P.propres.wr > P.propres.wrNulMedian ? "Le réel dépasse le nul en taux de gain ; reste à voir si l'espérance par trade et le percentile suivent." : "Le réel fait moins bien que le hasard en taux de gain.")}`);
L.push("");
L.push("Par famille, sur leur propre contrat :");
L.push("");
L.push("| famille | trades | WR | PF | net / trade | t brut | t net |");
L.push("|---|---|---|---|---|---|---|");
for (const [fam, s] of Object.entries(P.propres.parFamille || {})) L.push(`| ${fam} | ${s.n} | ${p(s.wr)} | ${n2(s.pf)} | ${p(s.moy, 3)} | ${n2(s.tBrut)} | ${n2(s.t)} |`);
L.push("");
L.push(`Sorties : ${Object.entries(P.propres.sorties || {}).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
L.push("");
const parProfil = (P.parProfil || []).filter((q) => q.ici && q.ici.n >= 5);
const posit = parProfil.filter((q) => q.ici.moy > 0).length;
L.push(`Sur ${parProfil.length} profils rejouables (≥ 5 trades ici), ${posit} ont un net positif sur toute la fenêtre. Le papier en donnait ${(P.parProfil || []).filter((q) => q.oosPapier && q.oosPapier.pf > 1).length} à PF > 1 sur son OOS.`);
L.push("");
L.push("### H2–H5 — flux, positionnement, volatilité, transversal");
L.push("");
L.push("Toutes les cellules, y compris les mauvaises. Percentile : le t net réel dans la distribution des t nets des répliques.");
L.push("");
L.push("| cellule | trades / périodes | WR | brut / trade | net / trade | t brut | t net | nul médian | percentile |");
L.push("|---|---|---|---|---|---|---|---|---|");
for (const c of [...V.cellules].sort((a, b) => (b.t || 0) - (a.t || 0))) {
  const brutTr = c.famille === "transversal" ? c.brut / Math.max(1, c.n) : c.moyBrut;
  L.push(`| ${c.cellule} | ${c.n} | ${c.wr == null ? "—" : p(c.wr)} | ${p(brutTr, 3)} | ${p(c.moy, 3)} | ${n2(c.tBrut)} | ${n2(c.t)} | ${n2(c.nulMed)} | ${pct(c.pct)} |`);
}
L.push("");
if (V.famille) {
  L.push(`**Test de famille (Westfall-Young, maxT, ${V.famille.cellules} cellules)** : meilleure cellule réelle ${V.famille.meilleure}, t ${V.famille.tReel} ; médiane des maxima des répliques ${V.famille.medianDesMaxima} ; le meilleur t réel bat **${V.famille.percentile == null ? "—" : Math.round(100 * V.famille.percentile) + " %"}** des maxima de répliques. ${V.famille.percentile != null && V.famille.percentile >= 0.95 ? "Au-delà du seuil de 95 % : la famille bat le hasard." : "Sous le seuil de 95 % : rien n'est démontré au niveau de la famille."}`);
  L.push("");
}
const retenues = V.cellules.filter((c) => c.pct != null && c.pct >= 0.95 && c.t > 2 && V.famille && V.famille.percentile >= 0.95);
L.push(`### Application des règles écrites d'avance`);
L.push("");
L.push(`- Règle 1 (cellule retenue : t net > 2, percentile ≥ 95, famille ≥ 95 %) : **${retenues.length ? retenues.map((c) => c.cellule).join(", ") : "aucune cellule retenue"}**.`);
const credA = P.propres.wr >= 0.60 && P.propres.pf >= 1.2, credB = P.propres.percentileNul != null && P.propres.percentileNul >= 0.95, credC = P.transfert.t > 0;
L.push(`- Règle 2 (le papier) : (a) ordre de grandeur reproduit — ${credA ? "oui" : "non"} (WR ${p(P.propres.wr)}, PF ${n2(P.propres.pf)}) ; (b) bat 95 % du nul — ${credB ? "oui" : "non"} (${pct(P.propres.percentileNul)}) ; (c) t net > 0 en transfert — ${credC ? "oui" : "non"} (${n2(P.transfert.t)}). **${credA && credB && credC ? "Le papier est crédité." : "Le papier n'est pas crédité."}**`);
L.push(`- Règle 3 : ${V.famille && V.famille.percentile >= 0.95 ? "la grille passe le test de famille." : "**la grille échoue au test de famille : aucune de ces stratégies n'entre dans Hermes.**"}`);
process.stdout.write(L.join("\n") + "\n");
