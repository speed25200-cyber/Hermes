#!/usr/bin/env node
/* ============================================================================
   L'HISTOIRE LARGE — cent instruments en pas horaire.

   Pourquoi un second cache alors qu'il en existe deja un.

   Le cache de cinq minutes porte trente instruments et pese deja
   plusieurs centaines de megaoctets. Le porter a cent en gardant le pas
   de cinq minutes demanderait des heures de telechargement et un disque
   qu'un VPS de deux gigaoctets n'a pas.

   Or l'etude qui a besoin de largeur n'a aucun besoin de finesse. Le
   classement transversal rebalance toutes les 72 heures et projette
   deja tout le monde sur une grille HORAIRE avant de calculer quoi que
   ce soit : les onze bougies de cinq minutes intermediaires sont jetees
   sans etre lues. Telecharger du 1 h, c'est donc douze fois moins de
   donnees pour exactement la meme mesure — pas une approximation, le
   meme nombre.

   POURQUOI CETTE LARGEUR CHANGE QUELQUE CHOSE. La loi fondamentale de
   la gestion active dit que le ratio d'information vaut a peu pres
   IC x racine(N) : la qualite du signal, multipliee par la racine du
   nombre de paris independants. Un classement sur trente instruments
   n'exploite que trente paris ; sur cent, il en exploite cent, et le
   meme signal devrait rendre un sharpe par periode environ 1,8 fois
   plus grand.

   Ce n'est pas un detail de confort. La duree qu'il faut pour prouver
   un avantage varie comme l'inverse du CARRE du sharpe : passer de
   0,137 a 0,25 fait tomber l'attente de deux ans a six mois. La
   largeur est le seul levier connu qui raccourcisse cette attente sans
   toucher a l'hypothese elle-meme.

   Ne fait que telecharger. N'evalue rien, ne branche rien.
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");
const L = require(path.join(__dirname, "histoire_longue.js"));
const CACHE = path.join(RACINE, "data", "cache-1h");
const MOIS_MAX = Number(process.env.HISTOIRE_MOIS || 24);
const BUDGET_MS = Number(process.env.LARGE_BUDGET_S || 1500) * 1000;

/* L'univers large. Il est declare ICI, en entier, et par ordre de
   capitalisation au moment ou il est ecrit — pas par performance
   passee, qui serait un biais de survie deguise en selection. Les
   instruments qui n'ont pas l'anciennete requise seront ecartes par la
   mesure, pas par cette liste. */
const LARGE = (process.env.LARGE_UNIVERS ||
  "BTC,ETH,SOL,XRP,DOGE,ADA,AVAX,LINK,LTC,BCH,DOT,FIL,NEAR,ATOM,UNI,APT,ARB,OP,TRX,ETC," +
  "XLM,ICP,INJ,SUI,SEI,TIA,AAVE,ALGO,SAND,MANA,VET,HBAR,EGLD,THETA,AXS,GALA,CHZ,ENJ,ZIL,IOTA," +
  "FTM,GRT,CRV,SNX,COMP,MKR,YFI,SUSHI,1INCH,LDO,RUNE,KAVA,ZRX,BAT,QTUM,ONT,IOST,ANKR,CELR,SKL," +
  "OCEAN,BAND,STORJ,KSM,DASH,ZEC,XMR,NEO,WAVES,OMG,LRC,MASK,DYDX,ENS,IMX,GMT,APE,JASMY,ROSE,FLOW," +
  "MINA,CFX,MAGIC,HIGH,ASTR,STG,WOO,BLUR,ARPA,LEVER,RDNT,PENDLE,ARKM,WLD,JTO,CYBER,BIGTIME,ORDI,TON,PYTH")
  .split(",").map((s) => s.trim()).filter(Boolean);

const UNIVERS = [...new Set(LARGE)].map((s) => s + "-USDT-SWAP");

/* La meme discipline que partout ailleurs dans ce depot : on ne
   reconstruit jamais, on complete. Un mois deja pris est relu depuis le
   disque ; un mois essaye et introuvable chez Binance est note pour ne
   pas faire retomber cent 404 a chaque passe — mais seulement s'il est
   clos depuis assez longtemps pour avoir ete publie. */
function absentPourDeBon(m) {
  const finDuMois = Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1);
  return Date.now() - finDuMois > 45 * 86400e3;
}

function lireEtat(instId) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(CACHE, instId + ".json"), "utf8"));
    if (Array.isArray(v)) return { bougies: v, moisAbsents: [] };      // ancien format
    return { bougies: v.bougies || [], moisAbsents: v.moisAbsents || [] };
  } catch { return { bougies: [], moisAbsents: [] }; }
}

function moisPresents(bougies) {
  const s = new Set();
  for (const b of bougies) s.add(new Date(b[0]).toISOString().slice(0, 7));
  return s;
}

async function unSymbole(instId, mois) {
  const sym = L.nomBinance(instId);
  const etat = lireEtat(instId);
  const vus = moisPresents(etat.bougies);
  const su = new Set(etat.moisAbsents);
  const manque = mois.filter((m) => !vus.has(m) && !su.has(m));
  if (!manque.length) return { instId, saute: true, points: etat.bougies.length };

  const neufs = [];
  const vides = [];
  for (const m of manque) {
    let brut = null;
    try { brut = await L.telecharger(`/data/futures/um/monthly/klines/${sym}/1h/${sym}-1h-${m}.zip`); }
    catch { vides.push(m); continue; }
    if (!brut) { vides.push(m); continue; }
    try {
      const r = L.lireCsv(L.ouvrirZip(brut).toString("utf8"));
      if (r.length) neufs.push(...r); else vides.push(m);
    } catch { vides.push(m); }
  }

  const m = new Map();
  for (const b of etat.bougies) m.set(b[0], b);
  for (const b of neufs) m.set(b[0], b);
  const propre = [...m.values()].sort((a, b) => a[0] - b[0]);
  if (!propre.length) return { instId, points: 0, neufs: 0, absents: vides.length };

  const paquet = { instId, bougies: propre,
                   moisAbsents: [...new Set([...etat.moisAbsents, ...vides.filter(absentPourDeBon)])].sort() };
  fs.mkdirSync(CACHE, { recursive: true });
  const tmp = path.join(CACHE, instId + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(paquet));
  fs.renameSync(tmp, path.join(CACHE, instId + ".json"));
  return { instId, points: propre.length, neufs: neufs.length, absents: vides.length,
           du: new Date(propre[0][0]).toISOString().slice(0, 10),
           au: new Date(propre[propre.length - 1][0]).toISOString().slice(0, 10) };
}

async function main() {
  const mois = L.moisAvant(MOIS_MAX);
  console.log(`[LARGE] ${UNIVERS.length} instruments, ${mois.length} mois (${mois[0]} → ${mois[mois.length - 1]}), pas 1 h, budget ${(BUDGET_MS / 60000).toFixed(0)} min`);
  console.log(`[LARGE] le pas horaire n'est pas une approximation : le banc transversal projette deja tout sur une grille horaire avant de calculer.`);
  const depart = Date.now();
  let faits = 0, sautes = 0, vides = 0;

  for (const instId of UNIVERS) {
    if (Date.now() - depart > BUDGET_MS) {
      console.log(`[LARGE] budget epuise : ${faits} completes, ${sautes} deja a jour, ${UNIVERS.length - faits - sautes} restants. Relancer reprend ou l'on s'arrete.`);
      break;
    }
    const t0 = Date.now();
    let r;
    try { r = await unSymbole(instId, mois); }
    catch (e) { console.log(`  ${instId.padEnd(18)} echec : ${e.message}`); continue; }
    if (r.saute) { sautes++; continue; }
    if (!r.points) { vides++; continue; }
    faits++;
    console.log(`  ${instId.replace("-USDT-SWAP", "").padEnd(10)} ${String(r.points).padStart(6)} heures ` +
      `(${r.du} → ${r.au}) · +${r.neufs} nouvelles · ${r.absents} mois absents · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  console.log(`[LARGE] ${faits} complete(s), ${sautes} deja a jour, ${vides} sans donnee · ${CACHE}`);
}

if (require.main === module) main().catch((e) => { console.error("[LARGE] echec :", e.message); process.exit(1); });
module.exports = { UNIVERS, CACHE, lireEtat, absentPourDeBon };
