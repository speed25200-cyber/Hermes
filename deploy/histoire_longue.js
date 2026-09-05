#!/usr/bin/env node
/* ============================================================================
   L'HISTOIRE LONGUE — parce qu'un mois sans tendance ne prouve rien.

   Le premier passage du banc du régime a rendu un verdict qu'il faut
   savoir lire : sur les trente derniers jours, le marché a passé 87 %
   du temps en fourchette, 7 % en tendance haussière, 2 % en tendance
   baissière. Le filtre n'a écarté que sept trades sur trois cent
   vingt-huit. Ce n'est pas que le filtre soit mauvais : c'est qu'on lui
   a demandé de prouver son utilité sur une fenêtre qui ne contient pas
   le problème qu'il traite. Le propriétaire décrit une panne « au
   retournement de marché » ; il n'y a pas eu de retournement dans la
   fenêtre.

   Ce script va chercher des années. Source : les archives mensuelles
   publiques de Binance Futures USDT-M — un fichier zip par mois et par
   instrument, sans compte ni clé, servi par un seau statique. Trois
   cents pages d'API OKX pour un seul mois contre un fichier de deux
   mégaoctets : le choix n'est pas serré.

   L'archive Binance et le perpétuel OKX ne sont pas le même contrat.
   Pour une étude de RÉGIME, la question ne se pose pas — BTC est BTC,
   et l'état du marché ne dépend pas de la place. Pour rejouer une
   perle, c'est une approximation, et elle est signalée comme telle
   dans le verdict du banc.

   Aucune clé, aucune écriture ailleurs que dans data/cache-long.
   ============================================================================ */
"use strict";
const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");
const CACHE_LONG = path.join(RACINE, "data", "cache-long");
const ROSTER = path.join(RACINE, "config", "roster.json");
const MOIS_MAX = Number(process.env.HISTOIRE_MOIS || 18);
const HOTE = "data.binance.vision";

/* Le nom Binance d'un instrument OKX : BTC-USDT-SWAP -> BTCUSDT. Les
   instruments qui n'existent pas chez Binance rendront un 404, traité
   comme un mois absent — sans bruit, sans arrêt. */
/* Correspondance OKX -> Binance. Le plus souvent le suffixe suffit ;
   quelques memecoins sont cotes en lots de mille chez Binance, et
   quelques contrats OKX (OKB, actions tokenisees) n'existent pas chez
   Binance — ils restent sans histoire et le banc les ecarte. */
const TABLE_BINANCE = { BONK: "1000BONKUSDT", PEPE: "1000PEPEUSDT", SHIB: "1000SHIBUSDT", FLOKI: "1000FLOKIUSDT",
                        LUNC: "1000LUNCUSDT", XEC: "1000XECUSDT", SATS: "1000SATSUSDT", RATS: "1000RATSUSDT",
                        CAT: "1000CATUSDT", WHY: "1000WHYUSDT", CHEEMS: "1000CHEEMSUSDT", X: "1000XUSDT" };
const nomBinance = (instId) => { const b = instId.replace("-USDT-SWAP", ""); return TABLE_BINANCE[b] || b + "USDT"; };

function telecharger(chemin) {
  return new Promise((ok, ko) => {
    https.get({ host: HOTE, path: chemin, family: 4,
                headers: { "User-Agent": "hermes-histoire" }, timeout: 60000 }, (r) => {
      if (r.statusCode === 404) { r.resume(); return ok(null); }
      if (r.statusCode !== 200) { r.resume(); return ko(new Error("HTTP " + r.statusCode)); }
      const morceaux = [];
      r.on("data", (c) => morceaux.push(c));
      r.on("end", () => ok(Buffer.concat(morceaux)));
    }).on("error", ko).on("timeout", function () { this.destroy(new Error("timeout")); });
  });
}

/* Le zip, lu à la main. Node sait dégonfler (zlib) mais ne sait pas lire
   un conteneur zip, et ajouter une dépendance pour une archive à une
   seule entrée serait payer cher un problème de vingt lignes. On lit
   l'en-tête local (signature PK\3\4), on saute le nom et le champ
   extra, on dégonfle ce qui suit. Méthode 0 = stocké, 8 = dégonflé ;
   Binance n'utilise que la seconde, la première est là par prudence. */
function ouvrirZip(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("pas un zip");
  const methode = buf.readUInt16LE(8);
  const tailleNom = buf.readUInt16LE(26);
  const tailleExtra = buf.readUInt16LE(28);
  const debut = 30 + tailleNom + tailleExtra;
  let fin = buf.length;
  // Le répertoire central marque la fin des données compressées.
  const central = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), debut);
  if (central > 0) fin = central;
  // Un descripteur de données peut précéder le répertoire central.
  const desc = buf.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), debut);
  if (desc > 0 && desc < fin) fin = desc;
  const corps = buf.subarray(debut, fin);
  if (methode === 0) return corps;
  if (methode === 8) return zlib.inflateRawSync(corps);
  throw new Error("methode zip " + methode);
}

/* Le CSV Binance : open_time, open, high, low, close, volume, … Les
   fichiers récents portent une ligne d'en-tête, les anciens non ; et
   depuis 2025 l'horodatage est en MICROsecondes. Les deux pièges sont
   silencieux — un horodatage mille fois trop grand ne lève aucune
   erreur, il place simplement toute l'histoire en l'an 57000. */
function lireCsv(texte) {
  const out = [];
  for (const ligne of texte.split("\n")) {
    if (!ligne) continue;
    const c = ligne.split(",");
    if (c.length < 6) continue;
    let ts = Number(c[0]);
    if (!Number.isFinite(ts)) continue;            // ligne d'en-tête
    if (ts > 1e14) ts = Math.floor(ts / 1000);     // microsecondes
    const o = +c[1], h = +c[2], l = +c[3], cl = +c[4], v = +c[5];
    if (!(o > 0 && h > 0 && l > 0 && cl > 0)) continue;
    /* Les klines Binance portent, au-dela d'OHLCV, le volume en devise de
       cotation (7), le nombre de transactions (8) et le VOLUME ACHETEUR
       AGRESSIF en base (9). Cette derniere colonne est le delta de flux
       d'ordres : 2*tb - v = achats agressifs - ventes agressives, ce que
       les traders appellent CVD une fois cumule. Elle rend inutile le
       telechargement des ticks (418 Mo par mois pour BTC) et rend moot la
       classification de Lee-Ready, qui n'existe que pour deviner le
       cote agresseur quand l'echange ne le donne pas.
       Les indices 0..5 ne changent pas : tout le code existant tient. */
    const qv = c.length > 9 ? +c[7] : NaN, n = c.length > 9 ? +c[8] : NaN, tb = c.length > 9 ? +c[9] : NaN;
    out.push(Number.isFinite(tb) ? [ts, o, h, l, cl, v, qv, n, tb] : [ts, o, h, l, cl, v]);
  }
  return out;
}

function moisAvant(n) {
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);             // le mois courant n'est pas archivé
  for (let i = 0; i < n; i++) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out.reverse();
}

async function unSymbole(instId, mois) {
  const sym = nomBinance(instId);
  const dossier = path.join(CACHE_LONG, "mois");
  fs.mkdirSync(dossier, { recursive: true });
  let bougies = [];
  let telecharges = 0, depuisCache = 0, absents = 0;
  for (const m of mois) {
    /* v2 : les fichiers par mois de la premiere version n'ont que six
       colonnes ; on les ignore et l'on retelecharge une fois, plutot que
       de servir un cache qui n'a pas la colonne demandee. */
    const fichier = path.join(dossier, `${sym}-${m}.v2.json`);
    if (fs.existsSync(fichier)) {
      try { bougies.push(...JSON.parse(fs.readFileSync(fichier, "utf8"))); depuisCache++; continue; } catch {}
    }
    let brut;
    try {
      brut = await telecharger(`/data/futures/um/monthly/klines/${sym}/5m/${sym}-5m-${m}.zip`);
    } catch (e) { absents++; continue; }
    if (!brut) { absents++; continue; }
    let rows;
    try { rows = lireCsv(ouvrirZip(brut).toString("utf8")); }
    catch (e) { absents++; continue; }
    if (!rows.length) { absents++; continue; }
    fs.writeFileSync(fichier, JSON.stringify(rows));
    bougies.push(...rows);
    telecharges++;
  }
  /* CE QUI EST DEJA SUR DISQUE RESTE.

     Ce fichier etait RECONSTRUIT a partir des seuls mois demandes. Une
     passe lancee avec HISTOIRE_MOIS=12 sur un cache qui en portait
     vingt-quatre le raccourcissait donc de moitie, sans un mot — et
     avec lui la fenetre d'apprentissage sur laquelle repose l'hypothese
     pre-inscrite. Les fichiers par mois survivaient, si bien que rien
     n'etait perdu pour de bon ; mais entre-temps les bancs lisaient une
     histoire deux fois plus courte en la croyant complete.

     On fusionne desormais avec l'existant. Une passe courte complete,
     elle ne tronque plus. */
  let ancien = [];
  try { const v = JSON.parse(fs.readFileSync(path.join(CACHE_LONG, instId + ".json"), "utf8")); if (Array.isArray(v)) ancien = v; } catch {}
  if (!bougies.length && !ancien.length) return { instId, bougies: 0, telecharges, depuisCache, absents };
  const vus = new Set(); const propre = [];
  for (const k of [...ancien, ...bougies].sort((a, b) => a[0] - b[0])) if (!vus.has(k[0])) { vus.add(k[0]); propre.push(k); }
  fs.mkdirSync(CACHE_LONG, { recursive: true });
  const tmp = path.join(CACHE_LONG, instId + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(propre));
  fs.renameSync(tmp, path.join(CACHE_LONG, instId + ".json"));
  return { instId, bougies: propre.length, telecharges, depuisCache, absents,
           du: new Date(propre[0][0]).toISOString().slice(0, 10),
           au: new Date(propre[propre.length - 1][0]).toISOString().slice(0, 10) };
}

/* L'univers du banc du chercheur : douze instruments majeurs, tous
   cotés depuis plus d'un an. Il est FIXE et choisi aujourd'hui — c'est
   un biais de survie, il est assumé et signalé partout où il compte.
   Le roster du jour s'y ajoute pour que le banc du régime, qui rejoue
   les perles en place, trouve aussi son histoire. */
/* Trente instruments plutot que douze. Le classement transversal a
   besoin de largeur : etre long des cinq meilleurs et court des cinq
   pires n'a de sens que si le classement porte sur assez de monde pour
   que « meilleur » veuille dire quelque chose. */
const UNIVERS_BANC = (process.env.BANC_UNIVERS ||
  "BTC,ETH,SOL,XRP,DOGE,ADA,AVAX,LINK,LTC,BCH,DOT,FIL,NEAR,ATOM,UNI,APT,ARB,OP,TRX,ETC,XLM,ICP,INJ,SUI,SEI,TIA,AAVE,ALGO,SAND,MANA")
  .split(",").map((s) => s.trim() + "-USDT-SWAP");

async function main() {
  const mois = moisAvant(MOIS_MAX);
  let liste = [...UNIVERS_BANC];
  /* Un fichier d'univers l'emporte : la recherche sur les movers en a
     besoin d'un large (136 instruments), illisible en variable. */
  if (process.env.BANC_UNIVERS_FICHIER) {
    try { const f = process.env.BANC_UNIVERS_FICHIER; const j = JSON.parse(fs.readFileSync(path.isAbsolute(f) ? f : path.join(RACINE, f), "utf8"));
          const l = Array.isArray(j) ? j : j.instruments; if (Array.isArray(l) && l.length) { liste = [...l]; console.log(`[HISTOIRE] univers : ${f} (${liste.length} instruments)`); } }
    catch (e) { console.log(`[HISTOIRE] univers fichier illisible (${e.message}) : liste par defaut`); }
  }
  try {
    const r = JSON.parse(fs.readFileSync(ROSTER, "utf8"));
    for (const id of Object.keys(r.perles || {})) if (!liste.includes(id)) liste.push(id);
  } catch {}
  if (process.argv[2]) liste = process.argv.slice(2);

  /* UN BUDGET DE TEMPS. Trente instruments sur trente-six mois font
     plus de mille fichiers, et une passe de workflow n'a que
     quarante-cinq minutes. Deux tentatives ont ete tuees en cours de
     route, sans que rien d'utile ne sorte du run.

     Les mois sont mis en cache un par un : une passe interrompue n'est
     donc pas perdue, elle avance. Le budget rend cette progression
     explicite plutot que subie — on s'arrete proprement, on dit ou l'on
     en est, et le run garde du temps pour la mesure qui suit. */
  const BUDGET_MS = Number(process.env.HISTOIRE_BUDGET_S || 1080) * 1000;
  const debut = Date.now();
  console.log(`[HISTOIRE] ${liste.length} instrument(s), ${mois.length} mois (${mois[0]} → ${mois[mois.length - 1]}), source ${HOTE}, budget ${(BUDGET_MS / 60000).toFixed(0)} min`);
  let faits = 0;
  for (const instId of liste) {
    if (Date.now() - debut > BUDGET_MS) {
      console.log(`[HISTOIRE] budget epuise apres ${faits}/${liste.length} instruments. Les mois deja pris sont en cache :`);
      console.log(`[HISTOIRE] relancer cette etape reprendra ou elle s'arrete, sans retelecharger.`);
      break;
    }
    faits++;
    const t0 = Date.now();
    try {
      const r = await unSymbole(instId, mois);
      console.log(`  ${instId.replace("-USDT-SWAP", "").padEnd(10)} ${String(r.bougies).padStart(7)} bougies` +
        (r.bougies ? ` du ${r.du} au ${r.au}` : " — aucune donnee (instrument absent de Binance ?)") +
        ` | ${r.telecharges} mois telecharges, ${r.depuisCache} en cache, ${r.absents} absents, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) {
      console.log(`  ${instId.replace("-USDT-SWAP", "").padEnd(10)} echec : ${e.message}`);
    }
  }
  console.log(`[HISTOIRE] cache long : ${CACHE_LONG}`);
}

if (require.main === module) main().catch((e) => { console.error("[HISTOIRE] echec :", e.message); process.exit(1); });
module.exports = { ouvrirZip, lireCsv, nomBinance, moisAvant, CACHE_LONG, telecharger, HOTE, TABLE_BINANCE };
