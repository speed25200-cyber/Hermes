const https=require("https"); const crypto=require("crypto"); const { RateLimiter }=require("./ratelimit");
const RL_PUBLIC=new RateLimiter({capacity:20,intervalMs:2000});
const RL_PRIVATE=new RateLimiter({capacity:6,intervalMs:2000});
function sign(ts,method,path,qs,body,secret){const pre=ts+method+path+(qs||"")+(body||""); return crypto.createHmac("sha256",secret).update(pre).digest("base64");}
function req(host,opt,body){ return new Promise((res,rej)=>{ const r=https.request({host, ...opt},(x)=>{let d="";x.on("data",c=>d+=c);x.on("end",()=>{ try{res(JSON.parse(d))}catch(e){rej(e)} });}); r.on("error",rej); if(body) r.write(body); r.end(); }); }
async function pub(host,path){ return RL_PUBLIC.enqueue(()=>req(host,{path,method:"GET"})); }
async function prv(host,key,pass,secret,method,path,qs,body){ return RL_PRIVATE.enqueue(()=>{ const ts=new Date().toISOString(); const sig=sign(ts,method,path,qs,body,secret); const headers={ "OK-ACCESS-KEY":key,"OK-ACCESS-PASSPHRASE":pass,"OK-ACCESS-TIMESTAMP":ts,"OK-ACCESS-SIGN":sig,"Content-Type":"application/json"}; return req(host,{path:path+(qs||""),method,headers},body); }); }
module.exports={pub,prv};
