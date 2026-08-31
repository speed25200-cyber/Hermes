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
const CANDLE_SECONDS         = Number(process.env.HERMES_CANDLE_SECONDS || 15);
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
const MIN_EQUITY_USDT   = Number(process.env.HERMES_MIN_EQUITY_USDT || 50);
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
  pendingSignals: [],            // [{instId, side, score, ts}]
  inflight: 0,
  cooldown: {},

  logsAIFile: path.join(DATADIR, "ai-logs.jsonl"),
  simLogsFile: path.join(DATADIR, "sim-logs.jsonl"),

  counters: { signals: 0, ordersPlaced: 0, orderErrors: 0, stopsPlaced: 0, be: 0, trail: 0 }
};

const MARKET = {
  universe: [...DEFAULT_UNIVERSE],
  tick: {}, candles: {},         // 15s store
  bars5m: {},                    // {instId: [{t,o,h,l,c,v}]}
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
/* Spécification client (29.08.2026) : (capital − 10 %) ÷ 10 = MARGE par trade,
   levier ×20, 10 positions simultanées maximum.
   perTradeUSDT est ici une MARGE — le notionnel envoyé à OKX = marge × levier. */
function positionSizing(cap) {
  const usable = Math.max(0, cap * 0.90);        // coussin de 10 % jamais engagé
  /* Ordre client 31/08 (v2) : marge entre 100 et 200 USDT par trade, adaptative —
     la moitié du budget disponible, bornée [100, 200]. À ~334 d'équité : ~150/trade,
     2 positions simultanées ; le plafond 200 s'atteint quand le capital grossit. */
  const MIN_M = Number(process.env.HERMES_MARGIN_MIN || 50);
  const MAX_M = Number(process.env.HERMES_MARGIN_MAX || 200);
  const marginPerTrade = Math.min(Math.max(Math.min(usable / 2, MAX_M), MIN_M), usable);
  return { perTradeUSDT: marginPerTrade, maxPositions: 10, riskFrac: 0.90, step: 5 };
}
function currentOpenCount() { return Object.keys(AI.openPositions).length; }
function perSymbolCooldown(instId) { const t = AI.cooldown[instId] || 0; return now() < t; }
function setCooldown(instId, sec = SYMBOL_COOLDOWN_SEC) { AI.cooldown[instId] = now() + sec * 1000; }

/* ===== CandleStore (15s) ===== */
class CandleStore {
  constructor(instId, sec = CANDLE_SECONDS) {
    this.instId = instId; this.sec = sec;
    this.active = null;           // { t,o,h,l,c,v }
    this.lastClosed = [];         // tableau d'historiques
    this.maxKeep = 600;
  }
  onTick(price, ts) {
    const slot = Math.floor(ts / 1000 / this.sec) * this.sec;
    if (!this.active || this.active.t !== slot) {
      if (this.active) {
        this.active.c = this.active.c ?? this.active.o;
        this.lastClosed.push({ ...this.active });
        if (this.lastClosed.length > this.maxKeep) this.lastClosed.shift();
        onCandleClose(this.instId, this.active);
      }
      this.active = { t: slot, o: price, h: price, l: price, c: price, v: 0 };
    } else {
      if (price > this.active.h) this.active.h = price;
      if (price < this.active.l) this.active.l = price;
      this.active.c = price;
    }
  }
  getHistory() { return this.lastClosed.slice(); }
}

/* ===== Bars 5m store ===== */
class Bars5m {
  constructor(instId) { this.instId = instId; this.rows = []; this.maxKeep = 500; }
  // arr: [[ts,o,h,l,c,vol,volCcy]...], newest first
  prefillFromRest(arr) {
    try {
      const mapped = arr.map(k => ({
        t: Number(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5] || 0)
      })).reverse();
      this.rows = mapped.slice(-this.maxKeep);
    } catch {}
  }
  // data: ["ts","o","h","l","c", ...]
  onWS(data) {
    try {
      const ts = Number(data[0]);
      const o = num(data[1]), h = num(data[2]), l = num(data[3]), c = num(data[4]), v = num(data[5] || 0);
      const last = this.rows[this.rows.length - 1];
      if (!last || last.t < ts) {
        this.rows.push({ t: ts, o, h, l, c, v });
        if (this.rows.length > this.maxKeep) this.rows.shift();
      } else if (last.t === ts) {
        last.o = o; last.h = h; last.l = l; last.c = c; last.v = v;
      }
    } catch (e) { log("[BARS5_ERR]", e.message); }
  }
  get() { return this.rows.slice(); }
}

/* ===== Indicators ===== */
function sma(values, period) { const p = Math.min(period, values.length); if (p <= 0) return 0; let s = 0; for (let i = values.length - p; i < values.length; i++) s += values[i]; return s / p; }
function ema(values, period) { if (!values.length) return 0; const k = 2 / (period + 1); let r = values[0]; for (let i = 1; i < values.length; i++) r = values[i] * k + r * (1 - k); return r; }
function atr(c, period = 14) {
  if (c.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < c.length; i++) {
    const H = c[i].h, L = c[i].l, C = c[i - 1].c;
    trs.push(Math.max(H - L, Math.abs(H - C), Math.abs(L - C)));
  }
  return ema(trs, Math.min(period, trs.length));
}
function computeSuperTrend(c, period = 10, factor = 3) {
  if (c.length < period + 2) return { dir: null, line: null };
  const a = atr(c, period); const last = c[c.length - 1]; const mid = (last.h + last.l) / 2;
  const upper = mid + factor * a, lower = mid - factor * a;
  const dir = (last.c > upper) ? "long" : (last.c < lower) ? "short" : null;
  const line = dir === "long" ? lower : dir === "short" ? upper : mid;
  return { dir, line };
}
function computeRSIfromCloses(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}
function computeBollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return { basis: closes[closes.length - 1] || 0, upper: 0, lower: 0, width: 0 };
  const basis = sma(closes, period); let variance = 0;
  for (let i = closes.length - period; i < closes.length; i++) variance += Math.pow(closes[i] - basis, 2);
  variance /= period; const sd = Math.sqrt(variance);
  const upper = basis + mult * sd, lower = basis - mult * sd; const width = (upper - lower) / (basis || 1);
  return { basis, upper, lower, width };
}
function computeKeltner(c, period = 20, mult = 1.5) {
  if (c.length < period) { const last = c[c.length - 1] || { c: 0 }; return { ma: last.c, upper: last.c, lower: last.c }; }
  const closes = c.map(x => x.c); const ma = ema(closes, period); const a = atr(c, period);
  return { ma, upper: ma + mult * a, lower: ma - mult * a };
}
function computeSqueeze(c) {
  if (c.length < 25) return { active: false, dir: null, momentum: 0 };
  const closes = c.map(x => x.c); const bb = computeBollinger(closes, 20, 2); const kc = computeKeltner(c, 20, 1.5);
  const active = (bb.upper - bb.lower) < (kc.upper - kc.lower);
  const deviation = closes.map(v => v - bb.basis);
  const mom = ema(deviation.slice(-20), 10);
  const dir = mom > 0 ? "long" : mom < 0 ? "short" : null;
  return { active, dir, momentum: mom };
}
function computeScore(c) {
  const closes = c.map(x => x.c);
  const st = computeSuperTrend(c, 10, 3);
  const rsi = computeRSIfromCloses(closes, 14);
  const bb = computeBollinger(closes, 20, 2);
  const sq = computeSqueeze(c);

  let score = 0;
  if (st.dir === "long")  score += 3;
  if (st.dir === "short") score -= 3;
  if (closes[closes.length - 1] < bb.lower && rsi < 35) score += 2;
  if (closes[closes.length - 1] > bb.upper && rsi > 65) score -= 2;
  if (sq.active) score += (sq.dir === "long" ? 1 : sq.dir === "short" ? -1 : 0);

  const volBoost = clamp(bb.width, 0, 0.05) / 0.05;
  score = score * (1 + 0.5 * volBoost);
  const dir = score > 0 ? "long" : score < 0 ? "short" : null;
  return { score, dir, st, rsi, bb, sq };
}
/* ===== Universe loader ===== */
const TAILLE_UNIVERS = Number(process.env.HERMES_UNIVERSE_SIZE || 20);
const RAFRAICHIR_UNIVERS_MS = Number(process.env.HERMES_UNIVERSE_REFRESH_MS || 3600000);
// Sur cent soixante-huit heures, combien doivent avoir vu un echange
// pour quon appelle un marche continu. Une action tokenisee tourne
// autour de trente-cinq heures par semaine ; une crypto, cent
// soixante-huit. Le seuil na donc pas besoin detre fin.
const CONTINU_MIN = Number(process.env.HERMES_CONTINU_MIN || 0.90);

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
  let res = { continu: true, heures: -1, ts: Date.now() };
  try {
    const r = await axios.get(
      OKX.REST_BASE + `/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=1H&limit=168`,
      { timeout: Number(process.env.HERMES_API_TIMEOUT_MS || 12000) }
    );
    const c = Array.isArray(r.data?.data) ? r.data.data : [];
    // On compte les heures ou il sest VRAIMENT echange quelque chose.
    // Compter les bougies rendues ne suffirait pas : un marche ferme
    // peut encore en produire, plates et a volume nul.
    const heures = c.filter((b) => num(b[5]) > 0).length;
    res = { continu: heures >= Math.round(168 * CONTINU_MIN), heures, ts: Date.now() };
  } catch (e) {
    // Une mesure ratee nest pas une preuve de discontinuite. On laisse
    // passer, et le prochain rafraichissement retentera — refuser sur
    // un timeout viderait luniverse a la premiere minute difficile.
    res = { continu: true, heures: -1, ts: Date.now() };
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
        trace.push(`${nom} ${(cote(x) / 1e6).toFixed(0)}M ${m.heures}/168h${m.continu ? "" : " REFUSE"}`);
        if (m.continu && retenus.length < TAILLE_UNIVERS) retenus.push(x.instId);
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
async function prefill5m() {
  try {
    const frame = (OKX_CFG.bars?.prefill?.frame) || "5m";
    const limit = (OKX_CFG.bars?.prefill?.limit) || 200;
    const uni = MARKET.universe.slice(0, 100);
    for (const instId of uni) {
      try {
        const r = await okxGET("/api/v5/market/candles", { instId, bar: frame, limit: String(limit) });
        const arr = Array.isArray(r?.data) ? r.data : [];
        if (!MARKET.bars5m[instId]) MARKET.bars5m[instId] = new Bars5m(instId);
        MARKET.bars5m[instId].prefillFromRest(arr);
        await sleep(30);
      } catch (e) { log("[PREFILL_5M_ERR]", instId, e.message); }
    }
  } catch (e) { log("[PREFILL_5M_ROOT_ERR]", e.message); }
}

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
  if (availableUSDT < MIN_BALANCE_AVAIL) return false;

  /* Fraîcheur : refus si le dernier tick date de plus de 10 s (flux gelé). */
  const tk = MARKET.tick[instId];
  if (!tk || !tk.rx || (Date.now() - tk.rx) > 10000) return false;

  /* Budget de marge (spec : 90 % de l'équité). Il suffit qu'il reste de quoi
     ouvrir un trade minimal — placeMarket dimensionne ensuite sur le reliquat,
     donc les places libérées se re-remplissent dès qu'un signal arrive. */
  const budget = MAX_RISK_PCT * AI.equityUSDT;
  if (usedMarginNow() + Math.max(MIN_BALANCE_AVAIL, 5) > budget) return false;
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

async function updateDynamicStop(instId) {
  try {
    const pos = AI.openPositions[instId];
    if (!pos) return;
    const s = positionSizing(AI.equityUSDT);
    const step = s.step;
    const last = MARKET.tick[instId]?.lastPrice || 0;
    if (!last || !pos.avgPx) return;

    // approx PnL USDT
    const pnlUSDT = (pos.side === "long") ? (last - pos.avgPx) * pos.qty : (pos.avgPx - last) * pos.qty;

    const beThreshold    = step;
    const trailThreshold = 2 * step;
    const trailOffset    = step;

    if (pnlUSDT >= beThreshold && (!pos.stopMode || pos.stopMode === "INIT")) {
      const newStop = pos.avgPx;
      pos.stopMode  = "BE";
      pos.stopPx    = newStop;
      AI.counters.be++; setHealth("stops", { be: AI.counters.be, status: "OK", info: "BE" });
      logAIEvent({ event: "STOP_BE", instId, newStop, pnlUSDT, live: true });
      return;
    }
    if (pnlUSDT >= trailThreshold) {
      const newStop = pos.side === "long" ? (last - trailOffset) : (last + trailOffset);
      if (!pos.stopMode || pos.stopMode !== "TRAIL" || (pos.side === "long" ? newStop > pos.stopPx : newStop < pos.stopPx)) {
        pos.stopMode = "TRAIL";
        pos.stopPx   = newStop;
        AI.counters.trail++; setHealth("stops", { trail: AI.counters.trail, status: "OK", info: "TRAIL" });
        logAIEvent({ event: "STOP_TRAIL", instId, newStop, last, pnlUSDT, live: true });
        return;
      }
    }
  } catch (e) { log("[STOP_UPDATE_ERR]", instId, e.message); }
}
/* ===== Decision Engine ===== */
function pushPendingSignal(instId, side, score) {
  AI.pendingSignals.push({ instId, side, score, ts: now() });
  if (AI.pendingSignals.length > 500) AI.pendingSignals.shift();
}

function onCandleClose(instId, candle) {
  setHealth("strategy", { lastCandle: Date.now() });

  const hist = MARKET.candles[instId]?.getHistory() || [];
  if (hist.length < 8) return;

  const { score, dir } = computeScore(hist);

  // SIM (toujours ON) + anti-spam lÃƒÂ©ger pour le flux UI
  appendJSONL(AI.simLogsFile, { ts: tsISO(), event: "SIM_SIGNAL", instId, dir, score, px: candle.c });
  try {
    if (!globalThis.__simRateLimiter) globalThis.__simRateLimiter = { lastAt: 0, count: 0 };
    const rl = globalThis.__simRateLimiter;
    const t  = Date.now();
    if (Math.abs(score) >= 4) {
      if (t - rl.lastAt > 1000) { rl.count = 0; rl.lastAt = t; }
      if (rl.count < 4) { broadcastAILog({ event: "SIM_SIGNAL", instId, score, price: candle.c, live: false }); rl.count++; }
    }
  } catch {}

  if (!dir) return;

  AI.counters.signals++;
  setHealth("strategy", { lastSignal: Date.now(), status: "OK", info: `score=${score.toFixed(2)}` });

  if (AI.on && OKX.KEY && OKX.SECRET && OKX.PASS) {
    if (canPlaceOrder(instId, dir)) {
      placeMarket(instId, dir);
    } else {
      pushPendingSignal(instId, dir, score);
    }
  } else {
    if (Math.abs(score) >= 3) pushPendingSignal(instId, dir, score);
  }

  if (AI.openPositions[instId]) updateDynamicStop(instId);
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
      upl:     num(x.upl),
      uplRatio:num(x.uplRatio)
    }));

    setHealth("portfolio", { status: "OK", info: "fetch", lastOk: Date.now() });
    return { balances, positions, ts: tsISO() };
  } catch (e) {
    setHealth("portfolio", { status: "WARN", info: "fetch error", lastErr: Date.now() });
    log("[PORTFOLIO_ERR]", e.message);
    return { balances: { totalEq: AI.equityUSDT || 0, details: [] }, positions: [], ts: tsISO(), error: String(e.message || e) };
  }
}

async function portfolioLoop() {
  while (RUNNING) {
    try {
      const port = await loadPortfolio();
      AI.equityUSDT = num(port.balances?.totalEq || AI.equityUSDT);
      refreshTier();

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

      // Consume pending signals if room available
      const open = currentOpenCount();
      const sizing = positionSizing(AI.equityUSDT);
      if (AI.on && OKX.KEY && OKX.SECRET && OKX.PASS &&
          open < Math.min(MAX_POSITIONS_GLOBAL, sizing.maxPositions) &&
          AI.pendingSignals.length) {
        /* Péremption : un signal de plus de 5 min est basé sur une bougie morte — on le jette. */
        const ttlMs = Number(process.env.HERMES_SIGNAL_TTL_MS || 5 * 60 * 1000);
        AI.pendingSignals = AI.pendingSignals.filter(x => (now() - (x.ts || 0)) <= ttlMs);
        AI.pendingSignals.sort((a, b) => b.score - a.score);
        const next = AI.pendingSignals.shift();
        if (next && !perSymbolCooldown(next.instId)) {
          await placeMarket(next.instId, next.side);
        }
      }
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

    // Subscribe in chunks (tickers + funding-rate + candle5m)
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
        const argsBar5 = symbols.map(i => ({ channel: "candle5m",     instId: i })); send({ op: "subscribe", args: argsBar5 });
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

        // Bougies 15s (IA interne)
        if (!MARKET.candles[id]) MARKET.candles[id] = new CandleStore(id, CANDLE_SECONDS);
        MARKET.candles[id].onTick(last, ts);

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

      // candle5m
      if (m.arg?.channel && String(m.arg.channel).startsWith("candle") && m.data?.[0]) {
        const id = m.arg.instId;
        if (!MARKET.bars5m[id]) MARKET.bars5m[id] = new Bars5m(id);
        MARKET.bars5m[id].onWS(m.data[0]); // ["ts","o","h","l","c",...]
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
      pending: AI.pendingSignals.length,
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
      const notional = last * szAbs * ct;
      const lev = p.lever || DEFAULT_LEVERAGE;
      const margin = (lev > 0 && last > 0) ? (notional / lev) : 0;
      const upl = (p.upl !== undefined)
        ? Number(p.upl)
        : ((p.posSide || "").toUpperCase() === "LONG"
            ? (last - (p.avgPx || last)) * szAbs * ct
            : ((p.avgPx || last) - last) * szAbs * ct);

      totalValue  += notional;
      totalMargin += margin;
      unreal      += upl;

      // Ce que lexchange rend ne suffit pas a afficher une position :
      // il ignore les protections que le moteur a posees. La taille, le
      // take-profit, le stop et le trail vivent dans AI.openPositions,
      // et sans eux la page ne peut pas montrer ce quelle doit montrer.
      const suivi = AI.openPositions[p.instId] || {};

      // stopMode dit COMMENT le stop est arrive la ou il est :
      //   INIT  le stop initial, pose a lentree
      //   BE    remonte au point mort, la position ne peut plus perdre
      //   TRAIL il suit le prix et ne redescend jamais
      // Cest la difference entre « un stop existe » et « un stop suit ».
      const modeStop = suivi.stopMode || (suivi.slPx ? "INIT" : null);
      const stopActuel = suivi.stopPx || suivi.slPx || null;

      return {
        symbol: p.instId,
        side:   (p.posSide || "").toUpperCase() === "LONG" ? "LONG" : "SHORT",
        leverage:  lev,
        entryPrice: p.avgPx || 0,
        markPrice:  last,
        size:      suivi.qty || szAbs,
        notional,
        margin,
        // Lheure REELLE douverture. Elle valait Date.now() ici, donc la
        // page affichait toujours « a linstant » et la duree de tenue
        // etait invisible.
        entryTime:  suivi.ts || null,
        unrealizedPnl: upl,
        pnlPctOfMargin: margin > 0 ? (upl / margin) * 100 : 0,
        takeProfit: suivi.tpPx || null,
        stopLoss:   suivi.slPx || null,
        stopActuel,
        stopMode:   modeStop,
        trailArme:  !!suivi.trailAlgoId,
        protection: suivi.protection || null
      };
    });

    const ds = DEALS && Array.isArray(DEALS.recent) ? DEALS.recent : [];
    const nowMs = Date.now();
    const last24 = ds.filter(d => (nowMs - Number(d.time || 0)) <= 86400000);
    const dailyTrades = last24.length;
    const dailyPnL    = last24.reduce((a, d) => a + num(d.profit || d.pnl || 0), 0);
    const dailyVolume = last24.reduce((a, d) => a + num((d.notional != null) ? d.notional : ((d.margin || 0) * (d.leverage || DEFAULT_LEVERAGE || 20))), 0);
    const wins        = last24.filter(d => num(d.profit || d.pnl || 0) > 0).length;
    const winrate     = dailyTrades ? (wins * 100 / dailyTrades) : 0;

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
        winrate, dailyPnL, totalTrades: ds.length, dailyTrades, dailyVolume
      },
      openPositionsDetails: posDetails,
      dealsRecent: ds.slice(0, 150),
      history: { spot: HISTORY && HISTORY.spot ? HISTORY.spot.slice(-600) : [] },
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
      pending: AI.pendingSignals.length,
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
      prefill5m().catch(() => {});
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
      if (marge < Math.max(MIN_BALANCE_AVAIL, 5)) return { ok:false, reason:"budgetEpuise" };
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
    updateDynamicStop = async function(_instId){ /* protections exchange-side : rien à faire ici */ };

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

    // Gating sur onCandleClose (seuils score & push pending)
    const __prev_onCandleClose = (typeof onCandleClose==="function") ? onCandleClose : null;
    onCandleClose = function(instId, candle){
      try{
        setHealth("strategy",{lastCandle:Date.now()});
        const hist = MARKET.candles[instId]?.getHistory() || [];
        if (hist.length < 8) return;
        const { score, dir } = computeScore(hist);
        try { globalThis.__fableD_ombre && globalThis.__fableD_ombre.onSignal(instId, dir, score); } catch {}

        // Log SIM pour apprentissage
        appendJSONL(AI.simLogsFile, { ts: tsISO(), event:"SIM_SIGNAL", instId, dir, score, px:candle.c });

        const live   = !!AI.on;
        const minAbs = live ? Math.abs(POLICY.minLiveScoreAbs||3) : Math.abs(POLICY.minSimScoreAbs||2);
        if (!dir || Math.abs(score) < minAbs) return;

        /* DIAG : pour un signal AU-DESSUS du seuil, on trace (max 1/3 s) pourquoi il
           ne devient pas un ordre — état IA, clés, verdict canPlaceOrder. */
        try {
          globalThis.__diagT = globalThis.__diagT || 0;
          if (Date.now() - globalThis.__diagT > 3000) {
            globalThis.__diagT = Date.now();
            const cpo = canPlaceOrder(instId, dir);
            log(`[DIAG] signal ${instId} ${dir} score ${score.toFixed(2)} | AI.on=${AI.on} keys=${!!(OKX.KEY&&OKX.SECRET&&OKX.PASS)} equity=${AI.equityUSDT?.toFixed(2)} open=${currentOpenCount()} canPlace=${cpo} tickAge=${MARKET.tick[instId]?.rx?((Date.now()-MARKET.tick[instId].rx)/1000).toFixed(1)+'s':'noTick'}`);
          }
        } catch(e){ log("[DIAG_ERR]", e.message); }

        /* Mode HERMES 15 (client 30/08) : la stratégie générique par score est
           DÉBRANCHÉE — les entrées viennent des 9 stratégies par crypto (module
           HERMES15 en fin de fichier). HERMES_MODE=generique pour revenir. */
        if (String(process.env.HERMES_MODE || "15") !== "generique") return;

        if (live && OKX.KEY && OKX.SECRET && OKX.PASS){
          if (canPlaceOrder(instId, dir)) placeMarket(instId, dir);
          else pushPendingSignal(instId, dir, score);
        } else {
          pushPendingSignal(instId, dir, score);
        }

        if (AI.openPositions[instId]) updateDynamicStop(instId);
      }catch(e){ log("[ONCLOSE_ERR]", instId, e.message); }
    };

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
  if (String(process.env.HERMES_MODE || "15") === "generique") { log("[HERMES15] désactivé (mode générique)"); return; }
  const H = 3600 * 1000;
  /* sig : rsi5m (RSI14 <25 long />75 short) · z48_5m (|z|>2,5 vs SMA48 -> contre-pied)
           run5_5m (5 bougies consécutives -> contre-pied) · meche5m / meche15m
           (mèche > 2x corps et > 0,4 % du prix + volume > 2x moyenne -> contre-pied) */
  /* Roster 31/08 (ordre client « retire les perdants, ajoute les nouveaux ») :
     NES retirée (−10 réels) · ENSO v1 → v2 (RSI + moitié du range 24 h, méga-validée)
     GPS → gen_regime_3 (4/4 : 3 fenêtres + Binance) · SOON → Keltner reclaim (4/4)
     Ajouts : O (Keltner), ACT (Donchian width), POPCAT (ROC+vol), LIT (%B+range). */
  const STRATS = {
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
  globalThis.__hermes15Instruments = new Set(Object.keys(STRATS));   // pour exclure les conflits avec la stratégie inverse armée
  // SL -30 % et trail 5 % (SPEC) pour toutes.
  const lastClosed = {};   // instId -> ts de la dernière bougie 5m traitée
  const lastClosed15 = {}; // idem pour les 15m reconstituées

  function rsi14(closes) {
    const p = 14;
    if (closes.length < p + 2) return null;
    let g = 0, pr = 0;
    for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else pr -= d; }
    g /= p; pr /= p;
    for (let i = p + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      g = (g * (p - 1) + Math.max(d, 0)) / p;
      pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
    }
    return 100 - 100 / (1 + g / (pr || 1e-12));
  }
  function zScore(closes, p) {
    if (closes.length < p) return null;
    const w = closes.slice(-p);
    const m = w.reduce((a, b) => a + b, 0) / p;
    const sd = Math.sqrt(Math.max(0, w.reduce((a, b) => a + (b - m) * (b - m), 0) / p));
    return sd > 0 ? (closes[closes.length - 1] - m) / sd : null;
  }
  function runLen(closes) {
    let run = 0, sgn = 0;
    for (let i = closes.length - 1; i > 0; i--) {
      const d = Math.sign(closes[i] - closes[i - 1]);
      if (d === 0) break;
      if (sgn === 0) { sgn = d; run = 1; }
      else if (d === sgn) run++;
      else break;
    }
    return { run, sgn };
  }
  function mecheSignal(c) { // c = [ts,o,h,l,cl,v] la bougie close + tableau pour vol moyen
    return null; // remplacé ci-dessous (implémenté inline pour avoir le contexte volume)
  }

  /* Position du close dans le range des 288 dernières bougies (24 h). */
  function rangePos24h(c5) {
    const n = c5.length;
    if (n < 288) return null;
    let hh = -Infinity, ll = Infinity;
    for (let k = n - 288; k < n; k++) { if (c5[k][2] > hh) hh = c5[k][2]; if (c5[k][3] < ll) ll = c5[k][3]; }
    return hh > ll ? (c5[n - 1][4] - ll) / (hh - ll) : 0.5;
  }
  /* Canal de Keltner EMA20 ± mult×ATR10 (Wilder) sur toute la série — {upper,lower} du dernier ET avant-dernier point. */
  function keltnerLast2(c5, mult) {
    const n = c5.length;
    if (n < 60) return null;
    let ema = c5[0][4], atr = null, prevC = c5[0][4];
    const kE = 2 / 21;
    let out1 = null, out2 = null;
    for (let i = 1; i < n; i++) {
      const h = c5[i][2], l = c5[i][3], c = c5[i][4];
      const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
      atr = atr === null ? tr : (atr * 9 + tr) / 10;
      ema = ema + kE * (c - ema);
      prevC = c;
      if (i === n - 2) out2 = { upper: ema + mult * atr, lower: ema - mult * atr };
      if (i === n - 1) out1 = { upper: ema + mult * atr, lower: ema - mult * atr };
    }
    return { last: out1, prev: out2 };
  }

  function evalStrat(instId, cfg, c5) {
    // c5 = bougies CLOSES ascendantes [[ts,o,h,l,c,v],...]
    const closes = c5.map(x => x[4]);
    if (cfg.sig === "rsi5m") {
      const r = rsi14(closes.slice(-60));
      if (r == null) return 0;
      return r < 25 ? 1 : (r > 75 ? -1 : 0);
    }
    if (cfg.sig === "z48_5m") {
      const z = zScore(closes, 48);
      if (z == null) return 0;
      return z > 2.5 ? -1 : (z < -2.5 ? 1 : 0);
    }
    if (cfg.sig === "run5_5m") {
      const { run, sgn } = runLen(closes.slice(-12));
      return (run >= 5 && sgn !== 0) ? -sgn : 0;
    }
    if (cfg.sig === "rsi_regime") {           // ENSO v2 (méga-validé) : RSI extrême + moitié favorable du range 24h
      const r = rsi14(closes.slice(-60));
      const pos = rangePos24h(c5);
      if (r == null || pos == null) return 0;
      if (r < 25 && pos < 0.5) return 1;
      if (r > 75 && pos > 0.5) return -1;
      return 0;
    }
    if (cfg.sig === "meche_regime") {         // GPS gen_regime_3 (4/4) : mèche 60% + vol 2x + moitié favorable
      const n = c5.length - 1;
      if (n < 288 + 1) return 0;
      const [ , o, h, l, cl, v] = c5[n];
      const range = h - l;
      if (!(range > 0)) return 0;
      let vs = 0; for (let k = n - 20; k < n; k++) vs += c5[k][5];
      vs /= 20;
      if (!(vs > 0)) return 0;
      const pos = rangePos24h(c5);
      if (pos == null) return 0;
      const wLo = (Math.min(o, cl) - l) / range, wHi = (h - Math.max(o, cl)) / range, vm = v / vs;
      if (wLo >= 0.6 && vm >= 2 && pos < 0.5) return 1;
      if (wHi >= 0.6 && vm >= 2 && pos > 0.5) return -1;
      return 0;
    }
    if (cfg.sig === "keltner3") {             // SOON + O (4/4 & double-validé) : reclaim du canal EMA20±3ATR10
      const kc = keltnerLast2(c5, 3);
      if (!kc || !kc.last || !kc.prev) return 0;
      const n = c5.length - 1;
      const cNow = c5[n][4], cPrev = c5[n - 1][4];
      if (cPrev < kc.prev.lower && cNow > kc.last.lower) return 1;
      if (cPrev > kc.prev.upper && cNow < kc.last.upper) return -1;
      return 0;
    }
    if (cfg.sig === "donchian_fade") {        // ACT (bi-époque) : compression Donchian (P15 sur 288) puis fade de la 1re cassure
      const n = c5.length - 1, N_DON = 20;
      if (n < N_DON + 250) return 0;
      const width = [];
      for (let i = N_DON; i <= n; i++) {
        let mx = -Infinity, mn = Infinity;
        for (let k = i - N_DON; k < i; k++) { if (c5[k][2] > mx) mx = c5[k][2]; if (c5[k][3] < mn) mn = c5[k][3]; }
        width.push({ i, w: (mx - mn) / c5[i][4], hi: mx, lo: mn });
      }
      const cur = width[width.length - 1];             // bougie n (cassure potentielle)
      const prev = width[width.length - 2];            // compression mesurée AVANT la cassure
      if (!prev) return 0;
      let below = 0, cnt = 0;
      for (let k = Math.max(0, width.length - 2 - 288); k < width.length - 2; k++) { cnt++; if (width[k].w <= prev.w) below++; }
      if (cnt < 200 || (100 * below / cnt) > 15) return 0;
      if (c5[n][4] > prev.hi) return -1;               // cassure haussière d'un canal compressé -> fade short
      if (c5[n][4] < prev.lo) return 1;
      return 0;
    }
    if (cfg.sig === "roc_vol") {              // POPCAT (bi-époque) : ROC12 étiré + volume >= 2,5x médiane 24h -> fade
      const n = c5.length - 1;
      if (n < 288) return 0;
      const rc = (c5[n][4] / c5[n - 12][4] - 1) * 100;
      const vols = [];
      for (let k = n - 287; k <= n; k++) vols.push(c5[k][5]);
      vols.sort((a, b) => a - b);
      const med = vols.length % 2 ? vols[vols.length >> 1] : (vols[(vols.length >> 1) - 1] + vols[vols.length >> 1]) / 2;
      if (!(med > 0) || c5[n][5] / med < 2.5) return 0;
      const bull = c5[n][4] > c5[n][1];
      if (rc < -1.5 && !bull) return 1;
      if (rc > 1.5 && bull) return -1;
      return 0;
    }
    if (cfg.sig === "bb_range") {             // LIT (bi-époque) : reclaim des bandes Bollinger + dixième extrême du range 24h
      const n = c5.length - 1;
      if (n < 288) return 0;
      function pctB(i) {
        let s = 0, s2 = 0;
        for (let k = i - 19; k <= i; k++) { s += c5[k][4]; s2 += c5[k][4] * c5[k][4]; }
        const m = s / 20, sd = Math.sqrt(Math.max(0, s2 / 20 - m * m));
        const up = m + 2 * sd, lo = m - 2 * sd;
        if (up <= lo) return null;
        return (c5[i][4] - lo) / (up - lo);
      }
      const bNow = pctB(n), bPrev = pctB(n - 1);
      if (bNow == null || bPrev == null) return 0;
      const pos = rangePos24h(c5);
      if (pos == null) return 0;
      if (bPrev <= 0 && bNow > 0 && pos <= 0.10) return 1;
      if (bPrev >= 1 && bNow < 1 && pos >= 0.90) return -1;
      return 0;
    }
    if (cfg.sig === "vwap_reclaim") {         // PENGU (candidates/x3_combos_3) : reclaim de bande VWAP session ±2σ + bougie de reprise
      const n = c5.length - 1, DAY = 86400000, WARM = 36, K = 2;
      if (n < 101) return 0;
      let day = -1, cv = 0, cpv = 0, cpv2 = 0, k = 0;
      let wNow = null, sNow = null, wPrev = null, sPrev = null, bodNow = 0;
      for (let i = 0; i <= n; i++) {
        const d = Math.floor(c5[i][0] / DAY);
        if (d !== day) { day = d; cv = 0; cpv = 0; cpv2 = 0; k = 0; }
        const tp = (c5[i][2] + c5[i][3] + c5[i][4]) / 3, v = Math.max(c5[i][5], 0);
        cv += v; cpv += tp * v; cpv2 += tp * tp * v; k++;
        if (i === n - 1 && cv > 0) { const m = cpv / cv; wPrev = m; sPrev = Math.sqrt(Math.max(cpv2 / cv - m * m, 0)); }
        if (i === n) { bodNow = k; if (cv > 0) { const m = cpv / cv; wNow = m; sNow = Math.sqrt(Math.max(cpv2 / cv - m * m, 0)); } }
      }
      if (wNow == null || !(sNow > 0) || bodNow < WARM) return 0;
      if (wPrev == null || !(sPrev > 0)) return 0;
      const z = (c5[n][4] - wNow) / sNow, zPrev = (c5[n - 1][4] - wPrev) / sPrev;
      const oN = c5[n][1], clN = c5[n][4];
      if (zPrev <= -K && z > -K && z < 0 && clN > oN) return 1;
      if (zPrev >= K && z < K && z > 0 && clN < oN) return -1;
      return 0;
    }
    if (cfg.sig === "double_extreme") {
      // portage fidèle de lab_vagues/agents/candidates/web_structure_1.js (PIEVERSE)
      const n = c5.length - 1, W = 144, GAP = 12, TOL = 0.003, BOUNCE = 0.01;
      if (n < W + 2) return 0;
      let mn = Infinity, mx = -Infinity, iMn = -1, iMx = -1;
      for (let k = n - W; k <= n - GAP; k++) {
        if (c5[k][3] < mn) { mn = c5[k][3]; iMn = k; }
        if (c5[k][2] > mx) { mx = c5[k][2]; iMx = k; }
      }
      const o = c5[n][1], h = c5[n][2], l = c5[n][3], cl = c5[n][4];
      if (l >= mn * (1 - TOL) && l <= mn * (1 + TOL) && cl > o) {
        let rb = -Infinity;
        for (let k = iMn + 1; k < n; k++) if (c5[k][4] > rb) rb = c5[k][4];
        if (rb >= mn * (1 + BOUNCE)) return 1;
      }
      if (h <= mx * (1 + TOL) && h >= mx * (1 - TOL) && cl < o) {
        let rb = Infinity;
        for (let k = iMx + 1; k < n; k++) if (c5[k][4] < rb) rb = c5[k][4];
        if (rb <= mx * (1 - BOUNCE)) return -1;
      }
      return 0;
    }
    if (cfg.sig === "meche5m" || cfg.sig === "meche15m") {
      let serie = c5;
      if (cfg.sig === "meche15m") {
        // reconstitue les 15m alignées, ne signale qu'une fois par 15m close
        const q = [];
        for (let i = 0; i + 3 <= c5.length; ) {
          if ((c5[i][0] / 300000) % 3 !== 0) { i++; continue; }
          if (i + 3 > c5.length) break;
          const tri = c5.slice(i, i + 3);
          q.push([tri[0][0], tri[0][1], Math.max(...tri.map(x => x[2])), Math.min(...tri.map(x => x[3])), tri[2][4], tri.reduce((a, x) => a + x[5], 0)]);
          i += 3;
        }
        serie = q;
        if (!serie.length) return 0;
        if (lastClosed15[instId] === serie[serie.length - 1][0]) return 0;
        lastClosed15[instId] = serie[serie.length - 1][0];
      }
      if (serie.length < 32) return 0;
      const d = serie[serie.length - 1];
      const [, o, h, l, cl, v] = d;
      const corps = Math.abs(cl - o), haut = h - Math.max(o, cl), bas = Math.min(o, cl) - l;
      let mv = 0;
      for (let k = serie.length - 31; k < serie.length - 1; k++) mv += serie[k][5];
      mv /= 30;
      if (v > 2 * mv && haut > 2 * corps && haut > 0.004 * cl) return -1;
      if (v > 2 * mv && bas > 2 * corps && bas > 0.004 * cl) return 1;
      return 0;
    }
    return 0;
  }

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

        const dir = evalStrat(instId, cfg, closed);
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

  log("[HERMES15] actif —", Object.keys(STRATS).length, "stratégies par crypto (générique débranché)");
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

/* === FABLE D — OMBRE INVERSE (ancienne stratégie) : trades PAPIER uniquement ===
   Journal : data/ombre-inverse.jsonl · kill-switch : HERMES_OMBRE=off puis restart.
   Aucun ordre, aucun appel privé : le module ne touche ni AI.*, ni le budget,
   ni les 13 stratégies HERMES15. Formule et validation : lab_vagues/fableD_*. */
(() => {
  try {
    if (String(process.env.HERMES_OMBRE || "on").toLowerCase() === "off") { log("[OMBRE_INV] désactivé (HERMES_OMBRE=off)"); return; }
    const ombreInverse = require(path.join(ROOT, "lab_vagues", "fableD_ombre_inverse.js"));
    ombreInverse.demarrer({ MARKET, DATADIR, log,
      /* Phase ARMÉE (accord client 31/08) : la variante fablew déclenche des ordres RÉELS
         via le circuit standard du bot (maker, budget, protections OKX, sizing 100-200).
         HERMES_INVERSE_ARME=off pour revenir au papier pur. Sorties de la formule fableW :
         TP +80 % / SL −30 % / trail 20 % activé à +20 % / durée max 12 h. */
      armer: String(process.env.HERMES_INVERSE_ARME || "fablew"),
      entrerReel: (instId, side) => {
        try {
          if (globalThis.__hermes15Instruments && globalThis.__hermes15Instruments.has(instId)) return;  // pas de conflit avec les 13
          if (!AI.on || typeof globalThis.__hermesEntre !== "function") return;
          if (!canPlaceOrder(instId, side)) { log("[INVERSE_ARME] refus (budget/slots/fraîcheur)", instId, side); return; }
          log("[INVERSE_ARME] entrée RÉELLE", instId, side);
          globalThis.__hermesEntre(instId, side, {
            tpPctMargin: 0.80, slPctMargin: 0.30, trailActPctMargin: 0.20, trailCbPctMargin: 0.20, holdMs: 12 * 3600e3
          });
        } catch (e) { log("[INVERSE_ARME_ERR]", e.message); }
      }
    });
    globalThis.__fableD_ombre = ombreInverse;
  } catch (e) { try { log("[OMBRE_INV_ERR]", e.message); } catch {} }
})();
