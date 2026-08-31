/**
 * OKX WS client (public + private), reconnection + resub, EEA-ready.
 * Usage:
 *   const { createOkxWs } = require("./modules/okx_ws");
 *   const wsPub = createOkxWs({ type:"public", onMessage: console.log });
 *   wsPub.subscribe([{ channel:"tickers", instId:"BTC-USDT-SWAP" }]);
 */
const crypto = require("crypto");
let WebSocket;
try { WebSocket = require("ws"); } catch(e){ throw new Error('Module "ws" manquant. Installez: npm i ws'); }

function getWsUrls(){
  const base = process.env.OKX_WS_BASE_URL && String(process.env.OKX_WS_BASE_URL).replace(/\/$/,'');
  if (base) return { public: base + "/ws/v5/public", private: base + "/ws/v5/private" };
  const httpBase = process.env.OKX_BASE_URL || "https://www.okx.com";
  const isEEA = /eea\.okx\.com|my\.okx\.com/i.test(httpBase);
  const host = isEEA ? "wss://wseea.okx.com" : "wss://ws.okx.com";
  return { public: host + "/ws/v5/public", private: host + "/ws/v5/private" };
}

function signWs(ts, secret){
  const prehash = ts + "GET" + "/users/self/verify";
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

function createOkxWs({ type="public", apiKey=process.env.OKX_API_KEY, apiSecret=process.env.OKX_API_SECRET, passphrase=process.env.OKX_PASSPHRASE, onMessage, onOpen, onClose, onError } = {}){
  const urls = getWsUrls();
  const url = type==="private" ? urls.private : urls.public;
  let ws=null, heartbeat=null, reconnectTimer=null, topics=[], manualClose=false;
  let backoff = 500; const maxBackoff=8000;

  function connect(){
    manualClose=false;
    ws = new WebSocket(url);
    ws.on("open", async ()=>{
      if(type==="private"){
        try{
          const ts = String(Date.now()/1000);
          const sign = signWs(ts, apiSecret);
          ws.send(JSON.stringify({ op:"login", args:[{ apiKey, passphrase, timestamp:ts, sign }] }));
        }catch(e){ onError && onError(e); }
      }
      if(heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(()=>{ try{ ws?.send("ping"); }catch(_){} }, 15000);
      if (topics.length) subscribe(topics, true);
      onOpen && onOpen();
    });
    ws.on("message", (data)=>{
      try{ const msg = JSON.parse(data.toString()); onMessage && onMessage(msg); }
      catch{ onMessage && onMessage(data.toString()); }
    });
    ws.on("close", ()=>{
      if(heartbeat){ clearInterval(heartbeat); heartbeat=null; }
      onClose && onClose();
      if(!manualClose){
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(()=>{
          backoff = Math.min(maxBackoff, Math.floor(backoff*1.8)+Math.floor(Math.random()*300));
          connect();
        }, backoff);
      }
    });
    ws.on("error", (e)=>{ onError && onError(e); try{ ws.close(); }catch(_){} });
  }

  function subscribe(arr, resub=false){
    if (!Array.isArray(arr) || !arr.length) return;
    if (!resub) topics = topics.concat(arr);
    try{ ws?.send(JSON.stringify({ op:"subscribe", args: arr })); }catch(_){}
  }
  function unsubscribe(arr){
    if (!Array.isArray(arr) || !arr.length) return;
    topics = topics.filter(t => !arr.find(u => JSON.stringify(u)===JSON.stringify(t)));
    try{ ws?.send(JSON.stringify({ op:"unsubscribe", args: arr })); }catch(_){}
  }
  function close(){ manualClose=true; try{ ws?.close(); }catch(_){} }

  connect();
  return { subscribe, unsubscribe, close, url };
}
module.exports = { createOkxWs };
