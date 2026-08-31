const fs=require("fs"), path=require("path");
const file=path.resolve("main.js");
let s=fs.readFileSync(file,"utf8");
const orig=s;

// --- petites répares de casse précédente ---
s=s.replace(/\$1100/g,"100");
s=s.replace(/^\s*100\s*,\s*(\/\/.*)$/m,"  UNIVERSE_COUNT: 100, $1");
s=s.replace(/^\s*100\s*,\s*$/m,"  UNIVERSE_COUNT: 100,");

// --- UNIVERSE_COUNT=100 + lock risque juste après dotenv ---
if(!/const\s+UNIVERSE_COUNT\s*=\s*100\s*;/.test(s)){
  s=s.replace(/require\("dotenv"\)\.config\(\);\s*/, 
    'require("dotenv").config();\n'
  + 'const UNIVERSE_COUNT = 100;\n\n'
  + '/* --- Risk lock: empêche l\\'IA de modifier l\\'exposition --- */\n'
  + 'const RISK_LOCK = { marginUSDT:20, leverage:20, maxOpen:10, maxCapitalFrac:0.5 };\n'
  + 'function applyRiskLock(target){ try{ if(!target) return; \n'
  + '  if(typeof target.marginUSDT!=="number")     target.marginUSDT=RISK_LOCK.marginUSDT;\n'
  + '  if(typeof target.leverage!=="number")       target.leverage   =RISK_LOCK.leverage;\n'
  + '  if(typeof target.maxOpen!=="number")        target.maxOpen    =RISK_LOCK.maxOpen;\n'
  + '  if(typeof target.maxCapitalFrac!=="number") target.maxCapitalFrac=RISK_LOCK.maxCapitalFrac;\n'
  + '  ["marginUSDT","leverage","maxOpen","maxCapitalFrac"].forEach(k=>{\n'
  + '    try{ Object.defineProperty(target,k,{writable:false, configurable:false}); }catch{}\n'
  + '  });\n'
  + '}catch{} }\n'
  + '/* -------------------------------------------------------- */\n'
  );
}
// uniformise l'usage
s=s.replace(/\bCONFIG\.UNIVERSE_COUNT\b/g,"UNIVERSE_COUNT");

// --- FEED.c1m (cache 1m) ---
s=s.replace(/const\s+FEED\s*=\s*new\s+MarketFeed\s*\(\s*\)\s*;/,
  m=> m + '\ntry{ FEED.c1m = FEED.c1m || new Map(); }catch{}'
);

// --- helper log rate si absent ---
if(!/function\s+addAiLogRate\s*\(/.test(s)){
  s=s.replace(/\/\/\s*----------\s*Portfolio\s*----------/,
`/* ===== helpers logs ===== */
if (typeof globalThis.__rateLog === "undefined") globalThis.__rateLog = {};
function addAiLogRate(key,msg,ttlMs){
  try{
    if(typeof addAiLog!=="function") return;
    const now=Date.now(), last=globalThis.__rateLog[key]||0;
    if(now-last>=(ttlMs||150000)){ addAiLog(msg); globalThis.__rateLog[key]=now; }
  }catch{}
}
function fmtUsd(n){ n=Number(n||0); const a=Math.abs(n);
  if(a>=1e6) return (n/1e6).toFixed(2)+'M';
  if(a>=1e3) return (n/1e3).toFixed(2)+'K';
  return n.toFixed(2);
}
/* ======================== */
\n// ---------- Portfolio ----------`);
}

// --- getLastPriceForInstId: préférer 1m puis 5m ---
if(/function\s+getLastPriceForInstId\s*\(/.test(s)){
  s=s.replace(/function\s+getLastPriceForInstId\s*\([\s\S]*?\}\s*\n/,
`function getLastPriceForInstId(instId){
  try{
    if(globalThis.FEED && typeof FEED.lastPrice==="function"){
      const p=FEED.lastPrice(instId); if(isFinite(p)&&p>0) return p;
    }
    if(globalThis.FEED && FEED.c1m && FEED.c1m.has(instId)){
      const a=FEED.c1m.get(instId);
      if(Array.isArray(a)&&a.length){
        const x=a[a.length-1];
        if(isFinite(x.c)&&x.c>0 && (Date.now()-x.ts)<90000) return x.c;
      }
    }
    if(globalThis.FEED && FEED.c5m && FEED.c5m.has(instId)){
      const b=FEED.c5m.get(instId);
      if(Array.isArray(b)&&b.length){
        const y=b[b.length-1]; if(isFinite(y.c)&&y.c>0) return y.c;
      }
    }
  }catch{}
  return NaN;
}
`);
} else {
  s=s.replace(/\/\/\s*----------\s*Portfolio\s*----------/,
`function getLastPriceForInstId(instId){
  try{
    if(globalThis.FEED && typeof FEED.lastPrice==="function"){
      const p=FEED.lastPrice(instId); if(isFinite(p)&&p>0) return p;
    }
    if(globalThis.FEED && FEED.c1m && FEED.c1m.has(instId)){
      const a=FEED.c1m.get(instId);
      if(Array.isArray(a)&&a.length){
        const x=a[a.length-1];
        if(isFinite(x.c)&&x.c>0 && (Date.now()-x.ts)<90000) return x.c;
      }
    }
    if(globalThis.FEED && FEED.c5m && FEED.c5m.has(instId)){
      const b=FEED.c5m.get(instId);
      if(Array.isArray(b)&&b.length){
        const y=b[b.length-1]; if(isFinite(y.c)&&y>0) return y.c;
      }
    }
  }catch{}
  return NaN;
}
\n// ---------- Portfolio ----------`);
}

// --- Refresh candles 1m (OKX) ---
if(!/function\s+refreshCandles1m\s*\(/.test(s)){
  s += `
/* ---- Candles 1m refresh (OKX) ---- */
async function refreshCandles1m(limitPerInst=200, concurrency=5){
  try{
    const ids = Array.from(new Set((globalThis.FEED?.instIds)||[]));
    if(!ids.length){ try{ addAiLogRate("candles1m","[CANDLES1M] refresh: 0 id",60000);}catch{}; return; }
    let updated=0, skipped=0, errors=0;
    for(let i=0;i<ids.length;i+=concurrency){
      const group=ids.slice(i,i+concurrency);
      await Promise.all(group.map(async(instId)=>{
        try{
          const cur=(globalThis.FEED?.c1m?.get(instId))||[];
          const fresh = Array.isArray(cur)&&cur.length&&(Date.now()-cur[cur.length-1].ts)<90000;
          if(fresh){ skipped++; return; }
          const r = await okxGET("/api/v5/market/candles", { instId, bar:"1m", limit: limitPerInst });
          const arr = (r.data?.data||[])
            .map(k=>({ ts:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], vol:+k[5] }))
            .sort((a,b)=>a.ts-b.ts);
          if(arr.length){
            FEED.c1m = FEED.c1m || new Map();
            FEED.c1m.set(instId, arr);
            updated++;
          } else { skipped++; }
        }catch(e){ errors++; }
      }));
      await new Promise(res=>setTimeout(res,120));
    }
    try{ addAiLogRate("candles1m","[CANDLES1M] refresh updated="+updated+" skipped="+skipped+" errors="+errors,60000);}catch{}
  }catch(e){
    try{ addAiLogRate("candles1m_err","[CANDLES1M] error: "+(e?.message||e),60000);}catch{}
  }
}
/* ----------------------------------- */
`;
}

// --- Planifie le refresh 1m au boot ---
s=s.replace(/app\.whenReady\(\)\.then\(\(\)\s*=>\s*\{\s*ensureDataDir\(\);\s*createWindow\(\);\s*\}\);/,
  'app.whenReady().then(()=>{ ensureDataDir(); createWindow(); try{ setTimeout(()=>refreshCandles1m(200,5),5000); setInterval(()=>refreshCandles1m(200,5),60000);}catch{} });'
);

// --- Bloque toute modif de risque par code ---
s=s.replace(/\b(ENGINE|SIM)\.cfg\.(marginUSDT|maxOpen|leverage|maxCapitalFrac)\s*=\s*[^;]+;/g,'/* blocked: risk change attempt */');

// --- Applique lock risque après création SIM + périodique ---
s=s.replace(/const\s+SIM\s*=\s*new\s+Simulator\s*\(\s*\)\s*;/,
  'const SIM = new Simulator();\ntry{ applyRiskLock(SIM.cfg); }catch{}\nsetInterval(()=>{ try{ applyRiskLock(SIM?.cfg); applyRiskLock(ENGINE?.cfg); }catch{} }, 10000);'
);

// --- Supprime tout TIMEOUT en simulation & maxHoldSec -> Infinity (si existe) ---
s=s.replace(/if\s*\(\s*reason===null\s*\)\s*\{\s*const\s+heldSec[\s\S]*?reason\s*=\s*"TIMEOUT"\s*;\s*\}/g,'/* no timeout in simulation */');
s=s.replace(/this\.maxHoldSec\s*=\s*\d+/g,'this.maxHoldSec = Infinity');

// --- Logs périodiques [AI-LIVE]/[AI-SIM] toutes ~3 min ---
if(!/function\s+logPeriodicStats\s*\(/.test(s)){
  s += `
async function calcStatsForLog(){
  const out={ open:0, closed:0, uPnL:0, realizedDay:0, simPnl15:0, mode:(AI_STATE&&AI_STATE.active)?"live":"sim" };
  try{
    if(out.mode==="live"){
      const posResp=await okxGET("/api/v5/account/positions",{instType:"SWAP"});
      const arr=Array.isArray(posResp.data?.data)?posResp.data.data:[];
      out.open=arr.length;
      out.uPnL=arr.reduce((s,p)=> s + (Number(p.upl||p.unrealizedPnl||0)||0), 0);
      try{
        const hist=await okxGET("/api/v5/account/positions-history",{instType:"SWAP",limit:200});
        const H=Array.isArray(hist.data?.data)?hist.data.data:[];
        const today=new Date().toDateString();
        out.realizedDay=H.reduce((s,t)=>{
          const ts=Number(t.closeTime||t.uTime||t.cTime||t.ts||Date.now());
          const d=new Date(ts).toDateString();
          const pnl=Number(t.pnl||t.realizedPnl||t.closePnl||t.pnlReal||0)||0;
          return s + (d===today ? pnl : 0);
        },0);
        out.closed=H.reduce((n,t)=>{
          const ts=Number(t.closeTime||t.uTime||t.cTime||t.ts||Date.now());
          return n + (new Date(ts).toDateString()===today ? 1 : 0);
        },0);
      }catch{}
    }else{
      try{
        const w=(globalThis.TUNER?.arms||[]).find(a=>a.name===globalThis.TUNER?.active)?.window||[];
        const cut=Date.now()-15*60*1000; out.simPnl15=w.filter(x=>x.t>=cut).reduce((s,x)=>s+Number(x.r||0),0);
      }catch{}
      try{
        out.open = Array.isArray(SIM?.open) ? SIM.open.length : (SIM?.openCount||0);
        out.closed = typeof SIM?.closedCount==="number" ? SIM.closedCount : 0;
      }catch{}
    }
  }catch{}
  if(typeof out.closed!=="number") out.closed=0;
  return out;
}
async function logPeriodicStats(){
  try{
    const s=await calcStatsForLog();
    if(s.mode==="live"){
      addAiLogRate("stats3m", \`[AI-LIVE] open=\${s.open} closed=\${s.closed} | uPnL=\$\\${fmtUsd(s.uPnL)} | realized(d)=\$\\${fmtUsd(s.realizedDay)}\`, 180000);
    }else{
      addAiLogRate("stats3m", \`[AI-SIM] open=\${s.open} closed=\${s.closed} | sim15m=\$\\${fmtUsd(s.simPnl15||0)}\`, 180000);
    }
  }catch{}
}
setTimeout(()=>logPeriodicStats(),10000); setInterval(()=>logPeriodicStats(),180000);
`;
}

// --- Écriture si modifié ---
if(s!==orig){
  fs.writeFileSync(file,s,"utf8");
  console.log("OK: main.js patché.");
}else{
  console.log("Info: aucun changement appliqué.");
}
