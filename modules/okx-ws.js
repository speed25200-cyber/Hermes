const WebSocket = require("ws");

class OkxWS {
  constructor(){
    this.url = "wss://ws.okx.com:8443/ws/v5/public";
    this.ws = null;
    this.connected = false;
    this.wantInst = new Set();
    this.tickers = new Map();      // instId -> last ticker object
    this.funding = new Map();      // instId -> fundingRate (number)
    this._retries = 0;
  }

  connect(instIds=[]){
    for(const id of instIds){ this.wantInst.add(id); }
    if(this.connected && this.ws) { this._resubscribe(); return; }

    this.ws = new WebSocket(this.url);
    this.ws.on("open", ()=> {
      this.connected = true; this._retries = 0;
      this._subscribe(Array.from(this.wantInst));
    });
    this.ws.on("message", (buf)=>{
      try{
        const msg = JSON.parse(buf.toString());
        if(msg.event === "error"){ return; }
        const ch = msg.arg?.channel;
        if(ch === "tickers" && Array.isArray(msg.data)){
          for(const d of msg.data){ this.tickers.set(d.instId, d); }
        }
        if(ch === "funding-rate" && Array.isArray(msg.data)){
          for(const d of msg.data){
            const r = parseFloat(d.fundingRate); 
            if(!Number.isNaN(r)) this.funding.set(d.instId, r);
          }
        }
      }catch{}
    });
    this.ws.on("close", ()=>{ this.connected = false; this._reconnect(); });
    this.ws.on("error", ()=>{ try{ this.ws.close(); }catch{} });
  }

  _reconnect(){
    const wait = Math.min(15000, 1000 * Math.pow(2, this._retries++));
    setTimeout(()=> this.connect([]), wait);
  }

  _chunks(arr, n=40){ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; }

  _subscribe(instIds){
    if(!this.ws || this.ws.readyState!==1) return;
    const uniq = Array.from(new Set(instIds));
    for(const batch of this._chunks(uniq, 40)){
      this.ws.send(JSON.stringify({ op:"subscribe", args: batch.map(id=>({channel:"tickers", instId:id})) }));
      this.ws.send(JSON.stringify({ op:"subscribe", args: batch.map(id=>({channel:"funding-rate", instId:id})) }));
    }
  }

  _unsubscribe(instIds){
    if(!this.ws || this.ws.readyState!==1) return;
    const uniq = Array.from(new Set(instIds));
    for(const batch of this._chunks(uniq, 40)){
      this.ws.send(JSON.stringify({ op:"unsubscribe", args: batch.map(id=>({channel:"tickers", instId:id})) }));
      this.ws.send(JSON.stringify({ op:"unsubscribe", args: batch.map(id=>({channel:"funding-rate", instId:id})) }));
    }
  }

  _resubscribe(){
    if(!this.connected) return;
    // on ré-envoie la liste désirée
    this._subscribe(Array.from(this.wantInst));
  }

  updateList(newInstIds=[]){
    const next = new Set(newInstIds);
    const add=[], del=[];
    for(const id of next) if(!this.wantInst.has(id)) add.push(id);
    for(const id of this.wantInst) if(!next.has(id)) del.push(id);
    this.wantInst = next;
    if(this.connected){
      if(del.length) this._unsubscribe(del);
      if(add.length) this._subscribe(add);
    }
  }
}

module.exports = { OkxWS };
