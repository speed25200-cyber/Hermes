/* [HERMES_PATCH_TPSL] */
const TRIGGER_PX_TYPE = (process.env.TRIGGER_PX_TYPE||"mark");

// Fallback si stopPxFromMargin n'existe pas: approx via levier => Δprix ≈ marge% / levier
function fallbackStopPxFromMargin(instId, side, entryPx, qty, marginPct, lev){
  const leverage = Number(process.env.DEFAULT_LEVERAGE||lev||20);
  const movePctOnPrice = Number(marginPct)/leverage; // ex: +0.20/20 = +0.01 = +1% prix
  const px = Number(entryPx||0);
  if (!px) return null;
  const move = px * movePctOnPrice;
  if ((side||"").toLowerCase().includes("long")) return px + move;
  return px - move; // short
}

async function attachTpSl({ okxPOST, stopPxFromMargin }, { instId, side, entryPx, qty }){
  try{
    let slPx, tpPx;
    if (typeof stopPxFromMargin === "function"){
      slPx = stopPxFromMargin(instId, side, entryPx, qty, -0.40);
      tpPx = stopPxFromMargin(instId, side, entryPx, qty, +0.20);
    } else {
      slPx = fallbackStopPxFromMargin(instId, side, entryPx, qty, -0.40);
      tpPx = fallbackStopPxFromMargin(instId, side, entryPx, qty, +0.20);
    }
    if (!slPx || !tpPx) { console.error("[TP/SL] prix invalides"); return; }

    const body = {
      instId,
      tdMode: "isolated",
      posSide: side,               // "long" / "short" si long_short_mode
      ordType: "conditional",
      slTriggerPxType: TRIGGER_PX_TYPE, slTriggerPx: String(slPx),
      tpTriggerPxType: TRIGGER_PX_TYPE, tpTriggerPx: String(tpPx)
    };
    await okxPOST("/api/v5/trade/order-algo", body);
    console.log("[TP/SL] Attach OK: "+instId+" side="+side+" tp="+tpPx+" sl="+slPx);
  }catch(e){
    console.error("[TP/SL] attach error:", e && e.message || e);
  }
}

module.exports = { attachTpSl };
