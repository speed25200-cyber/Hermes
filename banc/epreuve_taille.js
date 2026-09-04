#!/usr/bin/env node
"use strict";

/* Epreuve de la valeur effectivement serialisee vers OKX. Le calcul
   historique en Number produisait 0.6000000000000001 pour un lot de
   0,1. La primitive de production compte maintenant les lots entiers
   et reconstruit une chaine decimale exacte, sans feature flag. */
const { quantityToLotString } = require("../modules/live_safety.js");

let echecs = 0;
function verifier(nom, condition, detail) {
  if (condition) { console.log(`  ok   ${nom}`); return; }
  echecs++;
  console.log(`  ECHEC ${nom}${detail ? " — " + detail : ""}`);
}

function estMultiple(sz, lot) {
  const dec = (v) => (String(v).split(".")[1] || "").length;
  const d = Math.max(dec(sz), dec(lot));
  const pas = Math.round(Number(lot) * 10 ** d);
  return pas > 0 && Math.round(Number(sz) * 10 ** d) % pas === 0;
}

console.log("1. Les tailles historiquement refusees");
const reels = [
  ["LTC", "0.1", "0.1", 0.6061, "0.6"],
  ["LTC", "0.1", "0.1", 2.4242, "2.4"],
  ["STX", "0.1", "0.1", 28.9799, "28.9"],
  ["STX", "0.1", "0.1", 46.3679, "46.3"],
];
for (const [nom, lot, min, contrats, attendu] of reels) {
  const sz = quantityToLotString(contrats, lot, min);
  verifier(`${nom} ${contrats} -> ${attendu}`, sz === attendu && estMultiple(sz, lot), sz);
}

console.log("2. Tous les pas de lot");
for (const lot of ["1", "0.1", "0.01", "0.001", "0.00000001", "10", "100"]) {
  let mauvais = 0;
  for (let i = 1; i <= 1000; i++) {
    const sz = quantityToLotString(i * 0.7317 * Number(lot) * 3, lot, lot);
    if (!estMultiple(sz, lot)) mauvais++;
  }
  verifier(`pas ${lot}: 1000/1000 multiples`, mauvais === 0, String(mauvais));
}

console.log("3. Bornes et serialisation");
verifier("28,9 ne perd pas un lot", quantityToLotString(28.9, "0.1", "0.1") === "28.9");
verifier("0,3 reste 0,3", quantityToLotString(0.3, "0.1", "0.1") === "0.3");
verifier("le minimum est respecte", quantityToLotString(0.02, "0.1", "0.1") === "0.1");
verifier("un pas nul est refuse", quantityToLotString(5, "0", "0") === "0");
verifier("aucune notation exponentielle", !/[eE]/.test(quantityToLotString(0.00000039, "1e-8", "1e-8")));

console.log(echecs === 0 ? "\nEPREUVE DE LA TAILLE : verte." : `\nEPREUVE DE LA TAILLE : ${echecs} echec(s).`);
process.exitCode = echecs === 0 ? 0 : 1;
