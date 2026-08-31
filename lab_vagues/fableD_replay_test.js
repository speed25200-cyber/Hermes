// fableD_replay_test.js — VALIDATION du module ombre (fableD_ombre_inverse.js) par replay.
// Preuve exigée avant tout branchement : le module live, nourri bougie par bougie et signal
// par signal comme en production, doit reproduire TRADE PAR TRADE le banc v3 officiel
// (tools_fable_ancienne_banc3.js, formule V2 : INV s>=2 · vol>=2.5 · range 0.5 · verrou 12 h ·
// tp80/sl30/act25/cb15/hold12 · levier 15 · coûts 0,12 %).
//
// Phases :
//   1. référence : banc3.evaluer par instrument (_ts = [tsSignal, pnlFraction] par trade)
//   2. replay    : module alimenté séquentiellement (signaux bruts + bougies closes) ;
//                  comparaison par clé instId|entryBarTs, pnl à 1e-9 près
//   3. restart   : coupe le replay au milieu sur l'instrument le plus actif, restaure depuis
//                  le journal, reprend — les trades doivent rester identiques
// Usage : node fableD_replay_test.js
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const LAB = __dirname;
const { chargerCorpus, evaluer, LEV } = require(path.join(LAB, "tools_fable_ancienne_banc3.js"));
const M = require(path.join(LAB, "fableD_ombre_inverse.js"));

const STEP = 300000;
const SCRATCH = process.env.FABLED_SCRATCH || os.tmpdir();
const conv = r => ({ ts: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] });

/* ---- candidat de référence = FORMULE FINALE V2 (identique à tools_fable_ancienne_final2.js) ---- */
const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const EXF = { tp: 0.80, sl: 0.30, act: 0.25, cb: 0.15, holdH: 12 };
const CAND = {
  nom: "V2", lockHold: true, ex: EXF, exKey: "EXF",
  decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) ? nd : 0; }
};

/* ---- signaux bruts par instrument ---- */
const sigTous = JSON.parse(fs.readFileSync(path.join(LAB, "fable_signaux.json")));
const parInst = {};
for (const s of sigTous) (parInst[s[1]] = parInst[s[1]] || []).push(s);

const { corpus, midAout } = chargerCorpus();

/* ================= phase 1 : référence banc3, par instrument ================= */
const refMap = new Map(); // "inst|entryBarTs" -> pnlPct (marge, levier 15)
for (const [instId, inst] of Object.entries(corpus)) {
  const res = evaluer({ [instId]: inst }, midAout, [CAND]);
  for (const [ts, pnl] of res[0]._ts) {
    const entryBarTs = ts - (ts % STEP) + STEP;
    refMap.set(instId + "|" + entryBarTs, pnl * LEV * 100);
  }
}
console.log("référence banc3 (V2) :", refMap.size, "trades");

/* ================= phase 2 : replay du module ================= */
const F1 = path.join(SCRATCH, "fableD_replay_v2.jsonl");
try { fs.unlinkSync(F1); } catch {}
M._reset({ fichier: F1, variantes: ["v2"], seuil: 2, garde289: true });

function rejouer(instId, c5, sigs, iDebut, pDebut) {
  let p = pDebut;
  for (let i = Math.max(1, iDebut); i < c5.length; i++) {
    const closed = c5[i - 1];
    while (p < sigs.length && sigs[p][0] < closed[0]) p++;
    while (p < sigs.length && sigs[p][0] < closed[0] + STEP) {
      M.onSignal(instId, sigs[p][2], sigs[p][3], sigs[p][0]);
      p++;
    }
    M._barClose(instId, conv(closed), conv(c5[i]));
  }
  M._barClose(instId, conv(c5[c5.length - 1]), null); // gestion de la dernière bougie (pas d'entrée possible)
  M._flush(instId);                                    // troncature fin de données (= EDGE du banc)
  return p;
}

for (const [instId, inst] of Object.entries(corpus)) {
  rejouer(instId, inst.c5, parInst[instId] || [], 1, 0);
}

/* ---- lecture du journal replay ---- */
function lireCloses(fichier) {
  const map = new Map();
  for (const l of fs.readFileSync(fichier, "utf8").split("\n")) {
    if (!l) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.event === "OMBRE_CLOSE" && j.v === "v2")
      map.set(j.instId + "|" + j.entryBarTs, { pnl: j.pnlBrut, raison: j.raison });
  }
  return map;
}
const repMap = lireCloses(F1);
console.log("replay module (v2)   :", repMap.size, "trades ·", F1);

/* ---- comparaison trade par trade ---- */
const TOL = 1e-9;
let identiques = 0, differents = 0;
const seulReplay = [], seulRef = [], diffs = [];
for (const [k, r] of repMap) {
  if (!refMap.has(k)) { seulReplay.push(k); continue; }
  if (Math.abs(refMap.get(k) - r.pnl) <= TOL) identiques++;
  else { differents++; diffs.push([k, refMap.get(k), r.pnl, r.raison]); }
}
for (const k of refMap.keys()) if (!repMap.has(k)) seulRef.push(k);

/* ---- classification des trades vus SEULEMENT par le replay (gardes de corpus du banc) ---- */
function idxOf(c5, t) {
  let lo = 0, hi = c5.length - 1;
  while (lo <= hi) { const m2 = (lo + hi) >> 1; if (c5[m2][0] === t) return m2; if (c5[m2][0] < t) lo = m2 + 1; else hi = m2 - 1; }
  return -1;
}
const cat = { garde2h: 0, derniereBougie: 0, hist289: 0, inexplique: [] };
for (const k of seulReplay) {
  const sep = k.lastIndexOf("|"), instId = k.slice(0, sep), entryBarTs = +k.slice(sep + 1);
  const c5 = corpus[instId] ? corpus[instId].c5 : null;
  const i = c5 ? idxOf(c5, entryBarTs - STEP) : -1;
  if (i < 0) { cat.inexplique.push(k); continue; }
  if (i >= c5.length - 24 || (c5[i + 24] && c5[i + 24][0] !== c5[i][0] + 24 * STEP)) { cat.garde2h++; continue; }
  if (i + 1 >= c5.length - 1) { cat.derniereBougie++; continue; }
  if (i < 288 || c5[i - 288][0] !== c5[i][0] - 288 * STEP) { cat.hist289++; continue; }
  cat.inexplique.push(k);
}

console.log("\n===== COMPARAISON module live vs banc v3 (formule V2) =====");
console.log("trades communs pnl IDENTIQUE (1e-9) :", identiques);
console.log("trades communs pnl DIFFÉRENT       :", differents);
if (diffs.length) for (const d of diffs.slice(0, 10)) console.log("  DIFF", d[0], "ref", d[1].toFixed(6), "replay", d[2].toFixed(6), d[3]);
console.log("réplay seulement                   :", seulReplay.length,
  `(garde-2h-futur banc: ${cat.garde2h} · dernière bougie: ${cat.derniereBougie} · hist289: ${cat.hist289} · inexpliqué: ${cat.inexplique.length})`);
if (cat.inexplique.length) for (const k of cat.inexplique.slice(0, 10)) console.log("  INEXPLIQUE", k);
console.log("référence seulement                :", seulRef.length);
if (seulRef.length) for (const k of seulRef.slice(0, 10)) console.log("  REF_SEUL", k);

/* ---- agrégats du replay (sanité, à comparer aux chiffres officiels de final2) ---- */
function agg2(l) {
  const n = l.length;
  if (!n) return { n: 0 };
  const w = l.filter(p => p > 0).length, s = l.reduce((a, b) => a + b, 0);
  return { n, wr: +(100 * w / n).toFixed(1), esp: +(s / n).toFixed(2) };
}
const eras = { aout_IS: [], aout_OOS: [], epoque2: [] };
for (const [k, r] of repMap) {
  if (!refMap.has(k)) continue;                       // mêmes trades que le banc pour comparer à périmètre égal
  const ts = +k.slice(k.lastIndexOf("|") + 1) - STEP; // ~ ts bougie signal
  const era = ts >= Date.parse("2026-08-01") ? (ts <= midAout ? "aout_IS" : "aout_OOS") : "epoque2";
  eras[era].push(r.pnl);
}
console.log("\nagrégats replay (périmètre commun banc) :");
for (const e of Object.keys(eras)) {
  const a = agg2(eras[e]);
  console.log("  " + e.padEnd(9), a.n ? `esp ${a.esp}% · wr ${a.wr}% · n ${a.n}` : "—");
}

/* ================= phase 3 : test de restart (persistance) ================= */
let instActif = null, maxN = 0;
{
  const parI = {};
  for (const k of refMap.keys()) {
    const id = k.slice(0, k.lastIndexOf("|"));
    parI[id] = (parI[id] || 0) + 1;
    if (parI[id] > maxN) { maxN = parI[id]; instActif = id; }
  }
}
if (instActif) {
  const c5 = corpus[instActif].c5, sigs = parInst[instActif] || [];
  const F2 = path.join(SCRATCH, "fableD_replay_restart.jsonl");
  const F3 = path.join(SCRATCH, "fableD_replay_continu.jsonl");
  try { fs.unlinkSync(F2); } catch {}
  try { fs.unlinkSync(F3); } catch {}

  // continu
  M._reset({ fichier: F3, variantes: ["v2"], seuil: 2, garde289: true });
  rejouer(instActif, c5, sigs, 1, 0);
  const contMap = lireCloses(F3);

  // interrompu au milieu + restauration depuis le journal
  const m = Math.floor(c5.length / 2);
  M._reset({ fichier: F2, variantes: ["v2"], seuil: 2, garde289: true });
  {
    let p = 0;
    for (let i = 1; i < m; i++) {
      const closed = c5[i - 1];
      while (p < sigs.length && sigs[p][0] < closed[0]) p++;
      while (p < sigs.length && sigs[p][0] < closed[0] + STEP) { M.onSignal(instActif, sigs[p][2], sigs[p][3], sigs[p][0]); p++; }
      M._barClose(instActif, conv(closed), conv(c5[i]));
    }
  }
  // === RESTART SIMULÉ ===
  M._reset({ fichier: F2, variantes: ["v2"], seuil: 2, garde289: true });
  M._restaurer();
  M._seedRing(instActif, c5.slice(Math.max(0, m - 1 - 320), m - 1).map(conv)); // ≈ préfill REST + WS au boot
  {
    let p = 0;
    while (p < sigs.length && sigs[p][0] < c5[m - 1][0]) p++;
    rejouer(instActif, c5, sigs, m, p);
  }
  const restMap = lireCloses(F2);

  let idem = 0, diff = 0, manque = 0, extra = 0;
  for (const [k, r] of contMap) {
    if (!restMap.has(k)) { manque++; continue; }
    if (Math.abs(restMap.get(k).pnl - r.pnl) <= TOL) idem++; else diff++;
  }
  for (const k of restMap.keys()) if (!contMap.has(k)) extra++;
  console.log(`\n===== TEST RESTART (${instActif}, coupe à la bougie ${m}/${c5.length}) =====`);
  console.log(`trades continus: ${contMap.size} · après restart: ${restMap.size} · identiques: ${idem} · différents: ${diff} · manquants: ${manque} · en trop: ${extra}`);
}

console.log("\nVERDICT :", (differents === 0 && seulRef.length === 0 && cat.inexplique.length === 0)
  ? "PORT FIDÈLE — le module reproduit le banc v3 trade par trade"
  : "ÉCARTS À EXPLIQUER — voir ci-dessus");
