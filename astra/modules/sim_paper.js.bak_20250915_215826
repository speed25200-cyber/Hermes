"use strict";
const fs = require("fs");
const path = require("path");

let cfg = {
  dataDir: "",
  getCtVal: () => 1,
  qtyFromUSDT: () => 0,
  getPerTradeUSDT: () => 50,
  broadcast: () => {},
  tsISO: () => new Date().toISOString(),
  log: () => {},
  takeProfitPct: Math.max(0, Number(process.env.HERMES_TP_PCT || 0.20)),
  stopLossPct : Math.max(0, Number(process.env.HERMES_SL_PCT || 0.10)),
  takerFee    : Math.max(0, Number(process.env.HERMES_TAKER_FEE || 0.0005)),
  minNotional : Math.max(0, Number(process.env.HERMES_MIN_NOTIONAL || 5)),
  simLeverage : Number(process.env.HERMES_SIM_LEVERAGE || 20)
};

function ensureDir(p){ try{ fs.mkdirSync(p,{recursive:true}); }catch(e){} }
function ymd(ts){ const d=new Date(ts||Date.now()); const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,"0"); const dd=String(d.getDate()).padStart(2,"0"); return y+""+m+""+dd; }
function dealsFileFor(ts){ return path.join(cfg.dataDir,"trades-logs","sim_deals_"+ymd(ts)+".jsonl"); }
function appendLine(file,obj){ ensureDir(path.dirname(file)); fs.appendFileSync(file, JSON.stringify(obj)+"\n"); }
function num(x){ const n=Number(x); return Number.isFinite(n)?n:undefined; }

const state = new Map(); // instId -> { side, entry, qty, entryScore, entryFeatures }

function openTrade(instId, dir, px, score, features, nowTs){
  const perTrade = Number(process.env.HERMES_SIM_PER_TRADE_USDT || 20);
  const lev = Number(process.env.HERMES_SIM_LEVERAGE || cfg.simLeverage || 20);
  const target = perTrade * lev;

  const ct = Number((typeof cfg.getCtVal==="function" ? cfg.getCtVal(instId) : 0) || 0);
  let qty = 0;
  if (ct > 0 && px > 0) qty = target / (ct * px);
  else if (px > 0)      qty = target / px;
  else                  qty = Number((typeof cfg.qtyFromUSDT==="function" ? cfg.qtyFromUSDT(instId, perTrade) : 0) || 0);

  qty = Math.max(qty, 0.0001);

  if (ct > 0 && px > 0 && cfg.minNotional > 0){
    const notion = px * qty * ct;
    if (notion < cfg.minNotional) qty = cfg.minNotional / (px * ct);
  }

  let st = state.get(instId);
  if (!st){ st = { side:null, entry:0, qty:0, entryScore:null, entryFeatures:null }; state.set(instId, st); }

  st.side = dir;
  st.entry = px;
  st.qty = qty;
  st.entryScore = num(score) !== undefined ? num(score) : null;

  let fEn = {};
  if (features && typeof features==="object"){
    for (const k in features){ const v=num(features[k]); if (v!==undefined) fEn[k]=v; }
  }
  if (st.entryScore !== null) fEn.score = st.entryScore;
  st.entryFeatures = fEn;

  const rec = { ts: nowTs || cfg.tsISO(), event:"SIM_TRADE_ENTER", instId, side:dir, entry:px, qty:qty, score: st.entryScore, features: st.entryFeatures };
  appendLine(dealsFileFor(rec.ts), rec);
  return rec;
}

function closeTrade(instId, px, reason, nowTs){
  const st = state.get(instId); if (!st || !st.side) return null;
  const ct = Number((typeof cfg.getCtVal==="function" ? cfg.getCtVal(instId) : 1) || 1);
  const pnl = (st.side==="long") ? (px - st.entry) * st.qty * ct : (st.entry - px) * st.qty * ct;
  const fees = (st.entry + px) * st.qty * ct * cfg.takerFee;
  const pnlNet = pnl - fees;

  const rec = { ts: nowTs || cfg.tsISO(), event:"SIM_TRADE_EXIT", instId, side: st.side, entry: st.entry, exit: px, qty: st.qty, pnl: pnlNet, reason: reason, entryScore: st.entryScore, entryFeatures: st.entryFeatures };
  appendLine(dealsFileFor(rec.ts), rec);
  try{ if (cfg && typeof cfg.broadcast==="function") cfg.broadcast(rec); }catch(e){}

  st.side = null; st.entry = 0; st.qty = 0; st.entryScore = null; st.entryFeatures = null;
  return rec;
}

function onSimSignal(line){
  try{
    const instId = line.instId || line.symbol;
    const d = String(line.dir || line.side || "").toLowerCase();
    const px = Number(line.px || line.price || 0);
    const ts = line.ts || cfg.tsISO();
    if (!instId || !px || (d!=="long" && d!=="short")) return;

    let st = state.get(instId);
    if (!st){ st = { side:null, entry:0, qty:0, entryScore:null, entryFeatures:null }; state.set(instId, st); }

    const s = num(("score" in line) ? line.score : undefined);
    let f = (line.features && typeof line.features==="object") ? line.features : {};
    let fEn = {};
    for (const k in f){ const v=num(f[k]); if (v!==undefined) fEn[k]=v; }
    if (num(line.ml)    !== undefined) fEn.ml     = num(line.ml);
    if (num(line.rule)  !== undefined) fEn.rule   = num(line.rule);
    if (num(line.atrPct)!== undefined) fEn.atrPct = num(line.atrPct);
    if (s !== undefined) fEn.score = s;

    if (!st.side){ openTrade(instId, d, px, s, fEn, ts); return; }

    const rise = (st.side==="long") ? ((px - st.entry) / st.entry) : ((st.entry - px) / st.entry);
    if (rise >= cfg.takeProfitPct){ closeTrade(instId, px, "TP_"+Math.round(cfg.takeProfitPct*100), ts); openTrade(instId, d, px, s, fEn, ts); return; }

    const draw = (st.side==="long") ? ((px - st.entry) / st.entry) : ((st.entry - px) / st.entry);
    if (draw <= -cfg.stopLossPct){ closeTrade(instId, px, "SL_"+Math.round(cfg.stopLossPct*100), ts); openTrade(instId, d, px, s, fEn, ts); return; }

    if (st.side !== d){ closeTrade(instId, px, "FLIP", ts); openTrade(instId, d, px, s, fEn, ts); return; }
  }catch(e){ try{ cfg.log("[SIM_PAPER:onSimSignal]", e.message) }catch(_){} }
}

function readRecentSimDeals(windowMs){
  const now = Date.now(), cutoff = now - windowMs;
  const dir = path.join(cfg.dataDir,"trades-logs");
  if (!fs.existsSync(dir)) return {trades:0,pnl:0};
  const files = fs.readdirSync(dir).filter(f=>/^sim_deals_\d{8}\.jsonl$/.test(f)).sort().slice(-3).map(f=>path.join(dir,f));
  let trades=0, pnl=0;
  for (const f of files){
    const raw = fs.readFileSync(f,"utf8"); if(!raw) continue;
    const lines = raw.trim().split("\n");
    for (const ln of lines){
      try{
        const o = JSON.parse(ln);
        if (o.event!=="SIM_TRADE_EXIT") continue;
        const t = +new Date(o.ts||0); if (!t || t < cutoff) continue;
        trades += 1; pnl += Number(o.pnl||0);
      }catch(_){}
    }
  }
  return {trades,pnl};
}

function startSummaryLoop(everyMs, windowMs){
  const every = Number(process.env.HERMES_SIM_SUMMARY_EVERY_MS || everyMs || 180000);
  const win   = Number(process.env.HERMES_SIM_SUMMARY_WINDOW_MS || windowMs || 3600000);
  setInterval(()=>{
    try{
      const s = readRecentSimDeals(win);
      const line = { ts: cfg.tsISO(), event:"SIM_SUMMARY", trades: s.trades, pnl: s.pnl, live:false };
      try{ if (cfg && typeof cfg.broadcast==="function") cfg.broadcast(line); }catch(_){}
      appendLine(path.join(cfg.dataDir,"sim-summary.jsonl"), line);
    }catch(e){ try{ cfg.log("[SIM_PAPER:summary]", e.message) }catch(_){}} 
  }, every);
}

function initSimPaper(options){
  cfg = { ...cfg, ...options };
  ensureDir(path.join(cfg.dataDir,"trades-logs"));
}

module.exports = { initSimPaper, onSimSignal, startSummaryLoop, readRecentSimDeals, openTrade, closeTrade };

