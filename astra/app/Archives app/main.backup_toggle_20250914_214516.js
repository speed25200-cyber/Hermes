/* HERMES — main.js (V4.9 runtime • UI V4.4)
   ===================================================================================
   - UI locale (app/index.html) ou HERMES_DEV_URL (dev server)
   - Marchés: construit Top100 SWAP USDT par volume (REST) + méta instruments & fees
   - WS PUBLIC OKX: tickers + funding-rate + candle5m (prefill 5m via REST)
   - WS PRIVE OKX (si clés): login + heartbeat + subscribe account/positions/orders
   - IA: SIM toujours ON ; LIVE ON/OFF via UI ; sizing isolé x20 ; stops init/BE/trail
   - REST OKX (ISO timestamp) + x-simulated-trading si OKX_SIMULATED=true
   - IPC: fetch-data / fetch-portfolio / get-ai-state / toggle-ai / place-order
          + get-health / debug-snapshot
   - Logs: logs/main.log + data/*.json(l) + push temps réel "ai-log" vers l’UI
   - Robustesse: heartbeat ping/pong + backoff exponentiel + jitter + chunks + deflate off
   - Watchdog Santé: WS/REST/Stratégie/IA/Ordres/Stops/Portfolio/DataFlow (OK/WARN/FAULT)
   =================================================================================== */
"use strict";

/* ===== Imports ===== */
const { app, BrowserWindow, ipcMain, globalShortcut } = require("electron");
const path   = require("path");
const fs     = require("fs");
const http   = require("http");
const https  = require("https");
const crypto = require("crypto");
const axios  = require("axios");
const WebSocket = require("ws");

/* ===== ENV / ROOT ===== */
const ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env") });

/* ===== PATHS ===== */
const HERE  = __dirname;
const DEV_URL = process.env.HERMES_DEV_URL || "http://localhost:8000";
const INDEX_FILE   = path.join(HERE, "index.html");
const PRELOAD_FILE = path.join(HERE, "preload.js");

const LOGDIR  = path.join(HERE, "logs");
const DATADIR = path.join(HERE, "data");
for (const d of [LOGDIR, DATADIR]) { try { fs.mkdirSync(d, { recursive:true }); } catch {} }

/* ===== Logging ===== */
function log(...a){
  const s = `[${new Date().toISOString()}] ${a.join(" ")}`;
  console.log(s);
  try { fs.appendFileSync(path.join(LOGDIR,"main.log"), s+"\n"); } catch {}
}
function saveJSON(p, obj){ try { fs.writeFileSync(p, JSON.stringify(obj,null,2)); } catch(e){ log("[SAVEJSON_ERR]", e.message); } }
function appendJSONL(file, obj){ try{ fs.appendFileSync(file, JSON.stringify(obj)+"\n"); }catch{} }

/* ===== Utils ===== */
const tsISO = () => new Date().toISOString();
const now   = () => Date.now();
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));
function num(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }
function rndInt(a,b){ return a + Math.floor(Math.random()*(b-a+1)); }

/* ===== Safe Read Configs ===== */
function safeReadJSON(p, fallback){ try{ return JSON.parse(fs.readFileSync(p,"utf8")); } catch{ return fallback; } }
const OKX_CFG = safeReadJSON(path.join(ROOT,"config","okx.json"), {
  restBase: "https://www.okx.com",
  wsPublic: "wss://ws.okx.com:8443/ws/v5/public",
  wsPrivate:"wss://ws.okx.com:8443/ws/v5/private",
  wsPublicDemo:"wss://wspap.okx.com:8443/ws/v5/public",
  wsPrivateDemo:"wss://wspap.okx.com:8443/ws/v5/private",
  subscribeChunkMax: 40,
  subscribeJitterMs: [25, 50],
  heartbeat: { timerMs: 5000, pingIdleMs: 20000, pongWaitMs: 10000 },
  reconnectBackoff: { minMs: 1000, maxMs: 30000, jitterMs: 500 },
  bars: { prefill: { frame: "5m", limit: 200 } },
  trading: { defaultLeverage: 20, marginMode: "isolated", triggerPxType: "mark" }
});
const AI_CFG = safeReadJSON(path.join(ROOT,"config","ai.config.json"), {
  signals: { rsiPeriod:14, bbPeriod:20, bbMult:2, supertrendAtr:10, supertrendMult:3, squeezeKcMult:1.5 },
  filters: { minVolUsd24h: 2e7, atrPctMax: 0.05 },
  tuner:   { arms:["e001","e002","e003"], evalWindowMin:15 },
  trainer: { l2:0.0005, clip:3, saveInterval:300 },
  knowledge: { emaRetAlpha:0.1, emaAbsRetAlpha:0.1 }
});

/* ===== CONFIG / ENV Vars ===== */
const DEFAULT_UNIVERSE = (process.env.HERMES_MARKETS||"").split(",").map(s=>s.trim()).filter(Boolean);
const MAX_POSITIONS_GLOBAL = Number(process.env.HERMES_MAX_POSITIONS||10);
const DEFAULT_LEVERAGE = Number(process.env.HERMES_DEFAULT_LEVERAGE || OKX_CFG.trading.defaultLeverage || 20);
const CANDLE_SECONDS   = Number(process.env.HERMES_CANDLE_SECONDS||15);
const SYMBOL_COOLDOWN_SEC = 10;
const MAX_ORDERS_INFLIGHT = 5;

// WS timers
const HB_TIMER_MS = Number(process.env.HERMES_WS_HEARTBEAT_MS || OKX_CFG.heartbeat.timerMs || 5000);
const HB_PING_IDLE_MS = Number(process.env.HERMES_WS_PING_IDLE_MS || OKX_CFG.heartbeat.pingIdleMs || 20000);
const HB_PONG_WAIT_MS = Number(process.env.HERMES_WS_PONG_WAIT_MS || OKX_CFG.heartbeat.pongWaitMs || 10000);
const BK_MIN = Number(process.env.HERMES_WS_BACKOFF_MIN_MS || OKX_CFG.reconnectBackoff.minMs || 1000);
const BK_MAX = Number(process.env.HERMES_WS_BACKOFF_MAX_MS || OKX_CFG.reconnectBackoff.maxMs || 30000);
const BK_JITTER = Number(OKX_CFG.reconnectBackoff.jitterMs || 500);

// Risk guardrails (optionnels)
const MIN_EQUITY_USDT = Number(process.env.HERMES_MIN_EQUITY_USDT || 50);
const MAX_RISK_PCT    = Number(process.env.HERMES_MAX_RISK_PCT || 0.5); // part max du capital en marge
const MIN_BALANCE_AVAIL = Number(process.env.HERMES_MIN_BAL_AVAIL || 5); // USDT

let RUNNING = true;

/* ===== Global Buffers ===== */
const DEALS   = (globalThis.DEALS   = globalThis.DEALS   || { recent: [] });
const HISTORY = (globalThis.HISTORY = globalThis.HISTORY || { spot: [] });

/* ===== Health Dashboard ===== */
const HEALTH = {
  modules: {
    wsPublic:   { status:"FAULT", info:"not-started", lastTs:0, latencyMs:0 },
    wsPrivate:  { status:"FAULT", info:"not-started", lastTs:0, latencyMs:0, authed:false },
    rest:       { status:"OK",    info:"idle", lastOk:0, lastErr:0 },
    dataFlow:   { status:"FAULT", info:"no-ticks", lastTs:0, count:0 },
    strategy:   { status:"OK",    info:"idle", lastSignal:0, lastCandle:0 },
    aiEngine:   { status:"OK",    info:"off", on:false, lastToggle:0 },
    orders:     { status:"OK",    info:"idle", placed:0, errors:0, inflight:0 },
    stops:      { status:"OK",    info:"idle", placed:0, be:0, trail:0 },
    portfolio:  { status:"OK",    info:"idle", lastOk:0, lastErr:0 }
  },
  ts: tsISO()
};
function setHealth(mod, patch){
  try {
    Object.assign(HEALTH.modules[mod], patch||{});
    HEALTH.ts = tsISO();
  } catch {}
}
function statusFromAge(ageMs, warn=10000, fault=25000){
  if (ageMs > fault) return "FAULT";
  if (ageMs > warn ) return "WARN";
  return "OK";
}

/* ===== STATE ===== */
const AI = {
  on: (String(process.env.HERMES_AI_DEFAULT_ON||"false").toLowerCase()==="true"),
  simOn: (String(process.env.HERMES_AI_SIM_ALWAYS_ON||"true").toLowerCase()!=="false"),
  mode:"LIVE+SIM",
  equityUSDT:250, equityPeakTier:250,
  tier:"<1000", tierStopLossPct:0.5,
  openPositions:{},                // { instId: { side, qty, avgPx, ts, stopId?, stopPx?, stopMode? } }
  pendingSignals:[],               // [{instId, side, score, ts}]
  inflight:0, cooldown:{},
  logsAIFile: path.join(DATADIR,"ai-logs.jsonl"),
  simLogsFile: path.join(DATADIR,"sim-logs.jsonl"),
  counters: { signals:0, ordersPlaced:0, orderErrors:0, stopsPlaced:0, be:0, trail:0 }
};

const MARKET = {
  universe:[...DEFAULT_UNIVERSE],
  tick:{}, candles:{}, // 15s store
  bars5m:{},           // {instId: [{t,o,h,l,c,v}]}
  meta:{},             // instId -> {ctVal, lotSz, minSz}
  fees:{ maker:null, taker:null },
  wsPublic:null, wsPrivate:null,
  wsConnected:false, privateAuthed:false,
  preLoginQueue:[],
  lastPublicRx:0, lastPrivateRx:0
};

const OKX = {
  REST_BASE: OKX_CFG.restBase || "https://www.okx.com",
  PUB_WS   : (String(process.env.OKX_SIMULATED||"").toLowerCase()==="true") ? (OKX_CFG.wsPublicDemo || "wss://wspap.okx.com:8443/ws/v5/public") : (OKX_CFG.wsPublic || "wss://ws.okx.com:8443/ws/v5/public"),
  PRI_WS   : (String(process.env.OKX_SIMULATED||"").toLowerCase()==="true") ? (OKX_CFG.wsPrivateDemo|| "wss://wspap.okx.com:8443/ws/v5/private") : (OKX_CFG.wsPrivate|| "wss://ws.okx.com:8443/ws/v5/private"),
  KEY : process.env.OKX_API_KEY || "",
  SECRET: process.env.OKX_API_SECRET || "",
  PASS: process.env.OKX_API_PASSPHRASE || process.env.OKX_PASSPHRASE || "",
  SIMULATED: String(process.env.OKX_SIMULATED||"").toLowerCase()==="true"
};
log("[ENV] OKX key:", !!OKX.KEY, "secret:", !!OKX.SECRET, "pass:", !!OKX.PASS, "sim:", OKX.SIMULATED);

/* === UI runtime mode (auto: file/localhost => full, public => viewer) === */
let UI_RUNTIME_MODE = "full";

/* ===== Tiering & sizing ===== */
function currentTier(cap){ if(cap>=2000) return ">=2000"; if(cap>=1000) return "1000-1999"; return "<1000"; }
function tierStopLossPct(t){ return (t===">=2000") ? 0.30 : 0.50; }
function refreshTier(){
  AI.tier = currentTier(AI.equityUSDT);
  if (AI.equityUSDT > AI.equityPeakTier) AI.equityPeakTier = AI.equityUSDT;
  AI.tierStopLossPct = tierStopLossPct(AI.tier);
}
function tierBreach(){
  const floor = AI.equityPeakTier * (1 - AI.tierStopLossPct);
  return AI.equityUSDT <= floor;
}
function positionSizing(cap){
  if (cap < 1000) { return { perTradeUSDT: 20, maxPositions: 10, riskFrac: null, step: 5 }; }
  if (cap < 2000) { const total = 0.5*cap; return { perTradeUSDT: total/10, maxPositions: 10, riskFrac: 0.5, step: 10 }; }
  const total = 0.3*cap; return { perTradeUSDT: total/10, maxPositions: 10, riskFrac: 0.3, step: 20 };
}
function currentOpenCount(){ return Object.keys(AI.openPositions).length; }
function perSymbolCooldown(instId){ const t = AI.cooldown[instId] || 0; return now() < t; }
function setCooldown(instId, sec=SYMBOL_COOLDOWN_SEC){ AI.cooldown[instId] = now() + sec*1000; }

/* ===== CandleStore (15s) ===== */
class CandleStore {
  constructor(instId, sec=CANDLE_SECONDS){
    this.instId = instId; this.sec = sec;
    this.active = null;   // { t,o,h,l,c,v }
    this.lastClosed = []; this.maxKeep = 600;
  }
  onTick(price, ts){
    const slot = Math.floor(ts/1000/this.sec)*this.sec;
    if (!this.active || this.active.t !== slot){
      if (this.active){
        this.active.c = this.active.c ?? this.active.o;
        this.lastClosed.push({...this.active});
        if (this.lastClosed.length > this.maxKeep) this.lastClosed.shift();
        onCandleClose(this.instId, this.active);
      }
      this.active = { t:slot, o:price, h:price, l:price, c:price, v:0 };
    } else {
      if (price > this.active.h) this.active.h = price;
      if (price < this.active.l) this.active.l = price;
      this.active.c = price;
    }
  }
  getHistory(){ return this.lastClosed.slice(); }
}

/* ===== Bars 5m store ===== */
class Bars5m {
  constructor(instId){ this.instId=instId; this.rows=[]; this.maxKeep=500; }
  prefillFromRest(arr){ // arr: [[ts,o,h,l,c,vol,volCcy]...], newest first
    try{
      const mapped = arr.map(k => ({
        t: Number(k[0]), o:num(k[1]), h:num(k[2]), l:num(k[3]), c:num(k[4]), v:num(k[5]||0)
      })).reverse();
      this.rows = mapped.slice(-this.maxKeep);
    }catch{}
  }
  onWS(data){ // data: ["ts","o","h","l","c", ...]
    try{
      const ts = Number(data[0]);
      const o = num(data[1]);
      const h = num(data[2]);
      const l = num(data[3]);
      const c = num(data[4]);
      const v = num(data[5]||0);
      const last = this.rows[this.rows.length-1];
      if (!last || last.t < ts) { this.rows.push({t:ts,o,h,l,c,v}); if (this.rows.length>this.maxKeep) this.rows.shift(); }
      else if (last.t === ts) { last.o=o; last.h=h; last.l=l; last.c=c; last.v=v; }
    }catch(e){ log("[BARS5_ERR]", e.message); }
  }
  get(){ return this.rows.slice(); }
}

/* ===== Indicators ===== */
function sma(values, period){ const p = Math.min(period, values.length); if (p <= 0) return 0; let s=0; for (let i=values.length-p;i<values.length;i++) s+=values[i]; return s/p; }
function ema(values, period){ if (!values.length) return 0; const k=2/(period+1); let r=values[0]; for(let i=1;i<values.length;i++) r = values[i]*k + r*(1-k); return r; }
function atr(c, period=14){ if (c.length<2) return 0; const trs=[]; for(let i=1;i<c.length;i++){ const H=c[i].h,L=c[i].l,C=c[i-1].c; trs.push(Math.max(H-L, Math.abs(H-C), Math.abs(L-C))); } return ema(trs, Math.min(period, trs.length)); }
function computeSuperTrend(c, period=10, factor=3){
  if (c.length < period+2) return { dir:null, line:null };
  const a = atr(c, period); const last = c[c.length-1]; const mid=(last.h+last.l)/2;
  const upper = mid + factor*a, lower = mid - factor*a;
  const dir = (last.c > upper) ? 'long' : (last.c < lower) ? 'short' : null;
  const line = dir==='long' ? lower : dir==='short' ? upper : mid;
  return { dir, line };
}
function computeRSIfromCloses(closes, period=14){
  if (closes.length < period+1) return 50;
  let gains=0, losses=0; for(let i=closes.length-period;i<closes.length;i++){ const d=closes[i]-closes[i-1]; if(d>=0) gains+=d; else losses-=d; }
  const avgGain=gains/period, avgLoss=losses/period; if(avgLoss===0) return 100; const rs=avgGain/avgLoss; return 100 - (100/(1+rs));
}
function computeBollinger(closes, period=20, mult=2){
  if (closes.length < period) return { basis:closes[closes-1]||0, upper:0, lower:0, width:0 };
  const basis = sma(closes, period); let variance=0;
  for(let i=closes.length-period;i<closes.length;i++) variance += Math.pow(closes[i]-basis,2);
  variance/=period; const sd=Math.sqrt(variance); const upper=basis+mult*sd, lower=basis-mult*sd; const width=(upper-lower)/(basis||1);
  return { basis, upper, lower, width };
}
function computeKeltner(c, period=20, mult=1.5){
  if (c.length < period) { const last = c[c.length-1] || { c:0 }; return { ma:last.c, upper:last.c, lower:last.c }; }
  const closes = c.map(x=>x.c); const ma = ema(closes, period); const a = atr(c, period);
  return { ma, upper: ma + mult*a, lower: ma - mult*a };
}
function computeSqueeze(c){
  if (c.length < 25) return { active:false, dir:null, momentum:0 };
  const closes = c.map(x=>x.c); const bb=computeBollinger(closes,20,2); const kc=computeKeltner(c,20,1.5);
  const active = (bb.upper - bb.lower) < (kc.upper - kc.lower);
  const deviation = closes.map(v => v - bb.basis);
  const mom = ema(deviation.slice(-20), 10);
  const dir = mom>0?'long':mom<0?'short':null;
  return { active, dir, momentum:mom };
}
function computeScore(c){
  const closes = c.map(x=>x.c);
  const st=computeSuperTrend(c, 10, 3);
  const rsi=computeRSIfromCloses(closes, 14);
  const bb=computeBollinger(closes, 20, 2);
  const sq=computeSqueeze(c);

  let score=0;
  if (st.dir==='long') score+=3; if (st.dir==='short') score-=3;
  if (closes[closes.length-1] < bb.lower && rsi<35) score+=2;
  if (closes[closes.length-1] > bb.upper && rsi>65) score-=2;
  if (sq.active) score += (sq.dir==='long'?1 : sq.dir==='short'?-1 : 0);

  const volBoost = clamp(bb.width, 0, 0.05) / 0.05;
  score = score * (1 + 0.5*volBoost);
  const dir = score>0 ? 'long' : score<0 ? 'short' : null;
  return { score, dir, st, rsi, bb, sq };
}

/* ===== Universe loader ===== */
async function loadUniverse(){
  if (DEFAULT_UNIVERSE.length) return DEFAULT_UNIVERSE;
  try {
    const r = await axios.get(OKX.REST_BASE + "/api/v5/market/tickers?instType=SWAP", { timeout: Number(process.env.HERMES_API_TIMEOUT_MS||12000) });
    const arr = Array.isArray(r.data?.data) ? r.data.data : [];
    arr.sort((a,b)=> num(b.volCcy24h) - num(a.volCcy24h));
    const top = arr.slice(0, 100).map(x=>x.instId);
    return top.length ? top : ["BTC-USDT-SWAP","ETH-USDT-SWAP"];
  } catch(e) {
    log("[UNI_ERR]", e.message);
    return ["BTC-USDT-SWAP","ETH-USDT-SWAP"];
  }
}

/* ===== Meta instruments & fees ===== */
async function loadMetaInstruments(){
  try{
    const r = await axios.get(OKX.REST_BASE + "/api/v5/public/instruments?instType=SWAP", { timeout: Number(process.env.HERMES_API_TIMEOUT_MS||15000) });
    const arr = Array.isArray(r.data?.data) ? r.data.data : [];
    for(const x of arr){
      MARKET.meta[x.instId] = { ctVal:num(x.ctVal||1), lotSz:num(x.lotSz||0.001), minSz:num(x.minSz||0.001) };
    }
  }catch(e){ log("[META_ERR]", e.message); }
}
async function loadTradeFees(){
  try{
    const url = OKX.REST_BASE + "/api/v5/account/trade-fee?instType=SWAP";
    const r = await axios.get(url, { headers: okxRestHeaders("/api/v5/account/trade-fee?instType=SWAP","GET",""), timeout: 12000 });
    const d = r.data?.data?.[0] || r.data?.data?.data?.[0] || r.data?.[0] || {};
    MARKET.fees.maker = (d.maker || d.makerU) ? num(d.maker || d.makerU) : null;
    MARKET.fees.taker = (d.taker || d.takerU) ? num(d.taker || d.takerU) : null;
  }catch(e){
    try{
      const q = "/api/v5/account/trade-fee?instType=SWAP&ruleType=normal";
      const r2 = await axios.get(OKX.REST_BASE + q, { headers: okxRestHeaders(q,"GET",""), timeout: 12000 });
      const d2 = r2.data?.data?.[0] || {};
      MARKET.fees.maker = (d2.maker || d2.makerU) ? num(d2.maker || d2.makerU) : null;
      MARKET.fees.taker = (d2.taker || d2.takerU) ? num(d2.taker || d2.takerU) : null;
    }catch(e2){ log("[FEE_ERR]", e2.message); }
  }
}

/* ===== Heartbeat helper + backoff ===== */
function attachOkxHeartbeat(ws, name = "WS") {
  let lastRx = Date.now();
  let lastPong = Date.now();

  const pingTimer = setInterval(() => {
    try{
      const nowT = Date.now();
      if (nowT - lastRx > HB_PING_IDLE_MS) { try{ ws.ping(); }catch{} }
      if (nowT - lastPong > HB_PONG_WAIT_MS) {
        log(`[WS] ${name} heartbeat timeout -> terminate`);
        try{ ws.terminate(); }catch{}
        clearInterval(pingTimer);
      }
    }catch{}
  }, HB_TIMER_MS);

  ws.on("message", ()=> { lastRx = Date.now(); });
  ws.on("pong", ()=> { lastPong = Date.now(); });
  ws.on("ping", (data)=>{ try{ ws.pong(data); }catch{} });
  ws.on("close", ()=> { try{ clearInterval(pingTimer); }catch{} });
  ws.on("error", ()=> { try{ clearInterval(pingTimer); }catch{} });
}

function withBackoff(startMs){
  let d = clamp(startMs||BK_MIN, BK_MIN, BK_MAX);
  return async function bump(label){
    const jitter = rndInt(0, BK_JITTER);
    const wait = Math.min(d + jitter, BK_MAX);
    log(`[WS] ${label} reconnect in ${wait}ms`);
    await sleep(wait);
    d = Math.min(d*2, BK_MAX);
  };
}

/* ===== REST Helpers (OKX compliant) ===== */
function okxRestHeaders(pathname, method="GET", body=""){
  const ts = new Date().toISOString(); // ISO REST
  const prehash = ts + method + pathname + (body || "");
  const sign = crypto.createHmac("sha256", OKX.SECRET).update(prehash).digest("base64");
  const headers = {
    "OK-ACCESS-KEY": OKX.KEY,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": OKX.PASS,
    "Content-Type": "application/json",
  };
  if (OKX.SIMULATED) headers["x-simulated-trading"] = "1";
  return headers;
}
async function okxGET(pathname, params){
  try{
    const url = new URL(OKX.REST_BASE + pathname);
    if (params) Object.keys(params).forEach(k => url.searchParams.append(k, params[k]));
    const headers = okxRestHeaders(url.pathname + url.search, "GET", "");
    const r = await axios.get(url.toString(), { headers, timeout: Number(process.env.HERMES_API_TIMEOUT_MS||12000), httpsAgent:new https.Agent({ keepAlive:true }) });
    setHealth("rest", { status:"OK", info:"GET "+pathname, lastOk:Date.now() });
    return r.data;
  }catch(e){
    setHealth("rest", { status:"WARN", info:"GET_ERR "+pathname, lastErr:Date.now() });
    log("[REST_ERR GET]", pathname, e?.response?.data ? JSON.stringify(e.response.data) : e.message);
    throw e;
  }
}
async function okxPOST(pathname, body){
  try{
    const payload = JSON.stringify(body||{});
    const headers = okxRestHeaders(pathname, "POST", payload);
    const r = await axios.post(OKX.REST_BASE + pathname, payload, { headers, timeout: Number(process.env.HERMES_API_TIMEOUT_MS||12000), httpsAgent:new https.Agent({ keepAlive:true }) });
    setHealth("rest", { status:"OK", info:"POST "+pathname, lastOk:Date.now() });
    return r.data;
  }catch(e){
    setHealth("rest", { status:"WARN", info:"POST_ERR "+pathname, lastErr:Date.now() });
    log("[REST_ERR POST]", pathname, e?.response?.data ? JSON.stringify(e.response.data) : e.message);
    throw e;
  }
}

/* ===== Prefill bars 5m ===== */
async function prefill5m(){
  try{
    const frame = (OKX_CFG.bars?.prefill?.frame)||"5m";
    const limit = (OKX_CFG.bars?.prefill?.limit)||200;
    const uni = MARKET.universe.slice(0,100);
    for (const instId of uni){
      try{
        const r = await okxGET("/api/v5/market/candles", { instId, bar:frame, limit:String(limit) });
        const arr = Array.isArray(r?.data) ? r.data : [];
        if (!MARKET.bars5m[instId]) MARKET.bars5m[instId] = new Bars5m(instId);
        MARKET.bars5m[instId].prefillFromRest(arr);
        await sleep(30);
      }catch(e){ log("[PREFILL_5M_ERR]", instId, e.message); }
    }
  }catch(e){ log("[PREFILL_5M_ROOT_ERR]", e.message); }
}

/* ===== Helpers qty from USDT (contracts) ===== */
function roundQtyToLot(instId, qty){
  const meta = MARKET.meta[instId] || { lotSz:0.001, minSz:0.001 };
  const step  = num(meta.lotSz||0.001);
  const minSz = num(meta.minSz||step);
  const rounded = Math.floor(qty/step)*step;
  return Math.max(rounded, minSz);
}
function qtyFromUSDT(instId, usdt){
  const px = MARKET.tick[instId]?.lastPrice || 0;
  const ct = num(MARKET.meta[instId]?.ctVal || 1);
  if (px <= 0 || ct <= 0) return 0;
  const contracts = usdt / (px * ct);
  return roundQtyToLot(instId, contracts);
}

/* ===== Orders & Stops ===== */
function canPlaceOrder(instId, side, availableUSDT=Infinity){
  if (!AI.on) return false;
  if (AI.inflight >= MAX_ORDERS_INFLIGHT) return false;
  if (perSymbolCooldown(instId)) return false;

  const open = currentOpenCount();
  const sizing = positionSizing(AI.equityUSDT);
  if (open >= Math.min(MAX_POSITIONS_GLOBAL, sizing.maxPositions)) return false;

  const pos = AI.openPositions[instId];
  if (pos && pos.side === side) return false;

  if (AI.equityUSDT < MIN_EQUITY_USDT) return false;
  if (availableUSDT < MIN_BALANCE_AVAIL) return false;

  // Approx risk (marge) vs equity
  const px = MARKET.tick[instId]?.lastPrice || 0;
  const ct = num(MARKET.meta[instId]?.ctVal || 1);
  const qty = qtyFromUSDT(instId, sizing.perTradeUSDT);
  const notional = px * qty * ct;
  const margin = DEFAULT_LEVERAGE>0 ? notional/DEFAULT_LEVERAGE : notional;
  const usedMargin = Object.values(AI.openPositions).reduce((a,p)=>{
    const ppx = MARKET.tick[p.instId||instId]?.lastPrice || p.avgPx || 0;
    const pct = num(MARKET.meta[p.instId||instId]?.ctVal || 1);
    const ntn = ppx * Math.abs(p.qty||0) * pct;
    return a + (DEFAULT_LEVERAGE>0 ? ntn/DEFAULT_LEVERAGE : ntn);
  }, 0);
  if ((usedMargin + margin) > (MAX_RISK_PCT * AI.equityUSDT)) return false;

  return true;
}

async function placeInitialStop(instId, side, entryPx){
  try{
    const s = positionSizing(AI.equityUSDT);
    const step = s.step;
    const k = 5;             // profondeur initiale (5 * step)
    const stopPx = side==='long' ? Math.max(0.5, entryPx - k*step) : entryPx + k*step;
    const body = {
      instId, tdMode:"isolated", posSide: side,
      side: side==='long' ? "sell" : "buy",
      ordType:"trigger",
      triggerPx: String(stopPx),
      tpTriggerPxType: OKX_CFG.trading?.triggerPxType || "mark",
      slTriggerPxType: OKX_CFG.trading?.triggerPxType || "mark"
    };
    const res = await okxPOST("/api/v5/trade/order-algo", body);
    if (res?.data?.[0]?.algoId){
      AI.counters.stopsPlaced++;
      setHealth("stops", { placed:AI.counters.stopsPlaced, status:"OK", info:"placed" });
      return { ok:true, algoId: res.data[0].algoId, stopPx };
    }
    return { ok:false, res };
  }catch(e){
    setHealth("stops", { status:"WARN", info:"placeInitialStop error" });
    log("[STOP_INIT_ERR]", instId, e.message);
    return { ok:false, error:e.message };
  }
}

/* Trailing natif exchange — ratio conservateur */
async function placeTrailing(instId, side, entryPx){
  try{
    const ratio = 0.003; // 0.3%
    const activePx = side==='long' ? entryPx*(1+0.002) : entryPx*(1-0.002);
    const body = {
      instId, tdMode:"isolated", posSide: side,
      ordType:"move_order_stop",
      callbackRatio: String(ratio),
      activePx: String(activePx.toFixed(6))
    };
    const r = await okxPOST("/api/v5/trade/order-algo", body);
    if (r?.data?.[0]?.algoId) return { ok:true, algoId:r.data[0].algoId };
    return { ok:false, r };
  }catch(e){ log("[TRAIL_ERR]", instId, e.message); return { ok:false, error:e.message }; }
}

async function placeMarket(instId, side){
  const s = positionSizing(AI.equityUSDT);
  const px = MARKET.tick[instId]?.lastPrice || 0;
  const qty = qtyFromUSDT(instId, s.perTradeUSDT);
  if (px<=0 || qty<=0) return { ok:false, reason:"noPriceOrQty" };

  // Guardrails avec balance
  const port = await loadPortfolio().catch(()=>null);
  const availableUSDT = num(port?.balances?.details?.find(d=>String(d.ccy).toUpperCase()==="USDT")?.availBal || 0);
  if (!canPlaceOrder(instId, side, availableUSDT)) return { ok:false, reason:"cannotPlace" };

  try{
    AI.inflight++; setHealth("orders", { inflight:AI.inflight });

    await okxPOST("/api/v5/account/set-leverage",{ instId, lever:String(DEFAULT_LEVERAGE), mgnMode:"isolated", posSide:side });

    const res = await okxPOST("/api/v5/trade/order",{
      instId, tdMode:"isolated",
      side: side==='long' ? "buy" : "sell",
      ordType:"market",
      sz:String(qty),
      posSide: side,
      clOrdId: "HERMES-" + Date.now(),
    });

    AI.counters.ordersPlaced++; setHealth("orders", { placed:AI.counters.ordersPlaced, status:"OK", info:"placed" });
    logAIEvent({ event:"TRADE_ENTER", instId, side, qty, price:px, live:true });

    const stp = await placeInitialStop(instId, side, px);
    if (stp.ok){
      if (!AI.openPositions[instId]) AI.openPositions[instId] = { side, qty, avgPx:px, ts:now() };
      AI.openPositions[instId].stopId = stp.algoId;
      AI.openPositions[instId].stopPx = stp.stopPx;
      logAIEvent({ event:"STOP_PLACED", instId, side, stopPx:stp.stopPx, live:true });
    }
    // Trailing additionnel
    placeTrailing(instId, side, px).catch(()=>{});

    setCooldown(instId);
    return { ok:true, res };
  }catch(e){
    AI.counters.orderErrors++; setHealth("orders", { errors:AI.counters.orderErrors, status:"WARN", info:"place error" });
    log("[ORDER_ERR]", instId, side, e.message);
    return { ok:false, error:e.message };
  }finally{
    AI.inflight = Math.max(0, AI.inflight-1);
    setHealth("orders", { inflight:AI.inflight });
  }
}

async function updateDynamicStop(instId){
  try{
    const pos = AI.openPositions[instId];
    if (!pos) return;
    const s = positionSizing(AI.equityUSDT);
    const step = s.step;
    const last = MARKET.tick[instId]?.lastPrice || 0;
    if (!last || !pos.avgPx) return;

    // approx PnL USDT
    const pnlUSDT = (pos.side==='long') ? (last - pos.avgPx)*pos.qty : (pos.avgPx - last)*pos.qty;

    const beThreshold   = step;
    const trailThreshold= 2*step;
    const trailOffset   = step;

    if (pnlUSDT >= beThreshold && (!pos.stopMode || pos.stopMode==="INIT")){
      const newStop = pos.avgPx;
      pos.stopMode = "BE";
      pos.stopPx   = newStop;
      AI.counters.be++; setHealth("stops", { be:AI.counters.be, status:"OK", info:"BE" });
      logAIEvent({ event:"STOP_BE", instId, newStop, pnlUSDT, live:true });
      return;
    }
    if (pnlUSDT >= trailThreshold){
      const newStop = pos.side==='long' ? (last - trailOffset) : (last + trailOffset);
      if (!pos.stopMode || pos.stopMode!=="TRAIL" || (pos.side==='long' ? newStop>pos.stopPx : newStop<pos.stopPx)){
        pos.stopMode = "TRAIL";
        pos.stopPx   = newStop;
        AI.counters.trail++; setHealth("stops", { trail:AI.counters.trail, status:"OK", info:"TRAIL" });
        logAIEvent({ event:"STOP_TRAIL", instId, newStop, last, pnlUSDT, live:true });
        return;
      }
    }
  }catch(e){
    log("[STOP_UPDATE_ERR]", instId, e.message);
  }
}

/* ===== Decision Engine ===== */
function pushPendingSignal(instId, side, score){
  AI.pendingSignals.push({ instId, side, score, ts: now() });
  if (AI.pendingSignals.length > 500) AI.pendingSignals.shift();
}
function onCandleClose(instId, candle){
  setHealth("strategy", { lastCandle: Date.now() });

  const hist = MARKET.candles[instId]?.getHistory() || [];
  if (hist.length < 30) return;
  const { score, dir } = computeScore(hist);

  // SIM (toujours ON) + anti‑spam
  appendJSONL(AI.simLogsFile, { ts:tsISO(), event:"SIM_SIGNAL", instId, dir, score, px:candle.c });
  try{
    if (!globalThis.__simRateLimiter) globalThis.__simRateLimiter = { lastAt:0, count:0 };
    const rl = globalThis.__simRateLimiter;
    const t  = Date.now();
    if (Math.abs(score) >= 4) {
      if (t - rl.lastAt > 1000) { rl.count = 0; rl.lastAt = t; }
      if (rl.count < 4) { broadcastAILog({ event:"SIM_SIGNAL", instId, score, live:false }); rl.count++; }
    }
  }catch{}

  if (!dir) return;

  AI.counters.signals++; setHealth("strategy", { lastSignal:Date.now(), status:"OK", info:`score=${score.toFixed(2)}` });

  if (AI.on && OKX.KEY && OKX.SECRET && OKX.PASS){
    if (canPlaceOrder(instId, dir)){
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
function broadcastAILog(payload){
  try{
    if (payload == null) return;
    const all = BrowserWindow.getAllWindows() || [];
    for (const w of all) w.webContents.send("ai-log", payload);
  }catch{}
}
function broadcastHealth(){
  try{
    const all = BrowserWindow.getAllWindows() || [];
    for (const w of all) w.webContents.send("health-tick", HEALTH);
  }catch{}
}
function logAIEvent(obj){
  const line = { ts: tsISO(), ...obj };
  const file = obj.live ? AI.logsAIFile : AI.simLogsFile;
  appendJSONL(file, line);
  if (["TRADE_ENTER","TRADE_EXIT","AI_TOGGLE","GUARD","STOP_PLACED","STOP_BE","STOP_TRAIL"].includes(obj.event)){
    log("[AI]", obj.event, JSON.stringify(obj));
  }
  broadcastAILog(line);
}

/* ===== UI mode helpers ===== */
function isPrivateLAN(_hostname) { return false; } // garde public => viewer seulement si host public
function hostnameFromURL(u){ try { return new URL(u).hostname || ""; } catch { return ""; } }
function computeUIModeFromURL(u){
  const forced = String(process.env.HERMES_UI_MODE || "").toLowerCase();
  if (forced === "full")   return "full";
  if (forced === "viewer") return "viewer";
  if (!u || u.startsWith("file://")) return "full";
  const host = hostnameFromURL(u);
  if (host === "localhost" || host === "127.0.0.1") return "full";
  if (isPrivateLAN(host)) return "full";
  return "viewer";
}
function isViewerMode(){ return UI_RUNTIME_MODE === "viewer"; }

/* ===== Portfolio & Private WS ===== */
async function loadPortfolio(){
  if (!OKX.KEY || !OKX.SECRET || !OKX.PASS){
    return { balances:{ totalEq: AI.equityUSDT||0, details:[] }, positions:[], ts: tsISO(), note:"NO_OKX_CREDS" };
  }
  try{
    const b = await okxGET("/api/v5/account/balance");
    const root = (b?.data?.[0]) || (b?.data?.data?.[0]) || {};
    const totalEq = num(root.totalEq || root.totalAvailEq || 0);
    const det = Array.isArray(root.details)? root.details : [];
    const balances = {
      totalEq,
      details: det.map(d=>({ ccy:String(d.ccy||"USDT"), eq:num(d.eq), availBal:num(d.availBal??d.cashBal), cashBal:num(d.cashBal) }))
    };
    const p = await okxGET("/api/v5/account/positions", { instType:"SWAP" });
    const arr = Array.isArray(p?.data)? p.data : (Array.isArray(p?.data?.data)? p.data.data : []);
    const positions = arr.map(x=>({
      instId:String(x.instId||""),
      posSide:String(x.posSide||""),
      lever:num(x.lever??x.leverage),
      sz:num(x.pos||x.sz||0),
      avgPx:num(x.avgPx||x.openAvgPx),
      upl:num(x.upl),
      uplRatio:num(x.uplRatio)
    }));
    setHealth("portfolio", { status:"OK", info:"fetch", lastOk:Date.now() });
    return { balances, positions, ts: tsISO() };
  }catch(e){
    setHealth("portfolio", { status:"WARN", info:"fetch error", lastErr:Date.now() });
    log("[PORTFOLIO_ERR]", e.message);
    return { balances:{ totalEq: AI.equityUSDT||0, details:[] }, positions:[], ts: tsISO(), error:String(e.message||e) };
  }
}

async function portfolioLoop(){
  while(RUNNING){
    try{
      const port = await loadPortfolio();
      AI.equityUSDT = num(port.balances?.totalEq || AI.equityUSDT);
      refreshTier();

      if (AI.on && (String(process.env.HERMES_TIER_GUARD||"true").toLowerCase()!=="false") && tierBreach()){
        AI.on = false;
        logAIEvent({ event:"GUARD", reason:"tierBreach", tier:AI.tier, equity:AI.equityUSDT, peak:AI.equityPeakTier, live:true });
      }
      saveJSON(path.join(DATADIR, "portfolio.json"), port);

      // Enrich equity HISTORY (pour graphe)
      try {
        HISTORY.spot.push({ t: Date.now(), v: num(port.balances?.totalEq||0) });
        if (HISTORY.spot.length > 7200) HISTORY.spot.shift();
      } catch {}

      // Consommer pending si slot libre
      const open = currentOpenCount();
      const sizing = positionSizing(AI.equityUSDT);
      if (AI.on && OKX.KEY && OKX.SECRET && OKX.PASS && open < Math.min(MAX_POSITIONS_GLOBAL, sizing.maxPositions) && AI.pendingSignals.length){
        AI.pendingSignals.sort((a,b)=> b.score - a.score);
        const next = AI.pendingSignals.shift();
        if (next && !perSymbolCooldown(next.instId)) {
          await placeMarket(next.instId, next.side);
        }
      }
    }catch{}
    await sleep(4000);
  }
  log("[LOOP] portfolioLoop stopped");
}

/* ===== WS Public ===== */
async function startPublicWS(){
  if (MARKET.wsPublic) try{ MARKET.wsPublic.terminate(); }catch{}
  const backoff = withBackoff(BK_MIN);

  const ws = new WebSocket(OKX.PUB_WS, { perMessageDeflate:false, handshakeTimeout:15000 });
  MARKET.wsPublic = ws;
  attachOkxHeartbeat(ws, "public");

  ws.on("open", () => {
    MARKET.wsConnected = true;
    MARKET.lastPublicRx = Date.now();
    setHealth("wsPublic", { status:"OK", info:"open", lastTs:Date.now() });
    log("[WS] public open");

    // Subscribe
    const syms = MARKET.universe.slice();
    const chunkMax = Number(OKX_CFG.subscribeChunkMax||40);
    const chunks = []; for(let i=0;i<syms.length;i+=chunkMax) chunks.push(syms.slice(i,i+chunkMax));
    const send = (msg)=>ws.send(JSON.stringify(msg));
    (async()=>{
      for(const symbols of chunks){
        const argsTick = symbols.map(i => ({ channel:"tickers", instId:i }));
        send({ op:"subscribe", args:argsTick });
        await sleep(rndInt(OKX_CFG.subscribeJitterMs?.[0]||25, OKX_CFG.subscribeJitterMs?.[1]||50));
        const argsFund = symbols.map(i => ({ channel:"funding-rate", instId:i }));
        send({ op:"subscribe", args:argsFund });
        await sleep(rndInt(OKX_CFG.subscribeJitterMs?.[0]||25, OKX_CFG.subscribeJitterMs?.[1]||50));
        const argsBar5 = symbols.map(i => ({ channel:"candle5m", instId:i }));
        send({ op:"subscribe", args:argsBar5 });
        await sleep(rndInt(OKX_CFG.subscribeJitterMs?.[0]||25, OKX_CFG.subscribeJitterMs?.[1]||50));
      }
    })();
  });

  ws.on("message", (raw) => {
    MARKET.lastPublicRx = Date.now();
    setHealth("wsPublic", { status:"OK", info:"msg", lastTs:Date.now() });

    try{
      const m = JSON.parse(raw);

      // ---- tickers ----
      if (m.arg?.channel === "tickers" && m.data?.[0]){
        const d  = m.data[0];
        const id = m.arg.instId;
        const last = num(d.last);
        const ts   = Number(d.ts || Date.now());

        MARKET.tick[id] = {
          instId: id,
          lastPrice: last,
          riseFallRate: (num(d.sodUtc0)>0) ? ((last - num(d.sodUtc0))/num(d.sodUtc0)) : 0,
          volume24: num(d.volCcy24h || d.vol24h || 0),
          high24Price: num(d.high24h || 0),
          low24Price:  num(d.low24h  || 0),
          fundingRate: (typeof MARKET.tick[id]?.fundingRate === "number") ? MARKET.tick[id].fundingRate : null,
          makerFee: MARKET.fees.maker, takerFee: MARKET.fees.taker,
          ts
        };

        // Bougies 15s (IA interne)
        if (!MARKET.candles[id]) MARKET.candles[id] = new CandleStore(id, CANDLE_SECONDS);
        MARKET.candles[id].onTick(last, ts);

        // DataFlow health
        const c = HEALTH.modules.dataFlow;
        c.count++; c.lastTs = Date.now();
        c.status = "OK"; c.info = "tick";
      }

      // ---- funding-rate ----
      if (m.arg?.channel === "funding-rate" && m.data?.[0]){
        const d  = m.data[0];
        const id = m.arg.instId;
        const fr = (d.fundingRate !== undefined) ? num(d.fundingRate) : null;
        if (!MARKET.tick[id]) MARKET.tick[id] = { instId:id };
        MARKET.tick[id].fundingRate = fr;
      }

      // ---- candle5m ----
      if (m.arg?.channel && String(m.arg.channel).startsWith("candle") && m.data?.[0]){
        const id = m.arg.instId;
        if (!MARKET.bars5m[id]) MARKET.bars5m[id] = new Bars5m(id);
        MARKET.bars5m[id].onWS(m.data[0]); // ["ts","o","h","l","c",...]
      }
    }catch(e){ log("[WS_PUBLIC_MSG_ERR]", e.message); }
  });

  ws.on("close", async () => {
    MARKET.wsConnected=false;
    setHealth("wsPublic", { status:"WARN", info:"close", lastTs:Date.now() });
    if(!RUNNING) return;
    await backoff("public");
    startPublicWS();
  });
  ws.on("error", (e) => { setHealth("wsPublic", { status:"WARN", info:"error" }); log("[WS] public error", e.message); });
}

/* ===== WS Private ===== */
async function startPrivateWS(){
  if (!OKX.KEY || !OKX.SECRET || !OKX.PASS){
    setHealth("wsPrivate", { status:"WARN", info:"missing-creds", authed:false });
    log("[WS] private skipped — missing creds");
    return;
  }
  if (MARKET.wsPrivate) try{ MARKET.wsPrivate.terminate(); }catch{}
  const backoff = withBackoff(BK_MIN);

  const ws = new WebSocket(OKX.PRI_WS, { perMessageDeflate:false, handshakeTimeout:15000 });
  MARKET.wsPrivate = ws;
  attachOkxHeartbeat(ws, "private");

  const qSend = (payload) => {
    const s = JSON.stringify(payload);
    if (MARKET.privateAuthed && ws.readyState === ws.OPEN) { ws.send(s); }
    else { MARKET.preLoginQueue.push(s); }
  };

  ws.on("open", () => {
    MARKET.lastPrivateRx = Date.now();
    setHealth("wsPrivate", { status:"OK", info:"open", lastTs:Date.now(), authed:false });
    log("[WS] private open -> login");
    const ts = (Date.now()/1000).toFixed(3); // seconds.mmm
    const sign = crypto.createHmac("sha256", OKX.SECRET).update(ts + 'GET' + '/users/self/verify').digest("base64");
    const args = { apiKey:OKX.KEY, passphrase:OKX.PASS, timestamp:ts, sign };
    if (OKX.SIMULATED) args["x-simulated-trading"] = "1";
    ws.send(JSON.stringify({ op:"login", args:[args] }));
  });

  ws.on("message", (raw) => {
    MARKET.lastPrivateRx = Date.now();
    setHealth("wsPrivate", { status:"OK", info:"msg", lastTs:Date.now() });

    try {
      const msg = JSON.parse(raw);
      if (msg.event === 'login'){
        log("[WS] private login resp:", JSON.stringify({ code:msg.code||"?", msg: msg.msg||msg.message||"" }));
        if (msg.code === '0'){
          MARKET.privateAuthed = true;
          setHealth("wsPrivate", { authed:true, status:"OK", info:"authed" });
          log("[WS] private login OK -> subscribe account, positions, orders");
          while (MARKET.preLoginQueue.length && ws.readyState === ws.OPEN) ws.send(MARKET.preLoginQueue.shift());
          ws.send(JSON.stringify({ op:"subscribe", args:[{ channel:"account", ccy:"USDT" }] }));
          ws.send(JSON.stringify({ op:"subscribe", args:[{ channel:"positions", instType:"SWAP" }] }));
          ws.send(JSON.stringify({ op:"subscribe", args:[{ channel:"orders", instType:"SWAP" }] }));
        } else {
          setHealth("wsPrivate", { status:"WARN", info:"login-fail" });
          log("[WS] private login FAIL:", msg.code, msg.msg || msg.message || "");
        }
      }

      if (msg.arg?.channel === "positions" && msg.data){
        for (const p of msg.data){
          const instId = p.instId;
          const sz = num(p.pos);
          const side = (p.posSide||"").toLowerCase();
          const avgPx = num(p.avgPx);
          const was = AI.openPositions[instId];

          if (sz === 0){
            // Fermeture -> enregistrer un deal
            try {
              if (was) {
                const meta = MARKET.meta[instId] || { ctVal: 1 };
                const ct   = num(meta.ctVal || 1);
                const last = MARKET.tick[instId]?.lastPrice || avgPx || 0;
                const qty  = Math.abs(was.qty||0);
                const wasSide = String(was.side||"").toUpperCase();
                const lev  = num(p.lever??p.leverage) || DEFAULT_LEVERAGE || 20;
                const notional = last * qty * ct;
                const margin   = lev ? (notional/lev) : 0;
                const profit   = wasSide === "LONG" ? (last - (was.avgPx||last))*qty*ct : ((was.avgPx||last) - last)*qty*ct;
                try {
                  DEALS.recent.unshift({ time: Date.now(), symbol: instId, side: wasSide, price: last, margin, leverage: lev, notional, profit });
                  if (DEALS.recent.length > 300) DEALS.recent.pop();
                } catch {}
                logAIEvent({ event:"TRADE_EXIT", instId, side:wasSide, price:last, qty, profit, live:true });
              }
            } catch {}
            delete AI.openPositions[instId];
          } else {
            AI.openPositions[instId] = { side, qty: Math.abs(sz), avgPx, ts: now() };
          }
        }
      }
      // orders events -> on pourrait pousser des logs détaillés si souhaité
    } catch(e){ log("[WS_PRIVATE_MSG_ERR]", e.message); }
  });

  ws.on("close", async (code, reason) => {
    MARKET.privateAuthed=false;
    setHealth("wsPrivate", { authed:false, status:"WARN", info:"close", lastTs:Date.now() });
    log("[WS] private close | code:", code, "reason:", reason?reason.toString():"");
    if(!RUNNING) return;
    await backoff("private");
    startPrivateWS();
  });
  ws.on("error", (e) => { setHealth("wsPrivate", { status:"WARN", info:"error" }); log("[WS] private error", e.message); });
}

/* ===== Health Watchdog Loop ===== */
async function healthWatchdog(){
  while (RUNNING) {
    try{
      const nowT = Date.now();

      // WS public
      const agePub = nowT - (MARKET.lastPublicRx||0);
      setHealth("wsPublic", { status: statusFromAge(agePub, 10000, 25000), latencyMs: agePub });

      // WS private
      if (OKX.KEY && OKX.SECRET && OKX.PASS) {
        const agePri = nowT - (MARKET.lastPrivateRx||0);
        setHealth("wsPrivate", { status: statusFromAge(agePri, 12000, 28000), latencyMs: agePri });
      }

      // DataFlow
      const df = HEALTH.modules.dataFlow;
      const ageDf = nowT - (df.lastTs||0);
      df.status = statusFromAge(ageDf, 10000, 25000);
      df.latencyMs = ageDf;
      if (Object.keys(MARKET.tick).length === 0) { df.status = "WARN"; df.info = "no-ticks"; }

      // Stratégie
      const st = HEALTH.modules.strategy;
      const ageC = nowT - (st.lastCandle||0);
      if (ageC > 60000) { st.status = "WARN"; st.info = "no-candles"; }

      // IA
      setHealth("aiEngine", { on:AI.on, info: AI.on ? "on" : "off", status: AI.on ? "OK" : "OK" });

      // Orders / Stops -> status dépend du ratio erreurs
      const errRate = AI.counters.orderErrors / Math.max(1, AI.counters.ordersPlaced);
      if (AI.counters.ordersPlaced > 5 && errRate > 0.3) setHealth("orders", { status:"WARN", info:"high-error-rate" });
      broadcastHealth();
    }catch{}
    await sleep(2000);
  }
}

/* ===== Data APIs ===== */
ipcMain.handle("ui-auth", async (_e, pass) => {
  const enabled = String(process.env.HERMES_UI_AUTH_ENABLED || "false").toLowerCase() === "true";
  if (!enabled) return { ok:true, auth:false, required:false };
  const good = String(process.env.HERMES_UI_PASS || "");
  const ok = !!good && String(pass || "") === good;
  return { ok, auth: ok, required:true };
});
ipcMain.handle("ui-mode", async () => ({ ok:true, mode: UI_RUNTIME_MODE }));

ipcMain.handle("get-ai-state", async () => {
  try{
    let logs = [];
    try{
      if (fs.existsSync(AI.logsAIFile)) {
        const raw = fs.readFileSync(AI.logsAIFile, "utf8").trim().split("\n");
        logs = raw.slice(-150).map(line => {
  try{
    const o = JSON.parse(line);
    const mode = (o.live===true) ? "AI-LIVE" : "AI-SIM";
    const ev   = o.event ? String(o.event).toUpperCase() : "LOG";
    const parts = [];
    if (o.instId) parts.push(o.instId);
    if (o.side) parts.push(String(o.side).toUpperCase());
    if (o.qty!=null) parts.push("x"+o.qty);
    if (o.price!=null) parts.push("@ "+o.price);
    const label = `[${mode}] [${ev}] ${parts.join(" ")}`.trim();
    return { ts:o.ts||tsISO(), message: label };
  }catch{ return { ts: tsISO(), message: line }; }
});
      }
    }catch{}

    return {
      ok:true, success:true,
      active: !!AI.on,
      logs,
      mode: AI.mode,
      equityUSDT: AI.equityUSDT,
      tier: AI.tier,
      pending: AI.pendingSignals.length,
      ts: tsISO()
    };
  }catch(e){
    return { ok:false, success:false, active:false, logs:[], error:String(e.message||e), ts: tsISO() };
  }
});

ipcMain.handle("fetch-data", async () => {
  try{
    const data = Object.values(MARKET.tick).slice(0,100).map(t => ({
      symbol: t.instId,
      lastPrice: t.lastPrice || 0,
      riseFallRate: t.riseFallRate || 0,
      volume24: t.volume24 || 0,
      high24Price: t.high24Price || 0,
      low24Price:  t.low24Price  || 0,
      fundingRate: (typeof t.fundingRate === "number") ? t.fundingRate : null,
      makerFee: (typeof t.makerFee === "number") ? t.makerFee : MARKET.fees.maker ?? "—",
      takerFee: (typeof t.takerFee === "number") ? t.takerFee : MARKET.fees.taker ?? "—",
      updatedTs: t.ts || Date.now()
    }));
    return { ok:true, success:true, data, ts: tsISO() };
  }catch(e){
    return { ok:false, success:false, data:[], error:String(e.message||e), ts: tsISO() };
  }
});

ipcMain.handle("fetch-portfolio", async () => {
  try{
    const port = await loadPortfolio();

    // enrichir positions avec meta & last price
    const lastMap = MARKET.tick;
    let totalValue=0, totalMargin=0, unreal=0;
    const posDetails = (port.positions||[]).map(p => {
      const meta = MARKET.meta[p.instId] || { ctVal:1, lotSz:0.001, minSz:0.001 };
      const last = lastMap[p.instId]?.lastPrice || 0;
      const szAbs = Math.abs(p.sz||0);
      const ct = num(meta.ctVal || 1);
      const notional = last * szAbs * ct;
      const lev = p.lever || DEFAULT_LEVERAGE;
      const margin = (lev>0 && last>0) ? (notional/lev) : 0;
      const upl = (p.upl !== undefined) ? Number(p.upl) : ((p.posSide||"").toUpperCase()==="LONG" ? (last - (p.avgPx||last))*szAbs*ct : ((p.avgPx||last) - last)*szAbs*ct);
      totalValue += notional;
      totalMargin += margin;
      unreal += upl;
      return {
        symbol: p.instId,
        side: (p.posSide||"").toUpperCase()==="LONG" ? "LONG" : "SHORT",
        leverage: lev,
        entryPrice: p.avgPx || 0,
        margin: margin,
        entryTime: Date.now(),
        unrealizedPnl: upl
      };
    });

    const ds = DEALS && Array.isArray(DEALS.recent) ? DEALS.recent : [];
    const nowMs = Date.now();
    const last24 = ds.filter(d => (nowMs - Number(d.time||0)) <= 86400000);
    const dailyTrades = last24.length;
    const dailyPnL = last24.reduce((a,d)=> a + num(d.profit||d.pnl||0), 0);
    const dailyVolume = last24.reduce((a,d)=> a + num( (d.notional!=null) ? d.notional : ( (d.margin||0) * (d.leverage||DEFAULT_LEVERAGE||20) ) ), 0);
    const wins = last24.filter(d => num(d.profit||d.pnl||0) > 0).length;
    const winrate = dailyTrades ? (wins*100/dailyTrades) : 0;

    const data = {
      spot:    { total: 0 },
      futures: {
        total: Number(port.balances?.totalEq || 0),
        available: Number((port.balances?.details||[]).find(d=>String(d.ccy).toUpperCase()==="USDT")?.availBal || 0),
        unrealizedPnL: unreal
      },
      positions: {
        count: Array.isArray(port.positions) ? port.positions.length : 0,
        totalValue: totalValue,
        totalMargin: totalMargin
      },
      performance: {
        winrate, dailyPnL, totalTrades: ds.length, dailyTrades, dailyVolume
      },
      openPositionsDetails: posDetails,
      dealsRecent: ds.slice(0,150),
      history: { spot: HISTORY && HISTORY.spot ? HISTORY.spot.slice(-600) : [] },
      lastUpdate: port.ts
    };
    return { ok:true, success:true, data, ts: port.ts };
  }catch(e){
    return { ok:false, success:false, data:null, error:String(e.message||e), ts: tsISO() };
  }
});

ipcMain.handle("toggle-ai", async (_e, desired) => {
  log("[UI] toggle-ai requested | mode:", UI_RUNTIME_MODE);
  if (isViewerMode()) return { ok:false, success:false, error:"VIEW_ONLY" };
  try{
    const prev = !!AI.on;
    const next = (typeof desired === "boolean") ? desired : !prev;
    AI.on = next;

    setHealth("aiEngine", { on:AI.on, info: AI.on ? "on" : "off", lastToggle:Date.now() });
    logAIEvent({ event:"AI_TOGGLE", on:AI.on, live:true });

    return {
      ok:true, success:true,
      active: !!AI.on,
      mode: AI.mode,
      equityUSDT: AI.equityUSDT,
      tier: AI.tier,
      pending: AI.pendingSignals.length,
      ts: tsISO(),
      logs: []
    };
  }catch(e){
    return { ok:false, success:false, error:String(e.message||e) };
  }
});

ipcMain.handle("place-order", async (_e, opt={}) => {
  log("[UI] place-order requested | mode:", UI_RUNTIME_MODE);
  if (isViewerMode()) return { ok:false, success:false, error:"VIEW_ONLY" };
  try{
    if (!OKX.KEY || !OKX.SECRET || !OKX.PASS) return { ok:false, success:false, error:"NO_OKX_CREDS" };
    if (!AI.on) return { ok:false, success:false, error:"AI_OFF" };
    const instId = String(opt.instId||"BTC-USDT-SWAP");
    const side   = (opt.side==='long' || opt.side==='short') ? opt.side : 'long';
    const res = await placeMarket(instId, side);
    return { ok:!!res.ok, success:!!res.ok, res, ts:tsISO() };
  }catch(e){
    return { ok:false, success:false, error:String(e.message||e) };
  }
});

/* === Health / Snapshot IPC === */
ipcMain.handle("get-health", async () => ({ ok:true, health: HEALTH, ts: tsISO() }));
ipcMain.handle("debug-snapshot", async () => {
  try {
    return {
      ok:true,
      ai: { ...AI, openPositions: Object.keys(AI.openPositions).length },
      universe: MARKET.universe?.length || 0,
      ticks: Object.keys(MARKET.tick).length,
      ws: { pub: !!MARKET.wsPublic, pri: !!MARKET.wsPrivate, authed: MARKET.privateAuthed },
      health: HEALTH,
      ts: tsISO()
    };
  } catch (e) {
    return { ok:false, error:String(e.message||e), ts:tsISO() };
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

/* ===== ELECTRON BOOT ===== */
async function createWindow() {
  try {
    MARKET.universe = await loadUniverse();
    await loadMetaInstruments();
    await loadTradeFees();

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
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
        preload: fs.existsSync(PRELOAD_FILE) ? PRELOAD_FILE : undefined,
      },
    });

    if (loadTarget.type === "file")      await win.loadFile(loadTarget.value);
    else if (loadTarget.type === "url")  await win.loadURL(loadTarget.value);
    else throw new Error("Aucune source UI disponible (index.html introuvable et dev server injoignable).");

    // DevTools shortcuts
    try {
      win.webContents.on('before-input-event', (event, input) => {
        const ctrlOrCmd = input.control || input.meta;
        if (ctrlOrCmd && input.shift && input.key?.toUpperCase() === 'I') { win.webContents.openDevTools({ mode:'detach' }); event.preventDefault(); }
        if (input.key === 'F12') { win.webContents.openDevTools({ mode:'detach' }); event.preventDefault(); }
        if (ctrlOrCmd && input.key?.toUpperCase() === 'R') { win.webContents.reload(); event.preventDefault(); }
      });
      if (String(process.env.HERMES_DEVTOOLS||"0")==="1") win.webContents.openDevTools({ mode:'detach' });
    } catch {}

    win.webContents.once("did-finish-load", async () => {
      const url = win.webContents.getURL();
      UI_RUNTIME_MODE = computeUIModeFromURL(url);
      log("[UI] did-finish-load →", url, "→ mode:", UI_RUNTIME_MODE);
      prefill5m().catch(()=>{});
    });
    win.webContents.on("did-fail-load", (_e, code, desc) => log("[WEB] did-fail-load:", code, desc));
    win.webContents.on("render-process-gone", (_e, details) => log("[WEB] render-process-gone:", JSON.stringify(details)));
    win.on("unresponsive", () => log("[WEB] BrowserWindow unresponsive"));

    // Services
    startPublicWS();
    startPrivateWS();   // si clés → login + subscribe
    portfolioLoop();    // portfolio + pending consumer
    healthWatchdog();   // superviseur

  } catch (e) {
    log("createWindow failed:", e.message);
  }
}

/* ===== STOP / SHUTDOWN ===== */
function stopAll() {
  RUNNING = false;
  try { if (MARKET.wsPublic)  { MARKET.wsPublic.terminate();  log("[STOP] WS Public fermé"); } } catch {}
  try { if (MARKET.wsPrivate) { MARKET.wsPrivate.terminate(); log("[STOP] WS Privé fermé"); } } catch {}
  try { AI.on = false; log("[STOP] IA désactivée"); } catch {}
}

app.whenReady().then(() => {
  log("[BOOT] === whenReady ===");
  createWindow();

  try {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.openDevTools({ mode:'detach' });
    });
    globalShortcut.register('F12', () => {
      const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.openDevTools({ mode:'detach' });
    });
    globalShortcut.register('CommandOrControl+R', () => {
      const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.reload();
    });
  } catch {}

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch {} });
app.on("window-all-closed", () => { stopAll(); if (process.platform !== "darwin") app.quit(); });
process.on("uncaughtException", (e)=>log("[UNCAUGHT]", e.stack||e.message));
process.on("unhandledRejection", (e)=>log("[UNHANDLED]", e&&e.stack||String(e)));
/* === HERMES PATCH V4.4+ Policy & Risk/Stops Overrides (auto) === */
/* ... (bloc patch complet que je t’ai envoyé) ... */

