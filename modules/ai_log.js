"use strict";
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const ORIG = {
  log:  console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error:console.error.bind(console),
};

const bus = new EventEmitter();
const LOG_DIR  = path.join(process.cwd(), "runtime");
const LOG_FILE = path.join(LOG_DIR, "logs_ai.log");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const DEDUP_MS   = Number(process.env.AI_LOG_DEDUP_MS || 5000);      // 5s
const DROP_EMPTY = String(process.env.AI_LOG_DROP_EMPTY_INFO || "1")==="1";

const seen = new Map();
const now = ()=>Date.now();
const iso = ()=>new Date().toISOString();

/* Unifier le texte : msg || info || "" */
function textOf(e){ return ((e && (e.msg!=null ? e.msg : e.info!=null ? e.info : "")) + "").trim(); }

function keyOf(e){
  return [
    // canal est recalculé dans publish, ici seule la nature du message compte
    e.level||"info",             // info|warn|error
    e.area||"",                  // sous-zone
    e.code||"",
    textOf(e)
  ].join("|");
}
function shouldDrop(e){
  const txt = textOf(e);
  if (DROP_EMPTY && (e.level||"info")==="info" && !txt) return true;
  const k = keyOf(e), t = seen.get(k), n = now();
  if (t && (n - t) < DEDUP_MS) return true;
  seen.set(k, n);
  return false;
}

function formatUSD(v){
  const n = Number(v||0);
  const s = (Math.abs(n)>=100 ? n.toFixed(0) : Math.abs(n)>=1 ? n.toFixed(2) : n.toFixed(4));
  return `${s} USDT`;
}

function publish(entry){
  try{
    if (!entry || typeof entry!=="object") return;
    const txt = textOf(entry);               // ← unifie info/msg
    if (shouldDrop(entry)) return;

    // Canal :
    //  - INFO → canal "INFO"
    //  - sinon : AI-SIM / AI-LIVE si area explicite, ou selon OKX_SIMULATED
    let chan = "INFO";
    if ((entry.event||"").toUpperCase()!=="INFO" && (entry.area!=="INFO")) {
      if (entry.chan==="AI-SIM" || entry.area==="AI-SIM") chan = "AI-SIM";
      else if (entry.chan==="AI-LIVE" || entry.area==="AI-LIVE") chan = "AI-LIVE";
      else chan = (String(process.env.OKX_SIMULATED||"0")==="1" ? "AI-SIM" : "AI-LIVE");
    }

    // Construire la ligne affichée côté terminal
    const parts = [`[${chan}] [INFO]`];
    if (entry.area && entry.area!=="AI-SIM" && entry.area!=="AI-LIVE" && entry.area!=="INFO") parts.push(`[${entry.area}]`);
    if (entry.code)  parts.push(`[${entry.code}]`);
    if (entry.level && entry.level!=="info") parts.push(`[${String(entry.level).toUpperCase()}]`);
    if (txt) parts.push(txt);

    const line = parts.join(" ");

    // terminal (ORIG pour éviter re-capture)
    if ((entry.level||"info")==="error") ORIG.error(line);
    else if ((entry.level||"info")==="warn") ORIG.warn(line);
    else ORIG.log(line);

    // fichier
    const ts = entry.ts || iso();
    try { fs.appendFileSync(LOG_FILE, `[${ts}] ${line}\n`); } catch(_){}

    // vers UI : on renvoie l'objet enrichi avec msg rempli et chan explicite
    const out = { ...entry, ts, msg: txt, chan };
    bus.emit("log", out);
  }catch(_){}
}

function base(level, area, msg, code, data, chan){
  const e = {
    id: Math.random().toString(36).slice(2,10)+Date.now().toString(36),
    ts: iso(), level, area, msg, code, data: data||null, chan
  };
  publish(e);
  return e;
}

function info(area,msg,data,chan){ return base("info", area, msg, undefined, data, chan); }
function warn(area,msg,codeOrData,data,chan){
  const code = (typeof codeOrData==="string"||typeof codeOrData==="number")? String(codeOrData):undefined;
  const d    = (code? data: codeOrData)||null;
  return base("warn", area, msg, code, d, chan);
}
function error(area,msg,codeOrData,data,chan){
  const code = (typeof codeOrData==="string"||typeof codeOrData==="number")? String(codeOrData):undefined;
  const d    = (code? data: codeOrData)||null;
  return base("error", area, msg, code, d, chan);
}

/* ---------- Capture console -> [INFO] (dédoublonné) ---------- */
function setupConsoleCapture(){
  if (global.__AI_CONSOLE_CAPTURE__) return;
  global.__AI_CONSOLE_CAPTURE__ = true;
  const orig = { ...ORIG };
  console.log  = (...a)=>{ try{ info("INFO", a.join(" ")); }catch(_){} orig.log(...a); };
  console.info = (...a)=>{ try{ info("INFO", a.join(" ")); }catch(_){} orig.info(...a); };
  console.warn = (...a)=>{ try{ warn("INFO", a.join(" ")); }catch(_){} orig.warn(...a); };
  console.error= (...a)=>{ try{ error("INFO", a.join(" ")); }catch(_){} orig.error(...a); };
}

/* ---------- SIM summary (3 min) + API d intégration ---------- */
const simStats = { trades:0, pnl:0, balance:0 };
let   simProvider = null;
let   simTimer = null;

function setSimSnapshotProvider(fn){ simProvider = fn; }
function simEntry(symbol){ info("AI-SIM", `Entrée | ${symbol}`, null, "AI-SIM"); simStats.trades++; }
function simExit(symbol, pnlUSDT){ info("AI-SIM", `Sortie | ${symbol}`, null, "AI-SIM"); if (typeof pnlUSDT==="number") simStats.pnl += pnlUSDT; simStats.trades++; }

function startSimSummary(ms){
  const period = Number(ms || process.env.AI_SIM_SUMMARY_MS || 180000); // 3 min
  if (global.__AI_SIM_SUMMARY__) return;
  global.__AI_SIM_SUMMARY__ = true;
  simTimer = setInterval(()=>{
    let trades = simStats.trades, pnl = simStats.pnl, bal = simStats.balance;
    if (typeof simProvider === "function"){
      try{
        const s = simProvider() || {};
        if (typeof s.tradesCount === "number") trades = s.tradesCount;
        if (typeof s.pnlUSDT     === "number") pnl    = s.pnlUSDT;
        if (typeof s.balanceUSDT === "number") bal    = s.balanceUSDT;
      }catch(_){}
    }
    info("AI-SIM", `${trades} trades | pnl : ${formatUSD(pnl)} | solde : ${formatUSD(bal)}`, null, "AI-SIM");
  }, period);
}

/* ---------- Helpers LIVE minimalistes ---------- */
function liveEntry(instId){ info("AI-LIVE", `Entrée | ${instId}`, null, "AI-LIVE"); }
function liveExit (instId){ info("AI-LIVE", `Sortie | ${instId}`, null, "AI-LIVE"); }

module.exports = {
  bus, info, warn, error, setupConsoleCapture,
  setSimSnapshotProvider, simEntry, simExit, startSimSummary,
  liveEntry, liveExit
};
