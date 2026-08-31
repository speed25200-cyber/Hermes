function slotsFree(state, maxOpen){ return Math.max(0, (maxOpen||10) - state.open.size); }
function isCooldown(state, symbol){
  const t = state.cooldown.get(symbol);
  return t && t > Date.now();
}
function setCooldown(state, symbol, minutes=60){
  state.cooldown.set(symbol, Date.now() + minutes*60*1000);
}
function onTradeResult(state, pos, pnl, riskCfg){
  if (pnl < 0) {
    const key = `L_${pos.sym}`; const cur = state[key] || 0; state[key] = cur+1;
    if (state[key] >= (riskCfg.cooldownLosses||3)) { setCooldown(state, pos.sym, riskCfg.cooldownMinutes||60); state[key] = 0; }
  } else { const key = `L_${pos.sym}`; state[key]=0; }
}
function correlationOk(state, symbol, side, maxSameSideCorr){
  const fam = family(symbol); let cnt = 0;
  for (const [, p] of state.open.entries()){ if (family(p.sym)===fam && p.side===side) cnt++; }
  return cnt < (maxSameSideCorr||3);
}
function family(sym){
  const b = sym.split("_")[0];
  if (["BTC","ETH","SOL","ADA","XRP","BNB"].includes(b)) return "MAJORS";
  return "ALTS";
}
function shouldStopDay(state, riskCfg){ return false; }
function pickParamsFor(regime, strat, scoreTotal){
  const mid = (rng)=> (rng[0]+rng[1])/2;
  const tp = scoreTotal>=3 ? mid(strat.tp)+0.0005 : mid(strat.tp);
  const sl = mid(strat.sl);
  const be = mid(strat.be);
  const trail = mid(strat.trail);
  return { tp, sl, be, trail };
}
module.exports = { slotsFree, isCooldown, setCooldown, onTradeResult, correlationOk, shouldStopDay, pickParamsFor };

