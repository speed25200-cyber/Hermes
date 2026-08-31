function toInstId(sym){ // BTC_USDT -> BTC-USDT-SWAP
  const s = sym.replace("_","-");
  return s.includes("-SWAP")?s:(s+"-SWAP");
}
function toUi(sym){ // BTC-USDT-SWAP -> BTC_USDT
  return sym.replace("-USDT-SWAP","_USDT");
}
module.exports={toInstId,toUi};
