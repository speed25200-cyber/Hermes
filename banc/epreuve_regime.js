#!/usr/bin/env node
/* ============================================================================
   L'ÉPREUVE DU RÉGIME.

   Quatre questions, et la troisième est celle qui compte vraiment :

   1. Les états ont-ils le sens qu'on croit ? Une série qui monte avec
      persistance doit sortir « tendance_haussiere », une série calme
      « fourchette », une explosion de volatilité « choc ». Un module de
      régime qui ne sait pas reconnaître une tendance fabriquée sur
      commande ne reconnaîtra rien du tout.

   2. Le calcul est-il CAUSAL ? L'état à la bougie i doit être le même
      qu'on lui donne l'histoire jusqu'à i ou jusqu'à la fin des temps.
      Si ajouter des bougies futures change un état passé, le banc
      d'essai mesure une stratégie que le moteur ne peut pas jouer, et
      tous les chiffres qui suivent sont des mensonges.

   3. Le chemin VIVANT et le chemin BANC donnent-ils le même état ? Le
      moteur appelle etatMaintenant() sur 299 bougies ; le chercheur
      appelle serieEtats() sur trente jours. Deux formules pour un même
      nombre, c'est la porte ouverte à sélectionner sur un état et à en
      trader un autre. C'est exactement le défaut que modules/signaux.js
      rend impossible pour les signaux ; le régime mérite la même
      garantie.

   4. La série longue est-elle assez rapide ? La passe du chercheur doit
      tenir sous la minute ; le régime n'a pas le droit de la doubler.
   ============================================================================ */
"use strict";
const path = require("path");
const R = require(path.join(__dirname, "..", "modules", "regime.js"));

let echecs = 0;
function verifier(nom, condition, detail) {
  if (condition) { console.log(`  ok   ${nom}`); return; }
  echecs++;
  console.log(`  ECHEC ${nom}${detail ? " — " + detail : ""}`);
}

/* Un générateur reproductible : deux exécutions de l'épreuve doivent
   raconter la même histoire, sinon un échec intermittent passe pour de
   la malchance. */
function alea(graine) {
  let x = graine >>> 0;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
function gauss(rnd) {
  const u = Math.max(1e-12, rnd()), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* Fabrique n bougies 5 m à partir d'une suite de rendements. Les mèches
   sont cosmétiques ici : le module ne lit que les clôtures. */
function bougies(rendements, prix0 = 100, ts0 = 1700000000000) {
  const out = [];
  let c = prix0;
  for (let i = 0; i < rendements.length; i++) {
    const o = c;
    c = c * Math.exp(rendements[i]);
    out.push([ts0 + i * 300000, o, Math.max(o, c) * 1.0005, Math.min(o, c) * 0.9995, c, 1000]);
  }
  return out;
}

/* --- 1. Le sens des états ------------------------------------------------ */
console.log("1. Les états ont-ils le sens qu'on croit ?");

const n = R.N_JOUR * 3;
const rnd = alea(12345);

// Marche aléatoire pure : c'est la définition même d'une fourchette.
const plat = bougies(Array.from({ length: n }, () => 0.002 * gauss(rnd)));
verifier("une marche aléatoire est une fourchette",
  R.etatMaintenant(plat, null).etat === "fourchette",
  "obtenu " + R.etatMaintenant(plat, null).etat);

// Une dérive qui domine le bruit : le déplacement de 24 h dépasse
// largement ce que le hasard produirait.
const hausse = bougies(Array.from({ length: n }, () => 0.0012 + 0.002 * gauss(rnd)));
verifier("une dérive haussière est une tendance haussière",
  R.etatMaintenant(hausse, null).etat === "tendance_haussiere",
  "obtenu " + R.etatMaintenant(hausse, null).etat + " force " + (R.etatMaintenant(hausse, null).force || 0).toFixed(2));

const baisse = bougies(Array.from({ length: n }, () => -0.0012 + 0.002 * gauss(rnd)));
verifier("une dérive baissière est une tendance baissière",
  R.etatMaintenant(baisse, null).etat === "tendance_baissiere",
  "obtenu " + R.etatMaintenant(baisse, null).etat);

// Calme pendant un jour, puis la dernière heure explose.
const choc = bougies([
  ...Array.from({ length: n - R.N_HEURE }, () => 0.001 * gauss(rnd)),
  ...Array.from({ length: R.N_HEURE }, () => 0.010 * gauss(rnd)),
]);
verifier("une explosion de volatilité est un choc",
  R.etatMaintenant(choc, null).etat === "choc",
  "obtenu " + R.etatMaintenant(choc, null).etat + " ratio " + (R.etatMaintenant(choc, null).ratioVol || 0).toFixed(2));

// Le choc prime sur la tendance : une tendance qui explose reste un choc.
const tendanceQuiExplose = bougies([
  ...Array.from({ length: n - R.N_HEURE }, () => 0.0012 + 0.002 * gauss(rnd)),
  ...Array.from({ length: R.N_HEURE }, () => 0.012 * gauss(rnd)),
]);
verifier("le choc prime sur la tendance",
  R.etatMaintenant(tendanceQuiExplose, null).etat === "choc",
  "obtenu " + R.etatMaintenant(tendanceQuiExplose, null).etat);

// Histoire trop courte : on dit « inconnu », on n'invente pas.
verifier("une histoire trop courte donne inconnu",
  R.etatMaintenant(plat.slice(-50), null).etat === "inconnu");

/* --- 2. La causalité ----------------------------------------------------- */
console.log("2. Le calcul est-il causal ?");

const melange = [];
{
  const r2 = alea(999);
  for (let i = 0; i < R.N_JOUR * 6; i++) {
    // Trois phases : calme, tendance, choc — pour que la série visite
    // vraiment les quatre états et que la comparaison ait du contenu.
    const phase = Math.floor(i / (R.N_JOUR * 2));
    if (phase === 0) melange.push(0.002 * gauss(r2));
    else if (phase === 1) melange.push(0.0015 + 0.002 * gauss(r2));
    else melange.push((i % 40 < 6 ? 0.010 : 0.002) * gauss(r2));
  }
}
const serieMelange = bougies(melange);
const complet = R.serieEtats(serieMelange, null);
const tronque = R.serieEtats(serieMelange.slice(0, serieMelange.length - 200), null);
let divergences = 0;
for (let i = 0; i < tronque.length; i++) {
  const a = complet[i], b = tronque[i];
  if ((a && a.etat) !== (b && b.etat)) divergences++;
}
verifier("tronquer le futur ne change aucun état passé", divergences === 0, divergences + " divergence(s)");

const etatsVus = new Set(complet.filter(Boolean).map((e) => e.etat));
verifier("la série d'épreuve visite au moins trois états", etatsVus.size >= 3,
  "vus : " + [...etatsVus].join(", "));

/* --- 3. Parité entre le chemin vivant et le chemin banc ------------------ */
console.log("3. Le moteur vivant et le banc calculent-ils le même état ?");

let compares = 0, desaccords = 0;
// Le moteur voit 299 bougies closes : on lui donne exactement cela, à
// des instants tirés au hasard dans la série, et on compare à la série
// complète. 299 est plus court que ce que serieEtats a en mémoire — si
// la fenêtre du module dépassait 299, le désaccord apparaîtrait ici.
const rnd3 = alea(4242);
for (let k = 0; k < 200; k++) {
  const i = R.N_JOUR + 5 + Math.floor(rnd3() * (serieMelange.length - R.N_JOUR - 6));
  const vue = serieMelange.slice(Math.max(0, i - 298), i + 1);
  const vivant = R.etatMaintenant(vue, null);
  const banc = complet[i];
  if (!banc) continue;
  compares++;
  if (vivant.etat !== banc.etat) desaccords++;
}
verifier(`${compares} comparaisons vivant/banc, aucun désaccord`, desaccords === 0, desaccords + " désaccord(s)");

// Et avec ETH : l'alignement se fait par horodatage, pas par indice.
// On décale ETH d'une bougie pour vérifier que le module ne se contente
// pas de faire confiance aux indices.
const rndE = alea(31337);
const eth = bougies(Array.from({ length: R.N_JOUR * 6 }, () => 0.0025 * gauss(rndE)), 200);
const avecEth = R.serieEtats(serieMelange, eth);
const ethDecale = eth.slice(1);
const avecEthDecale = R.serieEtats(serieMelange, ethDecale);
let alignes = 0;
for (let i = 0; i < avecEth.length; i++) if (avecEth[i] && avecEthDecale[i] && avecEth[i].etat === avecEthDecale[i].etat) alignes++;
verifier("ETH est aligné par horodatage (un décalage ne casse pas tout)",
  alignes > 0, "aucun état commun");

/* --- 3 bis. La recherche d'état par horodatage --------------------------- */
console.log("3 bis. La recherche d'état par horodatage tient-elle les trous ?");

const idx = R.indexEtats(serieMelange, complet);
verifier("l'index ne garde que les bougies classées", idx.ts.length === complet.filter(Boolean).length);

const iRef = idx.ts.length - 1;
verifier("l'état à un horodatage exact est celui de la bougie",
  R.etatA(idx, idx.ts[iRef]) === idx.etat[iRef]);

// Entre deux bougies : le DERNIER état connu, jamais le suivant.
verifier("entre deux bougies, c'est le dernier état connu",
  R.etatA(idx, idx.ts[100] + 120000) === idx.etat[100]);

verifier("avant la première bougie classée, c'est inconnu",
  R.etatA(idx, idx.ts[0] - 1) === "inconnu");

// Un état vieux de plus d'une heure ne vaut plus rien.
verifier("un état trop vieux redevient inconnu",
  R.etatA(idx, idx.ts[iRef] + 2 * 3600e3) === "inconnu");

// Le trou : on retire cent bougies au milieu de l'index et on vérifie
// que la recherche rend l'état d'avant le trou, pas « inconnu ».
const troue = { ts: [...idx.ts.slice(0, 500), ...idx.ts.slice(560)],
                etat: [...idx.etat.slice(0, 500), ...idx.etat.slice(560)] };
verifier("un trou de cinq minutes ne rend pas inconnu",
  R.etatA(troue, idx.ts[502]) === idx.etat[499],
  "obtenu " + R.etatA(troue, idx.ts[502]));

/* --- 4. Le coût ---------------------------------------------------------- */
console.log("4. La série longue est-elle assez rapide ?");
const rndL = alea(5150);
const tresLongue = bougies(Array.from({ length: 30 * 288 }, () => 0.002 * gauss(rndL)));
const t0 = Date.now();
for (let k = 0; k < 10; k++) R.serieEtats(tresLongue, tresLongue);
const ms = (Date.now() - t0) / 10;
verifier(`trente jours de 5 m en ${ms.toFixed(1)} ms (budget 60 ms)`, ms < 60, ms.toFixed(1) + " ms");

console.log(echecs === 0 ? "\nÉPREUVE DU RÉGIME : verte." : `\nÉPREUVE DU RÉGIME : ${echecs} échec(s).`);
process.exit(echecs === 0 ? 0 : 1);
