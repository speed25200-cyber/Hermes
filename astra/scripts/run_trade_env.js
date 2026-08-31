(async function(){
  try{
    const path = require("path");
    const fs   = require("fs");

    // Se placer à la racine du projet
    const projectRoot = path.resolve(__dirname, "..");
    process.chdir(projectRoot);

    // Charge le client (autoload .env déjà patché dans modules/okx.js)
    const exec = require(path.join(projectRoot, "modules", "exec.js"));
    if (!exec || typeof exec.okxTradeOrderWithGuards !== "function") {
      console.error("[FATAL] okxTradeOrderWithGuards introuvable");
      process.exit(2);
    }

    // Paramètres depuis l'env (avec valeurs par défaut raisonnables)
    const inst   = process.env.AI_INST   || "BTC-USDT-SWAP";
    const side   = process.env.AI_SIDE   || "buy";
    const lev    = Number(process.env.AI_LEVERAGE || 20);
    const autoB  = (String(process.env.AI_AUTO_BUDGET || "1").toLowerCase()==="true" || process.env.AI_AUTO_BUDGET==="1");
    const tpPct  = process.env.AI_TP_PCT  ? Number(process.env.AI_TP_PCT)  : 0.20;
    const slPct  = process.env.AI_SL_PCT  ? Number(process.env.AI_SL_PCT)  : 0.30;
    const actPct = process.env.AI_TRAIL_ACTIVE_PCT ? Number(process.env.AI_TRAIL_ACTIVE_PCT) : 0.35;
    const cbRat  = process.env.AI_TRAIL_CB_RATIO   ? Number(process.env.AI_TRAIL_CB_RATIO)   : 0.15;

    const body = { instId: inst, side, ordType: "market", leverage: lev, autoBudget: autoB };
    if (!Number.isNaN(tpPct))  body.tpPct = tpPct;
    if (!Number.isNaN(slPct))  body.slPct = slPct;
    if (!Number.isNaN(actPct) && !Number.isNaN(cbRat)) body.trailingSpec = { activePct: actPct, callbackRatio: cbRat };

    console.log("[ENV]", {
      BASE: process.env.OKX_BASE_URL || "https://www.okx.com",
      SIM:  process.env.OKX_SIMULATED,
      INST: inst, SIDE: side, LEV: lev
    });

    const res = await exec.okxTradeOrderWithGuards(body);
    console.log("[ORDER SENT]");
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }catch(e){
    const data = e?.response?.data || e?.response || e;
    try { console.error("[ERROR]", JSON.stringify(data, Object.getOwnPropertyNames(data), 2)); }
    catch { console.error("[ERROR]", e?.message || e); }
    process.exit(1);
  }
})();
