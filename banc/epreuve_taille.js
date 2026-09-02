#!/usr/bin/env node
/* ============================================================================
   L'EPREUVE DE LA TAILLE DES ORDRES.

   Le moteur a passe des semaines a envoyer des tailles qu'OKX refuse, et
   personne ne l'a vu, parce que la panne etait silencieuse et
   selective : elle ne frappait que les instruments dont le lot est
   fractionnaire. Trois refus dans le journal — STX, SHIB, AVAX — tous
   avec un lot de 0,1 ; aucun sur les lots entiers.

   Une panne pareille est pire qu'un plantage. Elle supprime des trades
   sur certains instruments seulement, donc elle rompt la
   correspondance entre ce que les bancs mesurent — ou tout signal est
   trade — et ce que le moteur fait vraiment. Tous les chiffres de
   performance en dependent.

   Ce banc verifie la seule chose qui compte a l'arrivee : la CHAINE
   envoyee sur le reseau est-elle un multiple exact du lot ? Pas le
   nombre — la chaine, parce que c'est elle qu'OKX lit.
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const RACINE = path.join(__dirname, "..");

let echecs = 0;
function verifier(nom, condition, detail) {
  if (condition) { console.log(`  ok   ${nom}`); return; }
  echecs++;
  console.log(`  ECHEC ${nom}${detail ? " — " + detail : ""}`);
}

/* On extrait la fonction du moteur telle qu'elle est ecrite, plutot que
   d'en recopier une version : un banc qui teste sa propre copie ne
   teste rien. */
const src = fs.readFileSync(path.join(RACINE, "app", "main.js"), "utf8");
const bloc = src.slice(src.indexOf("function roundQtyToLot"));
const corps = bloc.slice(0, bloc.indexOf("\nfunction "));
const MARKET = { meta: {} };
const num = (x) => Number(x) || 0;
const roundQtyToLot = new Function("MARKET", "num", corps + "\nreturn roundQtyToLot;")(MARKET, num);

const dec = (v) => (String(v).split(".")[1] || "").length;
function estMultiple(sz, lot) {
  const d = Math.max(dec(sz), dec(lot));
  const pas = Math.round(Number(lot) * 10 ** d);
  return pas > 0 && Math.round(Number(sz) * 10 ** d) % pas === 0;
}

/* --- 1. Les cas exacts qui ont ete refuses en production -------------------- */
console.log("1. Les tailles refusees par OKX le 2 septembre");
/* Relevees sur le catalogue OKX reel : lot 0,1 pour LTC, STX, SHIB et
   AVAX, et les contrats calcules aux marges que le moteur emploie. */
const REELS = [
  ["LTC-USDT-SWAP", 0.1, 0.1, 0.6061, "0.6000000000000001"],
  ["LTC-USDT-SWAP", 0.1, 0.1, 2.4242, "2.4000000000000004"],
  ["STX-USDT-SWAP", 0.1, 0.1, 28.9799, "28.900000000000002"],
  ["STX-USDT-SWAP", 0.1, 0.1, 46.3679, "46.300000000000004"],
];
for (const [instId, lotSz, minSz, contrats, avant] of REELS) {
  MARKET.meta[instId] = { lotSz, minSz, ctVal: 1 };
  const sz = String(roundQtyToLot(instId, contrats));
  verifier(`${instId} ${contrats} contrats — envoyait "${avant}", envoie "${sz}"`,
    estMultiple(sz, lotSz) && sz !== avant, sz);
}

/* --- 2. Tous les pas de lot qu'OKX emploie ---------------------------------- */
console.log("2. Chaque pas de lot, sur mille tailles");
const PAS = [1, 0.1, 0.01, 0.001, 10, 100];
for (const lot of PAS) {
  MARKET.meta.X = { lotSz: lot, minSz: lot, ctVal: 1 };
  let mauvais = 0, exemple = "";
  for (let i = 1; i <= 1000; i++) {
    const q = i * 0.7317 * lot * 3;                 // des valeurs qui tombent mal expres
    const sz = String(roundQtyToLot("X", q));
    if (!estMultiple(sz, lot)) { mauvais++; if (!exemple) exemple = `${q} -> "${sz}"`; }
  }
  verifier(`pas ${lot} : mille tailles, toutes multiples`, mauvais === 0, `${mauvais} mauvaises, ex. ${exemple}`);
}

/* --- 3. On ne perd pas un lot par le bas ------------------------------------ */
console.log("3. L'arrondi ne mange pas un lot entier");
/* 28,9 / 0,1 vaut 288,99999999999994 en binaire. Sans epsilon, floor()
   rend 288 et l'on perd un lot — l'erreur inverse de celle qu'on vient
   de corriger, et tout aussi silencieuse. */
MARKET.meta.Y = { lotSz: 0.1, minSz: 0.1, ctVal: 1 };
verifier("28,9 reste 28,9 et ne tombe pas a 28,8",
  String(roundQtyToLot("Y", 28.9)) === "28.9", String(roundQtyToLot("Y", 28.9)));
verifier("0,3 reste 0,3", String(roundQtyToLot("Y", 0.3)) === "0.3", String(roundQtyToLot("Y", 0.3)));
verifier("une taille sous le lot minimal remonte au minimum",
  roundQtyToLot("Y", 0.02) === 0.1, String(roundQtyToLot("Y", 0.02)));

/* --- 4. Ce que la fonction ne doit jamais faire ----------------------------- */
console.log("4. Les garde-fous");
MARKET.meta.Z = { lotSz: 0, minSz: 0, ctVal: 1 };
verifier("un pas nul ne fabrique pas d'infini ni de NaN",
  Number.isFinite(roundQtyToLot("Z", 5)) , String(roundQtyToLot("Z", 5)));
MARKET.meta.W = { lotSz: 1, minSz: 1, ctVal: 1 };
verifier("une quantite negative ne devient pas une taille negative",
  roundQtyToLot("W", -3) >= 0, String(roundQtyToLot("W", -3)));
verifier("plus aucun produit flottant nu dans le code",
  !/Math\.floor\(qty \/ step\) \* step/.test(src));

console.log(echecs === 0 ? "\nEPREUVE DE LA TAILLE : verte." : `\nEPREUVE DE LA TAILLE : ${echecs} echec(s).`);
process.exit(echecs === 0 ? 0 : 1);
