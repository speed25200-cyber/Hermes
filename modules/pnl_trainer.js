"use strict";
const fs = require("fs");
const path = require("path");

function isNum(x){ return typeof x==="number" && Number.isFinite(x); }
function pearson(x,y){
  const n = x.length; if(n<2) return 0;
  let sx=0,sy=0,sxx=0,syy=0,sxy=0, m=n;
  for(let i=0;i<n;i++){
    const xi=x[i], yi=y[i];
    if(!isNum(xi)||!isNum(yi)){ m--; continue; }
    sx+=xi; sy+=yi; sxx+=xi*xi; syy+=yi*yi; sxy+=xi*yi;
  }
  if(m<2) return 0;
  const mx=sx/m, my=sy/m;
  const cov = sxy/m - mx*my;
  const vx  = sxx/m - mx*mx;
  const vy  = syy/m - my*my;
  if(vx<=0 || vy<=0) return 0;
  return cov / Math.sqrt(vx*vy);
}

function loadSimDeals(dataDir, windowMs){
  const now=Date.now(), cutoff=now-windowMs;
  const dir = path.join(dataDir,"trades-logs");
  const out=[];
  if(!fs.existsSync(dir)) return out;
  const files = fs.readdirSync(dir).filter(f=>/^sim_deals_\d{8}\.jsonl$/.test(f)).sort().slice(-3);
  for(const f of files){
    const raw = fs.readFileSync(path.join(dir,f),"utf8"); if(!raw) continue;
    for(const ln of raw.trim().split("\n")){
      try{
        const o = JSON.parse(ln);
        if(o.event!=="SIM_TRADE_EXIT") continue;
        const t = +new Date(o.ts||0); if(!t || t<cutoff) continue;
        out.push(o);
      }catch{}
    }
  }
  return out;
}

function trainOnPNL({dataDir, modelPath, log=()=>{}}){
  try{
    const windowMs = Number(process.env.HERMES_PNL_WINDOW_MS || 48*3600*1000); // 48h
    const deals = loadSimDeals(dataDir, windowMs);
    if(deals.length < 10){ log("[PNL_TRAIN] not enough sim deals:", deals.length); return {updated:false, samples:deals.length}; }

    let alpha={}; try{ alpha = JSON.parse(fs.readFileSync(modelPath,"utf8")); }catch{}
    const Y = deals.map(d=>Number(d.pnl||0)).filter(isNum);
    const n = Y.length; const mean = Y.reduce((a,b)=>a+b,0)/n;
    const std  = Math.sqrt(Y.reduce((a,b)=>a+(b-mean)*(b-mean),0)/Math.max(1,n-1));

    // Collecter features numériques (à l'entrée du trade de simu)
    const keysSet = new Set();
    for(const d of deals){
      const f = d.entryFeatures || d.features || {};
      for(const k in f){ if(isNum(f[k])) keysSet.add(k); }
    }
    const keys = Array.from(keysSet);
    const corr = {};
    for(const k of keys){
      const X=[]; const YY=[];
      for(const d of deals){
        const f = d.entryFeatures || d.features || {};
        if(isNum(f[k]) && isNum(d.pnl)){ X.push(f[k]); YY.push(d.pnl); }
      }
      if(X.length>=10) corr[k] = +pearson(X,YY).toFixed(4);
    }

    // Petit "nudging" de weights dans alpha.weights en fonction des corrélations
    const lr = Number(process.env.HERMES_PNL_LR || 0.02);
    alpha.weights = alpha.weights || {};
    for(const k in corr){
      const w0 = Number(alpha.weights[k]||0);
      const w1 = Math.max(-5, Math.min(5, w0 + lr*corr[k]));
      alpha.weights[k] = +(+w1).toFixed(4);
    }

    alpha.pnlTraining = {
      ts: new Date().toISOString(),
      windowHours: Math.round(windowMs/3600000),
      samples: n,
      mean: +mean.toFixed(6),
      std: +std.toFixed(6),
      corr
    };

    fs.writeFileSync(modelPath, JSON.stringify(alpha,null,2));
    log("[PNL_TRAIN] updated", modelPath, "samples", n);
    return {updated:true, samples:n};
  }catch(e){
    try{ log("[PNL_TRAIN:ERR]", e.message); }catch{}
    return {updated:false, error:e.message};
  }
}

function startPNLTrainerLoop(opts){
  const dataDir = opts.dataDir;
  const modelPath = opts.modelPath;
  const log = opts.log || (()=>{});
  const everyMs = Number(process.env.HERMES_PNL_TRAIN_EVERY_MS || 600000); // 10 min
  setInterval(()=>{ trainOnPNL({dataDir, modelPath, log}); }, everyMs);
  setTimeout(()=>{ trainOnPNL({dataDir, modelPath, log}); }, 5000); // warmup
}

module.exports = { trainOnPNL, startPNLTrainerLoop };
