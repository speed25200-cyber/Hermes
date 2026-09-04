"use strict";






const {
  assertOkxSuccess: __assertOkxSuccess,
  newHermesClientId: __newHermesClientId,
  isHermesOwnedAlgo: __isHermesOwnedAlgo,
} = require("./live_safety");

function __assertOkxResponse(response, operation) {
  const payload = response?.data && !Array.isArray(response.data) ? response.data : response;
  __assertOkxSuccess(payload, operation);
  return response;
}

/* === SAFE CLORDID CORE START === */
var __safeClOrdId = (typeof __safeClOrdId==="function") ? __safeClOrdId : function(prefix){
  const p = (prefix || process.env.AI_CLORD_PREFIX || "AI").replace(/[^A-Za-z0-9]/g,"") || "A";
  const ts = Date.now().toString(36);
  const rnd= Math.random().toString(36).slice(2,10);
  let id = (p + ts + rnd).replace(/[^A-Za-z0-9]/g,"").slice(0,32);
  if (!/^[A-Za-z]/.test(id)) id = "A" + id.slice(1);
  return id;
};
/* === SAFE CLORDID CORE END === */
/* === PHASEC POSSIDE TOP DEF START === */
var __phC_getPosMode = (typeof __phC_getPosMode === "function") ? __phC_getPosMode : async function(){
  try{
    if (typeof __ph2_getPosMode === "function") return await __ph2_getPosMode();
    const r = await okx.okxGET("/api/v5/account/config");
    const d = Array.isArray(r?.data?.data) ? r.data.data[0] : (Array.isArray(r?.data)? r.data[0] : r?.data) || r;
    return d?.posMode || d?.pos_mode || null; // 'long_short_mode' | 'net_mode'
  }catch(_){ return null; }
};

var __phC_ensurePosSide = (typeof __phC_ensurePosSide === "function") ? __phC_ensurePosSide : async function(body){
  try{
    const b = { ...(body||{}) };
    const mode = await __phC_getPosMode();
    if (mode === "long_short_mode") {
      if (!b.posSide) {
        const side = String(b.side||"").toLowerCase();
        const reduce = !!b.reduceOnly;
        b.posSide = reduce ? (side==="sell" ? "long" : "short")
                           : (side==="buy"  ? "long" : "short");
      }
    } else {
      if ("posSide" in b) delete b.posSide;
    }
    return b;
  }catch(_){ return body; }
};

(function(){
  try{
    if (typeof okxTradeOrderWithGuards === "function" && !global.__OKX_POSSIDE_TOP_WRAP__) {
      global.__OKX_POSSIDE_TOP_WRAP__ = true;
      const __prev = okxTradeOrderWithGuards;
      const wrapped = async function(body){
        const b1 = await __phC_ensurePosSide(body);
        return await __prev(b1);
      };
      try { okxTradeOrderWithGuards = wrapped; } catch(_){}
      try { module.exports.okxTradeOrderWithGuards = wrapped; } catch(_){}
    }
  }catch(_){}
})();
/* === PHASEC POSSIDE TOP DEF END === */
/* === PHASEC SZ ENSURE TOP DEF START === */
var __ph2_quantizeDown = (typeof __ph2_quantizeDown === "function") ? __ph2_quantizeDown : function(value, step){
  var v = Number(value), s = String(step||"1");
  var dec = (s.split(".")[1]||"").length;
  if (!isFinite(v)) return String(value);
  var st = Number(s); if (!isFinite(st) || st<=0) return String(value);
  var q = Math.floor(v/st)*st;
  return q.toFixed(dec).replace(/\.?0+$/,"");
};
var __ph2_maxStr = (typeof __ph2_maxStr === "function") ? __ph2_maxStr : function(a,b){ return (Number(a)>=Number(b))? String(a):String(b); };
var __phC_ensureSz = (typeof __phC_ensureSz === "function") ? __phC_ensureSz : async function(body){
  var b = Object.assign({}, body||{});
  try{
    if(!b.instId) return b;
    // ---- instruments
    var inst=null;
    try{
      if (typeof __ph2_loadInstruments === "function"){
        var m = await __ph2_loadInstruments();
        inst = m && m.get ? m.get(b.instId) : null;
      } else if (typeof okx !== "undefined" && okx && okx.okxGET){
        var r = await okx.okxGET("/api/v5/public/instruments",{ instType:"SWAP" });
        var arr = Array.isArray(r?.data?.data) ? r.data.data : (Array.isArray(r?.data)? r.data : (Array.isArray(r)? r : [])) || [];
        for (var i=0;i<arr.length;i++){ if (arr[i]?.instId===b.instId){ inst=arr[i]; break; } }
      }
    }catch(_){}
    var lotSz = String((inst && inst.lotSz) || "1");
    var minSz = String((inst && inst.minSz) || lotSz);
    var ctVal = Number((inst && inst.ctVal) || 1);
    // ---- prix
    var last=null;
    try{
      if (typeof __ph2_getLast === "function"){
        last = await __ph2_getLast(b.instId);
      } else if (typeof okx !== "undefined" && okx && okx.okxGET){
        var t = await okx.okxGET("/api/v5/market/ticker",{ instId: b.instId });
        var d = Array.isArray(t?.data?.data)? t.data.data : (Array.isArray(t?.data)? t.data : (Array.isArray(t)? t : []));
        if (Array.isArray(d) && d[0]) last = d[0].last ?? d[0].lastPx ?? null;
      }
    }catch(_){}
    // ---- budget & levier
    var envBudget = (typeof process!=="undefined" && process && process.env && process.env.AI_BUDGET_USDT) ? Number(process.env.AI_BUDGET_USDT) : null;
    var budget = (b.budgetUSDT ?? b._budgetUSDT ?? b.usdt ?? b.amountUSDT ?? envBudget);
    var lev = Number(b.leverage ?? b.lever ?? 1);
    // ---- calc sz si nécessaire
    if ((b.sz==null || Number(b.sz)<=0) && budget!=null && last!=null && isFinite(lev) && isFinite(ctVal)){
      var contracts = (Number(budget)*lev)/(Number(last)*ctVal);
      var q = __ph2_quantizeDown(String(contracts), lotSz);
      q = __ph2_maxStr(q, minSz);
      b.sz = q;
    }
    if (b.sz==null || !isFinite(Number(b.sz)) || Number(b.sz)<=0) b.sz = minSz;
    return b;
  }catch(_){ return b; }
};
/* === PHASEC SZ ENSURE TOP DEF END === */
/* === PHASEC CLORDID SAFE DEF START === */
var __safeClOrdId = (typeof __safeClOrdId === "function") ? __safeClOrdId : function(prefix){
  const p = (prefix || process.env.AI_CLORD_PREFIX || "AI").replace(/[^A-Za-z0-9]/g,"") || "A";
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2,10);
  let id = (p + ts + rnd).replace(/[^A-Za-z0-9]/g,"").slice(0,32);
  if (!/^[A-Za-z]/.test(id)) id = "A" + id.slice(1);
  return id;
};
/* === PHASEC CLORDID SAFE DEF END === */
/* === PHASEC OKX CLIENT ENSURE START === */
if (typeof okx === "undefined") { var okx = null; }
(function(){
  try { if (!okx) okx = require("./okx"); } catch(_) {}
  try { if (!okx) okx = require("../okx"); } catch(_) {}
  try { if (!okx) okx = require("../modules/okx"); } catch(_) {}
  if (!okx || !okx.okxGET || !okx.okxPOST) {
    try {
      const cands = ["./okx","../okx","../modules/okx","./clients/okx","../clients/okx"];
      for (const p of cands) {
        try {
          const m = require(p);
          const getFn  = m.okxGET  || m.get  || m.GET  || m.getJSON;
          const postFn = m.okxPOST || m.post || m.POST;
          if (getFn && postFn) { okx = { okxGET: getFn, okxPOST: postFn }; break; }
        } catch(e) {}
      }
    } catch(e) {}
  }
  if (!okx || !okx.okxGET || !okx.okxPOST) {
    throw new ReferenceError("OKX client introuvable : il faut un module exportant okxGET/okxPOST (ex: modules/okx.js).");
  }
})();
/* === PHASEC OKX CLIENT ENSURE END === */
const path = require("path");
const fs = require("fs");
/**
 * Ce module fournit des primitives d'exÃ©cution pour OKX USDT-M SWAP:
 * - setLeverage (isolated)
 * - openMarket (market order, isolated)
 * - closePosition (reduce-only, market)
 * - getPosition (lecture position)
 * - checkClosed (true si la position est fermÃ©e)
 *
 * Signature attendue par engine: on passe un objet `okx` qui expose okxGET/okxPOST.
 */

async function setLeverage({ okx, instId, leverage = 20, posSide = "long" }) {
  try {
    await okx.okxPOST("/api/v5/account/set-leverage", { lever:String(leverage), instId,
      
      mgnMode: "isolated",
      posSide
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function openMarket({ okx, instId, side, marginUSDT = 20, leverage = 20 }) {
  // Prix spot du contrat
  const tick = await okx.okxGET("/api/v5/market/ticker", { instId });
  const last = +(tick?.data?.[0]?.last || 0);
  if (!last) throw new Error("No price from ticker");

  const posSide = side === "LONG" ? "long" : "short";
  await setLeverage({ okx, instId, leverage, posSide });

  // notionnel = marge * levier ; taille = floor(notionnel / prix)
  const notionnel = marginUSDT * leverage;
  const sz = Math.max(1, Math.floor(notionnel / last));

  const body = {
    instId,
    tdMode: "isolated",
    side: side === "LONG" ? "buy" : "sell",
    ordType: "market",
    sz: String(sz),
    posSide
  };

  const r = await okxTradeOrderWithGuards(body);
  const code = r?.data?.code ?? r?.data?.data?.[0]?.sCode ?? "0";
  if (String(code) !== "0") {
    const msg = r?.data?.msg || r?.data?.data?.[0]?.sMsg || "order error";
    throw new Error(msg);
  }
  return { entryPx: last, sz, tdMode: "isolated" };
}

async function closePosition({ okx, instId, side, sz }) {
  const posSide = side === "LONG" ? "long" : "short";
  const closeSide = side === "LONG" ? "sell" : "buy";
  const qty = Math.max(1, parseInt(String(sz || 1), 10));

  const body = {
    instId,
    tdMode: "isolated",
    side: closeSide,
    ordType: "market",
    sz: String(qty),
    posSide,
    reduceOnly: true
  };

  const r = await okxTradeOrderWithGuards(body);
  const code = r?.data?.code ?? r?.data?.data?.[0]?.sCode ?? "0";
  if (String(code) !== "0") {
    const msg = r?.data?.msg || r?.data?.data?.[0]?.sMsg || "close error";
    throw new Error(msg);
  }
  return true;
}

/**
 * Retourne la position OKX pour un instId et un posSide donnÃ©, ou null si aucune.
 * posSide: "long" | "short" | undefined (si undefined -> on renvoie la premiÃ¨re non nulle)
 */
async function getPosition({ okx, instId, posSide }) {
  const res = await okx.okxGET("/api/v5/account/positions", { instType: "SWAP", instId });
  const list = res?.data?.data || [];
  if (!list.length) return null;

  if (!posSide) {
    const any = list.find(p => Math.abs(+p.pos || +p.holdVol || +p.sz || 0) > 0);
    return any || null;
  }
  const target = String(posSide).toLowerCase();
  const hit = list.find(p => {
    const ps = String(p.posSide || p.side || "").toLowerCase();
    const size = Math.abs(+p.pos || +p.holdVol || +p.sz || 0);
    return size > 0 && ps.includes(target);
  });
  return hit || null;
}

/**
 * Renvoie true si la position est fermÃ©e (plus de position ouverte).
 * side optionnel: si fourni, on vÃ©rifie ce cÃ´tÃ©; sinon on vÃ©rifie qu'il n'y a plus AUCUNE position.
 */
async function checkClosed({ okx, instId, side }) {
  const posSide = side ? (side === "LONG" ? "long" : "short") : undefined;
  const p = await getPosition({ okx, instId, posSide });
  return !p;
}

module.exports = {
  setLeverage,
  openMarket,
  closePosition,
  getPosition,
  checkClosed
};




/* ======================= PHASE2 HELPERS START ======================= */
let __ph2_instMap = null;
let __ph2_posMode = null;

function __ph2_scaleOf(x){ const s=String(x); const i=s.indexOf("."); return i>=0? (s.length-i-1):0; }
function __ph2_normDecStr(s){
  s=String(s);
  if(!s.includes(".")) return s.replace(/^(-?)0+$/,"$10");
  s=s.replace(/.?0+$/,""); 
  if(s===""||s===".") s="0";
  if(s[0]===".") s="0"+s;
  if(s[0]==="-" && s[1]===".") s="-0"+s.slice(1);
  return s;
}
function __ph2_toIntStr(s,scale){
  s=String(s);
  const neg=s[0]==="-"; const t=neg ? s.slice(1):s;
  const parts=t.split(".");
  let int=parts[0]||"0"; let frac=parts[1]||"";
  if(frac.length<scale) frac=frac+"0".repeat(scale-frac.length);
  else if(frac.length>scale) frac=frac.slice(0,scale);
  let full=(int+frac).replace(/^0+/,"");
  if(full==="") full="0";
  return (neg?"-":"")+full;
}
function __ph2_fromIntStr(s,scale){
  s=String(s);
  const neg=s[0]==="-"; let t=neg ? s.slice(1):s;
  while(t.length<=scale) t="0"+t;
  const a=t.slice(0,t.length-scale); const b=t.slice(t.length-scale);
  return __ph2_normDecStr((neg?"-":"")+a+(scale>0?"."+b:""));
}
function __ph2_quantizeDown(value, step){
  value=String(value); step=String(step);
  const S=Math.max(__ph2_scaleOf(value), __ph2_scaleOf(step));
  const vInt=BigInt(__ph2_toIntStr(value,S));
  const sInt=BigInt(__ph2_toIntStr(step,S));
  if(sInt===0n) return __ph2_normDecStr(value);
  const q=vInt/sInt; const res=(q*sInt).toString();
  return __ph2_fromIntStr(res,S);
}
function __ph2_maxStr(a,b){ return (Number(a)>=Number(b))? String(a):String(b); }

async function __ph2_loadInstruments(){
  if(__ph2_instMap) return __ph2_instMap;
  try{
    const r = await okx.okxGET("/api/v5/public/instruments", { instType: "SWAP" });
    const arr = (r && (Array.isArray(r.data?.data)? r.data.data : Array.isArray(r.data)? r.data : (Array.isArray(r)? r : []))) || [];
    const m = new Map();
    for(const it of arr){ if(it?.instId) m.set(it.instId, it); }
    __ph2_instMap = m;
  }catch(e){ __ph2_instMap = new Map(); }
  return __ph2_instMap;
}
async function __ph2_getLast(instId){
  try{
    const r = await okx.okxGET("/api/v5/market/ticker", { instId });
    const d = (Array.isArray(r?.data?.data)? r.data.data : Array.isArray(r?.data)? r.data : (Array.isArray(r)? r : []));
    if (Array.isArray(d) && d[0]) return d[0].last ?? d[0].lastPx ?? null;
    if (r?.last || r?.lastPx) return r.last ?? r.lastPx;
    return null;
  }catch(e){ return null; }
}
async function __ph2_getPosMode(){
  if(__ph2_posMode) return __ph2_posMode;
  try{
    const r = await okx.okxGET("/api/v5/account/config");
    const d = Array.isArray(r?.data?.data) ? r.data.data[0] : (Array.isArray(r?.data)? r.data[0] : r?.data) || r;
    __ph2_posMode = d?.posMode || d?.pos_mode || null; // 'long_short_mode' | 'net_mode'
    return __ph2_posMode;
  }catch(e){ return null; }
}
function __ph2_computeSz(inst, last, budgetUSDT, leverage){
  const ctVal = Number(inst?.ctVal ?? 1);
  const lotSz = String(inst?.lotSz ?? "1");
  const minSz = String(inst?.minSz ?? lotSz);
  const notion = Number(budgetUSDT) * Number(leverage ?? 1);
  const contracts = notion / (Number(last) * ctVal);
  let q = __ph2_quantizeDown(String(contracts), lotSz);
  q = __ph2_maxStr(q, minSz);
  return q;
}
function __ph2_attachFromPct(side, last, tpPct, slPct){
  const arr=[];
  if (tpPct!=null){
    const tp = side==="buy" ? Number(last)*(1+Number(tpPct)) : Number(last)*(1-Number(tpPct));
    arr.push({ tpTriggerPxType: "last", tpTriggerPx: String(tp), tpOrdPx: "-1" });
  }
  if (slPct!=null){
    const sl = side==="buy" ? Number(last)*(1-Number(slPct)) : Number(last)*(1+Number(slPct));
    arr.push({ slTriggerPxType: "last", slTriggerPx: String(sl), slOrdPx: "-1" });
  }
  return arr;
}

// Normalise le body d'ordre : taille contrats, grille lotSz/minSz, posSide selon posMode, TP/SL si tpPct/slPct
async function normalizeTradeOrderBody(body){
  try{
    if(!body || !body.instId) return body;
    const b = { ...body };
    // __PHASEA_AUTOBUDGET_INJECTED
    // tdMode déjà par défaut plus haut (isolated); si autoBudget activé et pas de budget fourni,
    // on affecte budgetUSDT = totalEq / AI_TRADE_SLOTS (défaut 10).
    if ((b.autoBudget || String(process.env.AI_AUTO_BUDGET||"") === "1")
        && b.leverage != null
        && (b.budgetUSDT==null && b._budgetUSDT==null && b.usdt==null && b.amountUSDT==null)) {
      try {
        const totalEq = await __ph2_getTotalEq();
        b._budgetUSDT = computeBudgetPerTrade(totalEq);
      } catch(e) {}
    } b.tdMode = b.tdMode || b.mgnMode || "isolated";
    const instMap = await __ph2_loadInstruments();
    const inst = instMap.get(b.instId);
    // Taille contrats
    if (inst){
      const lotSz = String(inst.lotSz ?? "1");
      const minSz = String(inst.minSz ?? lotSz);
      if (b.sz != null){
        b.sz = __ph2_maxStr(__ph2_quantizeDown(String(b.sz), lotSz), minSz);
      } else {
        const budget = b.budgetUSDT ?? b._budgetUSDT ?? b.usdt ?? b.amountUSDT ?? null;
        const lev    = b.leverage   ?? b.lever        ?? null;
        if (budget!=null && lev!=null){
          const last = await __ph2_getLast(b.instId);
          if (last!=null){
            b.sz = __ph2_computeSz(inst, last, budget, lev);
          }
        }
      }
    }
    // posSide vs position mode
    const posMode = await __ph2_getPosMode();
    if (posMode && posMode !== "long_short_mode" && "posSide" in b) delete b.posSide;

    // TP/SL attachés si fournis en pourcentage
    if ((b.tpPct!=null || b.slPct!=null) && !b.attachAlgoOrds){
      const last = await __ph2_getLast(b.instId);
      if(last!=null && b.side){
        const at = __ph2_attachFromPct(b.side, last, b.tpPct, b.slPct);
        if (at.length) b.attachAlgoOrds = at.map((algo) => ({
          ...algo,
          attachAlgoClOrdId: __newHermesClientId("attach"),
        }));
      }
    }
    return b;
  }catch(e){ return body; }
}
module.exports.normalizeTradeOrderBody = normalizeTradeOrderBody;
/* ======================== PHASE2 HELPERS END ======================== */

/* ===================== PHASE2B SET-LEVERAGE START ===================== */
async function normalizeSetLeverageBody(body){
  try{
    if(!body) return body;
    const b = { ...body };
    // lever: string depuis lever/leverage
    if (b.leverage != null && b.lever == null) b.lever = b.leverage;
    if (b.lever != null) b.lever = String(b.lever);
    // mgnMode obligatoire pour set-leverage (fallback sur tdMode ou 'isolated')
    if (!b.mgnMode) b.mgnMode = b.tdMode || "isolated";
    // posSide seulement en hedge (long_short_mode)
    try{
      const modeResp = await okx.okxGET("/api/v5/account/config");
      const cfgArr = Array.isArray(modeResp?.data?.data) ? modeResp.data.data : (Array.isArray(modeResp?.data)? modeResp.data : (Array.isArray(modeResp)? modeResp : []));
      const cfg = cfgArr && cfgArr[0] ? cfgArr[0] : modeResp;
      const posMode = cfg?.posMode || cfg?.pos_mode || null;
      if (posMode && posMode !== "long_short_mode" && "posSide" in b) delete b.posSide;
    }catch(e){}
    return b;
  }catch(e){ return body; }
}
module.exports.normalizeSetLeverageBody = normalizeSetLeverageBody;
/* ====================== PHASE2B SET-LEVERAGE END ====================== */

/* ====================== PHASEA RISK GUARDS START ====================== */
const __AI_STATE_FILE = path.join(process.cwd(), "runtime", "ai_state.json");

function __ai_loadState(){
  try { return JSON.parse(fs.readFileSync(__AI_STATE_FILE, "utf8")); }
  catch(e){ return {}; }
}
function __ai_saveState(st){
  fs.mkdirSync(path.dirname(__AI_STATE_FILE), { recursive: true });
  fs.writeFileSync(__AI_STATE_FILE, JSON.stringify(st, null, 2));
}

// totalEq depuis balance
async function __ph2_getTotalEq(){
  try{
    const r = await okx.okxGET("/api/v5/account/balance");
    const d = Array.isArray(r?.data?.data) ? r.data.data[0] :
              (Array.isArray(r?.data) ? r.data[0] : r?.data) || r;
    return Number(d?.totalEq ?? 0);
  }catch(e){ return 0; }
}

// kill-switch: OFF à -30% (par défaut), PANIC à -50%
async function ensureKillSwitch(){
  const offTh   = Number(process.env.AI_OFF_THRESHOLD   ?? "-0.30"); // -30%
  const panicTh = Number(process.env.AI_PANIC_THRESHOLD ?? "-0.50"); // -50%
  const st = __ai_loadState();

  if (st.killed) throw new Error("AI_PANIC: verrouillé (killed)");
  if (st.off)    throw new Error("AI_OFF: IA en pause (off)");

  let base = Number(st.baseEq ?? 0);
  if (!base) {
    base = await __ph2_getTotalEq();
    st.baseEq = base;
    __ai_saveState(st);
  }
  const cur = await __ph2_getTotalEq();
  if (base > 0) {
    const drop = (cur - base) / base; // négatif si perte
    if (drop <= panicTh) { st.killed = true; __ai_saveState(st); throw new Error("AI_PANIC: equity <= -50%"); }
    if (drop <= offTh)   { st.off    = true; __ai_saveState(st); throw new Error("AI_OFF: equity <= -30%"); }
  }
}
module.exports.ensureKillSwitch = ensureKillSwitch;

function computeBudgetPerTrade(totalEq, slots){
  const n = Number(slots ?? process.env.AI_TRADE_SLOTS ?? 10);
  const per = Number(totalEq)/ (n>0?n:10);
  return per>0 ? per : 0;
}
module.exports.computeBudgetPerTrade = computeBudgetPerTrade;
/* ======================= PHASEA RISK GUARDS END ======================= */

/* =================== PHASEA ORDER WRAPPER START =================== */
async function okxTradeOrderWithGuards(body){
  /* Ce module historique reste utile aux sorties reduce-only et au
     nettoyage, mais ne possede ni le gate signe, ni le ledger d'intent,
     ni la machine de fills de app/main.js. Toute entree doit donc passer
     par le chemin canonique; les anciens scripts CLI echouent ferme. */
  if (!body || body.reduceOnly !== true) {
    throw new Error("LEGACY_ENTRY_PATH_DISABLED_USE_APP_MAIN");
  }
  await ensureKillSwitch();
  const b = await normalizeTradeOrderBody(body);
  const response = await okx.okxPOST("/api/v5/trade/order", b);
  __assertOkxResponse(response, "POST order");
  return response;
}
module.exports.okxTradeOrderWithGuards = okxTradeOrderWithGuards;
/* ==================== PHASEA ORDER WRAPPER END ==================== */
/* === PHASEB1 APPEND START === */
if (typeof getOkxWsUrls !== 'function') {
  function getOkxWsUrls(){
    const envBase = process.env.OKX_WS_BASE_URL && String(process.env.OKX_WS_BASE_URL).replace(/\/$/,'');
    if (envBase) return { public: envBase + "/ws/v5/public", private: envBase + "/ws/v5/private" };
    const httpBase = (process.env.OKX_BASE_URL || "https://www.okx.com");
    const isEEA = /eea\.okx\.com|my\.okx\.com/i.test(httpBase);
    const host = isEEA ? "wss://wseea.okx.com" : "wss://ws.okx.com";
    return { public: host + "/ws/v5/public", private: host + "/ws/v5/private" };
  }
  try { module.exports.getOkxWsUrls = getOkxWsUrls; } catch(_) {}
}

if (typeof okxTradeOrderWithGuards_phaseB1 !== 'function') {
  async function okxTradeOrderWithGuards_phaseB1(body){
    const genClOrdId = (p="AI") => __safeClOrdId(p);

    if (typeof ensureKillSwitch === "function") await ensureKillSwitch();
    const baseBody = (typeof normalizeTradeOrderBody === "function") ? await normalizeTradeOrderBody(body) : body;
    const b = { ...baseBody };
    if (!b.clOrdId) b.clOrdId = __safeClOrdId("AI");
    const response = await okx.okxPOST("/api/v5/trade/order", b);
    __assertOkxResponse(response, "POST order");
    return response;
  }

  // Expose & override en douceur
  try { module.exports.okxTradeOrderWithGuards = okxTradeOrderWithGuards_phaseB1; } catch(_) {}
  try { okxTradeOrderWithGuards = okxTradeOrderWithGuards_phaseB1; } catch(_) {}
}
/* === PHASEB1 APPEND END === */
/* === PHASEA TRAILING APPEND START === */
if (typeof okxTradeOrderWithGuards_phaseA !== "function") {
  const __prevOkxTradeOrderWithGuards = (typeof okxTradeOrderWithGuards === "function") ? okxTradeOrderWithGuards : null;

  async function okxTradeOrderWithGuards_phaseA(body){
    // 1) on exécute la fonction actuelle (B1) ou fallback direct
    const baseFn = __prevOkxTradeOrderWithGuards || (async (b)=>{
      const nb = (typeof normalizeTradeOrderBody === "function") ? await normalizeTradeOrderBody(b) : b;
      const response = await okx.okxPOST("/api/v5/trade/order", nb);
      __assertOkxResponse(response, "POST order");
      return response;
    });
    const res = await baseFn(body);

    // 2) si trailing demandé, on place un order-algo move_order_stop
    try{
      const b = { ...(body||{}) };
      if (b.trailingSpec && b.instId && b.side) {
        let last = null;
        try { last = (typeof __ph2_getLast === "function") ? await __ph2_getLast(b.instId) : null; } catch(_){}
        if (last!=null) {
          const activePct = Number(b.trailingSpec.activePct ?? 0.35);     // +35% par défaut
          const callback  = Number(b.trailingSpec.callbackRatio ?? 0.15); // trailing 15% par défaut
          const opposite  = b.side==="buy" ? "sell" : "buy";
          let posMode = null;
          try { posMode = (typeof __ph2_getPosMode === "function") ? await __ph2_getPosMode() : null; } catch(_){}
          const activePx = b.side==="buy" ? (Number(last)*(1+activePct)) : (Number(last)*(1-activePct));
          const algo = {
            instId: b.instId,
            tdMode: b.tdMode || b.mgnMode || "isolated",
            side: opposite,
            ordType: "move_order_stop",
            algoClOrdId: __newHermesClientId("trail"),
            sz: String(b.sz || ""),
            callbackRatio: String(callback),
            activePx: String(activePx)
          };
          if (!algo.sz) {
            try { const nb = (typeof normalizeTradeOrderBody === "function") ? await normalizeTradeOrderBody(b) : b;
                  if (nb && nb.sz) algo.sz = String(nb.sz); } catch(_){}
          }
          if (posMode==="long_short_mode" && b.posSide) algo.posSide = b.posSide;

          const algoResponse = await okx.okxPOST("/api/v5/trade/order-algo", algo);
          __assertOkxResponse(algoResponse, "POST order-algo");
        }
      }
    }catch(_){}

    return res;
  }

  try { module.exports.okxTradeOrderWithGuards = okxTradeOrderWithGuards_phaseA; } catch(_){}
  try { okxTradeOrderWithGuards = okxTradeOrderWithGuards_phaseA; } catch(_){}
}
/* === PHASEA TRAILING APPEND END === */
/* === PHASEC CLEANUP APPEND START === */
if (typeof listOpenAlgoIdsByInst !== 'function') {
  async function listOpenAlgoIdsByInst(instId){
    try{
      const r = await okx.okxGET("/api/v5/trade/orders-algo-pending", { instType: "SWAP", instId });
      const arr = Array.isArray(r?.data?.data) ? r.data.data : (Array.isArray(r?.data)? r.data : (Array.isArray(r)? r : []));
      const ids = [];
      for (const it of arr || []) {
        if (it?.algoId && it?.instId === instId && __isHermesOwnedAlgo(it)) ids.push(it.algoId);
      }
      return ids;
    } catch(e){ return []; }
  }
  module.exports.listOpenAlgoIdsByInst = listOpenAlgoIdsByInst;
}

if (typeof cancelAlgosByInst !== 'function') {
  async function cancelAlgosByInst(instId){
    const ids = await listOpenAlgoIdsByInst(instId);
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10).map((algoId) => ({ algoId, instId }));
      const response = await okx.okxPOST("/api/v5/trade/cancel-algos", batch);
      __assertOkxResponse(response, "POST cancel-algos");
    }
    return ids.length;
  }
  module.exports.cancelAlgosByInst = cancelAlgosByInst;
}

if (typeof closePositionWithCleanup !== 'function') {
  async function closePositionWithCleanup({ instId, side, posSide, tdMode, sz }){
    try { await cancelAlgosByInst(instId); } catch(_) {}
    const opposite = side === "buy" ? "sell" : "buy";
    const order = { instId, tdMode: tdMode || "isolated", side: opposite, ordType: "market" };
    if (sz) order.sz = String(sz);
    try {
      const mode = (typeof __ph2_getPosMode === "function") ? await __ph2_getPosMode() : null;
      if (mode==="long_short_mode" && posSide) order.posSide = posSide;
    } catch(_) {}
    try {
      order.reduceOnly = true;
      return await okxTradeOrderWithGuards(order);
    } catch(e) {
      try { delete order.reduceOnly; return await okxTradeOrderWithGuards(order); }
      catch(e2){ throw e2; }
    }
  }
  module.exports.closePositionWithCleanup = closePositionWithCleanup;
}

/* === PHASEC LOGGER APPEND START === */
if (typeof safeLog !== 'function') {
  function redactSecrets(v){
    try{
      if (v && typeof v === 'object'){
        const out = Array.isArray(v) ? [] : {};
        for (const k of Object.keys(v)){
          const low = k.toLowerCase();
          if (/(secret|apikey|api_key|api-secret|passphrase|password|token|authorization)/.test(low)){
            out[k] = "***";
          } else {
            out[k] = redactSecrets(v[k]);
          }
        }
        return out;
      }
      if (typeof v === 'string'){
        if (v.length >= 24 && /[A-Za-z0-9+/=_-]{24,}/.test(v)) return v.slice(0,4)+"***"+v.slice(-4);
      }
      return v;
    }catch(_){ return v; }
  }
  const LEVELS = { error:0, warn:1, info:2, debug:3 };
  function curLevel(){ const l=(process.env.AI_LOG_LEVEL||"info").toLowerCase(); return LEVELS[l] ?? 2; }
  function safeLog(level, ...args){
    const L = LEVELS[level] ?? 2; if (L > curLevel()) return;
    const clean = args.map(a => redactSecrets(a)); const ts = new Date().toISOString();
    console[level] ? console[level](`[${ts}] [${level.toUpperCase()}]`, ...clean)
                   : console.log(`[${ts}] [${level.toUpperCase()}]`, ...clean);
  }
  module.exports.safeLog = safeLog;
}
/* === PHASEC CLEANUP APPEND END === */

/* === PHASEC CLORDID SANITIZE START === */
if (typeof __safeClOrdId !== "function") {
  function __safeClOrdId(prefix){
    const p = (prefix || process.env.AI_CLORD_PREFIX || "AI").replace(/[^A-Za-z0-9]/g,"") || "A";
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2,10);
    let id = (p + ts + rnd).replace(/[^A-Za-z0-9]/g,"").slice(0,32);
    if (!/^[A-Za-z]/.test(id)) id = "A" + id.slice(1);
    return id;
  }
}
(function(){
  try{
    const __old = (typeof okxTradeOrderWithGuards === "function") ? okxTradeOrderWithGuards : null;
    if (__old && !global.__OKX_CLORDID_SANITIZED__) {
      global.__OKX_CLORDID_SANITIZED__ = true;
      const wrapped = async function(body){
        const b = { ...(body||{}) };
        if (!b.clOrdId) {
          b.clOrdId = __safeClOrdId();
        } else {
          b.clOrdId = String(b.clOrdId).replace(/[^A-Za-z0-9]/g,"").slice(0,32);
          if (!/^[A-Za-z]/.test(b.clOrdId)) b.clOrdId = "A" + b.clOrdId.slice(1);
        }
        return await __old(b);
      };
      try { okxTradeOrderWithGuards = wrapped; } catch(_){}
      try { module.exports.okxTradeOrderWithGuards = wrapped; } catch(_){}
    }
  } catch(_){}
})();
/* === PHASEC CLORDID SANITIZE END === */

/* === PHASEC SZ ENSURE START === */
if (typeof __phC_ensureSz !== "function") {
  async function __phC_ensureSz(body){
    const b = { ...(body||{}) };
    try{
      if (!b.instId) return b;

      // Récup instruments
      let instMap = null, inst = null;
      try { instMap = await (__ph2_loadInstruments ? __ph2_loadInstruments() : null); } catch(_){}
      if (instMap && instMap.get) inst = instMap.get(b.instId);

      // Valeurs par défaut si /public/instruments indisponible
      const lotSz = String(inst?.lotSz ?? "1");
      const minSz = String(inst?.minSz ?? lotSz);
      const ctVal = Number(inst?.ctVal ?? 1);

      // Dernier prix
      let last = null;
      try { last = await (__ph2_getLast ? __ph2_getLast(b.instId) : null); } catch(_){}

      // Budget & levier
      const envBudget = process.env.AI_BUDGET_USDT ? Number(process.env.AI_BUDGET_USDT) : null;
      const budget = (b.budgetUSDT ?? b._budgetUSDT ?? b.usdt ?? b.amountUSDT ?? envBudget);
      const lev    = Number(b.leverage ?? b.lever ?? 1);

      // Si pas de sz fourni et qu'on peut calculer : notionnel -> contrats
      if ((b.sz == null || Number(b.sz) <= 0) && budget!=null && last!=null && isFinite(lev) && isFinite(ctVal)) {
        const contracts = (Number(budget) * lev) / (Number(last) * ctVal);
        let q = __ph2_quantizeDown( String(contracts), lotSz );
        // s'assurer d'au moins minSz
        q = __ph2_maxStr(q, minSz);
        b.sz = q;
      }

      // Si toujours invalide, forcer à minSz (évite 51000)
      if (b.sz == null || !isFinite(Number(b.sz)) || Number(b.sz) <= 0) {
        b.sz = minSz;
      }
      return b;
    }catch(_){ return b; }
  }
}

// Surcouche : garantir un sz valide avant d'appeler la version actuelle
(function(){
  try{
    if (typeof okxTradeOrderWithGuards === "function" && !global.__OKX_SZ_ENSURE_WRAP__) {
      global.__OKX_SZ_ENSURE_WRAP__ = true;
      const __prev = okxTradeOrderWithGuards;
      const wrapped = async function(body){
        const b1 = await __phC_ensureSz(body);
        return await __prev(b1);
      };
      try { okxTradeOrderWithGuards = wrapped; } catch(_){}
      try { module.exports.okxTradeOrderWithGuards = wrapped; } catch(_){}
    }
  }catch(_){}
})();
/* === PHASEC SZ ENSURE END === */

/* === PHASEC POSSIDE ENSURE START === */
if (typeof __phC_getPosMode !== "function") {
  async function __phC_getPosMode(){
    try{
      if (typeof __ph2_getPosMode === "function") return await __ph2_getPosMode();
      const r = await okx.okxGET("/api/v5/account/config");
      const d = Array.isArray(r?.data?.data) ? r.data.data[0] : (Array.isArray(r?.data)? r.data[0] : r?.data) || r;
      return d?.posMode || d?.pos_mode || null; // 'long_short_mode' | 'net_mode'
    }catch(_){ return null; }
  }
}

if (typeof __phC_ensurePosSide !== "function") {
  async function __phC_ensurePosSide(body){
    try{
      const b = { ...(body||{}) };
      const mode = await __phC_getPosMode();
      if (mode === "long_short_mode") {
        if (!b.posSide) {
          const side = String(b.side||"").toLowerCase();
          const reduce = !!b.reduceOnly;
          // ouvertures: buy->long, sell->short ; fermetures reduceOnly: sell->long, buy->short
          b.posSide = reduce ? (side==="sell" ? "long" : "short")
                             : (side==="buy"  ? "long" : "short");
        }
      } else {
        if ("posSide" in b) delete b.posSide;
      }
      return b;
    }catch(_){ return body; }
  }
}

(function(){
  try{
    if (typeof okxTradeOrderWithGuards === "function" && !global.__OKX_POSSIDE_ENSURE_WRAP__) {
      global.__OKX_POSSIDE_ENSURE_WRAP__ = true;
      const __prev = okxTradeOrderWithGuards;
      const wrapped = async function(body){
        const b1 = await __phC_ensurePosSide(body);
        return await __prev(b1);
      };
      try { okxTradeOrderWithGuards = wrapped; } catch(_){}
      try { module.exports.okxTradeOrderWithGuards = wrapped; } catch(_){}
    }
  }catch(_){}
})();
/* === PHASEC POSSIDE ENSURE END === */


/* === __OKX_LIVE_LOG_WRAP__ START === */
(function(){
  try{
    if (typeof okxTradeOrderWithGuards === "function" && !global.__OKX_LIVE_LOG_WRAP__) {
      global.__OKX_LIVE_LOG_WRAP__ = true;
      var aiLog=null;
      try{ aiLog = require("../modules/ai_log"); }catch(_){ try{ aiLog = require("./ai_log"); }catch(__){} }
      var __prev = okxTradeOrderWithGuards;
      var wrapped = async function(body){
        var res = await __prev(body);
        try{
          if (aiLog && body && body.instId){
            if (body.reduceOnly) { if (aiLog.liveExit) aiLog.liveExit(body.instId); }
            else { if (aiLog.liveEntry) aiLog.liveEntry(body.instId); }
          }
        }catch(_){}
        return res;
      };
      try { okxTradeOrderWithGuards = wrapped; }catch(_){}
      try { module.exports.okxTradeOrderWithGuards = wrapped; }catch(_){}
    }
  }catch(_){}
})();
/* === __OKX_LIVE_LOG_WRAP__ END === */
/* === PHASED LIVE CLOSE LOG WRAP START === */
(function(){
  try{
    if (module && module.exports && typeof module.exports.closePositionWithCleanup === "function" && !global.__OKX_LIVE_CLOSE_WRAP__) {
      global.__OKX_LIVE_CLOSE_WRAP__ = true;
      var __origClose = module.exports.closePositionWithCleanup;
      var aiLog=null;
      try{ aiLog = require("../modules/ai_log"); }catch(_){ try{ aiLog = require("./ai_log"); }catch(__){} }
      module.exports.closePositionWithCleanup = async function(args){
        try{
          var res = await __origClose.call(this, args);
          try{ if (aiLog && aiLog.liveExit && args && args.instId) aiLog.liveExit(args.instId); }catch(_){}
          return res;
        }catch(e){
          try{ if (aiLog && aiLog.liveExit && args && args.instId) aiLog.liveExit(args.instId); }catch(_){}
          throw e;
        }
      };
    }
  }catch(_){}
})();
/* === PHASED LIVE CLOSE LOG WRAP END === */

/* === CORE PHASE2 HELPERS START === */
function __ph2_scaleOf(x){ const s=String(x); const i=s.indexOf("."); return i>=0? (s.length-i-1):0; }
function __ph2_toIntStr(s,scale){
  s=String(s); const neg=s[0]==="-"; const t=neg? s.slice(1):s;
  const parts=t.split("."); let int=parts[0]||"0", frac=parts[1]||"";
  if(frac.length<scale) frac=frac+"0".repeat(scale-frac.length); else if(frac.length>scale) frac=frac.slice(0,scale);
  let full=(int+frac).replace(/^0+/,""); if(full==="") full="0"; return (neg?"-":"")+full;
}
function __ph2_fromIntStr(s,scale){
  s=String(s); const neg=s[0]==="-"; let t=neg? s.slice(1):s; while(t.length<=scale) t="0"+t;
  const a=t.slice(0,t.length-scale), b=t.slice(t.length-scale); return (neg?"-":"")+a+(scale>0?"."+b:"");
}
function __ph2_quantizeDown(value, step){
  value=String(value); step=String(step); const S=Math.max(__ph2_scaleOf(value), __ph2_scaleOf(step));
  const v=BigInt(__ph2_toIntStr(value,S)), st=BigInt(__ph2_toIntStr(step,S));
  if(st===0n) return value; const q=v/st; return __ph2_fromIntStr((q*st).toString(),S);
}
function __ph2_maxStr(a,b){ return (Number(a)>=Number(b))? String(a):String(b); }

async function __ph2_loadInstruments(){
  try{
    const r = await okx.okxGET("/api/v5/public/instruments", { instType:"SWAP" });
    const arr = Array.isArray(r?.data?.data) ? r.data.data : (Array.isArray(r?.data)? r.data : (Array.isArray(r)? r : []));
    const m = new Map(); for (const it of arr||[]) if (it?.instId) m.set(it.instId, it);
    return m;
  }catch(e){ return new Map(); }
}
async function __ph2_getLast(instId){
  try{
    const r = await okx.okxGET("/api/v5/market/ticker", { instId });
    const d = Array.isArray(r?.data?.data)? r.data.data : (Array.isArray(r?.data)? r.data : (Array.isArray(r)? r : []));
    if (Array.isArray(d) && d[0]) return d[0].last ?? d[0].lastPx ?? null;
    return null;
  }catch(e){ return null; }
}
async function __ph2_getPosMode(){
  try{
    const r = await okx.okxGET("/api/v5/account/config");
    const d = Array.isArray(r?.data?.data) ? r.data.data[0] : (Array.isArray(r?.data)? r.data[0] : r?.data) || r;
    return d?.posMode || d?.pos_mode || null; // 'long_short_mode' | 'net_mode'
  }catch(e){ return null; }
}
function __ph2_computeSz(inst, last, budgetUSDT, leverage){
  const ctVal = Number(inst?.ctVal ?? 1);
  const lotSz = String(inst?.lotSz ?? "1");
  const minSz = String(inst?.minSz ?? lotSz);
  const notion = Number(budgetUSDT) * Number(leverage ?? 1);
  const contracts = notion / (Number(last) * ctVal);
  let q = __ph2_quantizeDown(String(contracts), lotSz);
  q = __ph2_maxStr(q, minSz);
  return q;
}
function __ph2_attachFromPct(side, last, tpPct, slPct){
  const arr=[];
  if (tpPct!=null){
    const tp = side==="buy" ? Number(last)*(1+Number(tpPct)) : Number(last)*(1-Number(tpPct));
    arr.push({ tpTriggerPxType: "last", tpTriggerPx: String(tp), tpOrdPx: "-1" });
  }
  if (slPct!=null){
    const sl = side==="buy" ? Number(last)*(1-Number(slPct)) : Number(last)*(1+Number(slPct));
    arr.push({ slTriggerPxType: "last", slTriggerPx: String(sl), slOrdPx: "-1" });
  }
  return arr;
}

async function normalizeTradeOrderBody(body){
  try{
    if(!body || !body.instId) return body;
    const b = { ...body };
    b.tdMode = b.tdMode || b.mgnMode || "isolated";

    const instMap = await __ph2_loadInstruments();
    const inst    = instMap.get(b.instId);

    // taille contrats
    if (inst){
      const lotSz = String(inst.lotSz ?? "1");
      const minSz = String(inst.minSz ?? lotSz);
      if (b.sz != null){
        b.sz = __ph2_maxStr(__ph2_quantizeDown(String(b.sz), lotSz), minSz);
      } else {
        const budget = b.budgetUSDT ?? b._budgetUSDT ?? b.usdt ?? b.amountUSDT ?? null;
        const lev    = b.leverage   ?? b.lever        ?? null;
        const last   = await __ph2_getLast(b.instId);
        if (budget!=null && lev!=null && last!=null){
          b.sz = __ph2_computeSz(inst, last, budget, lev);
        }
      }
    }

    // posSide vs mode de position
    const posMode = await __ph2_getPosMode();
    if (posMode && posMode !== "long_short_mode" && "posSide" in b) delete b.posSide;

    // TP/SL attachés
    if ((b.tpPct!=null || b.slPct!=null) && !b.attachAlgoOrds){
      const last = await __ph2_getLast(b.instId);
      if(last!=null && b.side){
        const at = __ph2_attachFromPct(b.side, last, b.tpPct, b.slPct);
        if (at.length) b.attachAlgoOrds = at.map((algo) => ({
          ...algo,
          attachAlgoClOrdId: __newHermesClientId("attach"),
        }));
      }
    }
    return b;
  }catch(e){ return body; }
}
/* === CORE PHASE2 HELPERS END === */

/* === CORE RISK GUARDS START === */
const __AI_STATE_FILE2 = path.join(process.cwd(), "runtime", "ai_state.json");
function __ai_loadState(){ try { return JSON.parse(fs.readFileSync(__AI_STATE_FILE, "utf8")); } catch { return {}; } }
function __ai_saveState(st){ try{ fs.mkdirSync(path.dirname(__AI_STATE_FILE), { recursive:true }); fs.writeFileSync(__AI_STATE_FILE, JSON.stringify(st, null, 2)); }catch{} }

async function __ph2_getTotalEq(){
  try{
    const r = await okx.okxGET("/api/v5/account/balance");
    const d = Array.isArray(r?.data?.data) ? r.data.data[0] : (Array.isArray(r?.data)? r.data[0] : r?.data) || r;
    return Number(d?.totalEq ?? 0);
  }catch(e){ return 0; }
}
async function ensureKillSwitch(){
  const offTh   = Number(process.env.AI_OFF_THRESHOLD   ?? "-0.30"); // -30%
  const panicTh = Number(process.env.AI_PANIC_THRESHOLD ?? "-0.50"); // -50%
  const st = __ai_loadState();
  if (st.killed) throw new Error("AI_PANIC: verrouillé (killed)");
  if (st.off)    throw new Error("AI_OFF: IA en pause (off)");
  let base = Number(st.baseEq ?? 0);
  if (!base) { base = await __ph2_getTotalEq(); st.baseEq = base; __ai_saveState(st); }
  const cur = await __ph2_getTotalEq();
  if (base > 0) {
    const drop = (cur - base) / base; // négatif si perte
    if (drop <= panicTh) { st.killed = true; __ai_saveState(st); throw new Error("AI_PANIC: equity <= -50%"); }
    if (drop <= offTh)   { st.off    = true; __ai_saveState(st); throw new Error("AI_OFF: equity <= -30%"); }
  }
}
function computeBudgetPerTrade(totalEq){
  const n = Number(process.env.AI_TRADE_SLOTS || 10);
  const per = Number(totalEq)/ (n>0?n:10);
  return per>0 ? per : 0;
}
/* === CORE RISK GUARDS END === */

/* === CORE ENSURE SZ START === */
async function __phC_ensureSz(body){
  const b = { ...(body||{}) };
  try{
    if(!b.instId) return b;
    const instMap = await __ph2_loadInstruments();
    const inst = instMap.get(b.instId);
    const lotSz = String(inst?.lotSz ?? "1");
    const minSz = String(inst?.minSz ?? lotSz);
    const last  = await __ph2_getLast(b.instId);
    const budget= b.budgetUSDT ?? b._budgetUSDT ?? b.usdt ?? b.amountUSDT ?? (process.env.AI_BUDGET_USDT? Number(process.env.AI_BUDGET_USDT): null);
    const lev   = Number(b.leverage ?? b.lever ?? 1);

    if ((b.sz==null || Number(b.sz)<=0) && budget!=null && last!=null && isFinite(lev)) {
      b.sz = __ph2_computeSz(inst, last, budget, lev);
    }
    if (b.sz==null || !isFinite(Number(b.sz)) || Number(b.sz)<=0) b.sz = minSz;
    return b;
  }catch(_){ return b; }
}
/* === CORE ENSURE SZ END === */

/* === OKX CORE GUARD WRAP START === */
async function okxTradeOrderWithGuards(body){
  if (!body || body.reduceOnly !== true) {
    throw new Error("LEGACY_ENTRY_PATH_DISABLED_USE_APP_MAIN");
  }
  await ensureKillSwitch();
  let b = (typeof normalizeTradeOrderBody==="function") ? await normalizeTradeOrderBody(body) : body;
  b = await __phC_ensureSz(b);

  // clOrdId sûr
  if (!b.clOrdId) b.clOrdId = __safeClOrdId("AI");
  else {
    b.clOrdId = String(b.clOrdId).replace(/[^A-Za-z0-9]/g,"").slice(0,32);
    if (!/^[A-Za-z]/.test(b.clOrdId)) b.clOrdId = "A" + b.clOrdId.slice(1);
  }

  /* Une reponse perdue ne prouve pas que l'ordre a echoue. Rejouer le
     POST peut doubler l'exposition; la reconciliation par clOrdId doit
     preceder toute nouvelle tentative. */
  const response = await okx.okxPOST("/api/v5/trade/order", b);
  __assertOkxResponse(response, "POST order");
  return response;
}
try { module.exports.okxTradeOrderWithGuards = okxTradeOrderWithGuards; } catch(_){}
 /* === OKX CORE GUARD WRAP END === */

/* Barriere finale, apres tous les wrappers historiques. Plusieurs blocs
   ci-dessus reassigent la liaison de fonction pendant le chargement;
   seule une fermeture exportee en dernier garantit que le test porte
   sur la fonction effectivement appelee. */
const __legacyReduceOnlyDelegate = module.exports.okxTradeOrderWithGuards;
const __legacyReduceOnlyExport = async function(body) {
  if (!body || body.reduceOnly !== true) {
    throw new Error("LEGACY_ENTRY_PATH_DISABLED_USE_APP_MAIN");
  }
  return await __legacyReduceOnlyDelegate(body);
};
module.exports.okxTradeOrderWithGuards = __legacyReduceOnlyExport;
module.exports.openMarket = async function() {
  throw new Error("LEGACY_ENTRY_PATH_DISABLED_USE_APP_MAIN");
};
try { okxTradeOrderWithGuards = __legacyReduceOnlyExport; } catch(_){}

