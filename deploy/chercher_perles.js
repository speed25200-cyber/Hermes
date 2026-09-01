#!/usr/bin/env node
/* ============================================================================
   Le chercheur de perles.

   Une perle : pour UNE crypto, LA combinaison signal × sorties qui a le
   meilleur winrate ET qui gagne de l'argent — dans deux fenêtres de temps
   disjointes, pas une. Le classement d'août l'a appris au prix fort : ce
   qui brille sur une époque meurt souvent sur l'autre, et un score de banc
   mirifique est presque toujours un mirage. Ici la règle est écrite dans
   le code : une candidate n'existe que si elle est positive dans la
   fenêtre de sélection (23 jours) ET dans les 7 derniers jours, que le
   choix n'a jamais regardés. Parmi les survivantes, le winrate tranche.

   Pas de perle = pas de trade. Un roster vide sur une crypto n'est pas un
   échec du chercheur, c'est son verdict le plus utile.

   Ce que le chercheur évalue est EXACTEMENT ce que le moteur tradera :
   mêmes formules (modules/signaux.js, la bibliothèque unique), mêmes
   fenêtres de 299 bougies, mêmes sorties, mêmes frais taker
   (modules/backtest.js). Sélectionner sur une formule et en trader une
   autre est le défaut que cette architecture rend impossible.

   Tourne sur le VPS (points publics OKX, aucune clé, aucun ordre), écrit
   config/roster.json de façon atomique ; le moteur le recharge à chaud.
   Relancé par systemd toutes les trente minutes : la recherche n'est pas
   un événement, c'est un entretien.
   ============================================================================ */
"use strict";
const https = require("https");
const fs = require("fs");
const path = require("path");

const { serieSignaux, simuler, resumer } = require(path.join(__dirname, "..", "modules", "backtest.js"));
const { SIGNAUX } = require(path.join(__dirname, "..", "modules", "signaux.js"));

const RACINE = path.join(__dirname, "..");
const ROSTER = path.join(RACINE, "config", "roster.json");
const HISTORIQUE = path.join(RACINE, "data", "perles-historique.jsonl");
const CACHE_DIR = path.join(RACINE, "data", "cache-5m");
const PROGRESSION = path.join(RACINE, "data", "perles-progression.json");

/* La progression est ecrite dans un fichier que le moteur sert a la
   page : le bouton « lancer une recherche » a besoin de voir la passe
   avancer, et un minuteur de trente minutes a besoin que la passe soit
   COURTE — les deux vivent ici. */
function direProgression(obj) {
  try {
    if (obj == null) { fs.unlinkSync(PROGRESSION); return; }
    fs.mkdirSync(path.dirname(PROGRESSION), { recursive: true });
    fs.writeFileSync(PROGRESSION, JSON.stringify(obj));
  } catch {}
}

const JOURS = Number(process.env.PERLES_JOURS || 30);
const JOURS_VALID = Number(process.env.PERLES_VALID_JOURS || 7);
const MIN_TRADES_SEL = Number(process.env.PERLES_MIN_TRADES_SEL || 12);
const MIN_TRADES_VAL = Number(process.env.PERLES_MIN_TRADES_VAL || 5);
/* Les quatre seuils qui separent une perle d'un coup de chance. Ils ont
   ete regles sur un banc de marches ALEATOIRES : avec la premiere regle
   — « positif dans les deux fenetres », sans plancher de winrate ni de
   gain moyen — trois marches aleatoires sur trois obtenaient une perle.
   156 combinaisons jugees sur une validation courte, et le hasard passe
   la porte. Un chercheur qui trouve des perles dans du bruit n'est pas
   un chercheur, c'est un generateur d'illusions. */
const MIN_WR_SEL = Number(process.env.PERLES_MIN_WR_SEL || 55);
const MIN_WR_VAL = Number(process.env.PERLES_MIN_WR_VAL || 50);
const MIN_MOYENNE = Number(process.env.PERLES_MIN_MOYENNE || 0.02);   // gain moyen/trade, en fraction de marge
const TAILLE_UNIVERS = Number(process.env.HERMES_UNIVERSE_SIZE || 20);
const WEEKEND_MIN = Number(process.env.HERMES_WEEKEND_MIN || 0.34);
const LEVIER = Number(process.env.HERMES_DEFAULT_LEVERAGE || 15);

/* Les familles de sorties sont celles que le roster actuel emploie déjà :
   la grille explore ce que le moteur sait faire, rien de plus. SL −30 %
   et rappel de trail 5 % sont la constante SPEC du moteur. */
const SORTIES = [
  { tpPctMargin: 0.80, trailActPctMargin: 0.30 },
  { tpPctMargin: 0.60, trailActPctMargin: 0.20 },
  { tpPctMargin: 0.40, trailActPctMargin: 0.30 },
  { tpPctMargin: 0.30, trailActPctMargin: 0.15 },
];
const DUREES = [8, 12, 24].map((h) => h * 3600e3);
const SL = 0.30, CB = 0.05;

function get(chemin) {
  return new Promise((ok, ko) => {
    https.get({ host: "www.okx.com", path: chemin, family: 4,
                headers: { "User-Agent": "hermes-perles" }, timeout: 15000 }, (r) => {
      let d = "";
      r.on("data", (c) => d += c);
      r.on("end", () => { try { ok(JSON.parse(d)); } catch (e) { ko(e); } });
    }).on("error", ko).on("timeout", function () { this.destroy(new Error("timeout")); });
  });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* Un appel qui a le droit d'échouer deux fois : OKX rend parfois un 429
   quand on pagine vite, et un backoff vaut mieux qu'un trou de données. */
async function getSur(chemin) {
  for (let essai = 0; ; essai++) {
    try {
      const r = await get(chemin);
      if (r && r.code === "0") return r;
      if (essai >= 2) throw new Error("OKX code " + (r && r.code) + " " + (r && r.msg || ""));
    } catch (e) { if (essai >= 2) throw e; }
    await pause(800 * (essai + 1));
  }
}

/* ---- 1. les candidats : le top volume en dollars, filtre 24/7 ---- */

async function candidats() {
  const t = await getSur("/api/v5/market/tickers?instType=SWAP");
  const ranges = t.data
    .filter((x) => /-USDT-SWAP$/.test(x.instId))
    .map((x) => ({ instId: x.instId, dollars: Number(x.volCcy24h) * Number(x.last) }))
    .sort((a, b) => b.dollars - a.dollars);

  const retenus = [];
  for (const c of ranges) {
    if (retenus.length >= TAILLE_UNIVERS) break;
    // Le rapport week-end/semaine, même critère que le moteur : une
    // action tokenisée s'effondre le week-end, une crypto non.
    try {
      const h = await getSur(`/api/v5/market/candles?instId=${encodeURIComponent(c.instId)}&bar=1H&limit=168`);
      const rows = h.data || [];
      if (rows.length < 120) continue;
      let we = 0, sem = 0, nWe = 0, nSem = 0;
      for (const k of rows) {
        const j = new Date(Number(k[0])).getUTCDay();
        const v = Number(k[7] || k[6] || 0) || Number(k[5]) * Number(k[4]);
        if (j === 0 || j === 6) { we += v; nWe++; } else { sem += v; nSem++; }
      }
      const ratio = (nWe && nSem) ? (we / nWe) / ((sem / nSem) || 1e-9) : 0;
      if (ratio >= WEEKEND_MIN) retenus.push(c.instId);
    } catch { /* candidat suivant */ }
    await pause(120);
  }
  // Le roster courant reste candidat même sorti du top volume : une
  // perle en place se re-valide, elle ne disparaît pas en silence.
  try {
    const actuel = JSON.parse(fs.readFileSync(ROSTER, "utf8"));
    for (const id of Object.keys(actuel.perles || {})) if (!retenus.includes(id)) retenus.push(id);
  } catch {}
  return retenus;
}

/* ---- 2. l'histoire : JOURS jours de 5 m, paginés vers le passé ---- */

/* Le cache est ce qui rend la cadence de trente minutes honnete. La
   premiere passe pagine trente jours (plusieurs minutes) ; les
   suivantes relisent le cache et ne demandent a OKX que les bougies
   nouvelles — une page suffit, la passe entiere tient sous la minute.
   Sans lui, on martelerait l'exchange toutes les demi-heures pour des
   donnees deja vues. */
function lireCache(instId) {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, instId + ".json"), "utf8"));
    return Array.isArray(rows) && rows.length ? rows : null;
  } catch { return null; }
}
function ecrireCache(instId, rows) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = path.join(CACHE_DIR, instId + ".tmp");
    fs.writeFileSync(tmp, JSON.stringify(rows));
    fs.renameSync(tmp, path.join(CACHE_DIR, instId + ".json"));
  } catch {}
}

async function histoire5m(instId) {
  const besoin = JOURS * 288;

  const enCache = lireCache(instId);
  if (enCache && Date.now() - enCache[enCache.length - 1][0] < 24 * 3600e3) {
    // Le cache est frais : la page la plus recente (300 bougies = 25 h)
    // couvre forcement le trou. On fusionne, on taille, on repart.
    const r0 = await getSur(`/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=5m&limit=300`);
    const neuves = r0.data.slice(1).map((k) => [Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5])]).reverse();
    const parTs = new Map(enCache.map((k) => [k[0], k]));
    for (const k of neuves) parTs.set(k[0], k);   // la version fraiche fait foi
    const rows = [...parTs.values()].sort((a, b) => a[0] - b[0]).slice(-(besoin + 50));
    ecrireCache(instId, rows);
    return rows;
  }

  // Pas de cache utilisable : la collecte pleine, paginee vers le passe.
  let rows = [];
  const r0 = await getSur(`/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=5m&limit=300`);
  rows = r0.data.slice();
  while (rows.length < besoin + 2) {
    const apres = rows[rows.length - 1][0];
    const r = await getSur(`/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}&bar=5m&limit=100&after=${apres}`);
    if (!r.data || !r.data.length) break;
    rows.push(...r.data);
    await pause(250);   // la limite d'OKX sur history-candles est basse : on respire
  }
  // Descendant -> ascendant, bougie en cours exclue, six nombres.
  const asc = rows.slice(1).map((k) => [Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5])]).reverse();
  // Les pages peuvent se chevaucher d'une bougie : dédoublonnage par ts.
  const vus = new Set(); const propre = [];
  for (const k of asc) { if (!vus.has(k[0])) { vus.add(k[0]); propre.push(k); } }
  ecrireCache(instId, propre);
  return propre;
}

/* ---- 3. le juge : deux fenêtres, le winrate tranche les positives ---- */

/* Une mesure compacte, prete a etre ecrite dans le roster : la page du
   laboratoire montre ces nombres au clic, ils doivent donc exister. */
const mesure = (r) => ({ trades: r.trades, winrate: +r.winrate.toFixed(1), netMarge: +r.netMarge.toFixed(3),
  longs:  r.longs  ? { trades: r.longs.trades,  winrate: +r.longs.winrate.toFixed(1) }  : undefined,
  shorts: r.shorts ? { trades: r.shorts.trades, winrate: +r.shorts.winrate.toFixed(1) } : undefined });
const ovDe = (sortie) => ({ tpPctMargin: sortie.tpPctMargin, trailActPctMargin: sortie.trailActPctMargin, holdMs: sortie.holdMs });

function chercherPourInstrument(c5) {
  if (c5.length < 299 + 288 * 3) return { perle: null, raison: "histoire trop courte" };
  const finTs = c5[c5.length - 1][0];
  const borneV = finTs - JOURS_VALID * 86400e3;                       // derniers jours : jamais regardes par le choix
  const borneAB = borneV - ((JOURS - JOURS_VALID) / 2) * 86400e3;     // coupe la selection en deux sous-fenetres

  /* Le concours se joue en trois temps, et l'ordre est toute la defense
     contre le sur-ajustement :

     1. Pour CONCOURIR, une combinaison doit etre positive dans DEUX
        sous-fenetres de selection disjointes (A puis B). Le hasard doit
        reussir deux fois avant meme d'entrer dans le classement.
     2. Le classement (winrate A+B, gain net en departage) designe UN
        vainqueur.
     3. La validation — les derniers jours, jamais regardes — ne juge que
        LUI. Un test, pas cent cinquante-six : c'est la difference entre
        valider et miner la validation. Et s'il echoue, il n'y a PAS de
        repechage du deuxieme : redescendre la liste jusqu'a ce que ca
        passe reviendrait a remettre la validation au concours.

     La premiere version faisait entrer la validation dans l'eligibilite :
     quatre marches aleatoires sur six recevaient une perle, a 75-86 % de
     winrate. Dans du bruit pur. */
  let vainqueur = null;
  let concourantes = 0;
  const podium = [];        // les concourantes, resumees — le classement complet en sortira
  let presque = null;       // la meilleure recalee a l'eligibilite, et la porte qui l'a arretee
  for (const sig of SIGNAUX) {
    const signaux = serieSignaux(sig, c5);
    if (!signaux.some((v) => v !== 0)) continue;
    for (const sortieBase of SORTIES) {
      for (const holdMs of DUREES) {
        const sortie = { ...sortieBase, slPctMargin: SL, trailCbPctMargin: CB, holdMs };
        const trades = simuler({ c5, signaux, sortie, lev: LEVIER });
        const a = resumer(trades.filter((t) => t.tsIn < borneAB));
        const b = resumer(trades.filter((t) => t.tsIn >= borneAB && t.tsIn < borneV));
        const ab = resumer(trades.filter((t) => t.tsIn < borneV));
        // La porte qui arrete une combinaison est une information : la
        // page du laboratoire montre au clic POURQUOI personne n'a
        // concouru, pas seulement que personne n'a concouru.
        const porte =
          (a.trades < Math.ceil(MIN_TRADES_SEL / 2) || b.trades < Math.ceil(MIN_TRADES_SEL / 2)) ? "trades" :
          (a.netMarge <= 0) ? "negA" :
          (b.netMarge <= 0) ? "negB" :
          (ab.winrate < MIN_WR_SEL) ? "wr" :
          (ab.moyenneMarge < MIN_MOYENNE) ? "moyenne" : null;
        if (porte) {
          if (porte !== "trades" && (!presque || ab.winrate > presque.wr)) {
            presque = { sig, ov: ovDe(sortie), wr: +ab.winrate.toFixed(1),
                        mesures: { a: mesure(a), b: mesure(b), sel: mesure(ab) }, porte };
          }
          continue;
        }
        concourantes++;
        podium.push({ sig, ov: ovDe(sortie), wr: +ab.winrate.toFixed(1), net: +ab.netMarge.toFixed(3) });
        const cand = { sig, sortie, a, b, ab, trades };
        if (!vainqueur
            || cand.ab.winrate > vainqueur.ab.winrate
            || (cand.ab.winrate === vainqueur.ab.winrate && cand.ab.netMarge > vainqueur.ab.netMarge)) {
          vainqueur = cand;
        }
      }
    }
  }
  podium.sort((x, y) => y.wr - x.wr || y.net - x.net);
  const finalistes = podium.slice(0, 3);

  if (!vainqueur) {
    return { perle: null, candidates: concourantes,
             raison: concourantes + " concourante(s), aucune positive dans A ET B",
             detail: { presque } };
  }

  const val = resumer(vainqueur.trades.filter((t) => t.tsIn >= borneV));
  const vDetail = {
    sig: vainqueur.sig, ov: ovDe(vainqueur.sortie),
    mesures: { a: mesure(vainqueur.a), b: mesure(vainqueur.b), sel: mesure(vainqueur.ab), val: mesure(val) },
  };
  if (val.trades < MIN_TRADES_VAL || val.netMarge <= 0 || val.winrate < MIN_WR_VAL || val.moyenneMarge < MIN_MOYENNE) {
    // La porte de validation qui l'a recale, elle aussi, se montre.
    vDetail.porte =
      (val.trades < MIN_TRADES_VAL) ? "trades" :
      (val.netMarge <= 0) ? "negatif" :
      (val.winrate < MIN_WR_VAL) ? "wr" : "moyenne";
    return { perle: null, candidates: concourantes,
             raison: `le vainqueur (${vainqueur.sig}, wr ${vainqueur.ab.winrate.toFixed(0)} %) echoue en validation`,
             detail: { vainqueur: vDetail, finalistes } };
  }
  return { perle: { sig: vainqueur.sig, sortie: vainqueur.sortie,
                    a: vainqueur.a, b: vainqueur.b, sel: vainqueur.ab, val, finalistes },
           candidates: concourantes };
}

/* ---- 4. la passe entière ---- */

async function main() {
  const debut = Date.now();
  console.log(`[PERLES] recherche — ${JOURS} j de 5 m, validation ${JOURS_VALID} j, ` +
    `seuils ${MIN_TRADES_SEL}/${MIN_TRADES_VAL} trades, wr ${MIN_WR_SEL}/${MIN_WR_VAL} %, moyenne ${MIN_MOYENNE}, levier ${LEVIER}`);

  direProgression({ debut: new Date(debut).toISOString(), phase: "candidats" });
  const liste = await candidats();
  console.log(`[PERLES] ${liste.length} candidats : ${liste.map((s) => s.replace("-USDT-SWAP", "")).join(", ")}`);

  const perles = {};
  const refus = {};
  const rapport = [];
  let rang = 0;
  for (const instId of liste) {
    const nom = instId.replace("-USDT-SWAP", "");
    // Une ligne AVANT chaque collecte. Elle fait deux metiers : montrer
    // ou en est une passe de plusieurs minutes, et surtout maintenir en
    // vie la connexion qui la regarde — un SSH muet quatre minutes se
    // fait couper par le premier equipement du chemin, et la premiere
    // passe est morte exactement comme ca.
    console.log(`[PERLES] ${++rang}/${liste.length} ${nom} : collecte de ${JOURS} j…`);
    direProgression({ debut: new Date(debut).toISOString(), rang, total: liste.length, instId: nom });
    try {
      const c5 = await histoire5m(instId);
      const { perle, candidates, raison, detail } = chercherPourInstrument(c5);
      if (!perle) {
        refus[instId] = { raison: raison || "aucune concourante positive dans A et B", concourantes: candidates || 0,
                          ...(detail || {}) };
        rapport.push(`  ${nom.padEnd(10)} — pas de perle (${refus[instId].raison})`);
        continue;
      }
      perles[instId] = {
        sig: perle.sig,
        ov: { tpPctMargin: perle.sortie.tpPctMargin, trailActPctMargin: perle.sortie.trailActPctMargin, holdMs: perle.sortie.holdMs },
        mesures: {
          a: mesure(perle.a), b: mesure(perle.b),
          sel: mesure(perle.sel), val: mesure(perle.val),
        },
        finalistes: perle.finalistes,
      };
      rapport.push(`  ${nom.padEnd(10)} ${perle.sig.padEnd(14)} tp ${perle.sortie.tpPctMargin} act ${perle.sortie.trailActPctMargin} ` +
        `hold ${perle.sortie.holdMs / 3600e3}h | sel ${perle.sel.trades}t wr ${perle.sel.winrate.toFixed(0)}% net ${perle.sel.netMarge.toFixed(2)} ` +
        `| val ${perle.val.trades}t wr ${perle.val.winrate.toFixed(0)}% net ${perle.val.netMarge.toFixed(2)}`);
    } catch (e) {
      refus[instId] = { raison: "echec de collecte : " + e.message, concourantes: 0 };
      rapport.push(`  ${nom.padEnd(10)} — echec de collecte : ${e.message}`);
    }
  }

  const sortie = {
    genere: new Date().toISOString(),
    fenetres: { jours: JOURS, validationJours: JOURS_VALID, minTradesSel: MIN_TRADES_SEL, minTradesVal: MIN_TRADES_VAL },
    levier: LEVIER,
    dureeS: Math.round((Date.now() - debut) / 1000),
    candidats: liste,
    perles,
    refus,
  };

  // Écriture ATOMIQUE : le moteur relit ce fichier à chaud, il ne doit
  // jamais pouvoir lire une moitié de JSON.
  fs.mkdirSync(path.dirname(ROSTER), { recursive: true });
  const tmp = ROSTER + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sortie, null, 2));
  fs.renameSync(tmp, ROSTER);

  try {
    fs.mkdirSync(path.dirname(HISTORIQUE), { recursive: true });
    fs.appendFileSync(HISTORIQUE, JSON.stringify({ ts: sortie.genere, dureeS: Math.round((Date.now() - debut) / 1000), perles }) + "\n");
  } catch {}

  console.log(`[PERLES] verdict (${Object.keys(perles).length} perle(s) sur ${liste.length} candidats, ` +
    `${Math.round((Date.now() - debut) / 1000)} s) :`);
  for (const l of rapport) console.log(l);
  console.log(`[PERLES] roster ecrit : ${ROSTER}`);
  direProgression(null);
}

if (require.main === module) {
  main().catch((e) => { console.error("[PERLES] echec :", e.message); direProgression(null); process.exit(1); });
}
module.exports = { chercherPourInstrument, SORTIES, DUREES };
