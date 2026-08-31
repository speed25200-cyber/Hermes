const ss = require("simple-statistics");

function ema(arr, len){
  const k = 2/(len+1); let prev = arr[0]; const out=[prev];
  for (let i=1;i<arr.length;i++){ prev = arr[i]*k + prev*(1-k); out.push(prev); }
  return out;
}
function rmaTR(candles, len){
  const trs = [];
  for (let i=1;i<candles.length;i++){
    const c=candles[i], p=candles[i-1];
    const tr = Math.max(c.h-c.l, Math.abs(c.h-p.c), Math.abs(c.l-p.c));
    trs.push(tr);
  }
  const k = 1/len; let prev = ss.mean(trs.slice(0,len)) || trs[0] || 0;
  const out = new Array(candles.length).fill(null);
  out[len]=prev;
  for (let i=len+1;i<candles.length;i++){ prev = (prev*(len-1)+trs[i-1])/len; out[i]=prev; }
  return out;
}
function bollinger(closes, len, mult=2){
  const basis = [];
  for (let i=0;i<closes.length;i++){
    const s = Math.max(0,i-len+1);
    const seg = closes.slice(s,i+1);
    const mean = ss.mean(seg);
    const sd = ss.standardDeviation(seg) || 0;
    basis.push({ basis:mean, upper:mean+mult*sd, lower:mean-mult*sd, sigma:sd });
  }
  return basis;
}
function supertrend(candles, atrLen=10, mult=2.0){
  const atr = rmaTR(candles, atrLen);
  const hl2 = candles.map(c=>(c.h+c.l)/2);
  const up = [], dn=[], trend=[];
  for (let i=0;i<candles.length;i++){
    const a = atr[i] || 0;
    const u = hl2[i] - mult*a;
    const d = hl2[i] + mult*a;
    up.push(u); dn.push(d);
    if (i===0) trend[i]=1; else {
      const prev = trend[i-1];
      if (prev===-1 && candles[i].c>dn[i-1]) trend[i]=1;
      else if (prev===1 && candles[i].c<up[i-1]) trend[i]=-1;
      else trend[i]=prev;
    }
  }
  const i = candles.length-1;
  const stLine = trend[i]===1 ? up[i] : dn[i];
  const distStAtr = (atr[i]||0) ? Math.abs(candles[i].c - stLine)/atr[i] : 0;
  return { dir: trend[i], line: stLine, atr, distStAtr };
}
function rsi(closes, len=6){
  let gains=0, losses=0;
  for (let i=1;i<=len;i++){
    const d = closes[i]-closes[i-1];
    gains += d>0?d:0; losses += d<0?-d:0;
  }
  let rs = losses===0 ? 100 : gains/losses;
  let r = 100 - 100/(1+rs);
  for (let i=len+1;i<closes.length;i++){
    const d = closes[i]-closes[i-1];
    gains = (gains*(len-1) + (d>0?d:0))/len;
    losses= (losses*(len-1) + (d<0?-d:0))/len;
    rs = losses===0 ? 100 : (gains/(losses||1e-9));
    r = 100 - 100/(1+rs);
  }
  return r;
}
function squeezeState(candles, bbLen=20, kcLen=20, multKC=1.5){
  const closes = candles.map(c=>c.c);
  const highs = candles.map(c=>c.h);
  const lows  = candles.map(c=>c.l);
  const i = candles.length-1;
  const bb = bollinger(closes, bbLen, 2);
  const basis = bb[i].basis, sd = bb[i].sigma;
  const rngs=[];
  for (let k=i-kcLen+1;k<=i;k++){ if (k>0) rngs.push(highs[k]-lows[k]); }
  const rangema = ss.mean(rngs)||0;
  const upperKC = basis + rangema*multKC;
  const lowerKC = basis - rangema*multKC;
  const upperBB = bb[i].upper, lowerBB = bb[i].lower;
  const sqzOn  = (lowerBB > lowerKC) && (upperBB < upperKC);
  const sqzOff = (lowerBB < lowerKC) && (upperBB > upperKC);
  const emaFast = ema(closes.slice(-kcLen), Math.max(3, Math.floor(kcLen/4)));
  const mom = emaFast[emaFast.length-1] - emaFast[0];
  const histSide = mom>=0 ? 1 : -1;
  return { sqzOn, sqzOff, histSide, bbLen, kcLen, sd };
}
function computeAll(candles, strat){
  const closes = candles.map(c=>c.c);
  const last = candles[candles.length-1];
  const st = supertrend(candles, 10, 2.0);
  const bbAll = bollinger(closes, 120, 2);
  const bb = bbAll[bbAll.length-1];
  const r = rsi(closes, 3);
  const sq = squeezeState(candles, 20, 20, 1.5);
  const atrSeries = rmaTR(candles, 14);
  const atr = atrSeries[atrSeries.length-1] || 0;
  const atrPct = atr>0 ? atr / last.c : 0;
  return {
    price: last.c,
    stDir: st.dir, stLine: st.line, distStAtr: st.distStAtr, atrPct,
    rsi: r, bbBasis: bb.basis, bbUpper: bb.upper, bbLower: bb.lower, bbSigma: bb.sigma,
    sqzState: sq.sqzOn ? "on" : (sq.sqzOff ? "off" : "none"), sqzSide: sq.histSide,
  };
}
function pickFeaturesForLog(f){
  const { atrPct, distStAtr, sqzState, sqzSide, rsi, bbSigma, price, stDir } = f;
  return { atrPct, dist_st_atr: distStAtr, sqz_state: sqzState, sqz_side: sqzSide, rsi, bb_sigma: bbSigma, price, stDir };
}
module.exports = { computeAll, pickFeaturesForLog };
