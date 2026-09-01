"use strict";

/* ===== Imports ===== */
// Le VPS est un Linux sans ecran : Electron ne peut pas y tourner. La
// doublure ci-dessous presente exactement la meme surface — app,
// BrowserWindow, ipcMain, globalShortcut — mais elle est adossee a un
// serveur HTTP. Les onze canaux ipcMain deviennent des routes, les deux
// webContents.send deviennent un flux devenements. Cest la SEULE ligne
// de ce fichier qui change : le moteur, et donc les strategies
// validees, restent intacts.
const { app, BrowserWindow, ipcMain, globalShortcut } = require("./serveur");
const path   = require("path");
const fs     = require("fs");
const http   = require("http");
const https  = require("https");
const crypto = require("crypto");
const axios  = require("axios");
const WebSocket = require("ws");

/* ===== ENV / ROOT ===== */
const ROOT = path.resolve(__dirname, "..");
try { require("dotenv").config({ path: path.join(ROOT, ".env") }); } catch {}

/* ===== PATHS ===== */
const HERE         = __dirname;
const DEV_URL      = process.env.HERMES_DEV_URL || "http://localhost:8000";
const INDEX_FILE   = path.join(HERE, "index.html");
// preload.js etait le pont dElectron entre la fenetre et le processus
// principal. Il nexiste plus : le pont est app/pont.js, servi au
// navigateur, et il parle HTTP. La constante reste declaree parce que
// la doublure de BrowserWindow lit encore ses options — elle pointe
// simplement vers un fichier absent, ce que le code gere deja.
const PRELOAD_FILE = path.join(HERE, "preload.js");

const LOGDIR  = process.env.HERMES_LOG_DIR ? path.resolve(process.env.HERMES_LOG_DIR) : path.join(ROOT, "logs");
const DATADIR = process.env.HERMES_DATA_DIR ? path.resolve(process.env.HERMES_DATA_DIR) : path.join(ROOT, "data");
for (const d of [LOGDIR, DATADIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }

/* ===== Logging ===== */
function log(...a) {
  try {
    const s = `[${new Date().toISOString()}] ${a.join(" ")}`;
    console.log(s);
    try { fs.appendFileSync(path.join(LOGDIR, "main.log"), s + "\n"); } catch {}
  } catch {}
}
function saveJSON(p, obj) { try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch (e) { log("[SAVEJSON_ERR]", e.message); } }
function appendJSONL(file, obj) { try { fs.appendFileSync(file, JSON.stringify(obj) + "\n"); } catch {} }

/* ===== Utils ===== */
const tsISO = () => new Date().toISOString();
const now   = () => Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function rndInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

/* ===== Safe Read Configs ===== */
function safeReadJSON(p, fallback) {
  try {
    let s = fs.readFileSync(p, "utf8");
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);   // retirer le BOM UTF-8 (sinon JSON.parse échoue → défaut)
    return JSON.parse(s);
  } catch { return fallback; }
}

const OKX_CFG = safeReadJSON(path.join(ROOT, "config", "okx.json"), {
  restBase: "https://www.okx.com",
  wsPublic: "wss://ws.okx.com:8443/ws/v5/public",
  wsPrivate: "wss://ws.okx.com:8443/ws/v5/private",
  wsPublicDemo: "wss://wspap.okx.com:8443/ws/v5/public",
  wsPrivateDemo: "wss://wspap.okx.com:8443/ws/v5/private",
  subscribeChunkMax: 40,
  subscribeJitterMs: [25, 50],
  heartbeat: { timerMs: 5000, pingIdleMs: 20000, pongWaitMs: 10000 },
  reconnectBackoff: { minMs: 1000, maxMs: 30000, jitterMs: 500 },
  bars: { prefill: { frame: "5m", limit: 200 } },
  trading: { defaultLeverage: 20, marginMode: "isolated", triggerPxType: "mark" }
});

const AI_CFG = safeReadJSON(path.join(ROOT, "config", "ai.config.json"), {
  signals: { rsiPeriod: 14, bbPeriod: 20, bbMult: 2, supertrendAtr: 10, supertrendMult: 3, squeezeKcMult: 1.5 },
  filters: { minVolUsd24h: 2e7, atrPctMax: 0.05 },
  tuner:   { arms: ["e001", "e002", "e003"], evalWindowMin: 15 },
  trainer: { l2: 0.0005, clip: 3, saveInterval: 300 },
  knowledge: { emaRetAlpha: 0.1, emaAbsRetAlpha: 0.1 }
});
/* ===== CONFIG / ENV Vars ===== */
const DEFAULT_UNIVERSE       = (process.env.HERMES_MARKETS || "").split(",").map(s => s.trim()).filter(Boolean);
const MAX_POSITIONS_GLOBAL   = Number(process.env.HERMES_MAX_POSITIONS || 10);
const DEFAULT_LEVERAGE       = Number(process.env.HERMES_DEFAULT_LEVERAGE || 15);  // ×15 validé client 30/08 (ex-20)
const SYMBOL_COOLDOWN_SEC    = 10;
const MAX_ORDERS_INFLIGHT    = 5;

// WS timers
const HB_TIMER_MS     = Number(process.env.HERMES_WS_HEARTBEAT_MS   || OKX_CFG.heartbeat.timerMs      || 5000);
const HB_PING_IDLE_MS = Number(process.env.HERMES_WS_PING_IDLE_MS   || OKX_CFG.heartbeat.pingIdleMs   || 20000);
const HB_PONG_WAIT_MS = Number(process.env.HERMES_WS_PONG_WAIT_MS   || OKX_CFG.heartbeat.pongWaitMs   || 10000);
const BK_MIN          = Number(process.env.HERMES_WS_BACKOFF_MIN_MS || OKX_CFG.reconnectBackoff.minMs || 1000);
const BK_MAX          = Number(process.env.HERMES_WS_BACKOFF_MAX_MS || OKX_CFG.reconnectBackoff.maxMs || 30000);
const BK_JITTER       = Number(OKX_CFG.reconnectBackoff.jitterMs || 500);

// Risk guardrails (optionnels)
/* Plancher d'équité sous lequel aucun ordre n'est tenté. Il valait 50,
   ce qui interdisait tout trade à un compte de 10 USDT — le moteur
   tournait, recevait les signaux, et n'ouvrait jamais rien sans que
   rien ne le dise. Un refus silencieux ressemble à une panne.

   5 plutôt que 50, parce que c'est là que le refus commence à dire
   quelque chose : en dessous, la marge par trade tombe sous quelques
   dollars et l'arrondi au lot minimal écarte déjà presque tous les
   instruments — qtyFromUSDT le fait, instrument par instrument, ce
   qu'un seuil global sur l'équité ne peut pas faire. */
const MIN_EQUITY_USDT   = Number(process.env.HERMES_MIN_EQUITY_USDT || 5);
const MAX_RISK_PCT      = Number(process.env.HERMES_MAX_RISK_PCT || 0.90); // spec client : 90 % du capital en marge max (coussin 10 %)
const MIN_BALANCE_AVAIL = Number(process.env.HERMES_MIN_BAL_AVAIL || 5);  // USDT

let RUNNING = true;

/* ===== Global Buffers ===== */
const DEALS   = (globalThis.DEALS   = globalThis.DEALS   || { recent: [] });
const HISTORY = (globalThis.HISTORY = globalThis.HISTORY || { spot: [] });

/* ===== Health Dashboard ===== */
const HEALTH = {
  modules: {
    wsPublic:   { status: "FAULT", info: "not-started", lastTs: 0, latencyMs: 0 },
    wsPrivate:  { status: "FAULT", info: "not-started", lastTs: 0, latencyMs: 0, authed: false },
    rest:       { status: "OK",    info: "idle", lastOk: 0, lastErr: 0 },
    dataFlow:   { status: "FAULT", info: "no-ticks", lastTs: 0, count: 0 },
    strategy:   { status: "OK",    info: "idle", lastSignal: 0, lastCandle: 0 },
    aiEngine:   { status: "OK",    info: "off", on: false, lastToggle: 0 },
    orders:     { status: "OK",    info: "idle", placed: 0, errors: 0, inflight: 0 },
    stops:      { status: "OK",    info: "idle", placed: 0, be: 0, trail: 0 },
    portfolio:  { status: "OK",    info: "idle", lastOk: 0, lastErr: 0 }
  },
  ts: tsISO()
};
function setHealth(mod, patch) {
  try { Object.assign(HEALTH.modules[mod], patch || {}); HEALTH.ts = tsISO(); } catch {}
}
function statusFromAge(ageMs, warn = 10000, fault = 25000) {
  if (ageMs > fault) return "FAULT";
  if (ageMs > warn)  return "WARN";
  return "OK";
}

/* ===== STATE ===== */
const AI = {
  on:    (String(process.env.HERMES_AI_DEFAULT_ON || "false").toLowerCase() === "true"),
  simOn: (String(process.env.HERMES_AI_SIM_ALWAYS_ON || "true").toLowerCase() !== "false"),
  mode: "LIVE+SIM",

  equityUSDT: 0,
  equityPeakTier: null,          // amorcé sur l'equity RÉELLE au 1er relevé (plus de 250 en dur)
  tier: "<1000",
  tierStopLossPct: 0.5,

  openPositions: {},             // { instId: { side, qty, avgPx, ts, stopId?, stopPx?, stopMode? } }
  inflight: 0,
  cooldown: {},

  logsAIFile: path.join(DATADIR, "ai-logs.jsonl"),
  simLogsFile: path.join(DATADIR, "sim-logs.jsonl"),

  counters: { signals: 0, ordersPlaced: 0, orderErrors: 0, stopsPlaced: 0, be: 0, trail: 0 }
};

const MARKET = {
  universe: [...DEFAULT_UNIVERSE],
  tick: {}, candles: {},         // 15s store

  meta: {},                      // instId -> {ctVal, lotSz, minSz}
  fees: { maker: null, taker: null },

  wsPublic: null, wsPrivate: null,
  wsConnected: false, privateAuthed: false,
  preLoginQueue: [],
  lastPublicRx: 0, lastPrivateRx: 0
};

const OKX = {
  REST_BASE: OKX_CFG.restBase || "https://www.okx.com",
  PUB_WS: (String(process.env.OKX_SIMULATED || "").toLowerCase() === "true")
    ? (OKX_CFG.wsPublicDemo  || "wss://wspap.okx.com:8443/ws/v5/public")
    : (OKX_CFG.wsPublic      || "wss://ws.okx.com:8443/ws/v5/public"),
  PRI_WS: (String(process.env.OKX_SIMULATED || "").toLowerCase() === "true")
    ? (OKX_CFG.wsPrivateDemo || "wss://wspap.okx.com:8443/ws/v5/private")
    : (OKX_CFG.wsPrivate     || "wss://ws.okx.com:8443/ws/v5/private"),

  KEY:    process.env.OKX_API_KEY || "",
  SECRET: process.env.OKX_API_SECRET || "",
  PASS:   process.env.OKX_API_PASSPHRASE || process.env.OKX_PASSPHRASE || "",
  SIMULATED: (String(process.env.OKX_SIMULATED || "").toLowerCase() === "true")
};
log("[ENV] OKX key:", !!OKX.KEY, "secret:", !!OKX.SECRET, "pass:", !!OKX.PASS, "sim:", OKX.SIMULATED);

/* === UI runtime mode (auto: file/localhost => full, public => viewer) === */
let UI_RUNTIME_MODE = "full";
/* ===== Tiering & sizing ===== */
function currentTier(cap) {
  if (cap >= 2000) return ">=2000";
  if (cap >= 1000) return "1000-1999";
  return "<1000";
}
function tierStopLossPct(t) { return (t === ">=2000") ? 0.30 : 0.50; }

/* Baseline du garde-fou persistée (survit aux redémarrages : un restart ne doit
   pas effacer un vrai drawdown ni réinitialiser le pic sur une equity dégradée). */
const TIER_PEAK_FILE = path.join(ROOT, "runtime", "tier_peak.json");
function loadTierPeak() {
  try { const j = JSON.parse(fs.readFileSync(TIER_PEAK_FILE, "utf8")); if (j && j.peak > 0) AI.equityPeakTier = num(j.peak); } catch {}
}
function saveTierPeak() {
  try { fs.mkdirSync(path.dirname(TIER_PEAK_FILE), { recursive: true }); fs.writeFileSync(TIER_PEAK_FILE, JSON.stringify({ peak: AI.equityPeakTier, ts: Date.now() })); } catch {}
}
function refreshTier() {
  AI.tier = currentTier(AI.equityUSDT);
  /* 1er relevé réel : on amorce le pic sur l'equity courante (jamais 250 en dur). */
  if ((AI.equityPeakTier == null || AI.equityPeakTier <= 0) && AI.equityUSDT > 0) {
    AI.equityPeakTier = AI.equityUSDT; saveTierPeak();
  } else if (AI.equityUSDT > (AI.equityPeakTier || 0)) {
    AI.equityPeakTier = AI.equityUSDT; saveTierPeak();
  }
  AI.tierStopLossPct = tierStopLossPct(AI.tier);
}
function tierBreach() {
  /* Pas de verdict tant que la baseline réelle n'est pas connue. */
  if (AI.equityPeakTier == null || AI.equityPeakTier <= 0 || AI.equityUSDT <= 0) return false;
  const floor = AI.equityPeakTier * (1 - AI.tierStopLossPct);
  return AI.equityUSDT <= floor;
}
/* La taille se déduit du capital, à chaque appel. perTradeUSDT est une
   MARGE — le notionnel envoyé à OKX vaut marge × levier.

   Règle : coussin de 10 % jamais engagé, puis la moitié du budget par
   trade, plafonnée. La moitié plutôt que le dixième parce qu'un dixième
   de petit capital ne produit pas un lot que la place accepte.

   Deux défauts corrigés ici, et ils se voyaient mal parce qu'une garde
   budgétaire séparée rattrapait le second sans rien dire.

   Le plancher valait 50 USDT. Sur un compte de 10, il écrasait la règle
   de la moitié — 4,50 devenait 50, puis se faisait rabattre sur les 9
   disponibles : la totalité du capital partait dans UN trade, l'inverse
   de ce que la règle demande. Le plancher existe pour éviter les
   poussières qui n'atteignent aucun lot ; il ne doit jamais dépasser la
   part qu'il est censé protéger, donc il est borné par elle.

   maxPositions valait 10, écrit en dur, quel que soit le capital. Le
   plan annonçait ainsi 10 × 150 = 1503 USDT de marge pour 300 USDT
   disponibles, et 10 × 9 = 90 pour 9. Ce n'était pas seulement faux :
   canPlaceOrder s'en sert pour décider, et un nombre qui ne veut rien
   dire déplace la décision vers la garde budgétaire, où elle devient
   illisible. Le nombre de places est désormais celui que le budget
   finance vraiment. */
function positionSizing(cap) {
  const usable = Math.max(0, cap * MAX_RISK_PCT);
  const MIN_M  = Number(process.env.HERMES_MARGIN_MIN || 1);
  const MAX_M  = Number(process.env.HERMES_MARGIN_MAX || 200);

  let marginPerTrade = Math.min(usable / 2, MAX_M);
  /* Le plancher ne s'applique QUE s'il est franchi, et il ne peut pas
     dépasser ce qui est disponible : sinon il rendrait la marge plus
     grande que le budget, ce que la suite du calcul devrait défaire. */
  if (marginPerTrade < MIN_M) marginPerTrade = Math.min(MIN_M, usable);

  const places = marginPerTrade > 0
    ? Math.max(1, Math.min(Math.floor(usable / marginPerTrade), MAX_POSITIONS_GLOBAL))
    : 0;

  return { perTradeUSDT: marginPerTrade, maxPositions: places, riskFrac: MAX_RISK_PCT, step: 5 };
}
/* Dit tout haut ce que la taille courante permet d'ouvrir.

   Sans ça, un capital trop petit produit une panne muette : le moteur
   tourne, reçoit les signaux, et qtyFromUSDT rend 0 pour chaque
   instrument dont le lot minimal dépasse la marge visée. Rien ne
   s'ouvre, rien ne s'explique, et on cherche du côté des clés ou de la
   stratégie. C'est la même faute que le plancher d'équité à 50 : un
   refus qui ne se dit pas ressemble à une panne.

   La ligne n'est réimprimée que lorsqu'elle change — sinon elle
   reviendrait toutes les quatre secondes et noierait le journal. */
let __accesEmpreinte = "";
function rapportAccessibilite() {
  const univers = MARKET.universe || [];
  if (!univers.length || !(AI.equityUSDT > 0)) return;
  const s = positionSizing(AI.equityUSDT);
  if (!(s.perTradeUSDT > 0)) return;

  /* On ne juge QUE les instruments dont un prix est arrivé.

     Sans ce filtre, la toute première exécution ment. Elle tombe entre
     le démarrage et l'ouverture du flux public — mesuré : rapport à
     .794, « [WS] public open » à .971 — donc lastPrice vaut 0 partout,
     qtyFromUSDT rend 0 partout, et la ligne annonce « AUCUN instrument
     accessible ». C'est faux, et c'est pire que muet : ça désigne un
     coupable qui n'y est pour rien, et on part régler la taille ou le
     levier pendant que le seul problème était l'ordre d'arrivée. */
  const cotes = univers.filter((id) => (MARKET.tick[id]?.lastPrice || 0) > 0);
  if (!cotes.length) return;

  const oui = [], non = [];
  for (const id of cotes) {
    (qtyFromUSDT(id, s.perTradeUSDT) > 0 ? oui : non).push(id.replace("-USDT-SWAP", ""));
  }

  const empreinte = `${s.perTradeUSDT.toFixed(2)}|${s.maxPositions}|${oui.length}|${non.length}|${cotes.length}`;
  if (empreinte === __accesEmpreinte) return;
  __accesEmpreinte = empreinte;

  log(`[TAILLE] equite ${AI.equityUSDT.toFixed(2)} USDT -> marge ${s.perTradeUSDT.toFixed(2)}`
    + ` x levier ${DEFAULT_LEVERAGE} = ${(s.perTradeUSDT * DEFAULT_LEVERAGE).toFixed(0)} USDT de notionnel,`
    + ` ${s.maxPositions} place(s) | ${oui.length}/${cotes.length} instruments acceptent ce lot`
    + (cotes.length < univers.length ? ` (${univers.length - cotes.length} sans prix encore)` : "")
    + (oui.length ? ` : ${oui.join(", ")}` : "")
    + (non.length ? ` | lot trop gros pour : ${non.join(", ")}` : "")
    + (oui.length ? "" : " | AUCUN instrument accessible a cette taille : rien ne sera ouvert."));
}

function currentOpenCount() { return Object.keys(AI.openPositions).length; }
function perSymbolCooldown(instId) { const t = AI.cooldown[instId] || 0; return now() < t; }
function setCooldown(instId, sec = SYMBOL_COOLDOWN_SEC) { AI.cooldown[instId] = now() + sec * 1000; }

/* Le moteur generique (score SuperTrend/Bollinger/RSI sur bougies de
   15 s) et ses classes CandleStore/Bars5m ont ete SUPPRIMES le
   01/09 a la demande du proprietaire : debranches depuis le 30/08,
   ils calculaient encore a chaque tick pour un journal que personne
   ne lisait. Les entrees viennent de HERMES15 (fin de fichier),
   nourri par config/roster.json que le chercheur de perles ecrit. */

/* ===== Universe loader ===== */
const TAILLE_UNIVERS = Number(process.env.HERMES_UNIVERSE_SIZE || 20);
const RAFRAICHIR_UNIVERS_MS = Number(process.env.HERMES_UNIVERSE_REFRESH_MS || 3600000);
// Sur cent soixante-huit heures, combien doivent avoir vu un echange
// pour quon appelle un marche continu. Une action tokenisee tourne
// autour de trente-cinq heures par semaine ; une crypto, cent
// soixante-huit. Le seuil na donc pas besoin detre fin.
const CONTINU_MIN = Number(process.env.HERMES_CONTINU_MIN || 0.90);

// Le rapport minimal entre lactivite du week-end et celle de la
// semaine. Le seuil est pose DANS UN VIDE OBSERVE, et non choisi :
// au releve du 31 aout, vingt-quatre candidats se separaient en deux
// groupes sans rien entre les deux.
//
//   sous 0,26 : SPCX 0,05  SNDK 0,07  SNXX 0,07  SOXL 0,08  MU 0,09
//               SKHY 0,16  SKHYNIX 0,21  XAU 0,25  CL 0,25  XAG 0,26
//   au-dessus : BTC 0,42  HYPE 0,48  XRP 0,50  PEPE 0,53  ETH 0,54
//               SOL 0,56  DOGE 0,58  PUMP 0,65  SUI 0,69  ZEC 0,87
//               TRUMP 1,25  UNI 2,29
//
// Le groupe bas est exactement celui des actions tokenisees, plus lor,
// largent et le petrole. Le groupe haut, exactement les cryptos.
//
// DEUX EXCEPTIONS, ecrites ici pour quelles ne se perdent pas : ZORA
// (0,22) et 0G (0,08) sont des cryptos et tombent dans la bande basse.
// Elles sont donc ecartees a tort. Cest le prix assume dun seuil
// unique, et il est reversible — HERMES_MARKETS les reimpose, et
// HERMES_WEEKEND_MIN=0 desactive le critere.
//
// Ce seuil repose sur UNE lecture. Ce nest pas la meme chose quune loi
// : cest un vide observe une fois, et un deuxieme releve un autre jour
// dirait sil tient. Les deux exceptions sont peut-etre un accident de
// cette semaine-la — un jeton qui vient detre liste, ou un pic
// dactualite en semaine, produisent le meme chiffre quune bourse
// fermee.
const WEEKEND_MIN = Number(process.env.HERMES_WEEKEND_MIN || 0.34);

/* ===== le critere 24/7, mesure et non devine =====
 *
 * OKX cote des actions tokenisees sur ses perpetuels, et elles montent
 * haut au classement par volume : au premier releve, SNDK, XAU,
 * SKHYNIX, SPCX, MU, SOXL et CL occupaient SEPT des vingt places.
 * Javais ecrit quelles napparaitraient pas a ce niveau — la mesure la
 * dementi en trois minutes.
 *
 * Elles ne sechangent pas le week-end. Une strategie calibree sur un
 * marche continu y rencontre des trous : des prix figes, des stops
 * traverses a la reouverture, des signaux qui se declenchent sur des
 * bougies mortes.
 *
 * Le critere est une MESURE et non une liste de noms : on compte les
 * heures qui ont vu un echange sur les sept derniers jours. Une liste
 * de noms vieillit — OKX en ajoute — tandis quun marche qui ferme se
 * trahit toujours de la meme facon. Et le resultat est imprime pour
 * TOUS les candidats, admis compris : un critere qui ne sexplique que
 * lorsquil dit non est a moitie aveugle.
 */
const _continuite = new Map();      // instId -> { continu, heures, ts }
const CONTINUITE_TTL_MS = 12 * 3600 * 1000;

async function mesurerContinuite(instId) {
  const cache = _continuite.get(instId);
  if (cache && Date.now() - cache.ts < CONTINUITE_TTL_MS) return cache;
  let res = { continu: true, heures: -1, weekend: -1, ts: Date.now() };
  try {
    const r = await axios.get(
      OKX.REST_BASE + `/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=1H&limit=168`,
      { timeout: Number(process.env.HERMES_API_TIMEOUT_MS || 12000) }
    );
    const c = Array.isArray(r.data?.data) ? r.data.data : [];
    const heures = c.filter((b) => num(b[5]) > 0).length;

    // Le rapport entre lactivite du week-end et celle de la semaine.
    //
    // Le comptage dheures actives ci-dessus NE SEPARE RIEN : au premier
    // releve, SNDK, XAU, SPCX et SOXL affichaient 168/168 comme BTC. La
    // raison est que ce sont des PERPETUELS OKX sur ces actions, et non
    // les actions : le perpetuel sechange bien vingt-quatre heures sur
    // vingt-quatre, meme bourse fermee. Le critere etait bien forme et
    // ne repondait pas a la question.
    //
    // Ce qui distingue vraiment ces instruments, cest que leur activite
    // SEFFONDRE le week-end pendant que celle dune crypto ne bouge
    // guere. La quantite est imprimee et NEST PAS un seuil : poser un
    // seuil sur un nombre vu une seule fois est exactement lerreur qui
    // vient detre commise deux fois de suite. Elle le deviendra quand
    // plusieurs releves auront montre ou passe la separation.
    let vSem = 0, nSem = 0, vWe = 0, nWe = 0;
    for (const b of c) {
      const j = new Date(num(b[0])).getUTCDay();      // 0 dimanche, 6 samedi
      const v = num(b[7]) || num(b[6]) || num(b[5]);  // volume en quote si disponible
      if (j === 0 || j === 6) { vWe += v; nWe++; } else { vSem += v; nSem++; }
    }
    const moyWe = nWe ? vWe / nWe : 0;
    const moySem = nSem ? vSem / nSem : 0;
    const weekend = moySem > 0 ? moyWe / moySem : -1;

    res = { continu: heures >= Math.round(168 * CONTINU_MIN), heures, weekend, ts: Date.now() };
  } catch (e) {
    // Une mesure ratee nest pas une preuve de discontinuite. On laisse
    // passer, et le prochain rafraichissement retentera — refuser sur
    // un timeout viderait luniverse a la premiere minute difficile.
    res = { continu: true, heures: -1, weekend: -1, ts: Date.now() };
  }
  _continuite.set(instId, res);
  return res;
}

async function loadUniverse() {
  if (DEFAULT_UNIVERSE.length) return DEFAULT_UNIVERSE;
  try {
    const r = await axios.get(
      OKX.REST_BASE + "/api/v5/market/tickers?instType=SWAP",
      { timeout: Number(process.env.HERMES_API_TIMEOUT_MS || 12000) }
    );
    const arr = Array.isArray(r.data?.data) ? r.data.data : [];

    // Le classement se faisait sur volCcy24h seul. Or ce champ est un
    // volume exprime DANS LA MONNAIE DE BASE de chaque instrument :
    // trier dessus revient a comparer des BTC a des DOGE, cest-a-dire a
    // classer par NOMBRE DE PIECES et non par argent echange. SHIB et
    // PEPE ecrasaient alors mecaniquement BTC — le classement obtenu
    // netait pas « les plus gros volumes » mais « les moins chers ».
    // Multiplier par le dernier prix ramene tout le monde en dollars.
    const cote = (x) => num(x.volCcy24h) * num(x.last);

    const classe = arr
      .filter((x) => String(x.instId || "").endsWith("-USDT-SWAP"))
      .filter((x) => cote(x) > 0)
      .sort((a, b) => cote(b) - cote(a));

    // On descend le classement en verifiant la continuite, et on
    // sarrete quand on a le compte. Inutile deprouver les cent.
    // Les candidats sont eprouves par paquets. Un par un, soixante
    // appels a la suite mettaient une minute, et le demarrage entier
    // attendait derriere.
    const candidats = classe.slice(0, TAILLE_UNIVERS * 3);
    const retenus = [];
    const trace = [];
    for (let i = 0; i < candidats.length && retenus.length < TAILLE_UNIVERS; i += 6) {
      const paquet = candidats.slice(i, i + 6);
      const mesures = await Promise.all(paquet.map((x) => mesurerContinuite(x.instId)));
      paquet.forEach((x, k) => {
        const m = mesures[k];
        const nom = String(x.instId).replace("-USDT-SWAP", "");
        const ok = m.continu && (m.weekend < 0 || m.weekend >= WEEKEND_MIN);
        trace.push(`${nom} ${(cote(x) / 1e6).toFixed(0)}M ${m.heures}/168h`
          + ` we=${m.weekend >= 0 ? m.weekend.toFixed(2) : "?"}${ok ? "" : " REFUSE"}`);
        if (ok && retenus.length < TAILLE_UNIVERS) retenus.push(x.instId);
      });
    }

    if (retenus.length) {
      log(`[UNI] ${retenus.length} instruments retenus, par volume 24 h en dollars,`
        + ` avec les heures actives sur sept jours : ${trace.join(", ")}`);
      return retenus;
    }
    return ["BTC-USDT-SWAP", "ETH-USDT-SWAP"];
  } catch (e) {
    log("[UNI_ERR]", e.message);
    return ["BTC-USDT-SWAP", "ETH-USDT-SWAP"];
  }
}

// Les volumes tournent, et le moteur reste en marche des jours. Un
// univers fixe au demarrage derive donc sans que rien ne le signale.
// On le rejoue, et on IMPRIME les entrees et les sorties : un univers
// qui change en silence est un univers dont on ne peut pas expliquer
// les trades apres coup.
async function rafraichirUnivers() {
  if (DEFAULT_UNIVERSE.length) return;          // liste imposee a la main
  try {
    const neuf = await loadUniverse();
    if (!neuf || neuf.length < 2) return;
    const avant = new Set(MARKET.universe);
    const apres = new Set(neuf);
    const entrent = neuf.filter((i) => !avant.has(i));
    const sortent = [...avant].filter((i) => !apres.has(i));

    // Un instrument sur lequel une position est ouverte ne quitte pas
    // luniverse : le moteur cesserait de recevoir son prix, donc de
    // pouvoir la surveiller ni la fermer.
    const tenus = sortent.filter((i) => AI.openPositions[i]);
    const final = tenus.length ? [...neuf, ...tenus] : neuf;

    if (entrent.length || sortent.length) {
      MARKET.universe = final;
      log(`[UNI] rotation — entrent: ${entrent.map((s) => s.replace("-USDT-SWAP", "")).join(", ") || "aucun"}`
        + ` | sortent: ${sortent.map((s) => s.replace("-USDT-SWAP", "")).join(", ") || "aucun"}`
        + (tenus.length ? ` | gardes car position ouverte: ${tenus.map((s) => s.replace("-USDT-SWAP", "")).join(", ")}` : ""));
      try { await loadMetaInstruments(); } catch {}
    }
  } catch (e) {
    log("[UNI_REFRESH_ERR]", e.message);
  }
}

/* ===== Meta instruments & fees ===== */
async function loadMetaInstruments() {
  try {
    const r = await axios.get(
      OKX.REST_BASE + "/api/v5/public/instruments?instType=SWAP",
      { timeout: Number(process.env.HERMES_API_TIMEOUT_MS || 15000) }
    );
    const arr = Array.isArray(r.data?.data) ? r.data.data : [];
    for (const x of arr) {
      MARKET.meta[x.instId] = {
        ctVal: num(x.ctVal || 1),
        lotSz: num(x.lotSz || 0.001),
        minSz: num(x.minSz || 0.001),
        tickSz: String(x.tickSz || ""),  // pas de repli ici : pxToTick doit voir le vrai tick
        maxLever: num(x.lever || 0)      // levier max de la plateforme pour cet instrument
      };
    }
  } catch (e) { log("[META_ERR]", e.message); }
}

async function loadTradeFees() {
  try {
    const q = "/api/v5/account/trade-fee?instType=SWAP";
    const r = await axios.get(OKX.REST_BASE + q, {
      headers: okxRestHeaders(q, "GET", ""),
      timeout: 12000
    });
    const d = r.data?.data?.[0] || r.data?.data?.data?.[0] || r.data?.[0] || {};
    MARKET.fees.maker = (d.maker || d.makerU) ? num(d.maker || d.makerU) : null;
    MARKET.fees.taker = (d.taker || d.takerU) ? num(d.taker || d.takerU) : null;
  } catch (e) {
    try {
      const q2 = "/api/v5/account/trade-fee?instType=SWAP&ruleType=normal";
      const r2 = await axios.get(OKX.REST_BASE + q2, {
        headers: okxRestHeaders(q2, "GET", ""),
        timeout: 12000
      });
      const d2 = r2.data?.data?.[0] || {};
      MARKET.fees.maker = (d2.maker || d2.makerU) ? num(d2.maker || d2.makerU) : null;
      MARKET.fees.taker = (d2.taker || d2.takerU) ? num(d2.taker || d2.takerU) : null;
    } catch (e2) { log("[FEE_ERR]", e2.message); }
  }
}

/* ===== Heartbeat helper + backoff ===== */
/* Le délai d'attente du pong ne s'arme qu'APRÈS l'émission d'un ping : l'ancienne
   version comparait à un lastPong jamais rafraîchi (aucun ping envoyé sur un flux
   actif) et tuait chaque connexion ~11 s après l'ouverture. */
function attachOkxHeartbeat(ws, name = "WS") {
  let lastRx = Date.now();
  let awaitingPong = false;
  let pingSentAt = 0;

  const pingTimer = setInterval(() => {
    try {
      const nowT = Date.now();
      if (!awaitingPong && nowT - lastRx > HB_PING_IDLE_MS) {
        try { ws.ping(); awaitingPong = true; pingSentAt = nowT; } catch {}
      }
      if (awaitingPong && nowT - pingSentAt > HB_PONG_WAIT_MS) {
        log(`[WS] ${name} heartbeat timeout -> terminate`);
        try { ws.terminate(); } catch {}
        clearInterval(pingTimer);
      }
    } catch {}
  }, HB_TIMER_MS);

  ws.on("message", () => { lastRx = Date.now(); awaitingPong = false; });
  ws.on("pong",    () => { lastRx = Date.now(); awaitingPong = false; });
  ws.on("ping", (data) => { try { ws.pong(data); } catch {} });
  ws.on("close",  () => { try { clearInterval(pingTimer); } catch {} });
  ws.on("error",  () => { try { clearInterval(pingTimer); } catch {} });
}

/* État de backoff persistant par socket : l'ancienne closure était recréée à chaque
   reconnexion, le délai restait donc bloqué à ~1 s pour toujours. */
const BACKOFF_STATE = {};
function withBackoff(startMs, key) {
  const k = key || "ws";
  if (!BACKOFF_STATE[k]) BACKOFF_STATE[k] = clamp(startMs || BK_MIN, BK_MIN, BK_MAX);
  return async function bump(label) {
    const jitter = rndInt(0, BK_JITTER);
    const wait = Math.min(BACKOFF_STATE[k] + jitter, BK_MAX);
    log(`[WS] ${label} reconnect in ${wait}ms`);
    await sleep(wait);
    BACKOFF_STATE[k] = Math.min(BACKOFF_STATE[k] * 2, BK_MAX);
  };
}
function resetBackoff(key) { BACKOFF_STATE[key] = BK_MIN; }

/* ===== REST Helpers (OKX compliant) ===== */
/* Décalage horloge locale ↔ serveur OKX. Sur une VM Windows dont l'horloge dérive,
   un timestamp faux fait échouer TOUS les appels signés (code 50102). On se cale
   sur l'heure serveur au boot puis toutes les 15 min, et on signe avec l'heure corrigée. */
let TIME_OFFSET_MS = 0;
async function syncServerTime() {
  try {
    const r = await axios.get(OKX.REST_BASE + "/api/v5/public/time", { timeout: 8000 });
    const srv = Number(r?.data?.data?.[0]?.ts);
    if (srv > 0) {
      const drift = srv - Date.now();
      TIME_OFFSET_MS = drift;
      if (Math.abs(drift) > 1500) log("[TIME] dérive horloge corrigée:", drift, "ms");
    }
  } catch (e) { log("[TIME] sync impossible:", e.message); }
}

function okxRestHeaders(pathname, method = "GET", body = "") {
  const ts = new Date(Date.now() + TIME_OFFSET_MS).toISOString(); // horloge alignée serveur
  const prehash = ts + method + pathname + (body || "");
  const sign = crypto.createHmac("sha256", OKX.SECRET).update(prehash).digest("base64");
  const headers = {
    "OK-ACCESS-KEY":       OKX.KEY,
    "OK-ACCESS-SIGN":      sign,
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": OKX.PASS,
    "Content-Type": "application/json"
  };
  if (OKX.SIMULATED) headers["x-simulated-trading"] = "1";
  return headers;
}

/* Faut-il retenter cet appel ? (rate-limit, erreurs serveur, réseau, horloge). */
function __okxRetryable(e) {
  const st = e?.response?.status;
  if (st === 429 || (st >= 500 && st <= 599)) return true;
  const code = e?.response?.data?.code;
  if (code === "50011" || code === "50102" || code === "50001") return true; // rate-limit / timestamp / busy
  if (["ECONNRESET","ETIMEDOUT","ECONNREFUSED","EAI_AGAIN","ECONNABORTED"].includes(e?.code)) return true;
  return false;
}
async function __okxWithRetry(fn, label) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (!__okxRetryable(e)) break;
      if (e?.response?.data?.code === "50102") await syncServerTime(); // resynchro immédiate
      const wait = 300 * Math.pow(2, i) + Math.floor(Math.random() * 200);
      log("[REST_RETRY]", label, "tentative", i + 1, "dans", wait, "ms", e?.response?.data?.code || e?.code || e?.response?.status || e.message);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/* Mode de position du compte (net_mode | long_short_mode) — détecté au boot.
   En mode net, posSide doit être OMIS et les algos de protection portent reduceOnly. */
let POS_MODE = "net_mode";
async function loadAccountPosMode() {
  try {
    const r = await okxGET("/api/v5/account/config");
    const m = r?.data?.[0]?.posMode;
    if (m) { POS_MODE = m; log("[ACCOUNT] posMode:", m); }
  } catch (e) { log("[ACCOUNT] posMode indétectable, défaut net_mode:", e.message); }
}
const isHedge = () => POS_MODE === "long_short_mode";

async function okxGET(pathname, params) {
  const url = new URL(OKX.REST_BASE + pathname);
  if (params) Object.keys(params).forEach(k => url.searchParams.append(k, params[k]));
  try {
    const r = await __okxWithRetry(() => axios.get(url.toString(), {
      headers: okxRestHeaders(url.pathname + url.search, "GET", ""),
      timeout: Number(process.env.HERMES_API_TIMEOUT_MS || 12000),
      httpsAgent: new https.Agent({ keepAlive: true })
    }), "GET " + pathname);
    setHealth("rest", { status: "OK", info: "GET " + pathname, lastOk: Date.now() });
    return r.data;
  } catch (e) {
    setHealth("rest", { status: "WARN", info: "GET_ERR " + pathname, lastErr: Date.now() });
    log("[REST_ERR GET]", pathname, e?.response?.data ? JSON.stringify(e.response.data) : e.message);
    throw e;
  }
}

async function okxPOST(pathname, body) {
  const payload = JSON.stringify(body || {});
  try {
    const r = await __okxWithRetry(() => axios.post(OKX.REST_BASE + pathname, payload, {
      headers: okxRestHeaders(pathname, "POST", payload),
      timeout: Number(process.env.HERMES_API_TIMEOUT_MS || 12000),
      httpsAgent: new https.Agent({ keepAlive: true })
    }), "POST " + pathname);
    setHealth("rest", { status: "OK", info: "POST " + pathname, lastOk: Date.now() });
    return r.data;
  } catch (e) {
    setHealth("rest", { status: "WARN", info: "POST_ERR " + pathname, lastErr: Date.now() });
    log("[REST_ERR POST]", pathname, e?.response?.data ? JSON.stringify(e.response.data) : e.message);
    throw e;
  }
}
/* ===== Prefill bars 5m ===== */

/* ===== Helpers qty from USDT (contracts) ===== */
function roundQtyToLot(instId, qty) {
  const meta  = MARKET.meta[instId] || { lotSz: 0.001, minSz: 0.001 };
  const step  = num(meta.lotSz || 0.001);
  const minSz = num(meta.minSz || step);
  const rounded = Math.floor(qty / step) * step;
  return Math.max(rounded, minSz);
}
function qtyFromUSDT(instId, marginUSDT) {
  const px = MARKET.tick[instId]?.lastPrice || 0;
  const ct = num(MARKET.meta[instId]?.ctVal || 1);
  if (px <= 0 || ct <= 0 || marginUSDT <= 0) return 0;
  const lev = DEFAULT_LEVERAGE || 20;
  const notional = marginUSDT * lev;              // la spec donne une MARGE par trade
  const contracts = notional / (px * ct);
  const q = roundQtyToLot(instId, contracts);
  /* si l'arrondi au lot minimal dépasse nettement la marge visée, on SAUTE le
     trade au lieu de sur-risquer en silence (ancien bug : minSz forcé). */
  const actualMargin = (q * px * ct) / lev;
  /* tolérance serrée : à 1,5 la surconsommation cumulée mangeait le budget des
     10 places (6 positions = 95 USDT au lieu de 60-70) et bloquait les ré-ouvertures */
  if (actualMargin > marginUSDT * 1.10) return 0;
  return q;
}

/* Marge réellement consommée par les positions ouvertes : la marge isolée RÉELLE
   d'OKX quand la synchro l'a fournie, sinon estimation notionnel/levier. */
function usedMarginNow() {
  /* + marge RÉSERVÉE par les ordres en cours d'envoi : plusieurs signaux simultanés
     ne peuvent plus se partager le même reliquat de budget (rafale post-chauffe). */
  return num(AI.reservedMargin || 0) + Object.values(AI.openPositions).reduce((a, p) => {
    if (num(p.realMargin) > 0) return a + num(p.realMargin);
    const ppx = MARKET.tick[p.instId]?.lastPrice || p.avgPx || 0;
    const pct = num(MARKET.meta[p.instId]?.ctVal || 1);
    const ntn = ppx * Math.abs(p.qty || 0) * pct;
    return a + (DEFAULT_LEVERAGE > 0 ? ntn / DEFAULT_LEVERAGE : ntn);
  }, 0);
}

/* ===== Orders & Stops ===== */
/* === ORDER DEDUP HELPER START === */
function __keySide(side){
  const s = String(side||"").toLowerCase();
  return (s==="buy"||s==="long") ? "long" : "short";
}
function __shouldPlace(instId, side){
  /* Fenêtre par symbole+sens portée à 60 s : empêche la double-entrée sur un même
     symbole (bug observé : W ouvert 2× à 15 s d'intervalle, l'ancien gap de 1,5 s ne
     le couvrait pas). Un symbole déjà en position ne doit pas être réattaqué. */
  if (!global.__ORDER_DEDUP__) global.__ORDER_DEDUP__ = { t:{}, gap: Number(process.env.HERMES_ORDER_DEDUP_MS || 60000) };
  const key = `${instId}|${__keySide(side)}`;
  const now = Date.now();
  const last = global.__ORDER_DEDUP__.t[key] || 0;
  if (now - last < global.__ORDER_DEDUP__.gap) return false; // doublon rÃ©cent
  global.__ORDER_DEDUP__.t[key] = now;
  return true;
}
/* === ORDER DEDUP HELPER END === */
function canPlaceOrder(instId, side, availableUSDT = Infinity) {
  if (!AI.on) return false;
  if (AI.inflight >= MAX_ORDERS_INFLIGHT) return false;
  if (perSymbolCooldown(instId)) return false;

  if (!/-USDT-SWAP$/.test(instId)) return false;   // marge USDT uniquement (jamais les contrats coin-margined)
  const maxLev = num(MARKET.meta[instId]?.maxLever || 0);
  if (maxLev > 0 && maxLev < DEFAULT_LEVERAGE) return false;   // levier spec ×20 impossible ici (ex. BSB max 10x)

  const open = currentOpenCount();
  const sizing = positionSizing(AI.equityUSDT);
  if (open >= Math.min(MAX_POSITIONS_GLOBAL, sizing.maxPositions)) return false;

  /* Jamais de ré-entrée sur un symbole déjà en position (mode net : une seule
     position nette par instrument → on ne double ni ne réduit une position existante). */
  const pos = AI.openPositions[instId];
  if (pos) return false;

  if (AI.equityUSDT < MIN_EQUITY_USDT) return false;
  /* Assez de solde LIBRE pour financer un trade. Le seuil était fixe à
     5 USDT : négligeable sur un gros compte, la moitié du capital sur
     un compte de 10. On le compare donc à ce qu'un trade coûte
     réellement, sans jamais durcir le seuil existant. */
  const seuilLibre = Math.min(MIN_BALANCE_AVAIL, sizing.perTradeUSDT);
  if (availableUSDT < seuilLibre) return false;

  /* Fraîcheur : refus si le dernier tick date de plus de 10 s (flux gelé). */
  const tk = MARKET.tick[instId];
  if (!tk || !tk.rx || (Date.now() - tk.rx) > 10000) return false;

  /* Budget de marge (spec : 90 % de l'équité). Il suffit qu'il reste de quoi
     ouvrir un trade minimal — placeMarket dimensionne ensuite sur le reliquat,
     donc les places libérées se re-remplissent dès qu'un signal arrive. */
  const budget = MAX_RISK_PCT * AI.equityUSDT;
  /* La réserve est ce qu'un trade coûte, pas une constante. À 5 USDT
     fixes sur un budget de 9, la deuxième place que le calcul de taille
     vient d'accorder était refusée ici — les deux moitiés du programme
     ne parlaient pas du même compte. */
  if (usedMarginNow() + seuilLibre > budget) return false;
  return true;
}

async function placeInitialStop(instId, side, entryPx) {
  try {
    const s = positionSizing(AI.equityUSDT);
    const step = s.step;
    const k = 5; // profondeur initiale (5 * step)
    const stopPx = side === "long" ? Math.max(0.5, entryPx - k * step) : entryPx + k * step;

    const body = {
      instId, tdMode: "isolated", posSide: side,
      side: side === "long" ? "sell" : "buy",
      ordType: "trigger",
      triggerPx: String(stopPx),
      tpTriggerPxType: OKX_CFG.trading?.triggerPxType || "mark",
      slTriggerPxType: OKX_CFG.trading?.triggerPxType || "mark"
    };
    const res = await okxPOST("/api/v5/trade/order-algo", body);
    if (res?.data?.[0]?.algoId) {
      AI.counters.stopsPlaced++;
      setHealth("stops", { placed: AI.counters.stopsPlaced, status: "OK", info: "placed" });
      return { ok: true, algoId: res.data[0].algoId, stopPx };
    }
    return { ok: false, res };
  } catch (e) {
    setHealth("stops", { status: "WARN", info: "placeInitialStop error" });
    log("[STOP_INIT_ERR]", instId, e.message);
    return { ok: false, error: e.message };
  }
}

/* Trailing natif exchange Ã¢â‚¬â€ ratio conservateur */
async function placeTrailing(instId, side, entryPx) {
  try {
    const ratio = 0.003; // 0.3%
    const activePx = side === "long" ? entryPx * (1 + 0.002) : entryPx * (1 - 0.002);
    const body = {
      instId, tdMode: "isolated", posSide: side,
      ordType: "move_order_stop",
      callbackRatio: String(ratio),
      activePx: String(activePx.toFixed(6))
    };
    const r = await okxPOST("/api/v5/trade/order-algo", body);
    if (r?.data?.[0]?.algoId) return { ok: true, algoId: r.data[0].algoId };
    return { ok: false, r };
  } catch (e) { log("[TRAIL_ERR]", instId, e.message); return { ok: false, error: e.message }; }
}

async function placeMarket(instId, side) {
  const s  = positionSizing(AI.equityUSDT);
  const px = MARKET.tick[instId]?.lastPrice || 0;
  const qty= qtyFromUSDT(instId, s.perTradeUSDT);
  if (px <= 0 || qty <= 0) return { ok: false, reason: "noPriceOrQty" };

  // Guardrails avec balance
  const port = await loadPortfolio().catch(() => null);
  const availableUSDT = num(port?.balances?.details?.find(d => String(d.ccy).toUpperCase() === "USDT")?.availBal || 0);
  if (!canPlaceOrder(instId, side, availableUSDT)) return { ok: false, reason: "cannotPlace" };

  try {
    AI.inflight++; setHealth("orders", { inflight: AI.inflight });

    await okxPOST("/api/v5/account/set-leverage", { instId, lever: String(DEFAULT_LEVERAGE), mgnMode: "isolated", posSide: side });

    const res = await okxPOST('/api/v5/trade/order', {
      instId, tdMode: "isolated",
      side: side === "long" ? "buy" : "sell",
      ordType: "market",
      sz: String(qty),
      posSide: side});

    AI.counters.ordersPlaced++; setHealth("orders", { placed: AI.counters.ordersPlaced, status: "OK", info: "placed" });
    logAIEvent({ event: "TRADE_ENTER", instId, side, qty, price: px, live: true });

    const stp = await placeInitialStop(instId, side, px);
    if (stp.ok) {
      if (!AI.openPositions[instId]) AI.openPositions[instId] = { side, qty, avgPx: px, ts: now() };
      AI.openPositions[instId].stopId = stp.algoId;
      AI.openPositions[instId].stopPx = stp.stopPx;
      logAIEvent({ event: "STOP_PLACED", instId, side, stopPx: stp.stopPx, live: true });
    }
    // Trailing additionnel
    placeTrailing(instId, side, px).catch(() => {});

    setCooldown(instId);
    return { ok: true, res };
  } catch (e) {
    AI.counters.orderErrors++; setHealth("orders", { errors: AI.counters.orderErrors, status: "WARN", info: "place error" });
    log("[ORDER_ERR]", instId, side, e.message);
    return { ok: false, error: e.message };
  } finally {
    AI.inflight = Math.max(0, AI.inflight - 1);
    setHealth("orders", { inflight: AI.inflight });
  }
}

/* ===== Logging (push vers UI) ===== */
function broadcastAILog(payload) {
  try {
    if (payload == null) return;
    const all = BrowserWindow.getAllWindows() || [];
    for (const w of all) w.webContents.send("ai-log", payload);
  } catch {}
}
function broadcastHealth() {
  try {
    const all = BrowserWindow.getAllWindows() || [];
    for (const w of all) w.webContents.send("health-tick", HEALTH);
  } catch {}
}
function logAIEvent(obj) {
  const line = { ts: tsISO(), ...obj };
  const file = obj.live ? AI.logsAIFile : AI.simLogsFile;
  appendJSONL(file, line);
  if (["TRADE_ENTER", "TRADE_EXIT", "AI_TOGGLE", "GUARD", "STOP_PLACED", "STOP_BE", "STOP_TRAIL"].includes(obj.event)) {
    log("[AI]", obj.event, JSON.stringify(obj));
  }
  broadcastAILog(line);
}

/* ===== UI mode helpers ===== */
function isPrivateLAN(_hostname) { return false; } // garde public => viewer seulement si host public
function hostnameFromURL(u) { try { return new URL(u).hostname || ""; } catch { return ""; } }
function computeUIModeFromURL(u) {
  const forced = String(process.env.HERMES_UI_MODE || "").toLowerCase();
  if (forced === "full")   return "full";
  if (forced === "viewer") return "viewer";
  // Servi en HTTP, ladresse decoute ne dit RIEN de qui se connecte.
  // Sur une machine de bureau, « localhost » voulait dire « cest moi »,
  // et cetait un raisonnement juste. Sur un serveur, le navigateur est
  // ailleurs : 127.0.0.1 est simplement lendroit ou le processus ecoute,
  // et le lire comme une preuve de confiance accorderait le pilotage
  // complet a quiconque atteint le port. Le defaut est donc « viewer »,
  // et passer en pilotage demande un geste explicite dans
  // lenvironnement du service — HERMES_UI_MODE=full.
  if (String(u || "").startsWith("http")) return "viewer";
  if (!u || u.startsWith("file://")) return "full";
  const host = hostnameFromURL(u);
  if (host === "localhost" || host === "127.0.0.1") return "full";
  if (isPrivateLAN(host)) return "full";
  return "viewer";
}
function isViewerMode() { return UI_RUNTIME_MODE === "viewer"; }
/* ===== Portfolio & Private WS ===== */
async function loadPortfolio() {
  if (!OKX.KEY || !OKX.SECRET || !OKX.PASS) {
    return { balances: { totalEq: AI.equityUSDT || 0, details: [] }, positions: [], ts: tsISO(), note: "NO_OKX_CREDS" };
  }
  try {
    const b = await okxGET("/api/v5/account/balance");
    const root = (b?.data?.[0]) || (b?.data?.data?.[0]) || {};
    const totalEq = num(root.totalEq || root.totalAvailEq || 0);
    const det = Array.isArray(root.details) ? root.details : [];
    const balances = {
      totalEq,
      details: det.map(d => ({
        ccy: String(d.ccy || "USDT"),
        eq: num(d.eq),
        availBal: num(d.availBal ?? d.cashBal),
        cashBal:  num(d.cashBal)
      }))
    };

    const p = await okxGET("/api/v5/account/positions", { instType: "SWAP" });
    const arr = Array.isArray(p?.data) ? p.data : (Array.isArray(p?.data?.data) ? p.data.data : []);
    const positions = arr.map(x => ({
      instId:  String(x.instId || ""),
      posSide: String(x.posSide || ""),
      lever:   num(x.lever ?? x.leverage),
      sz:      num(x.pos || x.sz || 0),
      avgPx:   num(x.avgPx || x.openAvgPx),
      margin:  num(x.margin ?? x.imr ?? 0),   // marge isolée réellement immobilisée
      // null quand OKX ne la pas fourni, jamais 0 : un PnL absent et un
      // PnL nul sont deux informations differentes, et les confondre
      // ferait retomber laffichage sur un calcul local moins juste.
      upl:      x.upl      === undefined ? null : num(x.upl),
      uplRatio: x.uplRatio === undefined ? null : num(x.uplRatio),
      markPx:  num(x.markPx),
      liqPx:   num(x.liqPx),
      cTime:   num(x.cTime)     // heure douverture COTE EXCHANGE : elle
                                // survit aux redemarrages du moteur, la
                                // notre non
    }));

    setHealth("portfolio", { status: "OK", info: "fetch", lastOk: Date.now() });
    return { balances, positions, ts: tsISO() };
  } catch (e) {
    setHealth("portfolio", { status: "WARN", info: "fetch error", lastErr: Date.now() });
    log("[PORTFOLIO_ERR]", e.message);
    return { balances: { totalEq: AI.equityUSDT || 0, details: [] }, positions: [], ts: tsISO(), error: String(e.message || e) };
  }
}

/* Les protections VIVANTES, lues chez OKX et non dans la memoire du
   moteur.

   La page affichait le stop et le take-profit depuis AI.openPositions.
   Or cette memoire meurt a chaque redemarrage : une position readoptee
   ny a plus ni tp, ni sl, ni stop — et la carte montrait alors une
   position nue, comme si rien ne la protegeait, pendant quOKX detenait
   bel et bien un OCO et un trailing poses par le moteur lui-meme.
   Lecran de lexchange et le notre racontaient deux histoires.

   La source de verite est donc la liste des ordres algo EN ATTENTE chez
   OKX. Elle dit aussi une chose que la memoire ne dira jamais : ou en
   est le trailing (moveTriggerPx), puisque cest lexchange qui le fait
   glisser. */
let ALGOS = { ts: 0, par: {} };
async function chargerAlgosEnCours() {
  if (!OKX.KEY || !OKX.SECRET || !OKX.PASS) return;
  if (Date.now() - ALGOS.ts < 10000) return;   // 4 requetes toutes les 10 s suffisent
  ALGOS.ts = Date.now();                        // pose AVANT : un echec ne doit pas marteler
  const par = {};
  // Le point dOKX nadmet quUN ordType par appel, do la boucle.
  for (const t of ["oco", "conditional", "trigger", "move_order_stop"]) {
    try {
      const r = await okxGET("/api/v5/trade/orders-algo-pending", { instType: "SWAP", ordType: t });
      for (const a of (Array.isArray(r?.data) ? r.data : [])) {
        const id = String(a.instId || "");
        if (!id) continue;
        (par[id] = par[id] || []).push({
          type: t,
          tp:        num(a.tpTriggerPx),
          sl:        num(a.slTriggerPx),
          declenche: num(a.triggerPx),
          suit:      num(a.moveTriggerPx),  // le trail, la ou il en est
          actif:     num(a.activePx)
        });
      }
    } catch (e) { /* la prochaine passe retentera ; rien a casser ici */ }
  }
  ALGOS.par = par;
}

/* Les positions FERMEES — la verite d'OKX, pas la notre. Le winrate
   affiche se calculait sur une liste de « deals » persistee par le
   moteur : elle derive (redemarrages, fusions de fills) et racontait
   50 % la ou l'exchange comptait trois cloturees, trois gagnees.
   positions-history rend chaque position fermee avec son PnL realise,
   frais et financement compris : c'est elle qui fait foi, et c'est
   elle que la page montre en historique. */
let FERMEES = { ts: 0, liste: [] };
async function chargerPositionsFermees() {
  if (!OKX.KEY || !OKX.SECRET || !OKX.PASS) return;
  if (Date.now() - FERMEES.ts < 60000) return;   // une fois par minute suffit
  FERMEES.ts = Date.now();                        // pose AVANT : un echec ne martele pas
  try {
    const r = await okxGET("/api/v5/account/positions-history", { instType: "SWAP", limit: "100" });
    const rows = Array.isArray(r?.data) ? r.data : [];
    const liste = rows.map((p) => ({
      symbol:     String(p.instId || ""),
      side:       String(p.direction || "").toLowerCase() === "short" ? "SHORT" : "LONG",
      leverage:   num(p.lever) || null,
      openTime:   num(p.cTime) || null,
      closeTime:  num(p.uTime) || null,
      entryPrice: num(p.openAvgPx) || null,
      closePrice: num(p.closeAvgPx) || null,
      // realizedPnl inclut frais et financement ; pnl est le brut.
      pnl:        num(p.realizedPnl !== undefined && p.realizedPnl !== "" ? p.realizedPnl : p.pnl),
      pnlRatio:   num(p.pnlRatio) * 100,
    })).filter((p) => p.symbol && p.closeTime);
    liste.sort((a, b) => b.closeTime - a.closeTime);
    FERMEES.liste = liste;
  } catch (e) { /* la prochaine passe retentera */ }
}

async function portfolioLoop() {
  while (RUNNING) {
    try {
      const port = await loadPortfolio();
      AI.equityUSDT = num(port.balances?.totalEq || AI.equityUSDT);
      refreshTier();
      try { rapportAccessibilite(); } catch {}
      // Sans await : la fraicheur des protections vaut moins que la
      // regularite de cette boucle, qui synchronise aussi les positions.
      chargerAlgosEnCours().catch(() => {});
      chargerPositionsFermees().catch(() => {});

      /* Synchro de l'état des positions avec OKX (toutes les 4 s) : garantit que
         canPlaceOrder voit fidèlement les symboles déjà ouverts → empêche la
         ré-entrée (et donc le doublement) d'une position existante. */
      if (!port.error && Array.isArray(port.positions)) {   // jamais de purge sur une lecture en échec
        const realOpen = {};
        for (const x of port.positions) {
          const sz = num(x.sz);
          if (Math.abs(sz) <= 0) continue;
          const side = (String(x.posSide) === "short" || sz < 0) ? "short" : "long";
          realOpen[x.instId] = true;
          if (!AI.openPositions[x.instId]) AI.openPositions[x.instId] = { instId: x.instId, side, qty: Math.abs(sz), avgPx: num(x.avgPx), realMargin: num(x.margin), ts: Date.now(), adopted: true };
          else { AI.openPositions[x.instId].side = side; AI.openPositions[x.instId].qty = Math.abs(sz); AI.openPositions[x.instId].realMargin = num(x.margin); }
        }
        for (const id of Object.keys(AI.openPositions)) {
          if (!realOpen[id]) delete AI.openPositions[id];   // fermée côté OKX → libère le slot
        }
      }

      // Guard Ã¢â‚¬Å“tier breachÃ¢â‚¬Â => OFF
      if (AI.on && (String(process.env.HERMES_TIER_GUARD || "true").toLowerCase() !== "false") && tierBreach()) {
        AI.on = false;
        logAIEvent({ event: "GUARD", reason: "tierBreach", tier: AI.tier, equity: AI.equityUSDT, peak: AI.equityPeakTier, live: true });
      }

      // Persist portfolio snapshot
      saveJSON(path.join(DATADIR, "portfolio.json"), port);

      // Equity history (UI chart)
      try {
        HISTORY.spot.push({ t: Date.now(), v: num(port.balances?.totalEq || 0) });
        if (HISTORY.spot.length > 7200) HISTORY.spot.shift();
      } catch {}

    } catch {}
    await sleep(4000);
  }
  log("[LOOP] portfolioLoop stopped");
}

/* ===== WS Public ===== */
async function startPublicWS() {
  if (MARKET.wsPublic) try { MARKET.wsPublic.removeAllListeners("close"); MARKET.wsPublic.terminate(); } catch {}
  const backoff = withBackoff(BK_MIN, "public");

  const ws = new WebSocket(OKX.PUB_WS, { perMessageDeflate: false, handshakeTimeout: 15000 });
  MARKET.wsPublic = ws;
  attachOkxHeartbeat(ws, "public");

  ws.on("open", () => {
    MARKET.wsConnected = true;
    MARKET.lastPublicRx = Date.now();
    setHealth("wsPublic", { status: "OK", info: "open", lastTs: Date.now() });
    log("[WS] public open");
    setTimeout(() => { if (ws.readyState === 1) resetBackoff("public"); }, 30000);

    // Subscribe in chunks (tickers + funding-rate)
    const syms = MARKET.universe.slice();
    const chunkMax = Number(OKX_CFG.subscribeChunkMax || 40);
    const chunks = [];
    for (let i = 0; i < syms.length; i += chunkMax) chunks.push(syms.slice(i, i + chunkMax));
    const send = (msg) => ws.send(JSON.stringify(msg));

    (async () => {
      for (const symbols of chunks) {
        const argsTick = symbols.map(i => ({ channel: "tickers",      instId: i })); send({ op: "subscribe", args: argsTick });
        await sleep(rndInt(OKX_CFG.subscribeJitterMs?.[0] || 25, OKX_CFG.subscribeJitterMs?.[1] || 50));
        const argsFund = symbols.map(i => ({ channel: "funding-rate", instId: i })); send({ op: "subscribe", args: argsFund });
        await sleep(rndInt(OKX_CFG.subscribeJitterMs?.[0] || 25, OKX_CFG.subscribeJitterMs?.[1] || 50));
        await sleep(rndInt(OKX_CFG.subscribeJitterMs?.[0] || 25, OKX_CFG.subscribeJitterMs?.[1] || 50));
      }
    })();
  });

  ws.on("message", (raw) => {
    MARKET.lastPublicRx = Date.now();
    setHealth("wsPublic", { status: "OK", info: "msg", lastTs: Date.now() });

    try {
      const m = JSON.parse(raw);

      // tickers
      if (m.arg?.channel === "tickers" && m.data?.[0]) {
        const d  = m.data[0];
        const id = m.arg.instId;
        const last = num(d.last);
        const ts   = Number(d.ts || Date.now());

        MARKET.tick[id] = {
          instId: id,
          lastPrice: last,
          bidPx: num(d.bidPx || 0), askPx: num(d.askPx || 0),   // pour les entrées maker (ordre limite)
          riseFallRate: (num(d.sodUtc0) > 0) ? ((last - num(d.sodUtc0)) / num(d.sodUtc0)) : 0,
          volume24:     num(d.volCcy24h || d.vol24h || 0),
          high24Price:  num(d.high24h || 0),
          low24Price:   num(d.low24h  || 0),
          fundingRate: (typeof MARKET.tick[id]?.fundingRate === "number") ? MARKET.tick[id].fundingRate : null,
          makerFee: MARKET.fees.maker, takerFee: MARKET.fees.taker,
          ts, rx: Date.now()
        };

        // DataFlow health
        const c = HEALTH.modules.dataFlow;
        c.count++; c.lastTs = Date.now();
        c.status = "OK"; c.info = "tick";
      }

      // funding-rate
      if (m.arg?.channel === "funding-rate" && m.data?.[0]) {
        const d  = m.data[0];
        const id = m.arg.instId;
        const fr = (d.fundingRate !== undefined) ? num(d.fundingRate) : null;
        if (!MARKET.tick[id]) MARKET.tick[id] = { instId: id };
        MARKET.tick[id].fundingRate = fr;
      }

    } catch (e) { log("[WS_PUBLIC_MSG_ERR]", e.message); }
  });

  ws.on("close", async () => {
    MARKET.wsConnected = false;
    setHealth("wsPublic", { status: "WARN", info: "close", lastTs: Date.now() });
    if (!RUNNING) return;
    await backoff("public");
    startPublicWS();
  });
  ws.on("error", (e) => { setHealth("wsPublic", { status: "WARN", info: "error" }); log("[WS] public error", e.message); });
}

/* ===== WS Private ===== */
async function startPrivateWS() {
  if (!OKX.KEY || !OKX.SECRET || !OKX.PASS) {
    setHealth("wsPrivate", { status: "WARN", info: "missing-creds", authed: false });
    log("[WS] private skipped Ã¢â‚¬â€ missing creds");
    return;
  }
  if (MARKET.wsPrivate) try { MARKET.wsPrivate.removeAllListeners("close"); MARKET.wsPrivate.terminate(); } catch {}
  const backoff = withBackoff(BK_MIN, "private");

  const ws = new WebSocket(OKX.PRI_WS, { perMessageDeflate: false, handshakeTimeout: 15000 });
  MARKET.wsPrivate = ws;
  attachOkxHeartbeat(ws, "private");

  const qSend = (payload) => {
    const s = JSON.stringify(payload);
    if (MARKET.privateAuthed && ws.readyState === ws.OPEN) ws.send(s);
    else MARKET.preLoginQueue.push(s);
  };

  ws.on("open", () => {
    MARKET.lastPrivateRx = Date.now();
    setHealth("wsPrivate", { status: "OK", info: "open", lastTs: Date.now(), authed: false });
    log("[WS] private open -> login");

    const ts = (Date.now() / 1000).toFixed(3); // seconds.mmm
    const sign = crypto.createHmac("sha256", OKX.SECRET).update(ts + "GET" + "/users/self/verify").digest("base64");
    const args = { apiKey: OKX.KEY, passphrase: OKX.PASS, timestamp: ts, sign };
    if (OKX.SIMULATED) args["x-simulated-trading"] = "1";
    ws.send(JSON.stringify({ op: "login", args: [args] }));
  });

  ws.on("message", (raw) => {
    MARKET.lastPrivateRx = Date.now();
    setHealth("wsPrivate", { status: "OK", info: "msg", lastTs: Date.now() });

    try {
      const msg = JSON.parse(raw);
      if (msg.event === "login") {
        log("[WS] private login resp:", JSON.stringify({ code: msg.code || "?", msg: msg.msg || msg.message || "" }));
        if (msg.code === "0") {
          MARKET.privateAuthed = true;
          setHealth("wsPrivate", { authed: true, status: "OK", info: "authed" });
          log("[WS] private login OK -> subscribe account, positions, orders");
          while (MARKET.preLoginQueue.length && ws.readyState === ws.OPEN) ws.send(MARKET.preLoginQueue.shift());
          qSend({ op: "subscribe", args: [{ channel: "account",   ccy: "USDT" }] });
          qSend({ op: "subscribe", args: [{ channel: "positions", instType: "SWAP" }] });
          qSend({ op: "subscribe", args: [{ channel: "orders",    instType: "SWAP" }] });
        } else {
          setHealth("wsPrivate", { status: "WARN", info: "login-fail" });
          log("[WS] private login FAIL:", msg.code, msg.msg || msg.message || "");
        }
      }

      if (msg.arg?.channel === "positions" && msg.data) {
        for (const p of msg.data) {
          const instId = p.instId;
          const sz     = num(p.pos);
          const side   = (p.posSide || "").toLowerCase();
          const avgPx  = num(p.avgPx);
          const was    = AI.openPositions[instId];

          if (sz === 0) {
            // Fermeture -> enregistrer un deal
            try {
              if (was) {
                const meta = MARKET.meta[instId] || { ctVal: 1 };
                const ct   = num(meta.ctVal || 1);
                const last = MARKET.tick[instId]?.lastPrice || avgPx || 0;
                const qty  = Math.abs(was.qty || 0);
                const wasSide = String(was.side || "").toUpperCase();
                const lev  = num(p.lever ?? p.leverage) || DEFAULT_LEVERAGE || 20;
                const notional = last * qty * ct;
                const margin   = lev ? (notional / lev) : 0;
                const profit   = wasSide === "LONG"
                  ? (last - (was.avgPx || last)) * qty * ct
                  : ((was.avgPx || last) - last) * qty * ct;
                try {
                  DEALS.recent.unshift({ time: Date.now(), symbol: instId, side: wasSide, price: last, margin, leverage: lev, notional, profit });
                  if (DEALS.recent.length > 300) DEALS.recent.pop();
                } catch {}
                logAIEvent({ event: "TRADE_EXIT", instId, side: wasSide, price: last, qty, profit, live: true });
              }
            } catch {}
            delete AI.openPositions[instId];
          } else {
            AI.openPositions[instId] = { side, qty: Math.abs(sz), avgPx, ts: now() };
          }
        }
      }
      // (orders channel dispo si besoin)
    } catch (e) { log("[WS_PRIVATE_MSG_ERR]", e.message); }
  });

  ws.on("close", async (code, reason) => {
    MARKET.privateAuthed = false;
    setHealth("wsPrivate", { authed: false, status: "WARN", info: "close", lastTs: Date.now() });
    log("[WS] private close | code:", code, "reason:", reason ? reason.toString() : "");
    if (!RUNNING) return;
    await backoff("private");
    startPrivateWS();
  });
  ws.on("error", (e) => { setHealth("wsPrivate", { status: "WARN", info: "error" }); log("[WS] private error", e.message); });
}
/* ===== Health Watchdog Loop ===== */
async function healthWatchdog() {
  while (RUNNING) {
    try {
      const nowT = Date.now();

      // WS public
      const agePub = nowT - (MARKET.lastPublicRx || 0);
      setHealth("wsPublic", { status: statusFromAge(agePub, 10000, 25000), latencyMs: agePub });

      // WS private
      if (OKX.KEY && OKX.SECRET && OKX.PASS) {
        const agePri = nowT - (MARKET.lastPrivateRx || 0);
        setHealth("wsPrivate", { status: statusFromAge(agePri, 12000, 28000), latencyMs: agePri });
      }

      // DataFlow
      const df = HEALTH.modules.dataFlow;
      const ageDf = nowT - (df.lastTs || 0);
      df.status   = statusFromAge(ageDf, 10000, 25000);
      df.latencyMs= ageDf;
      if (Object.keys(MARKET.tick).length === 0) { df.status = "WARN"; df.info = "no-ticks"; }

      // StratÃƒÂ©gie
      const st = HEALTH.modules.strategy;
      const ageC = nowT - (st.lastCandle || 0);
      if (ageC > 60000) { st.status = "WARN"; st.info = "no-candles"; }

      // IA
      setHealth("aiEngine", { on: AI.on, info: AI.on ? "on" : "off", status: "OK" });

      // Orders -> WARN si taux dÃ¢â‚¬â„¢erreurs ÃƒÂ©levÃƒÂ©
      const errRate = AI.counters.orderErrors / Math.max(1, AI.counters.ordersPlaced);
      if (AI.counters.ordersPlaced > 5 && errRate > 0.3) {
        setHealth("orders", { status: "WARN", info: "high-error-rate" });
      }

      broadcastHealth();
    } catch {}
    await sleep(2000);
  }
}

/* ===== Data APIs (IPC) ===== */
ipcMain.handle("ui-auth", async (_e, pass) => {
  const enabled = String(process.env.HERMES_UI_AUTH_ENABLED || "false").toLowerCase() === "true";
  if (!enabled) return { ok: true, auth: false, required: false };
  const good = String(process.env.HERMES_UI_PASS || "");
  const ok   = !!good && String(pass || "") === good;
  return { ok, auth: ok, required: true };
});

ipcMain.handle("ui-mode", async () => ({ ok: true, mode: UI_RUNTIME_MODE }));

/* ============================================================
   IPC: poser-cles — amorcage des identifiants depuis la page.

   Pourquoi ce canal existe. Les cles doivent atteindre le .env du
   serveur, et toutes les autres voies se sont fermees : le proxy de la
   session dagent coupe SSH, et un secret de depot ne peut etre ecrit
   que par le proprietaire. Il restait la page elle-meme, quil ouvre
   deja et qui est protegee par sa cle.

   UNE SEULE GARDE, et elle suffit : le canal REFUSE de travailler si
   des cles sont deja en place. Il peut amorcer, il ne peut pas
   remplacer. Quelquun qui obtiendrait la cle du tableau de bord ne
   pourrait donc pas substituer ses propres identifiants a ceux du
   proprietaire — la fenetre est ouverte une fois, puis elle se ferme
   toute seule.

   Les cles sont EPROUVEES avant detre ecrites. Une cle posee sans
   verification est une cle dont on decouvre trois jours plus tard
   quelle portait la mauvaise restriction dIP.
   ============================================================ */
ipcMain.handle("poser-cles", async (_e, p = {}) => {
  try {
    if (OKX.KEY && OKX.SECRET && OKX.PASS) {
      return { ok: false, error: "DEJA_POSEES",
               message: "Des cles sont deja en place. Ce canal ne sert qua lamorcage ; pour les remplacer, editer le fichier .env sur le serveur." };
    }
    let cle    = String(p.cle || "").trim();
    let secret = String(p.secret || "").trim();
    let passe  = String(p.passe || "").trim();

    // On accepte des LIGNES DE .env collees telles quelles. Cest la
    // forme sous laquelle le proprietaire possede deja ses cles :
    // lobliger a les recopier champ par champ, cest lui faire faire un
    // travail que le programme sait faire, et lexposer a une faute de
    // frappe sur trente-six caracteres.
    //
    // Le fichier entier convient aussi bien que trois lignes : on ny
    // prend que ce quon cherche, le reste est ignore sans etre lu.
    const brut = String(p.env || "");
    if (brut) {
      const lire = (nom) => {
        const m = brut.match(new RegExp("^[ \\t]*(?:export[ \\t]+)?" + nom + "[ \\t]*=[ \\t]*(.*)$", "m"));
        if (!m) return "";
        return m[1].trim().replace(/^["']/, "").replace(/["']$/, "").replace(/\r/g, "").trim();
      };
      cle    = cle    || lire("OKX_API_KEY");
      secret = secret || lire("OKX_API_SECRET");
      // Certains fichiers portent la forme courte au lieu de la longue.
      passe  = passe  || lire("OKX_API_PASSPHRASE") || lire("OKX_API_PASS");
    }

    if (!cle || !secret || !passe) {
      const absents = [];
      if (!cle) absents.push("OKX_API_KEY");
      if (!secret) absents.push("OKX_API_SECRET");
      if (!passe) absents.push("OKX_API_PASSPHRASE");
      return { ok: false, error: "INCOMPLET",
               message: "Introuvable dans ce qui a ete colle : " + absents.join(", ") };
    }

    // Une vraie requete signee : cest OKX qui dit si les cles valent
    // quelque chose, pas nous.
    const ts = new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
    const chemin = "/api/v5/account/config";
    const sign = crypto.createHmac("sha256", secret).update(ts + "GET" + chemin).digest("base64");
    let rep;
    try {
      rep = await axios.get(OKX.REST_BASE + chemin, {
        timeout: 15000,
        headers: { "OK-ACCESS-KEY": cle, "OK-ACCESS-SIGN": sign,
                   "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": passe,
                   "Content-Type": "application/json" },
      });
    } catch (e) {
      rep = e.response || null;
    }
    const j = (rep && rep.data) || {};
    if (String(j.code) !== "0") {
      const aide = {
        "50111": "cle dAPI invalide ou inconnue",
        "50113": "signature invalide — le secret ne correspond pas a la cle",
        "50105": "phrase de passe invalide",
        "50110": "adresse IP non autorisee : ajouter celle du serveur dans les restrictions de la cle",
        "50102": "horloge du serveur desynchronisee",
      }[String(j.code)];
      return { ok: false, error: "REFUSE_PAR_OKX", code: j.code || "?",
               message: (j.msg || "reponse illisible") + (aide ? " — " + aide : "") };
    }

    // Ecriture seulement maintenant. Les anciennes lignes partent
    // dabord : dotenv garde la PREMIERE occurrence, donc en ajoutant
    // sans effacer on ecrirait une cle que rien ne lirait.
    const fenv = path.join(ROOT, ".env");
    let avant = "";
    try { avant = fs.readFileSync(fenv, "utf8"); } catch {}
    const garde = avant.split(/\r?\n/)
      .filter((l) => !/^\s*(OKX_API_KEY|OKX_API_SECRET|OKX_API_PASSPHRASE|OKX_API_PASS)\s*=/.test(l))
      .join("\n").replace(/\n+$/, "");
    fs.writeFileSync(fenv,
      (garde ? garde + "\n" : "") +
      `OKX_API_KEY=${cle}\nOKX_API_SECRET=${secret}\nOKX_API_PASSPHRASE=${passe}\n`,
      { mode: 0o600 });
    try { fs.chmodSync(fenv, 0o600); } catch {}

    // Prise en compte immediate, sans redemarrage : le moteur tient ses
    // identifiants en memoire, il suffit de les y poser.
    OKX.KEY = cle; OKX.SECRET = secret; OKX.PASS = passe;
    process.env.OKX_API_KEY = cle;
    process.env.OKX_API_SECRET = secret;
    process.env.OKX_API_PASSPHRASE = passe;
    log("[CLES] posees et validees par OKX, ecrites dans .env, prises en compte a chaud");
    try { startPrivateWS(); } catch (e) { log("[CLES] flux prive:", e.message); }
    const d = (Array.isArray(j.data) && j.data[0]) || {};
    return { ok: true, niveau: d.acctLv || "?", modePosition: d.posMode || "?" };
  } catch (e) {
    return { ok: false, error: "ERREUR", message: String(e.message || e) };
  }
});

/* === IPC: log subscribe + simple statuses === */
if (ipcMain && !global.__AI_LOG_SUB__) {
  global.__AI_LOG_SUB__ = true;
  ipcMain.handle("ai:log-subscribe", () => ({ ok: true }));
}

ipcMain.handle("ai:live-status", async () => ({
  ok: true,
  liveEnabled: !!AI.on,
  ts: tsISO()
}));

ipcMain.handle("ai:training-status", async () => ({
  ok: true,
  training: true,               // la SIM tourne en continu
  simLogsFile: AI.simLogsFile,
  ts: tsISO()
}));

/* === IPC: get-ai-state (historique propre) === */
ipcMain.handle("get-ai-state", async () => {
  try {
    let logs = [];
    try {
      if (fs.existsSync(AI.logsAIFile)) {
        const raw = fs.readFileSync(AI.logsAIFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
        const out = [];
        const slice = raw.slice(-600); // on lit large, on recoupe ensuite Ã  150

        for (const line of slice) {
          try {
            const o   = JSON.parse(line);
            const ev  = String(o.event || "").toUpperCase();
            const txt = (o.info || o.msg || o.message || "").toString().trim();
            const inst= o.instId || o.symbol || "";
            const sym = inst ? String(inst) : "";
            const dash = "\u2014";

            // Filtres forts
            if (ev === "AI_TOGGLE") continue;            // on n'affiche jamais cet event
            if (ev === "INFO" && !txt) continue;         // INFO vide = bruit

            let m = "";

            if (ev === "INFO" && txt) {
              m = `[INFO] ${txt}`;
            } else if (ev === "TRADE_ENTER" && o.live === true) {
              m = `[AI-LIVE] EntrÃ©e | ${sym || dash}`;
            } else if (ev === "TRADE_EXIT"  && o.live === true) {
              m = `[AI-LIVE] Sortie | ${sym || dash}`;
            } else if (ev === "SIM_SUMMARY" && txt) {
              m = `[AI-SIM] ${txt}`;
            } else if (ev === "SIM_SIGNAL") {
              const dir = (o.dir || "").toString().toUpperCase();
              if (!dir) continue;                        // ignore signaux non directionnels (bruit)
              m = `[AI-SIM] ${dir} | ${sym || dash}`;
            } else {
              // Fallback lisible si on a du texte
              if (txt) {
                m = `[INFO] ${txt}`;
              } else {
                // Fallback minimal si on a vraiment des infos utiles
                const mode = o.live === true ? "AI-LIVE" : "AI-SIM";
                const parts = [];
                if (sym)         parts.push(sym);
                if (o.side)      parts.push(String(o.side).toUpperCase());
                if (o.qty!=null) parts.push("x" + o.qty);
                if (o.price!=null) parts.push("@ " + o.price);
                const ev2 = ev || "LOG";
                m = `[${mode}] [${ev2}] ${parts.join(" ")}`.trim();
                // Si rien d'utile, on saute
                if (m === "[AI-LIVE] [LOG]" || m === "[AI-SIM] [LOG]" || m === "[AI-SIM] [INFO]" || m === "[AI-LIVE] [INFO]") continue;
              }
            }

            out.push({ ts: o.ts || tsISO(), message: m });
          } catch { /* ligne illisible: ignore */ }
        }
        logs = out.slice(-150);
      }
    } catch { /* lecture logs: ignore, on renvoie juste l'Ã©tat */ }

    return {
      ok: true, success: true,
      active: !!AI.on,
      logs,
      mode: AI.mode,
      equityUSDT: AI.equityUSDT,
      tier: AI.tier,
      pending: 0,
      ts: tsISO()
    };
  } catch (e) {
    return { ok: false, success: false, active: false, logs: [], error: String(e.message || e), ts: tsISO() };
  }
});

ipcMain.handle("fetch-data", async () => {
  try {
    const data = Object.values(MARKET.tick).slice(0, 100).map(t => ({
      symbol: t.instId,
      lastPrice: t.lastPrice || 0,
      riseFallRate: t.riseFallRate || 0,
      volume24: t.volume24 || 0,
      high24Price: t.high24Price || 0,
      low24Price:  t.low24Price  || 0,
      fundingRate: (typeof t.fundingRate === "number") ? t.fundingRate : null,
      makerFee: (typeof t.makerFee  === "number") ? t.makerFee  : (MARKET.fees.maker ?? "Ã¢â‚¬â€"),
      takerFee: (typeof t.takerFee  === "number") ? t.takerFee  : (MARKET.fees.taker ?? "Ã¢â‚¬â€"),
      updatedTs: t.ts || Date.now()
    }));
    return { ok: true, success: true, data, ts: tsISO() };
  } catch (e) {
    return { ok: false, success: false, data: [], error: String(e.message || e), ts: tsISO() };
  }
});

/* Les chandelles dun instrument, pour la vue graphique dune position.

   Le point interroge est PUBLIC : pas de cle requise, rien decrit, et
   la page peut donc dessiner meme quand le compte est en lecture seule.

   Un cache de vingt secondes par instrument : la vue se rouvre, se
   rafraichit, et sans lui chaque geste paierait un aller-retour a OKX
   — qui finirait par repondre 429 a force detre sollicite pour des
   donnees quil vient de donner. */
const CHANDELLES_CACHE = new Map();
ipcMain.handle("chandelles", async (_e, p) => {
  try {
    const instId = String(p?.instId || "");
    // Le nom part dans une URL : on ne laisse passer que la forme
    // exacte dun perpetuel USDT, pas ce quun client aurait envie dy
    // glisser.
    if (!/^[A-Z0-9]{1,20}-USDT-SWAP$/.test(instId)) {
      return { ok: false, error: "INSTRUMENT_INVALIDE" };
    }
    const bar = ["1m", "5m", "15m", "1H", "4H", "1D"].includes(p?.bar) ? p.bar : "5m";
    const cle = instId + "|" + bar;
    const enCache = CHANDELLES_CACHE.get(cle);
    if (enCache && Date.now() - enCache.ts < 20000) {
      return { ok: true, instId, bar, rows: enCache.rows, last: MARKET.tick[instId]?.lastPrice || 0, cache: true };
    }
    const r = await axios.get(OKX.REST_BASE + "/api/v5/market/candles", {
      params: { instId, bar, limit: "300" }, timeout: 10000
    });
    const brut = Array.isArray(r?.data?.data) ? r.data.data : [];
    // OKX rend la plus recente en premier ; un graphique se lit dans
    // lautre sens. Six nombres suffisent : heure, OHLC, volume.
    const rows = brut.map(k => [num(k[0]), num(k[1]), num(k[2]), num(k[3]), num(k[4]), num(k[5])]).reverse();
    if (rows.length) CHANDELLES_CACHE.set(cle, { ts: Date.now(), rows });
    return { ok: true, instId, bar, rows, last: MARKET.tick[instId]?.lastPrice || 0 };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

/* Ce que le laboratoire autonome a trouve : le dernier verdict complet
   (perles ET refus motives), l'historique des passes, et ce que le
   moteur joue reellement en ce moment. Lecture de fichiers uniquement —
   aucune cle requise, la lecture seule y a droit. */
ipcMain.handle("laboratoire", async () => {
  try {
    let roster = null;
    try { roster = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "roster.json"), "utf8")); }
    catch {}
    const historique = [];
    try {
      const lignes = fs.readFileSync(path.join(DATADIR, "perles-historique.jsonl"), "utf8")
        .trim().split("\n").slice(-40);
      for (const l of lignes) {
        try {
          const j = JSON.parse(l);
          historique.push({ ts: j.ts, dureeS: j.dureeS || 0, perles: Object.keys(j.perles || {}).length });
        } catch {}
      }
    } catch {}
    const joue = (typeof globalThis.__hermes15Roster === "function") ? globalThis.__hermes15Roster() : null;
    // La progression d'une passe en cours, ecrite par le chercheur
    // lui-meme. Un marqueur plus vieux que trente minutes est un
    // cadavre de passe tuee : on ne le montre pas.
    let progression = null;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(DATADIR, "perles-progression.json"), "utf8"));
      if (p && p.debut && Date.now() - new Date(p.debut).getTime() < 30 * 60e3) progression = p;
    } catch {}
    return { ok: true, roster, historique, joue, progression, ts: tsISO() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

/* Le bouton « lancer une recherche » de l'onglet Laboratoire. On passe
   par systemd quand il est la : meme unite que le minuteur, meme
   journal, et deux demandes simultanees se fondent en une. Sans
   systemd (poste de developpement), le script part en processus
   detache. Public et sans danger : le chercheur ne lit que des points
   publics et n'ecrit que son roster. */
ipcMain.handle("chercher-perles", async () => {
  try {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(DATADIR, "perles-progression.json"), "utf8"));
      if (p && p.debut && Date.now() - new Date(p.debut).getTime() < 30 * 60e3) {
        return { ok: true, dejaEnCours: true };
      }
    } catch {}
    const cp = require("child_process");
    const parSystemd = await new Promise((fin) => {
      cp.execFile("systemctl", ["start", "--no-block", "hermes-perles.service"], { timeout: 5000 },
        (err) => fin(!err));
    });
    if (!parSystemd) {
      const enfant = cp.spawn(process.execPath, [path.join(ROOT, "deploy", "chercher_perles.js")], {
        cwd: ROOT, detached: true, stdio: "ignore",
        env: { ...process.env, NODE_OPTIONS: "--dns-result-order=ipv4first" },
      });
      enfant.unref();
    }
    log("[PERLES] recherche demandee depuis la page", parSystemd ? "(systemd)" : "(processus direct)");
    return { ok: true, lance: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("fetch-portfolio", async () => {
  try {
    const port = await loadPortfolio();

    // enrichir positions avec mÃƒÂ©ta & last price
    const lastMap = MARKET.tick;
    let totalValue = 0, totalMargin = 0, unreal = 0;

    const posDetails = (port.positions || []).map(p => {
      const meta = MARKET.meta[p.instId] || { ctVal: 1, lotSz: 0.001, minSz: 0.001 };
      const last = lastMap[p.instId]?.lastPrice || 0;
      const szAbs = Math.abs(p.sz || 0);
      const ct = num(meta.ctVal || 1);
      const entree = p.avgPx || 0;

      /* Le SENS. Ce compte est en mode net : OKX repond posSide "net",
         et lancien test posSide === "LONG" rendait donc SHORT pour
         TOUTE position — deux longs se sont affiches SHORT pendant que
         lexchange, lui, disait Acheter. En mode net, le sens est dans
         le SIGNE de la taille ; posSide ne le porte quen mode hedge. */
      const brut = String(p.posSide || "").toLowerCase();
      const sens = brut === "long" ? "LONG" : brut === "short" ? "SHORT"
                 : ((p.sz || 0) < 0 ? "SHORT" : "LONG");
      const long = sens === "LONG";

      /* Le prix qui fait foi pour le PnL est le mark dOKX, pas notre
         dernier trade recu : cest sur lui que lexchange calcule, et
         cest lui que son application affiche. */
      const marque = num(p.markPx) || last;
      const notional = marque * szAbs * ct;
      const lev = p.lever || DEFAULT_LEVERAGE;

      /* La marge REELLE, celle quOKX immobilise. La notre etait
         notionnel/levier au prix courant — proche, jamais egale, et la
         page contredisait lexchange de quelques centimes en
         permanence. Un chiffre presque juste est plus corrosif quun
         chiffre faux : on ne sait jamais lequel croire. */
      const margin = num(p.margin) > 0 ? num(p.margin)
                   : ((lev > 0 && marque > 0) ? notional / lev : 0);

      /* PnL et pourcentage : ceux dOKX quand ils existent. uplRatio
         est le rapport que son application affiche — le reproduire par
         calcul local, cest garantir un ecart. */
      const upl = (p.upl != null) ? p.upl
                : (long ? (marque - entree) : (entree - marque)) * szAbs * ct;
      const pctMarge = (p.uplRatio != null) ? p.uplRatio * 100
                     : (margin > 0 ? (upl / margin) * 100 : 0);

      totalValue  += notional;
      totalMargin += margin;
      unreal      += upl;

      const suivi = AI.openPositions[p.instId] || {};

      /* Les protections, lues chez OKX (cache ALGOS) et non dans la
         memoire du moteur : celle-ci meurt a chaque redemarrage, et une
         position readoptee saffichait nue alors quun OCO et un trail
         etaient bel et bien poses cote exchange.

         Classement dun trigger nu : de quel cote de lentree tombe-t-il.
         Sous lentree pour un long, cest un stop ; au-dessus, un
         take-profit. Sil y a plusieurs stops, on garde le plus
         PROTECTEUR — le plus haut pour un long, le plus bas pour un
         short : cest celui qui se declenchera en premier. */
      let tpX = null, slX = null, trailSuit = null, trailPose = false;
      for (const a of (ALGOS.par[p.instId] || [])) {
        if (a.type === "move_order_stop") {
          trailPose = true;
          if (a.suit > 0) trailSuit = a.suit;
          continue;
        }
        if (a.tp > 0) tpX = a.tp;
        if (a.sl > 0) slX = slX == null ? a.sl : (long ? Math.max(slX, a.sl) : Math.min(slX, a.sl));
        if (a.declenche > 0 && !(a.tp > 0) && !(a.sl > 0) && entree > 0) {
          if (long ? a.declenche < entree : a.declenche > entree) {
            slX = slX == null ? a.declenche : (long ? Math.max(slX, a.declenche) : Math.min(slX, a.declenche));
          } else if (tpX == null) tpX = a.declenche;
        }
      }

      const stopActuel = trailSuit || slX || suivi.stopPx || suivi.slPx || null;
      // stopMode dit COMMENT le stop est arrive la ou il est :
      //   INIT  le stop initial, pose a lentree
      //   BE    remonte au point mort, la position ne peut plus perdre
      //   TRAIL il suit le prix et ne redescend jamais
      const modeStop = trailSuit ? "TRAIL"
        : (stopActuel && entree > 0 && (long ? stopActuel >= entree : stopActuel <= entree)) ? "BE"
        : (stopActuel ? (suivi.stopMode || "INIT") : null);

      return {
        symbol: p.instId,
        side:   sens,
        leverage:  lev,
        entryPrice: entree,
        markPrice:  marque,
        /* La taille en MONNAIE DE BASE (contrats x ctVal), comme
           lexchange laffiche : 194 contrats MEGA sont 1 940 MEGA, et
           cest 1 940 que le proprietaire lit sur son application. Deux
           ecrans qui appellent « taille » deux unites differentes ne
           peuvent que se contredire. */
        size:      szAbs * ct,
        notional,
        margin,
        // Lheure douverture COTE EXCHANGE : la notre repartait de zero
        // a chaque redemarrage du moteur, et la tenue affichait 0 min
        // pour des positions vieilles de deux heures.
        entryTime:  num(p.cTime) || suivi.ts || null,
        liqPrice:   num(p.liqPx) || null,
        unrealizedPnl: upl,
        pnlPctOfMargin: pctMarge,
        takeProfit: tpX || suivi.tpPx || null,
        stopLoss:   suivi.slPx || slX || null,
        stopActuel,
        stopMode:   modeStop,
        trailArme:  trailPose || !!suivi.trailAlgoId,
        protection: suivi.protection || null
      };
    });

    const ds = DEALS && Array.isArray(DEALS.recent) ? DEALS.recent : [];
    const nowMs = Date.now();
    const last24 = ds.filter(d => (nowMs - Number(d.time || 0)) <= 86400000);
    const dailyVolume = last24.reduce((a, d) => a + num((d.notional != null) ? d.notional : ((d.margin || 0) * (d.leverage || DEFAULT_LEVERAGE || 20))), 0);

    // La verite d'abord : les positions fermees d'OKX. Les deals
    // locaux ne servent que de repli tant qu'elle n'est pas arrivee.
    chargerPositionsFermees().catch(() => {});
    const fermees = FERMEES.liste;
    let winrate, dailyPnL, totalTrades, dailyTrades;
    if (fermees.length) {
      const f24     = fermees.filter((p) => nowMs - p.closeTime <= 86400000);
      const gagnees = fermees.filter((p) => p.pnl > 0).length;
      winrate     = gagnees * 100 / fermees.length;
      dailyPnL    = f24.reduce((a, p) => a + p.pnl, 0);
      totalTrades = fermees.length;
      dailyTrades = f24.length;
    } else {
      dailyTrades = last24.length;
      dailyPnL    = last24.reduce((a, d) => a + num(d.profit || d.pnl || 0), 0);
      const wins  = last24.filter(d => num(d.profit || d.pnl || 0) > 0).length;
      winrate     = dailyTrades ? (wins * 100 / dailyTrades) : 0;
      totalTrades = ds.length;
    }

    const data = {
      spot:    { total: 0 },
      futures: {
        total:     Number(port.balances?.totalEq || 0),
        available: Number((port.balances?.details || []).find(d => String(d.ccy).toUpperCase() === "USDT")?.availBal || 0),
        unrealizedPnL: unreal
      },
      positions: {
        count: Array.isArray(port.positions) ? port.positions.length : 0,
        totalValue,
        totalMargin
      },
      performance: {
        winrate, dailyPnL, totalTrades, dailyTrades, dailyVolume
      },
      openPositionsDetails: posDetails,
      positionsFermees: fermees.slice(0, 30),
      dealsRecent: ds.slice(0, 150),
      history: { spot: HISTORY && HISTORY.spot ? HISTORY.spot.slice(-600) : [] },
      // Le moteur SAIT quil na pas de cles — loadPortfolio pose la note
      // NO_OKX_CREDS — mais elle ne montait pas jusqua la page, qui
      // affichait donc un compte a zero sans dire pourquoi. Un tableau
      // de bord qui montre zero sans expliquer laisse croire a une
      // perte, ou a une panne, quand il ny a quune cle absente.
      clesOkx: port.note !== "NO_OKX_CREDS",
      lastUpdate: port.ts
    };
    return { ok: true, success: true, data, ts: port.ts };
  } catch (e) {
    return { ok: false, success: false, data: null, error: String(e.message || e), ts: tsISO() };
  }
});
ipcMain.handle("toggle-ai", async (_e, desired) => {
  // Log "requested" au plus 1x / 3s
  if (!global.__AI_TOGGLE_GUARD) global.__AI_TOGGLE_GUARD = { t: 0, lock: false, logTs: 0 };
  const now = Date.now();
  if (now - global.__AI_TOGGLE_GUARD.logTs > 3000) {
    log("[UI] toggle-ai requested | mode:", UI_RUNTIME_MODE);
    global.__AI_TOGGLE_GUARD.logTs = now;
  }

  try {
    // Debounce (800ms) + lock concurrent
    if (now - global.__AI_TOGGLE_GUARD.t < 800 || global.__AI_TOGGLE_GUARD.lock) {
      return { ok: true, success: true, active: !!AI.on, skipped: true, ts: tsISO() };
    }
    global.__AI_TOGGLE_GUARD.lock = true;

    const prev = !!AI.on;
    const next = (typeof desired === "boolean") ? desired : !prev;

    // Aucun changement d'Ã©tat â†’ no-op
    if (next === prev) {
      global.__AI_TOGGLE_GUARD.t = now;
      global.__AI_TOGGLE_GUARD.lock = false;
      return { ok: true, success: true, active: prev, noChange: true, ts: tsISO() };
    }

    // Appliquer l'Ã©tat
    AI.on = next;
    setHealth("aiEngine", { on: AI.on, info: AI.on ? "on" : "off", lastToggle: Date.now() });

    // Message unique et immÃ©diat
    const msg = `Hermes â€“ IA ${AI.on ? "activÃ©e" : "dÃ©sactivÃ©e"}`;
    try {
      const line = { ts: tsISO(), event: "INFO", info: msg, msg };
      appendJSONL(AI.logsAIFile, line);
      broadcastAILog(line);
    } catch {}

    global.__AI_TOGGLE_GUARD.t = Date.now();
    global.__AI_TOGGLE_GUARD.lock = false;

    return {
      ok: true, success: true,
      active: !!AI.on,
      mode: AI.mode,
      equityUSDT: AI.equityUSDT,
      tier: AI.tier,
      pending: 0,
      ts: tsISO(),
      logs: []
    };
  } catch (e) {
    if (global.__AI_TOGGLE_GUARD) {
      global.__AI_TOGGLE_GUARD.lock = false;
      global.__AI_TOGGLE_GUARD.t = Date.now();
    }
    return { ok: false, success: false, error: String(e.message || e), ts: tsISO() };
  }
});

ipcMain.handle("place-order", async (_e, opt = {}) => {
  log("[UI] place-order requested | mode:", UI_RUNTIME_MODE);
  if (isViewerMode()) return { ok: false, success: false, error: "VIEW_ONLY" };
  try {
    if (!OKX.KEY || !OKX.SECRET || !OKX.PASS) return { ok: false, success: false, error: "NO_OKX_CREDS" };
    if (!AI.on) return { ok: false, success: false, error: "AI_OFF" };
    const instId = String(opt.instId || "BTC-USDT-SWAP");
    const side   = (opt.side === "long" || opt.side === "short") ? opt.side : "long";
    const res    = await placeMarket(instId, side);
    return { ok: !!res.ok, success: !!res.ok, res, ts: tsISO() };
  } catch (e) {
    return { ok: false, success: false, error: String(e.message || e) };
  }
});
/* ===== BOOT helpers ===== */
function urlAlive(url, timeoutMs = 700) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.on("error", () => resolve(false));
    } catch { resolve(false); }
  });
}
async function resolveLoadTarget() {
  if (fs.existsSync(INDEX_FILE)) return { type: "file", value: INDEX_FILE };
  for (let i = 0; i < 8; i++) {
    if (await urlAlive(DEV_URL)) return { type: "url", value: DEV_URL };
    await sleep(500);
  }
  return { type: "none", value: null };
}

/* ===== IPC: ai:order-margin (marge Ãƒâ€” levier Ã¢â€¡â€™ notionnel) ===== */
(function orderMarginWiring(){
  try {
    function tryReq(p){ try { return require(p); } catch { return null; } }
    const exec = tryReq(path.join(ROOT, "modules", "exec.js")) || tryReq("../modules/exec.js") || tryReq("./modules/exec.js");
    const okx  = tryReq(path.join(ROOT, "modules", "okx.js"))  || tryReq("../modules/okx.js")  || tryReq("./modules/okx.js");

    if (!ipcMain || !exec || !okx) {
      log("[AI] modules exec/okx introuvables pour ai:order-margin");
      return;
    }

    async function ensureLeverage(instId, leverage, tdMode = "isolated") {
      try {
        if (exec.normalizeSetLeverageBody) {
          const body = await exec.normalizeSetLeverageBody({ instId, leverage, mgnMode: tdMode });
          return await okx.okxPOST("/api/v5/account/set-leverage", body);
        } else {
          return await okx.okxPOST("/api/v5/account/set-leverage", { instId, mgnMode: tdMode, lever: String(leverage) });
        }
      } catch (e) {
        log("[AI] set-leverage err:", (e?.response?.data || e?.message || e));
        return null;
      }
    }

    async function placeOrderMargin({ instId, side, marginUSDT, leverage, tpPct, slPct, trailingSpec, tdMode = "isolated", posSide = null }) {
  // DÃ©doublonnage manual (1.5s) pour Ã©viter double ouverture (instId+side)
  if (!__shouldPlace(instId, side)) {
    const __m = `[INFO] Filtre doublon : ordre ignorÃ© (${instId} ${side})`;
    try { appendJSONL(AI.logsAIFile, { ts: tsISO(), event:"INFO", info: __m, msg: __m }); broadcastAILog({ ts: tsISO(), event:"INFO", info: __m, msg: __m }); } catch {}
    return { ok:false, reason:"dedup" };
  }
      if (leverage != null) await ensureLeverage(instId, leverage, tdMode);
      const body = { instId, side, ordType: "market", tdMode, leverage, budgetUSDT: Number(marginUSDT) };
      if (posSide) body.posSide = posSide;
      if (tpPct  != null) body.tpPct = Number(tpPct);
      if (slPct  != null) body.slPct = Number(slPct);
      if (trailingSpec)   body.trailingSpec = trailingSpec;
      if (!exec.okxTradeOrderWithGuards) throw new Error("okxTradeOrderWithGuards indisponible");
      return await exec.okxTradeOrderWithGuards(body);
    }

    if (!global.__AI_ORDER_MARGIN__) {
      global.__AI_ORDER_MARGIN__ = true;
      ipcMain.handle("ai:order-margin", async (_e, p = {}) => { try { if (!AI.on) return { ok:false, error:"AI_OFF" };
          const inst   = p.instId   || process.env.AI_INST || "BTC-USDT-SWAP";
          const side   = p.side     || "buy";
          const lev    = (p.leverage != null ? Number(p.leverage) : Number(process.env.AI_DEFAULT_LEVERAGE || process.env.AI_LEVERAGE || 20));
          const margin = (p.marginUSDT != null ? Number(p.marginUSDT) : Number(process.env.AI_BUDGET_USDT || 20));
          const tpPct  = (p.tpPct  != null) ? Number(p.tpPct)  : (process.env.AI_TP_PCT  ? Number(process.env.AI_TP_PCT)  : undefined);
          const slPct  = (p.slPct  != null) ? Number(p.slPct)  : (process.env.AI_SL_PCT  ? Number(process.env.AI_SL_PCT)  : undefined);

          let trailingSpec = p.trailingSpec || null;
          if (!trailingSpec && (process.env.AI_TRAIL_ACTIVE_PCT || process.env.AI_TRAIL_CB_RATIO)) {
            trailingSpec = {
              activePct: Number(process.env.AI_TRAIL_ACTIVE_PCT || 0.35),
              callbackRatio: Number(process.env.AI_TRAIL_CB_RATIO || 0.15),
            };
          }

          const res = await placeOrderMargin({ instId: inst, side, marginUSDT: margin, leverage: lev, tpPct, slPct, trailingSpec });
          return { ok: true, res };
        } catch (e) {
          const payload = e?.response?.data || e?.response || e?.message || e;
          return { ok: false, error: payload };
        }
      });
      log("[AI] IPC prÃƒÂªt: ai:order-margin (marge Ãƒâ€” levier Ã¢â€¡â€™ notionnel).");
    }
  } catch (e) {
    log("[AI] Order wiring failed:", (e && e.message) || e);
  }
})();

/* ===== ELECTRON BOOT ===== */
async function createWindow() {
  try {
    MARKET.universe = await loadUniverse();
    await loadMetaInstruments();
    await syncServerTime();                 // aligner l'horloge AVANT tout appel signé
    setInterval(() => { syncServerTime().catch(()=>{}); }, 15 * 60 * 1000);
    await loadTradeFees();
    await loadAccountPosMode();
    loadTierPeak();

    log("[BOOT] Universe:", MARKET.universe.length, "symbols");
    log("[BOOT] __dirname:", HERE);
    log("[BOOT] ROOT:", ROOT);
    log("[BOOT] INDEX_FILE exists:", fs.existsSync(INDEX_FILE));
    log("[BOOT] PRELOAD_FILE exists:", fs.existsSync(PRELOAD_FILE));
    log("[BOOT] DEV_URL:", DEV_URL);

    const loadTarget = await resolveLoadTarget();
    log("[BOOT] loadTarget:", JSON.stringify(loadTarget));

    const win = new BrowserWindow({
      width: 1280, height: 800,
      backgroundColor: "#0b0b0c",
      autoHideMenuBar: true,
      show: true,
      webPreferences: {
        nodeIntegration: true,          // garde pour compatibilitÃƒÂ© actuelle
        contextIsolation: false,
        backgroundThrottling: false,
        preload: fs.existsSync(PRELOAD_FILE) ? PRELOAD_FILE : undefined,
      },
    });

    if (loadTarget.type === "file")      await win.loadFile(loadTarget.value);
    else if (loadTarget.type === "url")  await win.loadURL(loadTarget.value);
    else throw new Error("Aucune source UI disponible (index.html introuvable et dev server injoignable).");

    // Raccourcis DevTools & reload
    try {
      win.webContents.on("before-input-event", (event, input) => {
        const ctrlOrCmd = input.control || input.meta;
        if (ctrlOrCmd && input.shift && input.key?.toUpperCase() === "I") { win.webContents.openDevTools({ mode: "detach" }); event.preventDefault(); }
        if (input.key === "F12") { win.webContents.openDevTools({ mode: "detach" }); event.preventDefault(); }
        if (ctrlOrCmd && input.key?.toUpperCase() === "R") { win.webContents.reload(); event.preventDefault(); }
      });
      if (String(process.env.HERMES_DEVTOOLS || "0") === "1") win.webContents.openDevTools({ mode: "detach" });
    } catch {}

    win.webContents.once("did-finish-load", async () => {
      const url = win.webContents.getURL();
      UI_RUNTIME_MODE = computeUIModeFromURL(url);
      log("[UI] did-finish-load Ã¢â€ â€™", url, "Ã¢â€ â€™ mode:", UI_RUNTIME_MODE);
    });
    win.webContents.on("did-fail-load", (_e, code, desc) => log("[WEB] did-fail-load:", code, desc));
    win.webContents.on("render-process-gone", (_e, details) => log("[WEB] render-process-gone:", JSON.stringify(details)));
    win.on("unresponsive", () => log("[WEB] BrowserWindow unresponsive"));

    // Services
    startPublicWS();
    startPrivateWS();   // si clÃƒÂ©s Ã¢â€ â€™ login + subscribe
    portfolioLoop();    // portfolio + pending consumer
    healthWatchdog();   // superviseur
    setInterval(rafraichirUnivers, RAFRAICHIR_UNIVERS_MS);   // les volumes tournent
  } catch (e) {
    log("createWindow failed:", e.message);
  }
}
/* ===== STOP / SHUTDOWN ===== */
function stopAll() {
  RUNNING = false;
  try { if (MARKET.wsPublic)  { MARKET.wsPublic.terminate();  log("[STOP] WS Public fermÃƒÂ©"); } } catch {}
  try { if (MARKET.wsPrivate) { MARKET.wsPrivate.terminate(); log("[STOP] WS PrivÃƒÂ© fermÃƒÂ©"); } } catch {}
  try { AI.on = false; log("[STOP] IA dÃƒÂ©sactivÃƒÂ©e"); } catch {}
}

/* ===== App lifecycle ===== */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const wins = BrowserWindow.getAllWindows();
    const w = wins && wins[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });

  app.whenReady().then(async () => {
    log("[BOOT] === whenReady ===");
    await createWindow();

    // Global shortcuts (DevTools & reload)
    try {
      globalShortcut.register("CommandOrControl+Shift+I", () => {
        const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.openDevTools({ mode: "detach" });
      });
      globalShortcut.register("F12", () => {
        const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.openDevTools({ mode: "detach" });
      });
      globalShortcut.register("CommandOrControl+R", () => {
        const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.reload();
      });
    } catch {}
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch {} });

app.on("window-all-closed", () => {
  /* Bot de trading headless : la fenêtre peut disparaître (session RDP fermée,
     écran verrouillé) SANS arrêter le moteur. Ne jamais quitter ici — l'arrêt
     se fait uniquement en tuant le processus (taskkill / fermeture du .bat). */
  log("[APP] fenêtres fermées — moteur de trading maintenu en vie (headless)");
});

/* ===== Process-level error handlers ===== */
process.on("uncaughtException", (e) => log("[UNCAUGHT]", e && (e.stack || e.message) || e));
process.on("unhandledRejection", (e) => log("[UNHANDLED]", (e && e.stack) || String(e)));
/* === HERMES LOG_GUARD_V5 (anti-spam + normalisation INFO) === */
(() => {
  if (globalThis.__HERMES_LOG_GUARD_V5__) { try{ log("[LOG_GUARD_V5] dÃƒÂ©jÃƒÂ  installÃƒÂ©"); }catch{} return; }
  globalThis.__HERMES_LOG_GUARD_V5__ = true;

  try{
    const __orig = broadcastAILog;
    const cache = { key:"", at:0 };
    const nonEmpty = (s)=> !!(s && String(s).trim().length);

    broadcastAILog = function(payload){
      try{
        let p = payload;
        if (p == null) return;

        // ChaÃƒÂ®ne brute -> INFO lisible
        if (typeof p === "string"){
          if (p === "AI_TOGGLE"){
            p = { ts: tsISO(), event:"INFO", info:`Hermes Ã¢â‚¬â€œ IA ${AI?.on===true ? "ActivÃƒÂ©e" : "DÃƒÂ©sactivÃƒÂ©e"}` };
          } else {
            p = { ts: tsISO(), event:"INFO", info:String(p) };
          }
        }

        // Si pas dÃ¢â‚¬â„¢event mais un message -> INFO
        if (!p.event && nonEmpty(p.info)) p.event = "INFO";

        // AI_TOGGLE objet -> INFO
        if (p.event === "AI_TOGGLE"){
          p = { ts: p.ts || tsISO(), event:"INFO", info:`Hermes Ã¢â‚¬â€œ IA ${AI?.on===true ? "ActivÃƒÂ©e" : "DÃƒÂ©sactivÃƒÂ©e"}` };
        }

        // TRAINER_TICK -> INFO compact
        if (p.event === "TRAINER_TICK"){
          const n = (p.samples!=null) ? ` (samples ${p.samples})` : "";
          p = { ts: p.ts || tsISO(), event:"INFO", info:`Mise ÃƒÂ  jour modÃƒÂ¨le${n}` };
        }

        // RÃƒÂ¨gles INFO: pas de tag live, pas vide, dÃƒÂ©doublonnage 5s
        if (p.event === "INFO"){
          try{ delete p.live; }catch{}
          if (!nonEmpty(p.info)) return;
          const key = String(p.info).trim();
          const now = Date.now();
          if (cache.key === key && (now - cache.at) < 5000) return;
          cache.key = key; cache.at = now;
        }

        return __orig(p);
      } catch {
        try { return __orig(payload); } catch {}
      }
    };

    log("[LOG_GUARD_V5] actif");
  }catch(e){
    try{ log("[LOG_GUARD_V5_ERR]", e.message); }catch{}
  }
})();
/* === HERMES PERSIST_DEALS (historique JSONL + reload au boot) === */
(() => {
  if (globalThis.__HERMES_PERSIST_DEALS_V2__) { try{ log("[PERSIST_DEALS] dÃƒÂ©jÃƒÂ  installÃƒÂ©"); }catch{} return; }
  globalThis.__HERMES_PERSIST_DEALS_V2__ = true;

  try{
    const dir = path.join(DATADIR, "trades-logs");
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    function dailyDealsFile(ts){
      const d = new Date(ts || Date.now());
      const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,"0"), da = String(d.getUTCDate()).padStart(2,"0");
      return path.join(dir, `deals_${y}${m}${da}.jsonl`);
    }
    function persistDeal(deal){
      try { fs.appendFileSync(dailyDealsFile(deal.time || Date.now()), JSON.stringify(deal) + "\n"); }
      catch(e){ log("[DEALS_PERSIST_ERR]", e.message); }
    }
    function loadDealsHistory(days=14, maxItems=600){
      try{
        const now = Date.now(), one = 86400000;
        const files = fs.readdirSync(dir).filter(n=>/^deals_\d{8}\.jsonl$/i.test(n)).sort().reverse();
        const keep = files.filter(n=>{
          try{ const ymd = n.match(/deals_(\d{8})\.jsonl$/i)[1];
               const y=+ymd.slice(0,4), m=+ymd.slice(4,6), d=+ymd.slice(6,8);
               const ts = Date.UTC(y, m-1, d); return (now - ts) <= days*one; }catch{ return false; }
        });
        const acc = [];
        for (const f of keep){
          const txt = fs.readFileSync(path.join(dir,f), "utf8").trim();
          if (!txt) continue;
          for (const line of txt.split("\n")){
            try{ acc.push(JSON.parse(line)); }catch{}
            if (acc.length >= maxItems) break;
          }
          if (acc.length >= maxItems) break;
        }
        acc.sort((a,b)=> (b.time||0) - (a.time||0));
        try { DEALS.recent = acc.slice(0, maxItems); } catch {}
      }catch(e){ log("[DEALS_LOAD_ERR]", e.message); }
    }

    // Hook sur TRADE_EXIT pour persister
    const __orig_logAIEvent = logAIEvent;
    logAIEvent = function(obj){
      try{
        if (obj && obj.event === "TRADE_EXIT"){
          const deal = {
            time:     Date.now(),
            symbol:   obj.instId || obj.symbol || "",
            side:     String(obj.side||"").toUpperCase(),
            price:    obj.price,
            profit:   obj.profit || obj.pnl || 0,
            leverage: obj.leverage || DEFAULT_LEVERAGE || 20,
            margin:   obj.margin,
            notional: obj.notional
          };
          persistDeal(deal);
        }
      }catch(e){ log("[DEALS_HOOK_ERR]", e.message); }
      return __orig_logAIEvent(obj);
    };

    // Reload rÃƒÂ©cent au boot
    try { loadDealsHistory(14, 600); } catch {}

    // Watchers Ã¢â‚¬Å“infoÃ¢â‚¬Â
    function watchReload(label, targetFile){
      try{
        const dirW = path.dirname(targetFile);
        const base = path.basename(targetFile).toLowerCase();
        try{ fs.mkdirSync(dirW, { recursive: true }); } catch {}
        fs.watch(dirW, { persistent:false }, (_evt, fname) => {
          try{
            if (!fname || String(fname).toLowerCase() !== base) return;
            broadcastAILog({ ts: tsISO(), event:"INFO", info:`${label} mis ÃƒÂ  jour` });
          }catch{}
        });
      }catch(e){ log("[WATCH_ERR]", label, e.message); }
    }
    watchReload("policy.json",          path.join(ROOT,"config","policy.json"));
    watchReload("ai.config.json",       path.join(ROOT,"config","ai.config.json"));
    watchReload("modÃƒÂ¨le (alpha.json)",  path.join(DATADIR,"models","alpha.json"));

    log("[PERSIST_DEALS] actif");
  }catch(e){
    try{ log("[PERSIST_INIT_ERR]", e.message); }catch{}
  }
})();
/* === HERMES GATE V2 (seuils, cooldown, accept OKX, BE/Trail policy) === */
(() => {
  if (globalThis.__HERMES_GATE_V2__) { try{ log("[LIVE_SIM_GATE] dÃƒÂ©jÃƒÂ  installÃƒÂ©"); }catch{} return; }
  globalThis.__HERMES_GATE_V2__ = true;

  try{
    const POLICY = safeReadJSON(path.join(ROOT, "config", "policy.json"), {
      slInitPctOfMargin:      -0.40, // SL initial Ã¢â€°Ë† -40% de la marge
      beNetPctOfMargin:        0.25, // BE quand PnL net >= 25% marge Ã¢â€ â€™ stop ÃƒÂ  lÃ¢â‚¬â„¢entrÃƒÂ©e Ã‚Â± 25%
      trailOnNetPctOfMargin:   0.40, // activer trail ÃƒÂ  +40% net
      trailCallbackRatio:      0.003,
      cooldownLiveSec:        10,
      cooldownSimSec:          5,
      minLiveScoreAbs:         3,
      minSimScoreAbs:          2
    });

    const ctVal = (instId)=> num(MARKET.meta[instId]?.ctVal || 1);
    const marginAt = (entryPx, qty, instId, lev)=> {
      const notional = entryPx * qty * ctVal(instId);
      return (lev>0 ? notional/lev : notional);
    };
    const profitUSDT = (instId, side, entryPx, lastPx, qty)=>{
      const ct = ctVal(instId);
      return (side==='long' ? (lastPx-entryPx) : (entryPx-lastPx)) * qty * ct;
    };
    const feeTaker = ()=>{
      const f = (typeof MARKET.fees?.taker === "number") ? MARKET.fees.taker : 0.0005;
      return Math.max(0, f);
    };
    const stopPxFromMargin = (instId, side, entryPx, qty, pctOfMargin)=>{
      const lev = DEFAULT_LEVERAGE || 20;
      const dUSDT = (pctOfMargin||0) * marginAt(entryPx, qty, instId, lev);
      const dPx = dUSDT / (qty * ctVal(instId));
      return side==='long' ? (entryPx + dPx) : (entryPx - dPx);
    };
    const prettySymbol = (instId)=>{
      try{ const s=String(instId||"").toUpperCase().replaceAll("_","-"); const p=s.split("-"); return (p.length>=2)?`${p[0]}/${p[1]}`:s; }catch{return String(instId||"");}
    };

    /* ===== SPEC CLIENT (29.08.2026) — protections posées SUR OKX =====
       marge/trade = (capital − 10 %) ÷ 10, levier ×20, 10 positions max
       TP  = +50 % de la marge  (= +2,5 % de prix à ×20)
       SL  = −20 % de la marge  (= −1,0 % de prix)
       Trail : s'active à +10 % de marge (+0,5 % prix), suit à 10 % de marge (0,5 % prix)
       TOUT est côté exchange (attachAlgoOrds + move_order_stop avec activePx) :
       si l'app meurt, la position reste protégée. */
    /* SPEC validée par le client le 30/08 (ajusté même jour : activation +10 %) :
       levier ×15, TP +80 % marge / SL −30 % / trail 5 % de marge activé à +10 %.
       Tous les prix se déduisent du levier : pct marge ÷ levier = pct prix. */
    const SPEC = { tpPctMargin: 0.80, slPctMargin: 0.30, trailActPctMargin: 0.10, trailCbPctMargin: 0.05 };
    const trailCallbackPx = () => (SPEC.trailCbPctMargin / (DEFAULT_LEVERAGE || 15));

    /* Arrondi au tickSz de l'instrument, sortie décimale (jamais d'exponentielle). */
    const pxToTick = (instId, px) => {
      const tickS = String(MARKET.meta[instId]?.tickSz || "0.0001");
      const dec = tickS.includes(".") ? tickS.split(".")[1].length : 0;
      const t = Number(tickS) || 0.0001;
      const r = Math.round(px / t) * t;
      return r.toFixed(dec);
    };
    /* ov = surcharge par trade (mode HERMES 15 : chaque crypto a SES sorties). */
    const specPrices = (instId, side, entryPx, ov) => {
      const S = ov ? { ...SPEC, ...ov } : SPEC;
      const lev = DEFAULT_LEVERAGE || 15;
      const up = (pct) => entryPx * (1 + pct / lev);
      const dn = (pct) => entryPx * (1 - pct / lev);
      return side === "long"
        ? { tp: pxToTick(instId, up(S.tpPctMargin)), sl: pxToTick(instId, dn(S.slPctMargin)), act: pxToTick(instId, up(S.trailActPctMargin)) }
        : { tp: pxToTick(instId, dn(S.tpPctMargin)), sl: pxToTick(instId, up(S.slPctMargin)), act: pxToTick(instId, dn(S.trailActPctMargin)) };
    };

    /* Réparation : pose un OCO TP/SL exchange-side pour une position existante. */
    placeInitialStop = async function(instId, side, entryPx, qtyIn, ov){
      try{
        const qty = Math.abs(qtyIn || AI.openPositions[instId]?.qty || 0);
        if (qty <= 0 || !(entryPx > 0)) return { ok:false, reason:"noQty" };
        const px = specPrices(instId, side, entryPx, ov);
        const body = {
          instId, tdMode:"isolated",
          ...(isHedge() ? { posSide: side } : { reduceOnly: true }),
          side: side === "long" ? "sell" : "buy",
          ordType: "oco",
          sz: String(qty),
          tpTriggerPx: px.tp, tpOrdPx: "-1",
          slTriggerPx: px.sl, slOrdPx: "-1",
          tpTriggerPxType: "last", slTriggerPxType: "last"
        };
        const r = await okxPOST("/api/v5/trade/order-algo", body);
        const d0 = r?.data?.[0];
        if ((r?.code == "0") && d0?.algoId){
          AI.counters.stopsPlaced++; setHealth("stops",{ placed:AI.counters.stopsPlaced, status:"OK", info:"oco" });
          log("[STOP_PLACED]", instId, side, "TP", px.tp, "SL", px.sl, "algoId", d0.algoId);
          return { ok:true, algoId:d0.algoId, tpPx:px.tp, slPx:px.sl };
        }
        log("[STOP_INIT_ERR]", instId, JSON.stringify(r).slice(0,180));
        return { ok:false, r };
      }catch(e){ setHealth("stops",{ status:"WARN", info:"placeInitialStop error" }); log("[STOP_INIT_ERR]", instId, e.message); return { ok:false, error:e.message }; }
    };

    /* Trailing exchange-side : callback 0,5 % de prix (=10 % de marge), activation à +0,5 % prix. */
    placeTrailing = async function(instId, side, entryPx, qtyIn, ov){
      try{
        const qty = Math.abs(qtyIn || AI.openPositions[instId]?.qty || 0);
        if (qty <= 0 || !(entryPx > 0)) return { ok:false, reason:"noQty" };
        const px = specPrices(instId, side, entryPx, ov);
        const cb = ((ov?.trailCbPctMargin ?? SPEC.trailCbPctMargin) / (DEFAULT_LEVERAGE || 15));
        const body = {
          instId, tdMode:"isolated",
          ...(isHedge() ? { posSide: side } : { reduceOnly: true }),
          side: side === "long" ? "sell" : "buy",
          ordType: "move_order_stop",
          sz: String(qty),
          callbackRatio: cb.toFixed(4),
          activePx: px.act
        };
        const r = await okxPOST("/api/v5/trade/order-algo", body);
        const d0 = r?.data?.[0];
        if ((r?.code == "0") && d0?.algoId){
          log("[TRAIL_PLACED]", instId, side, "activation", px.act, "callback", cb.toFixed(4), "algoId", d0.algoId);
          return { ok:true, algoId:d0.algoId, activePx:px.act };
        }
        log("[TRAIL_ERR]", instId, JSON.stringify(r).slice(0,180));
        return { ok:false, r };
      }catch(e){ log("[TRAIL_ERR]", instId, e.message); return { ok:false, error:e.message }; }
    };

    /* Entrée protégée : TP/SL attachés À l'ordre (atomique côté OKX), puis trailing. */
    const __prev_placeMarket = (typeof placeMarket==="function") ? placeMarket : null;
    placeMarket = async function(instId, side, ov){
      const px = MARKET.tick[instId]?.lastPrice || 0;
      if (px<=0) return { ok:false, reason:"noPrice" };

      const port = await loadPortfolio().catch(()=>null);
      const availableUSDT = num(port?.balances?.details?.find(d=>String(d.ccy).toUpperCase()==="USDT")?.availBal || 0);
      if (!canPlaceOrder(instId, side, availableUSDT)) return { ok:false, reason:"cannotPlace" };

      /* Sizing sur le budget RESTANT (spec : 90 % de l'équité, surconsommation des
         lots déduite) : plafonné par la marge/trade de la spec et le cash dispo.
         Ainsi une place libérée se re-remplit immédiatement, même si le reliquat
         est inférieur à une marge pleine. */
      const s  = positionSizing(AI.equityUSDT);
      const restant = Math.max(0, MAX_RISK_PCT * AI.equityUSDT - usedMarginNow());
      const marge = Math.min(s.perTradeUSDT, restant * 0.98, availableUSDT * 0.95);
      /* Le plancher etait la constante 5 USDT, et il a coute la deuxieme
         place sur un compte de 11,35 : marge calculee 4,97, refusee pour
         trois centimes par un seuil qui n'a aucun rapport avec le
         capital. La question qu'il doit poser n'est pas « cinq dollars
         est-ce beaucoup » mais « ce trade vaut-il encore la peine face a
         celui qu'on visait ». La moitie de la taille visee repond a
         celle-la, et repond pareil a tout capital — sur un gros compte
         elle reste au-dessus de 5, donc rien ne change la-bas.

         Ce qui garde les poussieres a distance est ailleurs, et c'est sa
         place : qtyFromUSDT refuse instrument par instrument des que
         l'arrondi au lot depasse la marge. */
      const plancher = Math.min(MIN_BALANCE_AVAIL, s.perTradeUSDT * 0.5);
      if (marge < plancher) return { ok:false, reason:"budgetEpuise" };
      const qty = qtyFromUSDT(instId, marge);
      if (qty<=0) return { ok:false, reason:"noQty" };
      if (!__shouldPlace(instId, side)) return { ok:false, reason:"dedup" };

      /* Réservation synchrone du budget (pas d'await entre le calcul du reliquat et
         ici) : un signal concurrent verra ce budget comme consommé. Libérée dans le
         finally — en cas de succès la position est déjà comptée dans AI.openPositions. */
      AI.reservedMargin = num(AI.reservedMargin || 0) + marge;

      try{
        AI.inflight++; setHealth("orders",{ inflight:AI.inflight });

        const levR = await okxPOST("/api/v5/account/set-leverage",{ instId, lever:String(DEFAULT_LEVERAGE), mgnMode:"isolated", ...(isHedge() ? { posSide: side } : {}) });
        if (levR?.code != "0") log("[LEV_WARN]", instId, JSON.stringify(levR).slice(0,120));

        const prot = specPrices(instId, side, px, ov);
        const clOrdId = ("hm" + Date.now().toString(36) + Math.random().toString(36).slice(2,8)).slice(0,32);
        const common = {
          instId, tdMode:"isolated",
          side: side==='long' ? "buy" : "sell",
          sz:String(qty),
          ...(isHedge() ? { posSide: side } : {}),
          attachAlgoOrds: [{
            tpTriggerPx: prot.tp, tpOrdPx: "-1",
            slTriggerPx: prot.sl, slOrdPx: "-1",
            tpTriggerPxType: "last", slTriggerPxType: "last"
          }]
        };

        /* P2 (validé client 30/08) : entrée MAKER — limite post-only au meilleur prix du
           carnet. Non exécutée en ~5 s (ou rejetée car elle croiserait) → bascule en ordre
           marché pour ne perdre aucun trade. Frais ~divisés par 2 (~+2 % de marge/trade). */
        let res = null, viaMaker = false, filledPx = px;
        const tick0 = MARKET.tick[instId] || {};
        const lmtPx = side === 'long' ? (tick0.bidPx || px) : (tick0.askPx || px);
        const lim = await okxPOST('/api/v5/trade/order', { ...common, ordType:"post_only", px: pxToTick(instId, lmtPx), clOrdId }).catch(e => ({ __err: e?.response?.data || e.message }));
        const limId = (lim?.code=="0" && lim?.data?.[0]?.sCode=="0") ? lim?.data?.[0]?.ordId : null;
        if (!limId) log("[MAKER_MISS]", instId, "px", pxToTick(instId, lmtPx), "bid/ask", tick0.bidPx, tick0.askPx, JSON.stringify(lim?.data?.[0] || lim?.__err || lim).slice(0, 160));
        if (limId){
          const fin = Date.now() + Number(process.env.HERMES_MAKER_WAIT_MS || 5000);
          while (Date.now() < fin){
            await sleep(700);
            const st = await okxGET("/api/v5/trade/order?instId="+instId+"&ordId="+limId).catch(()=>null);
            const o = st?.data?.[0];
            if (!o) continue;
            if (o.state === "filled"){ viaMaker = true; filledPx = num(o.avgPx)||lmtPx; res = lim; break; }
            if (o.state === "canceled") break;             // post-only rejetée par l'exchange
          }
          if (!viaMaker){
            await okxPOST("/api/v5/trade/cancel-order", { instId, ordId: limId }).catch(()=>null);
            const st2 = await okxGET("/api/v5/trade/order?instId="+instId+"&ordId="+limId).catch(()=>null);
            const o2 = st2?.data?.[0];
            if (o2 && num(o2.accFillSz) > 0){              // remplie (en entier ou en partie) pendant l'annulation
              viaMaker = true; filledPx = num(o2.avgPx)||lmtPx; res = lim;
            }
          }
        }
        if (!res){
          res = await okxPOST('/api/v5/trade/order', { ...common, ordType:"market", clOrdId:(clOrdId+"m").slice(0,32) });
        }

        const accepted = (res && (res.code=="0"||res.code===0))
                      || (res?.data && res.data[0] && (res.data[0].sCode=="0"||res.data[0].sCode===0||res.data[0].ordId));
        if (!accepted){
          try{
            const code=res?.data?.[0]?.sCode??res?.code, msg=res?.data?.[0]?.sMsg??res?.msg;
            broadcastAILog({ ts: tsISO(), event:"INFO", info:`Refus OKX (${code}) ${msg}` });
            log("[ORDER_REJECT]", instId, side, code, msg);
          }catch{}
          throw new Error("OKX reject");
        }

        AI.counters.ordersPlaced++; setHealth("orders",{ placed:AI.counters.ordersPlaced, status:"OK", info:"placed" });

        const lev = DEFAULT_LEVERAGE || 15;
        const mgn = marginAt(filledPx, qty, instId, lev);
        AI.openPositions[instId] = { instId, side, qty, avgPx:filledPx, ts:Date.now(), marginAtEntry: mgn,
                                     tpPx: prot.tp, slPx: prot.sl, protection: "ATTACHED",
                                     ...(ov ? { ov } : {}),   // sorties personnalisées : la garde doit les respecter
                                     ...(ov?.holdMs ? { holdUntil: Date.now() + ov.holdMs } : {}) };

        /* Trailing exchange-side (activation/suivi selon la spec ou la stratégie perso).
           Échec non fatal : le SL attaché protège déjà ; la garde horaire retentera. */
        const tr = await placeTrailing(instId, side, filledPx, qty, ov);
        if (tr.ok) AI.openPositions[instId].trailAlgoId = tr.algoId;

        broadcastAILog({ ts: tsISO(), event:"TRADE_ENTER", instId, symbol: prettySymbol(instId), side, qty, price:filledPx,
                         lev:lev, tp:prot.tp, sl:prot.sl, trail:(tr.ok?"armé":"à réparer"), entree:(viaMaker?"maker":"marché"), live: !!AI.on });
        logAIEvent({ event:"TRADE_ENTER", instId, side, qty, price:filledPx, leverage:lev, tp:prot.tp, sl:prot.sl, entree:(viaMaker?"maker":"marché"), live:true });

        const cd = !!AI.on ? (POLICY.cooldownLiveSec||10) : (POLICY.cooldownSimSec||5);
        setCooldown(instId, cd);

        return { ok:true, res };
      }catch(e){
        if (String(e.message||"") !== "OKX reject"){
          AI.counters.orderErrors++; setHealth("orders",{ errors:AI.counters.orderErrors, status:"WARN", info:"place error" });
          log("[ORDER_ERR]", instId, side, e.message);
        }
        return { ok:false, error:e.message };
      }finally{
        AI.reservedMargin = Math.max(0, num(AI.reservedMargin || 0) - marge);
        AI.inflight = Math.max(0, AI.inflight-1); setHealth("orders",{ inflight:AI.inflight });
      }
    };

    /* Les protections vivent sur OKX (TP/SL attachés + trailing move_order_stop).
       L'ancien BE/trailing « dynamique » ne modifiait que la mémoire locale en
       affichant de faux logs STOP_BE/TRAIL — supprimé. */

    /* ===== GARDE HORAIRE : vérifie et RÉPARE les protections de chaque position =====
       - resynchronise AI.openPositions avec les positions réelles OKX (fantômes/manquantes)
       - toute position sans TP/SL actif reçoit un OCO reconstruit depuis son prix d'entrée
       - toute position sans trailing actif reçoit son move_order_stop
       - les algos orphelins (position fermée) sont annulés */
    const ensureProtections = async function(){
      try{
        const pr = await okxGET("/api/v5/account/positions?instType=SWAP");
        if (pr?.code != "0"){ log("[GUARD] positions illisibles", JSON.stringify(pr).slice(0,120)); return; }
        const positions = (pr.data||[]).filter(x => Math.abs(num(x.pos)) > 0);

        const algos = [];
        for (const ot of ["oco","conditional","move_order_stop","trigger"]){
          const ar = await okxGET("/api/v5/trade/orders-algo-pending?instType=SWAP&ordType=" + ot).catch(()=>null);
          if (ar?.code == "0" && Array.isArray(ar.data)) algos.push(...ar.data);
        }

        /* 1) resynchronisation de l'état local */
        const realSet = new Set(positions.map(x => x.instId));
        for (const id of Object.keys(AI.openPositions)){
          if (!realSet.has(id)){
            const gp = AI.openPositions[id];
            broadcastAILog({ ts: tsISO(), event:"TRADE_EXIT", instId:id, symbol: prettySymbol(id), side: gp.side, info:"réconciliation (fermée côté OKX)", live: !!AI.on });
            delete AI.openPositions[id];
          }
        }
        for (const x of positions){
          const side = (x.posSide === "short" || num(x.pos) < 0) ? "short" : "long";
          if (!AI.openPositions[x.instId]){
            AI.openPositions[x.instId] = { instId:x.instId, side, qty:Math.abs(num(x.pos)), avgPx:num(x.avgPx), ts:Date.now(), adopted:true };
            log("[GUARD] position adoptée", x.instId, side, "avgPx", x.avgPx);
          }
        }

        /* 2) protections manquantes */
        let repare = 0;
        for (const x of positions){
          const side = (x.posSide === "short" || num(x.pos) < 0) ? "short" : "long";
          /* En mode net, OKX marque les algos posSide:"net" — il faut les reconnaître,
             sinon la garde croit les protections absentes et les repose (en écrasant
             les sorties personnalisées HERMES 15 par la spec globale). */
          const mine = algos.filter(a => a.instId === x.instId && (a.posSide && a.posSide !== "net" ? a.posSide === side : true));
          const hasSl    = mine.some(a => (a.ordType === "oco" || a.ordType === "conditional" || a.ordType === "trigger") && num(a.slTriggerPx || a.triggerPx) > 0);
          const hasTrail = mine.some(a => a.ordType === "move_order_stop");
          const qty = Math.abs(num(x.pos)), avg = num(x.avgPx);
          if (!hasSl){
            const r1 = await placeInitialStop(x.instId, side, avg, qty, AI.openPositions[x.instId]?.ov);
            if (r1.ok) repare++;
            else {
              /* SL improsable (ex. 51053 : le prix a déjà dépassé le déclencheur).
                 La position aurait dû être stoppée — on la ferme au marché plutôt
                 que de la laisser sans filet jusqu'au prochain passage. */
              const mark = num(x.markPx) || num(x.last);
              const slPx = side === "short" ? avg * (1 + SPEC.slPctMargin / (DEFAULT_LEVERAGE || 20))
                                            : avg * (1 - SPEC.slPctMargin / (DEFAULT_LEVERAGE || 20));
              const depasse = side === "short" ? (mark >= slPx) : (mark <= slPx);
              if (depasse && mark > 0 && qty > 0){
                const body = { instId: x.instId, tdMode: "isolated",
                               side: side === "short" ? "buy" : "sell",
                               ordType: "market", sz: String(qty), reduceOnly: true };
                if (isHedge()) body.posSide = side;
                const cr = await okxPOST("/api/v5/trade/order", body).catch(()=>null);
                log("[GUARD] SL improsable et prix au-delà -> fermeture marché", x.instId, cr?.code == "0" ? "OK" : JSON.stringify(cr?.data?.[0] || cr));
                continue;
              }
            }
          }
          if (!hasTrail){
            const r2 = await placeTrailing(x.instId, side, avg, qty, AI.openPositions[x.instId]?.ov);
            if (r2.ok){ repare++; if (AI.openPositions[x.instId]) AI.openPositions[x.instId].trailAlgoId = r2.algoId; }
          }
        }

        /* 3) Re-scan et nettoyage : annule les ORPHELINS (position fermée) ET les
           DOUBLONS (garde 1 seul SL/TP + 1 trailing par position, le plus récent).
           Nécessaire car les TP/SL attachés à l'entrée n'apparaissent pas toujours
           comme des algos autonomes → la repose peut en créer un second. */
        let fresh = [];
        for (const ot of ["oco","conditional","move_order_stop","trigger"]){
          const ar = await okxGET("/api/v5/trade/orders-algo-pending?instType=SWAP&ordType=" + ot).catch(()=>null);
          if (ar?.code == "0" && Array.isArray(ar.data)) fresh.push(...ar.data.map(a => ({ ...a, __grp: (a.ordType === "move_order_stop" ? "trail" : "sltp") })));
        }
        const posSz = {};
        for (const x of positions) posSz[x.instId] = Math.abs(num(x.pos));
        const toCancel = [];
        const groups = {};
        for (const a of fresh){
          if (!realSet.has(a.instId)) { toCancel.push(a); continue; }   // orphelin (position fermée)
          const k = a.instId + "|" + a.__grp;
          (groups[k] = groups[k] || []).push(a);
        }
        /* Dédup CONSCIENT DE LA TAILLE : on garde, du plus récent au plus ancien,
           juste assez d'ordres pour couvrir toute la position (cas net-mode où une
           position agrégée nécessite 2 ordres). On n'annule que le vrai surplus. */
        for (const k in groups){
          const instId = k.split("|")[0];
          const need = posSz[instId] || 0;
          const arr = groups[k].sort((x,y) => (+y.cTime||0) - (+x.cTime||0));
          let acc = 0;
          for (const a of arr){
            if (acc >= need * 0.99) toCancel.push(a);   // couverture déjà atteinte → surplus
            else acc += Math.abs(num(a.sz));
          }
        }
        for (let i = 0; i < toCancel.length; i += 10){
          const lot = toCancel.slice(i, i+10).map(a => ({ algoId: a.algoId, instId: a.instId }));
          await okxPOST("/api/v5/trade/cancel-algos", lot).catch(()=>null);
        }
        if (toCancel.length) log("[GUARD] nettoyage algos (orphelins+doublons):", toCancel.length);

        setHealth("guard", { status:"OK", info:`positions ${positions.length} · réparations ${repare} · nettoyés ${toCancel.length}`, lastTs: Date.now() });
        log(`[GUARD] contrôle : ${positions.length} position(s), ${repare} reposée(s), ${toCancel.length} algo(s) nettoyé(s)`);
      }catch(e){ log("[GUARD_ERR]", e.message); setHealth("guard",{ status:"WARN", info:e.message }); }
    };
    globalThis.__hermesEnsureProtections = ensureProtections;
    setTimeout(() => { ensureProtections().catch(()=>{}); }, 20 * 1000);       // 1er contrôle 90 s après le boot
    setInterval(() => { ensureProtections().catch(()=>{}); }, 3600 * 1000);    // puis toutes les heures (spec client)

    /* Le gating onCandleClose du moteur generique vivait ici ; parti
       avec lui. Les entrees passent par __hermesEntre, appele par
       HERMES15 avec les sorties propres a chaque strategie. */
    globalThis.__hermesEntre = (instId, side, ov) => placeMarket(instId, side, ov);
    log("[LIVE_SIM_GATE_V2] actif");
  }catch(e){
    log("[LIVE_SIM_GATE_V2_ERR]", e.message);
  }
})();

/* ============================================================================
   HERMES 15 — stratégies PAR CRYPTO (validées le 30/08 sur 90 j de données,
   9 survivantes du test hors-échantillon de 60 j jamais vus).
   Chaque crypto a SON indicateur et SES sorties. Long ET short.
   Boucle indépendante : bougies 5 m par REST public toutes les 20 s.
   ============================================================================ */
(() => {
  const H = 3600 * 1000;
  /* sig : rsi5m (RSI14 <25 long />75 short) · z48_5m (|z|>2,5 vs SMA48 -> contre-pied)
           run5_5m (5 bougies consécutives -> contre-pied) · meche5m / meche15m
           (mèche > 2x corps et > 0,4 % du prix + volume > 2x moyenne -> contre-pied) */
  /* Roster 31/08 (ordre client « retire les perdants, ajoute les nouveaux ») :
     NES retirée (−10 réels) · ENSO v1 → v2 (RSI + moitié du range 24 h, méga-validée)
     GPS → gen_regime_3 (4/4 : 3 fenêtres + Binance) · SOON → Keltner reclaim (4/4)
     Ajouts : O (Keltner), ACT (Donchian width), POPCAT (ROC+vol), LIT (%B+range). */
  /* Le roster ecrit en dur du 31/08 — desormais le REPLI, plus la
     source. La source est config/roster.json, ecrit par le chercheur de
     perles (deploy/chercher_perles.js) toutes les douze heures et
     recharge ici a chaud. Le repli ne sert que tant qu'aucun roster
     valide n'existe : mieux vaut trader les perles validees d'hier
     qu'un fichier absent. */
  const STRATS_REPLI = {
    "ENSO-USDT-SWAP":  { sig:"rsi_regime",    ov:{ tpPctMargin:0.80, trailActPctMargin:0.30, holdMs:12*H } },
    "GRASS-USDT-SWAP": { sig:"z48_5m",        ov:{ tpPctMargin:0.60, trailActPctMargin:0.30, holdMs:12*H } },
    /* GPS version haut-winrate (boucle Fable, bi-époque wr 68,7/65,8 %) : TP court +30 %, trail à mi-chemin. */
    "GPS-USDT-SWAP":   { sig:"meche_regime",  ov:{ tpPctMargin:0.30, trailActPctMargin:0.15, holdMs:12*H } },
    "AXS-USDT-SWAP":   { sig:"run5_5m",       ov:{ tpPctMargin:0.80, trailActPctMargin:0.30, holdMs:12*H } },
    "SOON-USDT-SWAP":  { sig:"keltner3",      ov:{ tpPctMargin:0.80, trailActPctMargin:0.30, holdMs:8*H } },
    "MANA-USDT-SWAP":  { sig:"run5_5m",       ov:{ tpPctMargin:0.60, trailActPctMargin:0.20, holdMs:12*H } },
    "LUNA-USDT-SWAP":  { sig:"run5_5m",       ov:{ tpPctMargin:0.40, trailActPctMargin:0.30, holdMs:24*H } },
    "MEGA-USDT-SWAP":  { sig:"run5_5m",       ov:{ tpPctMargin:0.40, trailActPctMargin:0.30, holdMs:24*H } },
    "PIEVERSE-USDT-SWAP": { sig:"double_extreme", ov:{ tpPctMargin:0.80, trailActPctMargin:0.30, holdMs:12*H } },
    "O-USDT-SWAP":     { sig:"keltner3",      ov:{ tpPctMargin:0.80, trailActPctMargin:0.30, holdMs:8*H } },
    /* ACT version haut-winrate (boucle Fable, bi-époque wr 74,5/76,8 %) : TP court +30 %, trail à mi-chemin. */
    "ACT-USDT-SWAP":   { sig:"donchian_fade", ov:{ tpPctMargin:0.30, trailActPctMargin:0.15, holdMs:12*H } },
    "POPCAT-USDT-SWAP":{ sig:"roc_vol",       ov:{ tpPctMargin:0.60, trailActPctMargin:0.20, holdMs:8*H } },
    "LIT-USDT-SWAP":   { sig:"bb_range",      ov:{ tpPctMargin:0.60, trailActPctMargin:0.20, holdMs:8*H } },
    /* PENGU x3_combos_3 (3/4 : +3,53 60j / +0,99 180j / Binance +3,20, recale J-180→365) — validé client 31/08. */
    "PENGU-USDT-SWAP": { sig:"vwap_reclaim",  ov:{ tpPctMargin:0.60, trailActPctMargin:0.20, holdMs:24*H } }
  };
  // SL -30 % et trail 5 % (SPEC) pour toutes.

  let STRATS = STRATS_REPLI;
  let rosterVu = "";        // empreinte du dernier roster charge, pour ne journaliser que les changements
  function chargerRoster() {
    try {
      const brut = fs.readFileSync(path.join(ROOT, "config", "roster.json"), "utf8");
      const j = JSON.parse(brut);
      const perles = j && j.perles && typeof j.perles === "object" ? j.perles : null;
      if (!perles || !Object.keys(perles).length) return;   // roster vide : on garde ce qu'on a
      const neuf = {};
      for (const [instId, p] of Object.entries(perles)) {
        if (!p || typeof p.sig !== "string" || !p.ov) continue;
        neuf[instId] = { sig: p.sig, ov: p.ov };
      }
      if (!Object.keys(neuf).length) return;
      const empreinte = JSON.stringify(neuf);
      if (empreinte === rosterVu) return;
      const avant = new Set(Object.keys(STRATS));
      const apres = new Set(Object.keys(neuf));
      const entrent = [...apres].filter((k) => !avant.has(k)).map((k) => k.replace("-USDT-SWAP", ""));
      const sortent = [...avant].filter((k) => !apres.has(k)).map((k) => k.replace("-USDT-SWAP", ""));
      const changent = [...apres].filter((k) => avant.has(k) && STRATS[k] && STRATS[k].sig !== neuf[k].sig)
        .map((k) => k.replace("-USDT-SWAP", "") + " " + STRATS[k].sig + "->" + neuf[k].sig);
      STRATS = neuf;
      rosterVu = empreinte;
      // Une position deja ouverte garde SES sorties : elles ont ete
      // attachees a l'entree, cote exchange. Le roster ne gouverne que
      // les prochaines entrees — un instrument qui en sort n'est donc
      // jamais abandonne en cours de trade.
      log(`[ROSTER] ${Object.keys(neuf).length} perle(s) chargee(s) (${j.genere || "?"})`
        + (entrent.length ? ` | entrent: ${entrent.join(", ")}` : "")
        + (sortent.length ? ` | sortent: ${sortent.join(", ")}` : "")
        + (changent.length ? ` | changent: ${changent.join(", ")}` : ""));
    } catch (e) {
      // Fichier absent au premier demarrage : normal, le repli joue.
      if (e && e.code !== "ENOENT") log("[ROSTER_ERR]", e.message);
    }
  }
  chargerRoster();
  setInterval(chargerRoster, 60 * 1000);
  // La page du laboratoire veut savoir ce que le moteur JOUE en ce
  // moment — qui n'est pas toujours ce que le fichier dit (repli du
  // 31/08 tant que le chercheur n'a rien ecrit, dernier roster valide
  // si le fichier devient illisible).
  globalThis.__hermes15Roster = () => ({
    source: rosterVu ? "chercheur" : "repli-31/08",
    strats: Object.fromEntries(Object.entries(STRATS).map(([k, v]) => [k, { sig: v.sig, ov: v.ov }])),
  });

  const lastClosed = {};   // instId -> ts de la dernière bougie 5m traitée
  /* Les évaluateurs vivent dans modules/signaux.js, partagés avec le
     chercheur de perles : une seule formule, deux consommateurs, aucun
     écart possible entre ce qu'on teste et ce qu'on trade. La parité a
     été prouvée avant la bascule — 3 237 comparaisons, 0 désaccord. */
  const { evalSignal } = require(path.join(__dirname, "..", "modules", "signaux.js"));
  const etatsSignaux = {};   // instId -> mémoire du signal (dédup 15 m)

  async function poll() {
    for (const [instId, cfg] of Object.entries(STRATS)) {
      try {
        const r = await axios.get(OKX.REST_BASE + "/api/v5/market/candles?instId=" + instId + "&bar=5m&limit=300", { timeout: 10000 });
        const raw = (r.data?.data || []);
        if (raw.length < 60) continue;
        // data[0] = bougie EN COURS -> on l'exclut ; ordre API descendant -> on inverse
        const closed = raw.slice(1).map(c => [+c[0], +c[1], +c[2], +c[3], +c[4], +c[5]]).reverse();
        const lastTs = closed[closed.length - 1][0];
        if (lastClosed[instId] === lastTs) continue;   // pas de nouvelle bougie close
        lastClosed[instId] = lastTs;

        // rafraîchit le tick local (fraîcheur + prix + bid/ask pour le maker)
        const tk = await axios.get(OKX.REST_BASE + "/api/v5/market/ticker?instId=" + instId, { timeout: 8000 }).catch(() => null);
        const t0 = tk?.data?.data?.[0];
        if (t0) MARKET.tick[instId] = { ...(MARKET.tick[instId] || {}), instId, lastPrice: +t0.last, bidPx: +t0.bidPx, askPx: +t0.askPx, rx: Date.now() };

        const dir = evalSignal(cfg.sig, closed, (etatsSignaux[instId] = etatsSignaux[instId] || {}));
        setHealth("strategy", { lastCandle: Date.now(), info: "hermes15" });
        if (!dir) continue;
        const side = dir > 0 ? "long" : "short";
        if (!AI.on) { log("[H15] signal", instId, side, "(AI.off, ignoré)"); continue; }
        if (!canPlaceOrder(instId, side)) continue;
        log("[H15] signal", instId, side, "stratégie", cfg.sig);
        const res = await globalThis.__hermesEntre(instId, side, cfg.ov);
        if (!res?.ok) log("[H15] entrée refusée", instId, res?.reason || "");
      } catch (e) { log("[H15_ERR]", instId, e.message); }
      await new Promise(r => setTimeout(r, 300));
    }
  }
  setInterval(() => { poll().catch(() => {}); }, 20 * 1000);

  /* Sortie de secours temporelle (12 h / 24 h selon la stratégie) : ferme au marché
     une position qui a dépassé sa durée max — comme dans les tests. */
  setInterval(async () => {
    for (const [instId, p] of Object.entries(AI.openPositions)) {
      if (!p.holdUntil || Date.now() < p.holdUntil) continue;
      try {
        const body = { instId, tdMode: "isolated", side: p.side === "long" ? "sell" : "buy",
                       ordType: "market", sz: String(Math.abs(p.qty || 0)), reduceOnly: true };
        if (isHedge()) body.posSide = p.side;
        const r = await okxPOST("/api/v5/trade/order", body);
        log("[H15] durée max atteinte -> fermeture", instId, r?.code == "0" ? "OK" : JSON.stringify(r?.data?.[0] || r).slice(0, 120));
        delete AI.openPositions[instId];   // la synchro 4 s et la garde nettoient le reste
      } catch (e) { log("[H15_HOLD_ERR]", instId, e.message); }
    }
  }, 60 * 1000);

  log("[HERMES15] actif —", Object.keys(STRATS).length, "perle(s) au roster (repli du 31/08 tant que le chercheur n'a pas ecrit)");
})();








/* === LOGS_FIX: INFO dedupe 1.5s === */
(() => {
  try{
    const __prev = broadcastAILog;
    broadcastAILog = function(payload){
      try{
        if (payload && payload.event === "INFO") {
          const txt = ((payload.info ?? payload.msg ?? "") + "").trim();
          if (!txt) return; // INFO vide -> ignorÃ©
          if (!global.__AI_INFO_DEDUP__) global.__AI_INFO_DEDUP__ = { last:"", at:0 };
          const now = Date.now();
          if (global.__AI_INFO_DEDUP__.last === txt && (now - global.__AI_INFO_DEDUP__.at) < 1500) {
            return; // drop doublon <1.5s
          }
          global.__AI_INFO_DEDUP__.last = txt; global.__AI_INFO_DEDUP__.at = now;
        }
      }catch{}
      return __prev(payload);
    };
  }catch{}
})();


/* === LOGS_FINAL_GUARD (no AI_TOGGLE, INFO non vide, dedupe 1.5s) === */
(() => {
  try {
    const __prevBroadcast = broadcastAILog;
    if (!global.__FINAL_LOGS_GUARD__) {
      global.__FINAL_LOGS_GUARD__ = { last:"", at:0 };
    }
    broadcastAILog = function(payload){
      try{
        if (!payload) return;
        // 1) ignorer tout AI_TOGGLE rÃ©siduel
        if (payload.event === "AI_TOGGLE") return;

        // 2) INFO non vide
        if (payload.event === "INFO") {
          const txt = ((payload.info ?? payload.msg ?? "") + "").trim();
          if (!txt) return;
          // 3) dÃ©doublonnage 1.5s
          const now = Date.now();
          if (global.__FINAL_LOGS_GUARD__.last === txt && (now - global.__FINAL_LOGS_GUARD__.at) < 1500) {
            return;
          }
          global.__FINAL_LOGS_GUARD__.last = txt;
          global.__FINAL_LOGS_GUARD__.at   = now;
        }
      }catch{}
      return __prevBroadcast(payload);
    };
  } catch {}
})();
/* === BUSâ†’UI RELAY (single, dedup 1.5s) === */
try {
  if (aiLog && aiLog.bus && typeof aiLog.bus.on === "function") {
    try { aiLog.bus.removeAllListeners && aiLog.bus.removeAllListeners("log"); } catch {}
    if (!global.__BUS_INFO_DEDUP__) global.__BUS_INFO_DEDUP__ = { last:"", at:0 };

    aiLog.bus.on("log", (entry) => {
      try {
        // Filtrage minimal
        if (!entry) return;
        if (entry.event === "AI_TOGGLE") return;
        if (entry.event === "INFO") {
          const txt = ((entry.info ?? entry.msg ?? "") + "").trim();
          if (!txt) return;
          const now = Date.now();
          if (global.__BUS_INFO_DEDUP__.last === txt && (now - global.__BUS_INFO_DEDUP__.at) < 1500) return;
          global.__BUS_INFO_DEDUP__.last = txt; global.__BUS_INFO_DEDUP__.at = now;
        }
      } catch {}

      // Broadcast unique
      try {
        if (typeof broadcastToRenderers === "function") {
          broadcastToRenderers("ai:log", entry);
        } else {
          const wins = BrowserWindow ? BrowserWindow.getAllWindows() : [];
          for (const w of wins) {
            const wc = w.webContents;
            if (wc && !wc.isDestroyed()) wc.send("ai:log", entry);
          }
        }
      } catch {}
    });
  }
} catch {}




/* ---- Greffons désactivés (29.08.2026) ----
   patch.tp_sl.js : superseded — les TP/SL sont désormais ATTACHÉS à l'ordre d'entrée
   (attachAlgoOrds) dans le GATE V2, avec bodies OKX corrects.
   patch.auto_reopen.js : SUPPRIMÉ du chargement — c'était un motif de ré-ouverture
   automatique type martingale, dangereux (perte en spirale). Ne jamais réactiver.
   (Les deux étaient déjà inertes ; on retire le require par sécurité.) */

/* L'« ombre inverse » (Fable D) chargee ici a ete SUPPRIMEE le 01/09 :
   presentee comme papier, elle etait ARMEE par defaut (fablew) et
   passait des ordres reels sur la formule de l'ancienne strategie —
   nourrie par le moteur generique, supprime le meme jour. Les
   fichiers d'etude restent dans lab_vagues/. */
