const qs = require("qs");
let okx = null, BAR = "5m";
const lastMap = new Map();
const cache = new Map();

function toInstId(sym){ return sym.replace("_","-")+"-SWAP"; }

async function getCandles(instId, limit=200){
  const res = await okx.okxGET("/api/v5/market/candles", { instId, bar: BAR, limit });
  const rows = (res.data?.data||[]).map(a=>({ ts:+a[0], o:+a[1], h:+a[2], l:+a[3], c:+a[4], v:+a[5] })).reverse();
  cache.set(instId, rows);
  if (rows.length) lastMap.set(instId, rows[rows.length-1].c);
  return rows;
}

async function getLast(instId){
  if (lastMap.has(instId)) return lastMap.get(instId);
  const rows = await getCandles(instId, 2);
  return rows?.length ? rows[rows.length-1].c : null;
}

module.exports = {
  async init({ okx: api, bar="5m" }) { okx = api; BAR = bar; },
  getCandles, getLast, toInstId
};
