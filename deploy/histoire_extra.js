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

/* EXTRA_LARGE=1 prend l'univers large de histoire_1h.js plutot que les
   trente du banc. On ne recopie pas la liste : deux listes de cent noms
   qui doivent rester identiques finissent toujours par diverger, et
   c'est le genre de divergence qui ne se voit pas. */
const TRENTE = (process.env.BANC_UNIVERS ||
  "BTC,ETH,SOL,XRP,DOGE,ADA,AVAX,LINK,LTC,BCH,DOT,FIL,NEAR,ATOM,UNI,APT,ARB,OP,TRX,ETC,XLM,ICP,INJ,SUI,SEI,TIA,AAVE,ALGO,SAND,MANA")
  .split(",").map((s) => s.trim() + "-USDT-SWAP");

const UNIVERS = process.env.EXTRA_LARGE === "1"
  ? require(path.join(__dirname, "histoire_1h.js")).UNIVERS
  : TRENTE;

/* Un fichier d'univers l'emporte sur la liste : la recherche sur les
   movers en a besoin d'un large (une centaine), et une variable
   d'environnement de cette taille n'est pas lisible dans un workflow. */
function universDepuisFichier(defaut) {
  const f = process.env.BANC_UNIVERS_FICHIER;
  if (!f) return defaut;
  try { const j = JSON.parse(fs.readFileSync(path.isAbsolute(f) ? f : path.join(RACINE, f), "utf8"));
        const l = Array.isArray(j) ? j : j.instruments; if (Array.isArray(l) && l.length) return l; } catch {}
  console.log(`[EXTRA] univers ${f} illisible : liste par defaut`);
  return defaut;
}
const UNIVERS_EFFECTIF = universDepuisFichier(UNIVERS);

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

/* La cloture d'une kline. L'indice de prime (base perpetuel/indice) est
   publie sous forme de klines : la valeur qui compte est la cloture, et
   le lecteur generique prendrait la premiere colonne plausible — l'open. */
function lireClotureKline(texte) {
  const out = [];
  for (const l of texte.split("\n")) {
    const c = l.split(","); let ts = Number(c[0]); const v = Number(c[4]);
    if (!Number.isFinite(ts) || !Number.isFinite(v)) continue;
    if (ts > 1e14) ts = Math.floor(ts / 1000);
    out.push([ts, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/* Les « metrics » Binance : un fichier par JOUR, huit colonnes, avec un
   horodatage en texte (« 2026-07-15 00:05:00 ») et non en millisecondes.
   On garde : interet ouvert (contrats), sa valeur en USDT, ratio
   long/short des gros comptes (par comptes puis par positions), ratio
   long/short global, ratio volume taker achat/vente. Cinq minutes. */
const METRICS_COLS = ["sum_open_interest", "sum_open_interest_value", "count_toptrader_long_short_ratio",
                      "sum_toptrader_long_short_ratio", "count_long_short_ratio", "sum_taker_long_short_vol_ratio"];
function lireMetrics(texte) {
  const lignes = texte.split("\n").filter(Boolean);
  if (!lignes.length) return [];
  const tete = lignes[0].split(",").map((x) => x.trim());
  const idx = METRICS_COLS.map((n) => tete.indexOf(n));
  const iTs = tete.indexOf("create_time");
  if (iTs < 0 || idx.some((i) => i < 0)) return [];
  const out = [];
  for (let k = 1; k < lignes.length; k++) {
    const c = lignes[k].split(",");
    const ts = Date.parse(String(c[iTs]).trim().replace(" ", "T") + "Z");
    if (!Number.isFinite(ts)) continue;
    const vals = idx.map((i) => Number(c[i]));
    if (vals.some((v) => !Number.isFinite(v))) continue;
    out.push([ts, ...vals]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/* Les jours d'archive : chaque jour est un fichier, on les prend par
   paquets de huit en parallele — un seul a la file, ce serait trois
   heures pour cinquante instruments sur deux ans. */
function joursAvant(n) {
  const out = []; const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - 2);               // la veille n'est pas toujours publiee
  for (let i = 0; i < n; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  return out.reverse();
}
const jourDe = (rows) => { const s = new Set(); for (const r of rows || []) s.add(new Date(r[0]).toISOString().slice(0, 10)); return s; };

async function serieJours(sym, jours, chemin, lecteur, parallele) {
  const rows = []; const vides = []; let absents = 0;
  const P = parallele || 40;   // borne par la latence, pas le debit : 730 requetes par instrument
  for (let i = 0; i < jours.length; i += P) {
    const lot = jours.slice(i, i + P);
    const res = await Promise.all(lot.map(async (j) => {
      try { const b = await telecharger(chemin(sym, j)); if (!b) return { j, r: null };
            return { j, r: lecteur(ouvrirZip(b).toString("utf8")) }; }
      catch { return { j, r: null }; }
    }));
    for (const { j, r } of res) { if (!r || !r.length) { absents++; vides.push(j); } else rows.push(...r); }
  }
  const vus = new Set(); const propre = [];
  for (const k of rows.sort((a, b) => a[0] - b[0])) if (!vus.has(k[0])) { vus.add(k[0]); propre.push(k); }
  return { rows: propre, absents, vides };
}

async function serie(sym, mois, chemin, estValeur, lecteur) {
  const rows = [];
  let absents = 0;
  const vides = [];                               // les mois qui n'ont rien rendu
  for (const m of mois) {
    let brut = null;
    try { brut = await telecharger(chemin(sym, m)); } catch { absents++; vides.push(m); continue; }
    if (!brut) { absents++; vides.push(m); continue; }
    try {
      const r = lecteur ? lecteur(ouvrirZip(brut).toString("utf8")) : lire(ouvrirZip(brut).toString("utf8"), estValeur);
      if (r.length) rows.push(...r); else vides.push(m);
    } catch { absents++; vides.push(m); }
  }
  const vus = new Set(); const propre = [];
  for (const k of rows.sort((a, b) => a[0] - b[0])) if (!vus.has(k[0])) { vus.add(k[0]); propre.push(k); }
  return { rows: propre, absents, vides };
}

/* CE QUI MANQUE, mois par mois — et non « cet instrument est-il deja
   fait ? ».

   La premiere version sautait un instrument des lors que sa serie
   COMMENCAIT assez tot. C'etait juste pour une reprise de
   telechargement, qui est le probleme qu'elle resolvait : sans elle,
   chaque relance recommencait tout depuis le debut et n'arrivait jamais
   au bout. Mais elle rendait la serie incapable de s'etendre vers
   l'AVANT : un instrument couvert depuis septembre 2024 restait saute
   pour toujours, et son financement s'arretait au dernier mois
   telecharge, definitivement.

   Cela ne se voyait pas tant qu'on mesurait du passe. Le releve hors
   echantillon, lui, ne vit que de mois nouveaux : avec l'ancienne
   regle, il aurait affiche zero periode jusqu'a la fin des temps en
   ayant l'air de fonctionner.

   On raisonne donc par mois. Un mois est acquis s'il porte deja des
   points, ou s'il a ete essaye et n'existe pas chez Binance — ce
   second cas est memorise, sinon les instruments listes tardivement
   feraient re-tomber trente 404 a chaque passe. */

function lireExistant(instId) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DEST, instId + ".json"), "utf8"));
    return (j && typeof j === "object") ? j : null;
  } catch { return null; }
}

function moisDe(rows) {
  const s = new Set();
  for (const r of rows || []) s.add(new Date(r[0]).toISOString().slice(0, 7));
  return s;
}

function manquants(mois, rows, absentsConnus) {
  const vus = moisDe(rows);
  const su = new Set(absentsConnus || []);
  return mois.filter((m) => !vus.has(m) && !su.has(m));
}

/* Fusion par horodatage : ce qui est deja sur disque reste, ce qui
   arrive complete. Jamais d'ecrasement — une passe interrompue ne doit
   pas pouvoir raccourcir une serie deja acquise. */
function fusionner(ancien, nouveau) {
  const m = new Map();
  for (const r of ancien || []) m.set(r[0], r);
  for (const r of nouveau || []) m.set(r[0], r);
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}

/* Un mois n'est declare absent POUR DE BON que s'il est clos depuis
   assez longtemps pour que Binance ait eu le temps de le publier. Sans
   ce delai, le mois qui vient de finir serait marque absent le 1er et
   plus jamais retente. */
function absentPourDeBon(m) {
  const finDuMois = Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1);
  return Date.now() - finDuMois > 45 * 86400e3;
}

async function main() {
  const mois = moisAvant(MOIS_MAX);
  fs.mkdirSync(DEST, { recursive: true });
  const BUDGET_MS = Number(process.env.EXTRA_BUDGET_S || 900) * 1000;
  const depart = Date.now();
  console.log(`[EXTRA] ${UNIVERS_EFFECTIF.length} instruments, ${mois.length} mois (${mois[0]} → ${mois[mois.length - 1]}), budget ${(BUDGET_MS / 60000).toFixed(0)} min`);

  const A_BLANC = process.env.EXTRA_DRY === "1";   // lister le travail, ne rien telecharger
  const OI = process.env.EXTRA_OI === "1";
  /* La prime (base) est mensuelle et legere ; les metrics sont
     journalieres et nombreuses. EXTRA_METRICS_JOURS=0 les laisse de
     cote ; 730 en demande deux ans, par paquets, avec reprise. */
  const METRICS_JOURS = Number(process.env.EXTRA_METRICS_JOURS || 0);
  const jours = METRICS_JOURS > 0 ? joursAvant(METRICS_JOURS) : [];
  const PRIME = process.env.EXTRA_PRIME !== "0";
  let faits = 0, sautes = 0;
  for (const instId of UNIVERS_EFFECTIF) {
    const deja = lireExistant(instId) || {};
    const mFin = manquants(mois, deja.financement, deja.moisAbsents);
    const mOi = OI ? manquants(mois, deja.interetOuvert, deja.moisAbsentsOi) : [];
    const mPrime = PRIME ? manquants(mois, deja.prime, deja.moisAbsentsPrime) : [];
    const jVus = jourDe(deja.metrics), jAbs = new Set(deja.joursAbsentsMetrics || []);
    const jMet = jours.filter((j) => !jVus.has(j) && !jAbs.has(j));
    if (!mFin.length && !mOi.length && !mPrime.length && !jMet.length) { sautes++; continue; }
    if (A_BLANC) { console.log(`  ${instId.padEnd(18)} a prendre : financement ${mFin.length} mois · prime ${mPrime.length} mois · metrics ${jMet.length} jours`); faits++; continue; }
    if (Date.now() - depart > BUDGET_MS) {
      console.log(`[EXTRA] budget epuise : ${faits} telecharges, ${sautes} deja presents, ${UNIVERS_EFFECTIF.length - faits - sautes} restants.`);
      console.log(`[EXTRA] relancer cette etape reprendra la ou elle s'arrete.`);
      break;
    }
    faits++;
    const sym = nomBinance(instId);
    const nom = instId.replace("-USDT-SWAP", "");
    const t0 = Date.now();
    // Le financement : quelques millièmes, positif ou négatif.
    const fin = await serie(sym, mFin,
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
    const oi = OI
      ? await serie(sym, mOi, (s, m) => `/data/futures/um/monthly/metrics/${s}/${s}-metrics-${m}.zip`, (v) => v > 1000)
      : { rows: [], absents: 0, vides: [] };

    const prime = mPrime.length
      ? await serie(sym, mPrime, (s, m) => `/data/futures/um/monthly/premiumIndexKlines/${s}/5m/${s}-5m-${m}.zip`, null, lireClotureKline)
      : { rows: [], absents: 0, vides: [] };
    const met = jMet.length
      ? await serieJours(sym, jMet, (s, j) => `/data/futures/um/daily/metrics/${s}/${s}-metrics-${j}.zip`, lireMetrics)
      : { rows: [], absents: 0, vides: [] };

    const financement = fusionner(deja.financement, fin.rows);
    const interetOuvert = OI ? fusionner(deja.interetOuvert, oi.rows) : (deja.interetOuvert || []);
    const garder = (ancien, vides) => [...new Set([...(ancien || []), ...vides.filter(absentPourDeBon)])].sort();
    /* Un jour est absent pour de bon apres 4 jours : les archives
       journalieres paraissent avec un ou deux jours de retard. */
    const garderJours = (ancien, vides) => [...new Set([...(ancien || []), ...vides.filter((j) => Date.now() - Date.parse(j + "T00:00:00Z") > 4 * 86400e3)])].sort();
    const paquet = { instId, financement, interetOuvert,
                     prime: fusionner(deja.prime, prime.rows),
                     metrics: fusionner(deja.metrics, met.rows),
                     metricsColonnes: ["ts", ...METRICS_COLS],
                     moisAbsents: garder(deja.moisAbsents, fin.vides),
                     moisAbsentsOi: OI ? garder(deja.moisAbsentsOi, oi.vides) : (deja.moisAbsentsOi || []),
                     moisAbsentsPrime: garder(deja.moisAbsentsPrime, prime.vides),
                     joursAbsentsMetrics: garderJours(deja.joursAbsentsMetrics, met.vides) };
    const tmp = path.join(DEST, instId + ".tmp");
    fs.writeFileSync(tmp, JSON.stringify(paquet));
    fs.renameSync(tmp, path.join(DEST, instId + ".json"));
    console.log(`  ${nom.padEnd(6)} ${String(mFin.length).padStart(2)} mois demandes · financement ${String(financement.length).padStart(5)} points` +
      (financement.length ? ` (${new Date(financement[0][0]).toISOString().slice(0, 10)} → ${new Date(financement[financement.length - 1][0]).toISOString().slice(0, 10)})` : " — absent") +
      ` · +${fin.rows.length} nouveaux · prime ${String(paquet.prime.length).padStart(6)} · metrics ${String(paquet.metrics.length).padStart(7)} (+${met.rows.length}, ${met.absents} jours absents)` +
      ` · interet ouvert ${OI ? String(interetOuvert.length).padStart(6) + " points" : "non demande"}` +
      ` · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  console.log(`[EXTRA] ${faits} telecharge(s), ${sautes} deja present(s) · ecrit dans ${DEST}`);
}

if (require.main === module) main().catch((e) => { console.error("[EXTRA] echec :", e.message); process.exit(1); });
module.exports = { reperer, lire, manquants, fusionner, absentPourDeBon, moisDe, lireMetrics, lireClotureKline, joursAvant, METRICS_COLS };
