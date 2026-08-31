/* test_trade.js — OKX SWAP test trade (marge -> notional, TP/SL attachés) */
require('dotenv').config();
const https = require('https');
const crypto = require('crypto');

const API = 'https://www.okx.com';
const KEY = process.env.OK_ACCESS_KEY || process.env.OKX_ACCESS_KEY || process.env.OK_ACCESSKEY || process.env.OK_ACCESSKEY;
const SEC = process.env.OK_SECRET_KEY || process.env.OKX_SECRET_KEY || process.env.OK_SECRETKEY || process.env.OK_SECRET;
const PAS = process.env.OK_PASSPHRASE || process.env.OKX_PASSPHRASE || process.env.OK_PASSP;
const SUB = process.env.OK_SUBACCOUNT || process.env.OKX_SUBACCOUNT || '';

if(!KEY || !SEC || !PAS){
  console.error('Manque OKX credentials dans .env (OK_ACCESS_KEY / OK_SECRET_KEY / OK_PASSPHRASE).');
  process.exit(1);
}

const args = require('minimist')(process.argv.slice(2));
const instId   = args.instId  || 'BTC-USDT-SWAP';
const margin   = Number(args.margin||20);
const lev      = Number(args.lev||20);
const side     = (args.side||'long').toLowerCase(); // long|short
const triggerT = (args.trigger||'mark').toLowerCase(); // mark|last
const tpPct    = Number(args.tp||0.20);
const slPct    = Number(args.sl||-0.40);

function ts(){ return new Date().toISOString(); }
function sign(method, path, body=''){
  const prehash = ts() + method.toUpperCase() + path + (body||'');
  const hmac = crypto.createHmac('sha256', SEC).update(prehash).digest('base64');
  return { prehash, sig: hmac };
}
function req(method, path, bodyObj){
  return new Promise((resolve, reject)=>{
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const auth = sign(method, path, body);
    const headers = {
      'OK-ACCESS-KEY': KEY,
      'OK-ACCESS-SIGN': auth.sig,
      'OK-ACCESS-TIMESTAMP': auth.prehash.slice(0,24), // garde l'ISO (sans Z redondant)
      'OK-ACCESS-PASSPHRASE': PAS,
      'Content-Type': 'application/json'
    };
    if (SUB) headers['OK-ACCESS-PROJECT'] = SUB;
    const url = new URL(API + path);
    const opt = { method, headers };
    const req = https.request(url, opt, (res)=>{
      let data=''; res.on('data', d=>data+=d);
      res.on('end', ()=>{
        try{
          const j = JSON.parse(data);
          if(j.code && j.code!=='0') return reject(new Error(j.code+': '+j.msg));
          resolve(j);
        }catch(e){ reject(e); }
      });
    });
    req.on('error', reject);
    if(body) req.write(body);
    req.end();
  });
}

async function getInstrument(instId){
  const j = await req('GET', `/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`);
  if(!j.data || !j.data.length) throw new Error('Instrument introuvable');
  return j.data[0];
}
async function getTicker(instId){
  const j = await req('GET', `/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
  if(!j.data || !j.data.length) throw new Error('Ticker introuvable');
  return j.data[0];
}
function roundDownToStep(x, step){
  const s = Number(step||'1');
  const n = Math.floor(Number(x)/s)*s;
  // corrige flottants
  return Number(n.toFixed(12));
}
async function setLeverage(instId, lev, side){
  // posSide requis si long_short_mode
  await req('POST', '/api/v5/account/set-leverage', { instId, lever:String(lev), mgnMode:'isolated', posSide: side });
}

async function placeMarket(instId, side, posSide, sz){
  const body = { instId, tdMode:'isolated', side: (side==='long'?'buy':'sell'), posSide, ordType:'market', sz: String(sz) };
  const j = await req('POST', '/api/v5/trade/order', body);
  // id: j.data[0].ordId
  return j;
}
function priceFromMarginPct(entry, side, pct, lev){
  // approx: Δprix% ≈ marge% / levier
  const moveFrac = pct/lev;
  return side==='long' ? entry*(1+moveFrac) : entry*(1-moveFrac);
}
async function attachTpSl(instId, posSide, entryPx, tpPct, slPct, triggerPxType){
  const tp = priceFromMarginPct(entryPx, posSide, tpPct, lev);
  const sl = priceFromMarginPct(entryPx, posSide, slPct, lev);
  const body = {
    instId,
    tdMode:'isolated',
    posSide: posSide,
    ordType:'conditional',
    tpTriggerPxType: triggerPxType, tpTriggerPx: String(tp),
    slTriggerPxType: triggerPxType, slTriggerPx: String(sl)
  };
  return req('POST', '/api/v5/trade/order-algo', body);
}

(async ()=>{
  try{
    const posSide = side; // 'long' or 'short'
    const inst = await getInstrument(instId);
    const tk = await getTicker(instId);
    const markPx = Number(tk.last||tk.sodUtc0||tk.sodUtc8);
    const ctVal   = Number(inst.ctVal);     // taille contrat en COIN (souvent 0.01 BTC)
    const lotSz   = Number(inst.lotSz);     // pas de quantité
    if(!markPx || !ctVal || !lotSz) throw new Error('Métadonnées instrument incomplètes');

    // Notional en USDT = marge * levier
    const notionalUSDT = margin * lev;
    // Convertir en quantité en contrats: (notional/price)/ctVal, arrondi sur lotSz
    const qtyRaw = (notionalUSDT / markPx) / ctVal;
    const sz = roundDownToStep(qtyRaw, lotSz);
    if (sz <= 0) throw new Error('Taille calculée <= 0; augmente marge/levier.');

    console.log(`Inst=${instId} price≈${markPx} ctVal=${ctVal} lotSz=${lotSz} -> sz=${sz}`);

    // 1) Levier
    await setLeverage(instId, lev, posSide);
    console.log('Levier réglé.');

    // 2) Ordre marché
    const ord = await placeMarket(instId, side, posSide, sz);
    console.log('Ordre marché placé:', ord.data && ord.data[0] && ord.data[0].ordId);

    // 3) TP/SL attachés (utilise mark ou last selon args)
    const entryPxApprox = markPx; // approximation suffisante pour poser les triggers
    const algo = await attachTpSl(instId, posSide, entryPxApprox, tpPct, slPct, triggerT);
    console.log('TP/SL posés:', JSON.stringify(algo.data||algo, null, 2));

    console.log('✅ Fini.');
  }catch(e){
    console.error('❌ ERREUR:', e.message||e);
    process.exit(1);
  }
})();
