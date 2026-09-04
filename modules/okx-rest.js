const https=require("https"); const crypto=require("crypto"); const { RateLimiter }=require("./ratelimit");
const RL_PUBLIC=new RateLimiter({capacity:20,intervalMs:2000});
const RL_PRIVATE=new RateLimiter({capacity:6,intervalMs:2000});
function sign(ts,method,path,qs,body,secret){const pre=ts+method+path+(qs||"")+(body||""); return crypto.createHmac("sha256",secret).update(pre).digest("base64");}
function req(host,opt,body){ return new Promise((res,rej)=>{ const r=https.request({host, ...opt},(x)=>{let d="";x.on("data",c=>d+=c);x.on("end",()=>{ try{res(JSON.parse(d))}catch(e){rej(e)} });}); r.on("error",rej); if(body) r.write(body); r.end(); }); }
async function pub(host,path){ return RL_PUBLIC.enqueue(()=>req(host,{path,method:"GET"})); }
function assertLegacyOrderIsReduceOnly(method,path,body){
  if(String(method).toUpperCase()!=="POST") return;
  const route=String(path||"").split("?",1)[0];
  if(!route.startsWith("/api/v5/trade/")) return;
  const cancellations=new Set(["/api/v5/trade/cancel-order","/api/v5/trade/cancel-batch-orders","/api/v5/trade/cancel-algos"]);
  if(cancellations.has(route)) return;
  const creations=new Set(["/api/v5/trade/order","/api/v5/trade/order-algo","/api/v5/trade/batch-orders"]);
  let parsed=body;
  if(typeof body==="string"){try{parsed=JSON.parse(body);}catch{parsed=null;}}
  const rows=Array.isArray(parsed)?parsed:[parsed];
  if(creations.has(route) && rows.length && rows.every((row)=>row?.reduceOnly===true)) return;
  const error=new Error(creations.has(route)?"LEGACY_REAL_ENTRY_DISABLED_REDUCE_ONLY_REQUIRED":"LEGACY_TRADE_MUTATION_DISABLED_USE_APP_MAIN_GATED_EXECUTOR");error.code="LEGACY_ENTRY_DISABLED";throw error;
}
async function prv(host,key,pass,secret,method,path,qs,body){ assertLegacyOrderIsReduceOnly(method,path,body); return RL_PRIVATE.enqueue(()=>{ const ts=new Date().toISOString(); const sig=sign(ts,method,path,qs,body,secret); const headers={ "OK-ACCESS-KEY":key,"OK-ACCESS-PASSPHRASE":pass,"OK-ACCESS-TIMESTAMP":ts,"OK-ACCESS-SIGN":sig,"Content-Type":"application/json"}; return req(host,{path:path+(qs||""),method,headers},body); }); }
module.exports={pub,prv,assertLegacyOrderIsReduceOnly};
