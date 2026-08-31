const https=require("https"); const INSTR_URL="/api/v5/public/instruments?instType=SWAP";
let cache=null, at=0;
function httpsGet(host,path){return new Promise((res,rej)=>https.request({host, path, method:"GET"},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)));}).on("error",rej).end());}
async function loadInstruments(host="www.okx.com"){ if(cache && Date.now()-at<10*60*1000) return cache; const j=await httpsGet(host,INSTR_URL); cache = (j.data||[]).reduce((m,it)=>{m[it.instId]=it; return m;},{}); at=Date.now(); return cache; }
async function sizeFromMargin({instId,px,marginUSDT,lev}){ const ins=(await loadInstruments())[instId]; if(!ins) throw new Error("InstrumentNotFound:"+instId); const ctVal=Number(ins.ctVal); const lotSz=Number(ins.lotSz); const raw=(marginUSDT*lev)/(px*ctVal); const sz=Math.floor(raw/lotSz)*lotSz; return Math.max(sz,lotSz); }
module.exports={loadInstruments,sizeFromMargin};
