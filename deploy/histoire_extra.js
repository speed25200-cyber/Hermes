#!/usr/bin/env node
/* ============================================================================
   LES DONNÉES QUE LE PRIX NE CONTIENT PAS ENCORE.

   Douze mois de mesures ont établi que les bougies de cinq minutes, à
   elles seules, ne portent aucun avantage exploitable : ni en pariant
   contre le mouvement, ni en le suivant, ni à court terme, ni à long.
   C'est le résultat attendu d'un marché liquide — tout ce que la série
   de prix contient est arbitré en secondes par des acteurs mieux placés.

   Reste ce que la série de prix NE contient pas. Sur les perpétuels,
   deux séries publiques valent d'être essayées, et elles sont
   documentées depuis des années :

     LE TAUX DE FINANCEMENT. Toutes les huit heures, les longs paient
     les shorts ou l'inverse, selon l'écart entre le perpétuel et le
     comptant. Un financement fortement positif dit que les longs sont
     encombrés et paient pour le rester. C'est une mesure de
     POSITIONNEMENT, pas de prix : deux instruments au même graphique
     peuvent avoir des financements opposés.

     L'INTÉRÊT OUVERT. Le nombre de contrats en vie. Sa variation
     distingue une hausse portée par de l'argent frais d'une hausse
     portée par des shorts qui capitulent — deux choses que le prix
     seul ne sait pas dire.

   Ce script va les chercher dans les archives mensuelles publiques de
   Binance Futures, comme deploy/histoire_longue.js va chercher les
   bougies. Aucune clé, aucune écriture ailleurs que dans data/extra.

   Le lecteur de colonnes est délibérément tolérant : Binance a changé
   le format de ces fichiers plusieurs fois (en-tête ou non,
   millisecondes ou microsecondes, ordre des colonnes). Plutôt que de
   coder un format qui cassera, on cherche la colonne qui RESSEMBLE à un
   horodatage et celle qui ressemble à un taux.
   ============================================================================ */
"use strict";
const https = require("https");
const fs = require("fs");
const path = require("path");
const { ouvrirZip, moisAvant, nomBinance } = require(path.join(__dirname, "histoire_longue.js"));

const RACINE = path.join(__dirname, "..");
const DEST = path.join(RACINE, "data", "extra");
const MOIS_MAX = Number(process.env.HISTOIRE_MOIS || 12);
const HOTE = "data.binance.vision";

const UNIVERS = (process.env.BANC_UNIVERS ||
  "BTC,ETH,SOL,XRP,DOGE,ADA,AVAX,LINK,LTC,BCH,DOT,FIL,NEAR,ATOM,UNI,APT,ARB,OP,TRX,ETC,XLM,ICP,INJ,SUI,SEI,TIA,AAVE,ALGO,SAND,MANA")
  .split(",").map((s) => s.trim() + "-USDT-SWAP");

function telecharger(chemin) {
  return new Promise((ok, ko) => {
    https.get({ host: HOTE, path: chemin, family: 4, headers: { "User-Agent": "hermes-extra" }, timeout: 60000 }, (r) => {
      if (r.statusCode === 404) { r.resume(); return ok(null); }
      if (r.statusCode !== 200) { r.resume(); return ko(new Error("HTTP " + r.statusCode)); }
      const m = []; r.on("data", (c) => m.push(c)); r.on("end", () => ok(Buffer.concat(m)));
    }).on("error", ko).on("timeout", function () { this.destroy(new Error("timeout")); });
  });
}

/* Trouve, sur les premières lignes de données, quelle colonne porte un
   horodatage et quelle colonne porte la valeur cherchée. Rendre les
   indices plutôt que de les supposer, c'est accepter que le format
   change sans que le script meure. */
function reperer(lignes, estValeur) {
  const echant = lignes.filter((l) => l && /\d/.test(l)).slice(0, 30).map((l) => l.split(","));
  if (!echant.length) return null;
  const nCol = Math.max(...echant.map((c) => c.length));
  let iTs = -1, iVal = -1;
  for (let c = 0; c < nCol; c++) {
    const vals = echant.map((e) => Number(e[c])).filter(Number.isFinite);
    if (vals.length < echant.length / 2) continue;
    const ts = vals.every((v) => v > 1.4e12 && v < 4e15);           // ms ou µs depuis 1970
    if (ts && iTs < 0) { iTs = c; continue; }
    if (iVal < 0 && vals.every(estValeur)) iVal = c;
  }
  return (iTs >= 0 && iVal >= 0) ? { iTs, iVal } : null;
}

function lire(texte, estValeur) {
  const lignes = texte.split("\n");
  const rep = reperer(lignes, estValeur);
  if (!rep) return [];
  const out = [];
  for (const l of lignes) {
    const c = l.split(",");
    let ts = Number(c[rep.iTs]), v = Number(c[rep.iVal]);
    if (!Number.isFinite(ts) || !Number.isFinite(v)) continue;
    if (ts > 1e14) ts = Math.floor(ts / 1000);
    out.push([ts, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

async function serie(sym, mois, chemin, estValeur) {
  const rows = [];
  let absents = 0;
  for (const m of mois) {
    let brut = null;
    try { brut = await telecharger(chemin(sym, m)); } catch { absents++; continue; }
    if (!brut) { absents++; continue; }
    try { rows.push(...lire(ouvrirZip(brut).toString("utf8"), estValeur)); }
    catch { absents++; }
  }
  const vus = new Set(); const propre = [];
  for (const k of rows.sort((a, b) => a[0] - b[0])) if (!vus.has(k[0])) { vus.add(k[0]); propre.push(k); }
  return { rows: propre, absents };
}

async function main() {
  const mois = moisAvant(MOIS_MAX);
  fs.mkdirSync(DEST, { recursive: true });
  console.log(`[EXTRA] ${UNIVERS.length} instruments, ${mois.length} mois (${mois[0]} → ${mois[mois.length - 1]})`);

  for (const instId of UNIVERS) {
    const sym = nomBinance(instId);
    const nom = instId.replace("-USDT-SWAP", "");
    const t0 = Date.now();
    // Le financement : quelques millièmes, positif ou négatif.
    const fin = await serie(sym, mois,
      (s, m) => `/data/futures/um/monthly/fundingRate/${s}/${s}-fundingRate-${m}.zip`,
      (v) => Math.abs(v) < 0.05);
    /* L'intérêt ouvert vit dans les « metrics », et ces archives sont
       d'un tout autre poids : la première passe y a consommé plus de
       vingt minutes pour trente instruments, au point de manger le
       budget du run avant que la mesure ait pu commencer. Le
       financement, lui, tient en quelques secondes par instrument.

       Comme le financement est de loin la série la plus documentée des
       deux, l'intérêt ouvert devient optionnel : EXTRA_OI=1 pour le
       demander. Une donnée qu'on n'a pas encore vaut mieux qu'une
       mesure qu'on ne fait jamais. */
    const oi = process.env.EXTRA_OI === "1"
      ? await serie(sym, mois, (s, m) => `/data/futures/um/monthly/metrics/${s}/${s}-metrics-${m}.zip`, (v) => v > 1000)
      : { rows: [], absents: 0 };
    const paquet = { instId, financement: fin.rows, interetOuvert: oi.rows };
    const tmp = path.join(DEST, instId + ".tmp");
    fs.writeFileSync(tmp, JSON.stringify(paquet));
    fs.renameSync(tmp, path.join(DEST, instId + ".json"));
    console.log(`  ${nom.padEnd(6)} financement ${String(fin.rows.length).padStart(5)} points` +
      (fin.rows.length ? ` (du ${new Date(fin.rows[0][0]).toISOString().slice(0, 10)})` : " — absent") +
      ` · interet ouvert ${process.env.EXTRA_OI === "1" ? String(oi.rows.length).padStart(6) + " points" : "non demande"}` +
      ` · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  console.log(`[EXTRA] ecrit dans ${DEST}`);
}

if (require.main === module) main().catch((e) => { console.error("[EXTRA] echec :", e.message); process.exit(1); });
module.exports = { reperer, lire };
