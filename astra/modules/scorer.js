function score(feat, strat){
  const stOKlong  = (feat.stDir===1);
  const stOKshort = (feat.stDir===-1);
  const distOK = feat.distStAtr >= 0.15;

  const sqzOK = feat.sqzState==="off";
  const sqzSideLong = feat.sqzSide===1;
  const sqzSideShort= feat.sqzSide===-1;

  const rsiLong  = feat.rsi>50;
  const rsiShort = feat.rsi<50;
  const bbNearBasis = Math.abs((feat.price - feat.bbBasis)/ (feat.bbSigma||1e-9)) <= 1.0;
  const timingLong  = (rsiLong || feat.price <= feat.bbLower) && bbNearBasis;
  const timingShort = (rsiShort|| feat.price >= feat.bbUpper) && bbNearBasis;

  const longVotes  = (stOKlong?1:0) + (sqzOK&&sqzSideLong?1:0) + (timingLong?1:0);
  const shortVotes = (stOKshort?1:0) + (sqzOK&&sqzSideShort?1:0) + (timingShort?1:0);
  const side = longVotes>=shortVotes ? "LONG" : "SHORT";

  const score_st  = (side==="LONG" ? stOKlong : stOKshort) && distOK ? 1 : 0;
  const score_sqz = (sqzOK && (side==="LONG"?sqzSideLong:sqzSideShort)) ? 1 : 0;
  const score_rbb = (side==="LONG"?timingLong:timingShort) ? 1 : 0;
  const bonus = (side==="LONG" ? (feat.rsi>55) : (feat.rsi<45)) ? 1 : 0;

  const total = score_st + score_sqz + score_rbb + bonus;
  const wideFromBasis = Math.abs((feat.price - feat.bbBasis)/ (feat.bbSigma||1e-9)) >= 1.5;
  const mode = (sqzOK && (side==="LONG"?sqzSideLong:sqzSideShort) && !wideFromBasis) ? "TF" : "MR";

  return { total, side, mode, score_st, score_sqz, score_rbb, bonus };
}
module.exports = { score };
