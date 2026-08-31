const crypto=require('crypto'); const axios=require('axios'); const WebSocket=require('ws'); require('dotenv').config();
const OKX_HOST='https://www.okx.com';
function sign(ts,method,path,body,secret){const pre=ts+method+path+(body||'');return crypto.createHmac('sha256',secret).update(pre).digest('base64');}
async function rest(method,path,body){const ts=new Date().toISOString(); const key=process.env.OKX_API_KEY,sec=process.env.OKX_API_SECRET,pp=process.env.OKX_API_PASSPHRASE;
  const headers={'OK-ACCESS-KEY':key,'OK-ACCESS-SIGN':sign(ts,method.toUpperCase(),path,body?JSON.stringify(body):'',sec),'OK-ACCESS-TIMESTAMP':ts,'OK-ACCESS-PASSPHRASE':pp,'Content-Type':'application/json'};
  const url=OKX_HOST+path; const cfg={headers}; const fn=method.toLowerCase()==='get'?axios.get:axios.post; return (await fn(url,body||{},cfg)).data;}
class OkxTrader{
  constructor(){this.ws=null;this.wsReady=false;this.queue=[];}
  async connectPrivate(){
    if(this.ws&&this.wsReady)return; const sim=String(process.env.OKX_SIMULATION||'true').toLowerCase()==='true';
    const url = ''; // sim; prod: wss://ws.okx.com:8443/ws/v5/private
    this.ws=new WebSocket(url);
    this.ws.on('open',()=>{const ts=Date.now()/1000+''; const signStr=crypto.createHmac('sha256',process.env.OKX_API_SECRET).update(ts+'GET'+'/users/self/verify').digest('base64');
      this.ws.send(JSON.stringify({op:'login',args:[{apiKey:process.env.OKX_API_KEY,passphrase:process.env.OKX_API_PASSPHRASE,timestamp:ts,sign:signStr}]}));});
    this.ws.on('message',(m)=>{try{const msg=JSON.parse(m); if(msg.event==='login'&&msg.code==='0'){this.wsReady=true; this.queue.splice(0).forEach(x=>this.ws.send(x));} }catch{}});
    this.ws.on('close',()=>{this.wsReady=false; this.ws=null;});
  }
  async orderWS(args){await this.connectPrivate(); const payload=JSON.stringify({op:'order',args:[args]}); if(this.wsReady)this.ws.send(payload); else this.queue.push(payload); return { via:'ws', sent:true, args }; }
  async orderREST(args){return await rest('POST','/api/v5/trade/order',args);}
  async setLeverage({instId,lever,mgnMode,posSide}){return await rest('POST','/api/v5/account/set-leverage',{instId,lever:String(lever),mgnMode,...(posSide?{posSide}:{})});}
  async placeMarketWithAttach({instId,side,tdMode='isolated',posSide,sz,tpPx,slPx,tpTrigType='mark',slTrigType='mark'}){
    const args={instId,tdMode,side,ordType:'market',sz:String(sz),...(posSide?{posSide}:{})};
    if(tpPx||slPx){args.attachAlgoOrds=[]; if(tpPx){args.attachAlgoOrds.push({tpTriggerPxType:tpTrigType,tpTriggerPx:String(tpPx),tpOrdPx:String(tpPx)})}
      if(slPx){args.attachAlgoOrds.push({slTriggerPxType:slTrigType,slTriggerPx:String(slPx),slOrdPx:'-1'})}}
    try{ return await this.orderWS(args);}catch(e){ return await this.orderREST(args); }
  }
  async placeTrailing({instId,side,tdMode='isolated',callbackRatio='0.003',activePx}){
    const args={instId,tdMode,side,ordType:'move_order_stop',callbackRatio:String(callbackRatio),activePx:String(activePx)};
    try{ return await this.orderWS(args);}catch(e){ return await rest('POST','/api/v5/trade/order',args); }
  }
}
function roundToStep(v,step){const s=Number(step||1); return (Math.floor((Number(v)+1e-12)/s)*s).toFixed((s.toString().split('.')[1]||'').length);}
function computeSz({equity,price,lev,cfg,lotSz=1,minSz=1}){const risk=Math.min(Math.max(equity*cfg.sizing.riskPctPerTrade,cfg.sizing.minUSDT),Math.min(cfg.sizing.maxUSDT,equity*cfg.sizing.capPortfolioPct)); const notion=risk*lev; let sz=notion/price; sz=Math.max(sz, Number(minSz)); return roundToStep(sz,lotSz);}
function calcPx(entry,pct,side,kind){const k=Number(pct||0); if(kind==='tp'){return side==='buy'?entry*(1+k):entry*(1-k)} else {return side==='buy'?entry*(1-k):entry*(1+k)}}
module.exports={OkxTrader,computeSz,calcPx,rest};

