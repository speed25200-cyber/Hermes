"use strict";
const fs = require("fs");
const path = require("path");

let cfg = { dataDir:"", startEq:400, tsISO: ()=> new Date().toISOString(), log: ()=>{} };
let state = { equity:0, realized:0, start:0, updatedAt:null };
let paths = {};

function ensureDir(p){ try{ fs.mkdirSync(p, { recursive:true }); } catch(_e){} }

function initSimEquity(opts={}){
  cfg = Object.assign({}, cfg, opts||{});
  paths.account   = path.join(cfg.dataDir, "sim-account.json");
  paths.equityLog = path.join(cfg.dataDir, "sim-equity.jsonl");
  ensureDir(path.dirname(paths.account));
  try{
    const s = JSON.parse(fs.readFileSync(paths.account,"utf8"));
    state = Object.assign({}, state, s||{});
    if (!Number.isFinite(state.start))    state.start    = Number(cfg.startEq)||400;
    if (!Number.isFinite(state.equity))   state.equity   = state.start;
    if (!Number.isFinite(state.realized)) state.realized = 0;
  }catch(_e){
    state.start   = Number(cfg.startEq)||400;
    state.equity  = state.start;
    state.realized= 0;
    save();
  }
  appendEquity(null); // assure une 1ère ligne dans sim-equity.jsonl
}

function save(){
  state.updatedAt = cfg.tsISO();
  // écriture atomique pour éviter artifacts "}}..."
  const tmp = paths.account + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state,null,2));
  fs.renameSync(tmp, paths.account);
}

function appendEquity(o){
  const line = {
    ts: cfg.tsISO(),
    equity: +Number(state.equity).toFixed(8),
    realized: +Number(state.realized).toFixed(8),
    trade: o ? { instId: o.instId, pnl: +Number(o.pnl||0).toFixed(8) } : null
  };
  fs.appendFileSync(paths.equityLog, JSON.stringify(line)+"\n");
}

function onTradeExit(o){
  const pnl = Number(o && o.pnl || 0);
  state.realized += pnl;
  state.equity   += pnl;
  save();
  appendEquity(o||null);
}

function _pair(instId){
  const m = String(instId||"").match(/^([A-Z0-9\-]+)-([A-Z]+)-/i);
  return m ? `${m[1]}/${m[2]}` : String(instId||"");
}

function makeInfo(summary){
  const t = Number(summary && summary.trades || 0);
  const p = Number(summary && summary.pnl    || 0);
  const sgn = (p>=0?"+":"");
  return `[AI-SIM] Trades (3m) ${t} | PnL : ${sgn}${Math.abs(p).toFixed(2)} USDT | Equity : ${state.equity.toFixed(2)} USDT`;
}

function makeExitInfo(o){
  const p  = Number(o && o.pnl || 0);
  const sgn= (p>=0?"+":"");
  const pair = _pair(o && o.instId);
  return `[AI-SIM] Exit ${pair} | PnL ${sgn}${Math.abs(p).toFixed(2)} | Total : ${state.realized.toFixed(2)} USDT`;
}

module.exports = { initSimEquity, onTradeExit, makeInfo, makeExitInfo, state, paths };
