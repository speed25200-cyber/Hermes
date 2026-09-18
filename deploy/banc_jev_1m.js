#!/usr/bin/env node
/* ============================================================================
   LE BANC JEV 1 MIN — la porte du reel.

   Ce script ne branche rien. Il rejoue l'histoire recente a la minute PAR
   LE MEME CHEMIN que le vivant — modules/etat_jev.js pour l'etat et la
   regle de decision, modules/backtest.js pour les sorties — et il a le
   droit de conclure que non. Tant qu'il n'a pas ecrit config/jev_verdict.json
   avec autorise:true, le decideur Jev reste en observation sur un compte
   reel, quoi qu'on mette dans l'environnement.

   LE PROTOCOLE, ecrit avant le premier chiffre :

     1. L'histoire 1 m des instruments (OKX, history-candles), JOURS jours.
        Le regime de marche est recalcule depuis BTC/ETH agreges en 5 m,
        comme le vivant le lit.
     2. A chaque bougie close, l'etat est construit avec les seules bougies
        PASSEES, et Jev est interroge — une fois, la reponse est mise en
        cache par (signature des questions, instrument, horodatage).
        Rejouer ne coute rien ; changer les questions change la signature
        et repart de zero, c'est voulu.
     3. La regle de decision est celle du vivant. Ses deux seuils sont
        CHOISIS SUR LA PREMIERE MOITIE de la fenetre (grille fixe ci-dessous)
        et MESURES SUR LA SECONDE, jamais regardee pour choisir.
     4. Le nul : les memes decisions, DECALEES dans le temps d'un offset
        aleatoire d'au moins deux heures. Meme nombre d'entrees, memes
        grappes, memes sorties, meme marche — seul le lien entre ce que Jev
        a vu et ce qui a suivi est detruit. Vingt repliques, aucun appel
        Jev supplementaire. C'est la question exacte : « ces decisions
        savent-elles quelque chose de CES minutes-la ? »
     5. Le test de famille (maxT) sur la grille des seuils : le meilleur t
        reel doit battre 95 % des meilleurs t des repliques, sinon la grille
        a simplement trouve du bruit.

   LES REGLES DE DECISION, ecrites ici et appliquees telles quelles :

     autorise:true si, sur la seconde moitie, avec les seuils choisis sur
     la premiere :
       - au moins 30 trades ;
       - t de Student du gain NET par trade > 2 ;
       - le gain net reel est au-dessus du 95e percentile des repliques ;
       - le meilleur t de la grille bat 95 % des maxima des repliques.
     Sinon autorise:false, et le fichier le dit avec les chiffres.

   Ce que ce banc ne mesure PAS, et qui reste a la charge du vivant : le
   spread reel (l'etat du banc n'a pas de carnet, donc le cout est frais
   seuls), le glissement, et les refus de lot. Tout cela ne peut que
   DEGRADER le resultat du reel par rapport au banc — jamais l'ameliorer.

   Usage :
     node deploy/banc_jev_1m.js                 # top 10 par volume, 3 jours
     HERMES_MARKETS=BTC-USDT-SWAP,ETH-USDT-SWAP HERMES_BANC_JOURS=7 node deploy/banc_jev_1m.js
     node deploy/banc_jev_1m.js --sans-jev      # un modele factice, pour eprouver le banc lui-meme
     node deploy/banc_jev_1m.js --confirmer     # accepte un cout estime au-dessus de 2 USD
     HERMES_BANC_SYNTHETIQUE=1 node deploy/banc_jev_1m.js --sans-jev   # sans reseau du tout
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");
const ETAT = require(path.join(RACINE, "modules", "etat_jev.js"));
const { simuler, resumer } = require(path.join(RACINE, "modules", "backtest.js"));
const { alea } = require(path.join(RACINE, "modules", "juge.js"));
const REGIME = require(path.join(RACINE, "modules", "regime.js"));
const jev = require(path.join(RACINE, "modules", "jev.js"));

const ARGS = new Set(process.argv.slice(2));
const SANS_JEV = ARGS.has("--sans-jev");
const CONFIRMER = ARGS.has("--confirmer");
const SYNTHETIQUE = process.env.HERMES_BANC_SYNTHETIQUE === "1";

const JOURS = Number(process.env.HERMES_BANC_JOURS || 3);
const N_INSTRUMENTS = Number(process.env.HERMES_BANC_INSTRUMENTS || 10);
const REPLIQUES = Number(process.env.HERMES_BANC_REPLIQUES || 20);
const PAS = Math.max(1, Number(process.env.HERMES_BANC_PAS || 1));
const CONCURRENCE = Number(process.env.HERMES_JEV_CONCURRENCE || 6);
const HORIZON_MIN = Number(process.env.HERMES_JEV_HORIZON_MIN || 15);
const LEVIER = Number(process.env.HERMES_DEFAULT_LEVERAGE || 15);
const FRAIS = 0.0005;
const COUT_SANS_CONFIRMER = 2;
const REST = process.env.OKX_REST_BASE || "https://www.okx.com";

const OV = {
  tpPctMargin: Number(process.env.HERMES_JEV_TP_PCT || 0.15),
  slPctMargin: Number(process.env.HERMES_JEV_SL_PCT || 0.10),
  trailActPctMargin: Number(process.env.HERMES_JEV_TRAIL_ACT_PCT || 0.05),
  trailCbPctMargin: Number(process.env.HERMES_JEV_TRAIL_CB_PCT || 0.03),
  holdMs: Number(process.env.HERMES_JEV_HOLD_MIN || 2 * HORIZON_MIN) * 60000,
};

/* La grille des seuils. Fixe, declaree, petite : 15 cellules. A 5 %, on
   attend 0,75 cellule brillante par pur hasard — d'ou le test de famille. */
const GRILLE_SENS = [0.55, 0.60, 0.65, 0.70, 0.75];
const GRILLE_COUT = [0.50, 0.60, 0.70];

const CACHE_1M = path.join(RACINE, "data", "cache-1m");
const CACHE_JEV = path.join(RACINE, "data", "cache-jev", ETAT.SIGNATURE + (SANS_JEV ? "-factice" : ""));
const VERDICT = path.join(RACINE, "config", "jev_verdict.json");

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function dire(...a) { console.log(...a); }

/* ----- 1. les donnees ----- */

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

async function univers() {
  if (process.env.HERMES_MARKETS) return process.env.HERMES_MARKETS.split(",").map((s) => s.trim()).filter(Boolean);
  if (SYNTHETIQUE) return Array.from({ length: Math.min(N_INSTRUMENTS, 4) }, (_, i) => `SYN${i}-USDT-SWAP`);
  const j = await getJson(`${REST}/api/v5/market/tickers?instType=SWAP`);
  return (j.data || []).filter((t) => /-USDT-SWAP$/.test(t.instId))
    .map((t) => ({ id: t.instId, v: Number(t.volCcy24h) * Number(t.last) }))
    .filter((t) => Number.isFinite(t.v)).sort((a, b) => b.v - a.v).slice(0, N_INSTRUMENTS).map((t) => t.id);
}

function synthetique(instId, n) {
  // Une marche aleatoire avec grappes de volatilite, graine par instrument :
  // il n'y a RIEN a trouver dedans, et c'est le point — un banc qui trouve
  // un avantage ici est un banc casse.
  let g = 0; for (const c of instId) g = (g * 31 + c.charCodeAt(0)) >>> 0;
  const r = alea(g || 1);
  const t0 = Date.now() - n * 60000; let p = 100, vol = 0.0006;
  const out = [];
  for (let i = 0; i < n; i++) {
    vol = Math.max(0.0002, Math.min(0.003, vol * (1 + (r() - 0.5) * 0.1)));
    const o = p; p = p * Math.exp((r() - 0.5) * vol * 3.46);
    const h = Math.max(o, p) * (1 + r() * vol), l = Math.min(o, p) * (1 - r() * vol);
    out.push([t0 + i * 60000, o, h, l, p, 100 + r() * 200, 0]);
  }
  return out;
}

async function histoire1m(instId, jours) {
  fs.mkdirSync(CACHE_1M, { recursive: true });
  const f = path.join(CACHE_1M, instId.replace(/[^\w.-]/g, "_") + ".json");
  const voulu = jours * 1440;
  let serie = [];
  try { serie = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  if (SYNTHETIQUE) return synthetique(instId, voulu);
  const norm = (c) => [Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5]), Number(c[7] ?? 0)];
  // Les bougies recentes d'abord (candles), puis on remonte (history-candles).
  const r0 = await getJson(`${REST}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=1m&limit=300`);
  let neuf = (r0.data || []).filter((c) => String(c[8] ?? "1") === "1").map(norm);
  let plusAncien = neuf.length ? neuf[neuf.length - 1][0] : Date.now();
  const connu = new Set(serie.map((c) => c[0]));
  let tout = [...serie.filter((c) => !neuf.some((x) => x[0] === c[0])), ...neuf];
  let garde = 0;
  while (tout.length < voulu && garde++ < 400) {
    if (connu.has(plusAncien - 60000) && serie.length && serie[0][0] < plusAncien - 60000 * 100) {
      // le cache couvre deja cette zone : on saute au plus ancien du cache
      plusAncien = serie[0][0];
      if (tout.length >= voulu) break;
    }
    const r = await getJson(`${REST}/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}&bar=1m&limit=100&after=${plusAncien}`);
    const lot = (r.data || []).map(norm);
    if (!lot.length) break;
    tout.push(...lot);
    plusAncien = lot[lot.length - 1][0];
    await pause(250);   // la limite d'OKX sur history-candles est basse : on respire
  }
  const parTs = new Map(); for (const c of tout) parTs.set(c[0], c);
  const finale = [...parTs.values()].sort((a, b) => a[0] - b[0]).slice(-voulu - 1440);   // une journee de plus pour le regime
  fs.writeFileSync(f, JSON.stringify(finale));
  return finale;
}

/* 1 m -> 5 m, pour le regime. Une bougie 5 m = cinq 1 m alignees sur le
   multiple de 5 minutes ; une bougie incomplete est ecartee. */
function agreger5m(c1) {
  const out = []; let cour = null;
  for (const c of c1) {
    const t5 = Math.floor(c[0] / 300000) * 300000;
    if (!cour || cour[0] !== t5) { if (cour && cour.n === 5) out.push(cour.b); cour = { t: t5, n: 0, b: [t5, c[1], c[2], c[3], c[4], 0] }; cour[0] = t5; }
    cour.n++; cour.b[2] = Math.max(cour.b[2], c[2]); cour.b[3] = Math.min(cour.b[3], c[3]); cour.b[4] = c[4]; cour.b[5] += c[5];
  }
  if (cour && cour.n === 5) out.push(cour.b);
  return out;
}

/* ----- 2. Jev, avec cache ----- */

function cheminCacheJev(instId) { fs.mkdirSync(CACHE_JEV, { recursive: true }); return path.join(CACHE_JEV, instId.replace(/[^\w.-]/g, "_") + ".jsonl"); }
function lireCacheJev(instId) {
  const m = new Map();
  try { for (const l of fs.readFileSync(cheminCacheJev(instId), "utf8").split("\n")) { if (!l) continue; const j = JSON.parse(l); m.set(j.ts, j.reponse); } } catch {}
  return m;
}

/* Le modele factice : momentum + position dans le range, tire vers le
   plat. Il n'a aucune raison d'avoir raison ; il sert a verifier que le
   banc tourne et que le nul fait son travail. */
function factice(etat) {
  const r = etat.rendementsBps;
  const s = (r.m5 || 0) / 20 + (r.m15 || 0) / 40 + ((etat.rangePos24h ?? 0.5) - 0.5) * 2;
  const pl = 1 / (1 + Math.exp(-s)), ps = 1 - pl;
  const conc = Math.abs(pl - 0.5) * 2;
  const aucun = 0.2 * (1 - conc);
  return { answers: { direction: { choice: pl > ps ? "long" : "short", probabilities: { long: pl * (1 - aucun), short: ps * (1 - aucun), aucun } },
                      depasse_cout: { probability: Math.min(0.95, 0.3 + (etat.volatilite.ratioCourtLong || 1) * 0.3) },
                      conviction: { score: 1 + Math.round(conc * 4) } } };
}

async function interrogerAvecCache(instId, etats) {
  const cache = lireCacheJev(instId);
  const manquants = etats.filter((e) => !cache.has(e.ts));
  if (!manquants.length) return cache;
  const fd = fs.openSync(cheminCacheJev(instId), "a");
  let i = 0, erreurs = 0;
  const travailleur = async () => {
    while (i < manquants.length) {
      const e = manquants[i++];
      let rep = null;
      if (SANS_JEV) rep = factice(e);
      else {
        try { rep = await jev.interroger(e, ETAT.QUESTIONS, { delaiMs: 20000, essais: 3 }); }
        catch (err) { erreurs++; if (erreurs <= 5) dire("   ! jev", instId, e.ts, err.message); if (erreurs > 50) throw new Error("trop d'erreurs Jev, arret"); continue; }
      }
      cache.set(e.ts, rep);
      fs.writeSync(fd, JSON.stringify({ ts: e.ts, reponse: rep }) + "\n");
    }
  };
  await Promise.all(Array.from({ length: SANS_JEV ? 1 : CONCURRENCE }, travailleur));
  fs.closeSync(fd);
  return cache;
}

/* ----- 3. la mesure ----- */

function t_student(xs) {
  const n = xs.length; if (n < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1);
  return v > 0 ? m / Math.sqrt(v / n) : null;
}

/* Les signaux d'une serie de reponses pour des seuils donnes. */
function signauxPour(serie, reponses, seuils, idx) {
  const out = new Array(serie.length).fill(0);
  for (const i of idx) {
    const rep = reponses.get(serie[i][0]);
    if (!rep) continue;
    const d = ETAT.decider(rep, seuils, { long: true, short: true });
    out[i] = d.sens === "long" ? 1 : d.sens === "short" ? -1 : 0;
  }
  return out;
}

function mesurer(serie, signaux, de, a) {
  // On simule sur toute la serie (les positions peuvent chevaucher la
  // coupure) mais on ne COMPTE que les trades entres dans [de, a).
  const trades = simuler({ c5: serie, signaux, sortie: OV, lev: LEVIER, frais: FRAIS, pasMs: 60000 })
    .filter((t) => t.iIn >= de && t.iIn < a);
  const r = resumer(trades);
  const brut = trades.map((t) => t.pnlMarge + 2 * FRAIS * LEVIER);
  return { ...r, tNet: t_student(trades.map((t) => t.pnlMarge)), tBrut: t_student(brut), brutMoyen: brut.length ? brut.reduce((x, y) => x + y, 0) / brut.length : 0, trades };
}

/* Le nul : les memes signaux, decales d'un offset aleatoire >= 2 h. */
function decaler(signaux, graine, minOffset) {
  const n = signaux.length;
  const r = alea(graine);
  const off = minOffset + Math.floor(r() * (n - 2 * minOffset));
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) out[(i + off) % n] = signaux[i];
  return out;
}

async function main() {
  dire(`=== BANC JEV 1 MIN — questions ${ETAT.SIGNATURE}${SANS_JEV ? " (modele FACTICE)" : ""}${SYNTHETIQUE ? " (donnees SYNTHETIQUES)" : ""} ===`);
  dire(`jours ${JOURS} · horizon ${HORIZON_MIN} min · sorties ${JSON.stringify(OV)} · repliques ${REPLIQUES} · pas ${PAS}`);
  const ids = await univers();
  dire(`instruments (${ids.length}) : ${ids.map((s) => s.replace("-USDT-SWAP", "")).join(", ")}`);

  /* Le regime, depuis BTC/ETH 5 m — le vivant le lit toutes les cinq
     minutes ; ici il est aligne sur chaque minute par horodatage. */
  let regimeA = () => null;
  if (!SYNTHETIQUE) {
    try {
      const btc1 = await histoire1m("BTC-USDT-SWAP", JOURS + 1);
      const eth1 = await histoire1m("ETH-USDT-SWAP", JOURS + 1).catch(() => null);
      const c5b = agreger5m(btc1);
      const s = REGIME.serieEtats(c5b, eth1 ? agreger5m(eth1) : null);
      // serieEtats est alignee sur c5b par INDICE ; l'horodatage vient de la bougie.
      const parTs = s.map((e, i) => [c5b[i][0], e]).filter(([, e]) => e);
      regimeA = (ts) => { let best = null; for (const [t, e] of parTs) { if (t <= ts) best = e; else break; } return best ? { etat: best.etat, force: best.force } : null; };
    } catch (e) { dire("regime indisponible :", e.message); }
  }

  const series = {};
  let nEtats = 0;
  for (const id of ids) {
    try { series[id] = await histoire1m(id, JOURS); } catch (e) { dire("   ! histoire", id, e.message); continue; }
    const n = series[id].length;
    nEtats += Math.max(0, Math.floor((n - ETAT.N_HEURE - 1) / PAS));
    dire(`   ${id.padEnd(18)} ${n} bougies 1 m (${(n / 1440).toFixed(1)} j)`);
  }
  const tokens = nEtats * 750;
  const coutUsd = tokens / 1e6 * 0.042;
  dire(`etats a juger : ${nEtats} · cout estime ${coutUsd.toFixed(2)} USD (cache deduit ensuite)`);
  if (!SANS_JEV && coutUsd > COUT_SANS_CONFIRMER && !CONFIRMER) { dire(`cout au-dessus de ${COUT_SANS_CONFIRMER} USD : relancer avec --confirmer`); process.exit(2); }

  /* Le rejeu, instrument par instrument. */
  const resultats = [];
  const tousTradesReel = { premiere: [], seconde: [] };
  const grille = []; for (const s of GRILLE_SENS) for (const c of GRILLE_COUT) grille.push({ sens: s, cout: c });
  const parCellule = grille.map(() => ({ premiere: [], seconde: [] }));
  const signauxParInstrument = {};

  for (const id of Object.keys(series)) {
    const serie = series[id];
    const n = serie.length;
    const idx = []; for (let i = ETAT.N_HEURE; i < n - 1; i += PAS) idx.push(i);
    const etats = [];
    for (const i of idx) {
      const b = serie.slice(Math.max(0, i - 719), i + 1);
      const e = ETAT.construireEtat({ instId: id, bougies: b, tick: {}, regime: regimeA(serie[i][0]), autorise: { long: true, short: true }, fraisTaker: FRAIS, horizonMin: HORIZON_MIN });
      if (e) etats.push(e);
    }
    process.stdout.write(`   ${id.padEnd(18)} ${etats.length} etats … `);
    const reponses = await interrogerAvecCache(id, etats);
    const moitie = Math.floor(n / 2);
    signauxParInstrument[id] = { serie, reponses, idx, moitie };
    grille.forEach((g, k) => {
      const sig = signauxPour(serie, reponses, g, idx);
      parCellule[k].premiere.push(...mesurer(serie, sig, 0, moitie).trades);
      parCellule[k].seconde.push(...mesurer(serie, sig, moitie, n).trades);
    });
    const sigDef = signauxPour(serie, reponses, ETAT.SEUILS_DEFAUT, idx);
    const mDef = mesurer(serie, sigDef, 0, n);
    dire(`${reponses.size} reponses · seuils par defaut : ${mDef.trades.length} trades, wr ${mDef.winrate.toFixed(1)} %, net/trade ${mDef.moyenneMarge.toFixed(4)}`);
    resultats.push({ id, trades: mDef.trades.length, winrate: mDef.winrate, net: mDef.moyenneMarge });
  }

  /* Le choix des seuils sur la premiere moitie, la mesure sur la seconde. */
  dire("\n--- La grille : premiere moitie (choix) / seconde moitie (mesure, jamais regardee pour choisir) ---");
  dire("sens  cout | trades  net/trade   t net | trades  net/trade   t net");
  let meilleur = null;
  const tSeconde = [];
  grille.forEach((g, k) => {
    const p = parCellule[k].premiere, s = parCellule[k].seconde;
    const np = p.length, ns = s.length;
    const netP = np ? p.reduce((a, t) => a + t.pnlMarge, 0) / np : 0;
    const netS = ns ? s.reduce((a, t) => a + t.pnlMarge, 0) / ns : 0;
    const tP = t_student(p.map((t) => t.pnlMarge)), tS = t_student(s.map((t) => t.pnlMarge));
    tSeconde.push(tS == null ? -Infinity : tS);
    dire(`${g.sens.toFixed(2)}  ${g.cout.toFixed(2)} | ${String(np).padStart(6)}  ${netP.toFixed(4).padStart(9)}  ${tP == null ? "    —" : tP.toFixed(2).padStart(6)} | ${String(ns).padStart(6)}  ${netS.toFixed(4).padStart(9)}  ${tS == null ? "    —" : tS.toFixed(2).padStart(6)}`);
    if (np >= 20 && (!meilleur || netP > meilleur.netP)) meilleur = { g, k, netP, np };
  });
  if (!meilleur) { dire("\nAucune cellule n'a vingt trades sur la premiere moitie : rien a mesurer. autorise:false"); ecrireVerdict(false, { motif: "trop peu de trades" }, resultats); return; }
  const seuils = meilleur.g;
  const oos = parCellule[meilleur.k].seconde;
  const nOos = oos.length;
  const netOos = nOos ? oos.reduce((a, t) => a + t.pnlMarge, 0) / nOos : 0;
  const brutOos = nOos ? oos.reduce((a, t) => a + t.pnlMarge + 2 * FRAIS * LEVIER, 0) / nOos : 0;
  const tOos = t_student(oos.map((t) => t.pnlMarge));
  const wrOos = nOos ? 100 * oos.filter((t) => t.pnlMarge > 0).length / nOos : 0;
  dire(`\nSeuils choisis sur la premiere moitie : sens ${seuils.sens}, cout ${seuils.cout} (${meilleur.np} trades, net ${meilleur.netP.toFixed(4)})`);
  dire(`Seconde moitie, hors echantillon : ${nOos} trades · wr ${wrOos.toFixed(1)} % · brut/trade ${brutOos.toFixed(4)} · net/trade ${netOos.toFixed(4)} · t net ${tOos == null ? "—" : tOos.toFixed(2)}`);

  /* Le nul par decalage, sur la seconde moitie, avec les seuils choisis. */
  const nets = [], maxT = [];
  for (let g = 1; g <= REPLIQUES; g++) {
    let tradesRep = [];
    const tParCellule = grille.map(() => []);
    for (const id of Object.keys(signauxParInstrument)) {
      const { serie, reponses, idx, moitie } = signauxParInstrument[id];
      const sig = decaler(signauxPour(serie, reponses, seuils, idx), g * 7919 + 1, 120);
      tradesRep.push(...mesurer(serie, sig, moitie, serie.length).trades);
      grille.forEach((gg, k) => { const s2 = decaler(signauxPour(serie, reponses, gg, idx), g * 7919 + 1, 120); tParCellule[k].push(...mesurer(serie, s2, moitie, serie.length).trades.map((t) => t.pnlMarge)); });
    }
    nets.push(tradesRep.length ? tradesRep.reduce((a, t) => a + t.pnlMarge, 0) / tradesRep.length : 0);
    maxT.push(Math.max(...tParCellule.map((xs) => { const t = t_student(xs); return t == null ? -Infinity : t; })));
  }
  nets.sort((a, b) => a - b); maxT.sort((a, b) => a - b);
  const pct = nets.length ? nets.filter((x) => netOos > x).length / nets.length : 0;
  const tReelMax = Math.max(...tSeconde);
  const pctFamille = maxT.length ? maxT.filter((x) => tReelMax > x).length / maxT.length : 0;
  dire(`\nNul (${REPLIQUES} decalages) : net/trade median ${nets[Math.floor(nets.length / 2)].toFixed(4)} · le reel bat ${(100 * pct).toFixed(0)} % des repliques`);
  dire(`Famille (maxT sur ${grille.length} cellules) : meilleur t reel ${tReelMax === -Infinity ? "—" : tReelMax.toFixed(2)} · median des maxima ${maxT[Math.floor(maxT.length / 2)].toFixed(2)} · le reel bat ${(100 * pctFamille).toFixed(0)} % des maxima`);

  const regles = { trades: nOos >= 30, tNet: tOos != null && tOos > 2, nul: pct >= 0.95, famille: pctFamille >= 0.95 };
  const autorise = Object.values(regles).every(Boolean);
  dire(`\nRegles : trades>=30 ${regles.trades ? "oui" : "NON"} · t net>2 ${regles.tNet ? "oui" : "NON"} · bat 95 % du nul ${regles.nul ? "oui" : "NON"} · famille 95 % ${regles.famille ? "oui" : "NON"}`);
  dire(`\n>>> VERDICT : autorise:${autorise}${SANS_JEV ? " (FACTICE : ce verdict n'est PAS ecrit)" : ""}`);
  if (!SANS_JEV) ecrireVerdict(autorise, { seuils, oos: { trades: nOos, winrate: wrOos, brutParTrade: brutOos, netParTrade: netOos, tNet: tOos }, nul: { repliques: REPLIQUES, percentile: pct, medianNet: nets[Math.floor(nets.length / 2)] }, famille: { tReelMax, percentile: pctFamille }, regles }, resultats);
  else dire("(relancer sans --sans-jev pour un verdict qui compte)");
}

function ecrireVerdict(autorise, mesure, parInstrument) {
  fs.mkdirSync(path.dirname(VERDICT), { recursive: true });
  const v = { autorise, signature: ETAT.SIGNATURE, genere: new Date().toISOString(), jours: JOURS, horizonMin: HORIZON_MIN, sorties: OV, mesure, parInstrument };
  fs.writeFileSync(VERDICT, JSON.stringify(v, null, 2));
  dire(`verdict ecrit : ${VERDICT}`);
}

main().catch((e) => { console.error("banc en erreur :", e); process.exit(1); });
