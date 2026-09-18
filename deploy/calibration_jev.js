#!/usr/bin/env node
/* ============================================================================
   LA CALIBRATION DE JEV — sur ce qu'il a VRAIMENT dit, minute par minute.

   Le decideur journalise chaque decision (data/jev-decisions.jsonl) avec
   l'etat, la reponse, la latence et le prix. Ce script relit ce journal
   et repond a la question que le fournisseur ne peut pas poser a notre
   place : quand Jev dit 0,70, a-t-il raison sept fois sur dix SUR NOS
   DONNEES ?

   Le prix a l'horizon vient du journal lui-meme : une decision par minute
   et par instrument, donc la ligne de +15 min porte le prix de +15 min.
   Quand le journal a un trou (moteur arrete, budget atteint), la decision
   est ecartee — on ne devine pas un prix.

   Trois lectures, et elles ne mesurent pas la meme chose :

     depasse_cout  le mouvement absolu a l'horizon a-t-il depasse le cout ?
                   Brier et table de fiabilite par tranche de probabilite.
     direction     quand Jev penche (pLong ≠ pShort), le signe du mouvement
                   lui a-t-il donne raison ? Justesse par tranche.
     conviction    le score 1-5 est-il monotone avec l'ampleur du mouvement ?

   Aucun reseau, aucune ecriture ailleurs que sur la sortie standard.

   Usage : node deploy/calibration_jev.js [data/jev-decisions.jsonl]
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const FICHIER = process.argv[2] || path.join(__dirname, "..", "data", "jev-decisions.jsonl");
const TOLERANCE_MS = 90000;   // le prix a l'horizon doit venir d'une bougie a +/- 1,5 min

function dire(...a) { console.log(...a); }
function pct(x) { return (100 * x).toFixed(1) + " %"; }

const lignes = [];
try {
  for (const l of fs.readFileSync(FICHIER, "utf8").split("\n")) { if (!l) continue; try { lignes.push(JSON.parse(l)); } catch {} }
} catch (e) { dire("journal illisible :", FICHIER, e.message); process.exit(1); }

dire(`=== CALIBRATION JEV — ${lignes.length} lignes dans ${FICHIER} ===`);
const signatures = new Map();
for (const l of lignes) signatures.set(l.signature, (signatures.get(l.signature) || 0) + 1);
dire("questions :", [...signatures].map(([s, n]) => `${s} (${n})`).join(", "));
if (signatures.size > 1) dire("! plusieurs jeux de questions : les tables ci-dessous les melangent — a lire par signature si les chiffres surprennent");

const parInst = new Map();
for (const l of lignes) { if (!parInst.has(l.instId)) parInst.set(l.instId, []); parInst.get(l.instId).push(l); }
for (const arr of parInst.values()) arr.sort((a, b) => a.bougie - b.bougie);

/* Les observations : une par decision avec reponse et prix a l'horizon. */
const obs = [];
let sansReponse = 0, sansHorizon = 0, tardives = 0;
const latences = [];
for (const [instId, arr] of parInst) {
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i];
    if (Number.isFinite(d.latenceMs)) latences.push(d.latenceMs);
    if (d.tardive) tardives++;
    if (!d.reponse || !d.decision) { sansReponse++; continue; }
    const horizonMs = (d.etat && d.etat.horizonMin ? d.etat.horizonMin : 15) * 60000;
    const cible = d.bougie + horizonMs;
    let fut = null;
    for (let j = i + 1; j < arr.length; j++) { if (arr[j].bougie >= cible - TOLERANCE_MS) { if (arr[j].bougie <= cible + TOLERANCE_MS) fut = arr[j]; break; } }
    if (!fut) { sansHorizon++; continue; }
    const moveBps = (fut.prix / d.prix - 1) * 1e4;
    const cout = d.etat && d.etat.coutAllerRetourBps ? d.etat.coutAllerRetourBps : 10;
    obs.push({ instId, pDepasse: d.decision.pDepasse, pLong: d.decision.pLong, pShort: d.decision.pShort, conviction: d.decision.conviction, sens: d.decision.sens,
               moveBps, depasse: Math.abs(moveBps) > cout, cout });
  }
}
latences.sort((a, b) => a - b);
const p = (q) => latences.length ? Math.round(latences[Math.min(latences.length - 1, Math.floor(q * latences.length))]) : null;
dire(`\nlatence : p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · max ${latences[latences.length - 1] ?? "—"} ms · tardives ${tardives}`);
dire(`observations exploitables : ${obs.length} · sans reponse ${sansReponse} · sans prix a l'horizon ${sansHorizon}`);
if (obs.length < 30) { dire("\nMoins de trente observations : aucune table ne serait lisible. Laisser tourner."); process.exit(0); }

/* --- depasse_cout --- */
dire("\n--- depasse_cout : « le mouvement absolu depassera-t-il le cout ? » ---");
const avecP = obs.filter((o) => typeof o.pDepasse === "number");
const brier = avecP.reduce((a, o) => a + Math.pow(o.pDepasse - (o.depasse ? 1 : 0), 2), 0) / Math.max(1, avecP.length);
const base = avecP.filter((o) => o.depasse).length / Math.max(1, avecP.length);
const brierBase = base * (1 - base);   // ce que fait un modele qui dit toujours la frequence de base
dire(`frequence de base ${pct(base)} · Brier ${brier.toFixed(4)} · Brier d'un modele constant ${brierBase.toFixed(4)} · ${brier < brierBase ? "MIEUX que constant" : "PAS mieux que constant"}`);
dire("tranche      n     annonce   observe   ecart");
for (let b = 0; b < 10; b++) {
  const lo = b / 10, hi = (b + 1) / 10;
  const t = avecP.filter((o) => o.pDepasse >= lo && (b === 9 ? o.pDepasse <= hi : o.pDepasse < hi));
  if (!t.length) continue;
  const ann = t.reduce((a, o) => a + o.pDepasse, 0) / t.length, obsv = t.filter((o) => o.depasse).length / t.length;
  dire(`${lo.toFixed(1)}–${hi.toFixed(1)}  ${String(t.length).padStart(6)}   ${pct(ann).padStart(7)}   ${pct(obsv).padStart(7)}   ${((obsv - ann) * 100).toFixed(1).padStart(5)} pts`);
}

/* --- direction --- */
dire("\n--- direction : quand Jev penche, le signe lui donne-t-il raison ? ---");
const pench = obs.filter((o) => typeof o.pLong === "number" && typeof o.pShort === "number" && o.pLong !== o.pShort && Math.abs(o.moveBps) > 0);
const juste = (o) => (o.pLong > o.pShort ? o.moveBps > 0 : o.moveBps < 0);
dire(`n ${pench.length} · justesse globale ${pct(pench.filter(juste).length / Math.max(1, pench.length))} (50 % = pile ou face)`);
dire("p du sens    n     justesse   move moyen dans le sens (bps)");
for (const [lo, hi] of [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 0.8], [0.8, 1.01]]) {
  const t = pench.filter((o) => { const m = Math.max(o.pLong, o.pShort); return m >= lo && m < hi; });
  if (!t.length) continue;
  const mv = t.reduce((a, o) => a + (o.pLong > o.pShort ? o.moveBps : -o.moveBps), 0) / t.length;
  dire(`${lo.toFixed(2)}–${Math.min(hi, 1).toFixed(2)}  ${String(t.length).padStart(6)}   ${pct(t.filter(juste).length / t.length).padStart(7)}   ${mv.toFixed(1).padStart(8)}`);
}
const prises = obs.filter((o) => o.sens);
if (prises.length) {
  const mv = prises.reduce((a, o) => a + (o.sens === "long" ? o.moveBps : -o.moveBps), 0) / prises.length;
  dire(`decisions PRISES (au-dessus des seuils) : ${prises.length} · justesse ${pct(prises.filter((o) => (o.sens === "long" ? o.moveBps > 0 : o.moveBps < 0)).length / prises.length)} · move moyen dans le sens ${mv.toFixed(1)} bps · cout moyen ${(prises.reduce((a, o) => a + o.cout, 0) / prises.length).toFixed(1)} bps`);
}

/* --- conviction --- */
dire("\n--- conviction : le score est-il monotone avec l'ampleur ? ---");
dire("score    n     |move| moyen (bps)   part > cout");
for (let s = 1; s <= 5; s++) {
  const t = obs.filter((o) => Number(o.conviction) === s);
  if (!t.length) continue;
  dire(`  ${s}   ${String(t.length).padStart(6)}   ${(t.reduce((a, o) => a + Math.abs(o.moveBps), 0) / t.length).toFixed(1).padStart(10)}        ${pct(t.filter((o) => o.depasse).length / t.length)}`);
}
dire("\nLecture : une table de fiabilite ou « observe » suit « annonce » est un modele calibre SUR NOS DONNEES. Une justesse de direction a 50 % avec un Brier egal au constant est un modele qui ne sait rien de ces minutes — et le dit honnetement.");
