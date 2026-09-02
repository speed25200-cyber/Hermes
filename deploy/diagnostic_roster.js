#!/usr/bin/env node
/* ============================================================================
   CE QUE LE MOTEUR TRADE VRAIMENT, ET SI CELA A PASSE LA PORTE DU HASARD.

   La regle du depot est « pas de perle, pas de trade », et la porte du
   hasard l'a durcie le 2 septembre : une perle ne vaut que si elle bat
   ce que la MEME recherche produit sur le MEME instrument prive de sa
   memoire. Onze candidates, trois retenues.

   Mais une regle ne vaut que si elle s'applique a ce qui tourne. Le
   journal de demarrage dit :

     [HERMES15] actif — 4 perle(s) au roster
                (repli du 31/08 tant que le chercheur n'a pas ecrit)

   Quatre, la ou la recherche gardee en avait rendu trois, et un repli
   date du 31 aout — anterieur a la porte. Si le moteur trade un roster
   ecrit avant la porte, alors la porte ne protege rien et tous les
   refus de la journee sont decoratifs.

   Ce script ne fait que lire le roster en place et repondre a une seule
   question, perle par perle : porte-t-elle la trace de son epreuve du
   hasard, et cette trace passe-t-elle le seuil ?

   Une perle SANS trace n'est pas une perle recalee — c'est une perle
   qui n'a jamais ete jugee, ce qui est pire, parce que rien dans
   l'affichage ne la distingue d'une perle validee.

   Lit config/roster.json. N'ecrit rien. Ne place aucun ordre.
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");
const SEUIL = Number(process.env.PERLES_NULL_PERCENTILE || 0.90);

function main() {
  const chemin = path.join(RACINE, "config", "roster.json");
  let r;
  try { r = JSON.parse(fs.readFileSync(chemin, "utf8")); }
  catch (e) { console.error(`[ROSTER] illisible : ${e.message}`); process.exit(1); }

  const perles = r.perles || {};
  const noms = Object.keys(perles);
  console.log(`[ROSTER] fichier : ${chemin}`);
  console.log(`[ROSTER] ecrit le : ${r.ts || r.genere || "date absente"}`);
  console.log(`[ROSTER] ${noms.length} perle(s) : ${noms.map((n) => n.replace("-USDT-SWAP", "")).join(", ") || "aucune"}`);
  console.log(`[ROSTER] seuil de la porte du hasard : ${(100 * SEUIL).toFixed(0)}e percentile`);

  let jugees = 0, nonJugees = 0, sousSeuil = 0;
  for (const id of noms) {
    const p = perles[id] || {};
    const nom = id.replace("-USDT-SWAP", "");
    const nul = p.nul;
    if (!nul || typeof nul.percentile !== "number") {
      nonJugees++;
      console.log(`  ${nom.padEnd(10)} ${String(p.sig || "?").padEnd(14)} AUCUNE TRACE D'EPREUVE — jamais passee par la porte du hasard`);
      continue;
    }
    jugees++;
    const passe = nul.percentile >= SEUIL;
    if (!passe) sousSeuil++;
    console.log(`  ${nom.padEnd(10)} ${String(p.sig || "?").padEnd(14)} percentile ${(100 * nul.percentile).toFixed(0)}e ` +
      `sur ${nul.tirages} tirages · ${passe ? "passe" : "SOUS LE SEUIL alors qu'elle est au roster"}`);
  }

  console.log(`[ROSTER] verdict :`);
  console.log(`  jugees par la porte : ${jugees}`);
  console.log(`  jamais jugees       : ${nonJugees}`);
  console.log(`  jugees mais sous le seuil et pourtant presentes : ${sousSeuil}`);
  if (nonJugees === 0 && sousSeuil === 0) {
    console.log(`  TOUT CE QUI TRADE A PASSE LA PORTE. La regle s'applique a ce qui tourne.`);
  } else {
    console.log(`  LA PORTE NE PROTEGE PAS CE QUI TOURNE : ${nonJugees + sousSeuil} perle(s) tradent sans avoir battu le hasard.`);
    console.log(`  Rien n'est change ici : ce script ne fait que le constater.`);
  }
}

if (require.main === module) main();
