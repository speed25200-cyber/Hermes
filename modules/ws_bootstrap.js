const EventEmitter = require("events");
const { createOkxWs } = require("./okx_ws");

function startWs({ tickers = ["BTC-USDT-SWAP","ETH-USDT-SWAP"] } = {}){
  const bus = new EventEmitter();

  const pub = createOkxWs({
    type: "public",
    onMessage: (msg)=>{
      if (msg?.arg?.channel==="tickers" && Array.isArray(msg?.data)) bus.emit("ticker", msg.data);
    },
    onError: (e)=> bus.emit("error", e)
  });
  pub.subscribe(tickers.map(instId => ({ channel:"tickers", instId })));

  let priv = null;
  if (process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_PASSPHRASE){
    priv = createOkxWs({
      type: "private",
      onMessage: (msg)=>{
        if (msg?.arg?.channel) bus.emit(msg.arg.channel, msg.data || msg);
      },
      onError: (e)=> bus.emit("error", e)
    });
    priv.subscribe([{ channel:"orders" }, { channel:"positions" }, { channel:"account" }]);
  }

  return { bus, pub, priv };
}

module.exports = { startWs };
