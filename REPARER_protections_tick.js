// Remplace les protections mal arrondies (bug tickSz corrigé le 30/08) par des
// protections au tick exact de l'instrument, selon la spec :
//   short : TP = entrée -2,5% | SL = entrée +1% | trail activé à entrée -0,5%, callback 0,5%
// Sécurité : la NOUVELLE protection est posée et confirmée AVANT d'annuler l'ancienne.
// Les trailings déjà ACTIFS (moveTriggerPx présent) ne sont pas touchés.
require("dotenv").config({ path: __dirname + "/.env" });
const crypto = require("crypto");
const https = require("https");
const { assertOkxSuccess, newHermesClientId, isHermesOwnedAlgo } = require("./modules/live_safety");

function req(method, p, body) {
  return new Promise((res, rej) => {
    const ts = new Date().toISOString();
    const b = body ? JSON.stringify(body) : "";
    const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET).update(ts + method + p + b).digest("base64");
    const r = https.request({
      hostname: "www.okx.com", path: p, method,
      headers: {
        "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
        "Content-Type": "application/json",
        ...(String(process.env.OKX_SIMULATED || "").toLowerCase() === "true" || process.env.OKX_SIMULATED === "1"
          ? { "x-simulated-trading": "1" } : {})
      }
    }, x => { let d = ""; x.on("data", c => d += c); x.on("end", () => { try { res(JSON.parse(d)); } catch { res({}); } }); });
    r.on("error", rej);
    if (b) r.write(b);
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function roundTick(px, tickS) {
  const dec = tickS.includes(".") ? tickS.split(".")[1].length : 0;
  const t = Number(tickS);
  return (Math.round(px / t) * t).toFixed(dec);
}

async function main() {
  if (process.env.HERMES_MAINTENANCE_CONFIRM !== "REPAIR_OWNED_PROTECTIONS") {
    throw new Error("refus: definir HERMES_MAINTENANCE_CONFIRM=REPAIR_OWNED_PROTECTIONS");
  }
  if (!String(process.env.HERMES_ALGO_OWNER || "").trim()) {
    throw new Error("refus: HERMES_ALGO_OWNER stable est obligatoire");
  }
  const inst = await req("GET", "/api/v5/public/instruments?instType=SWAP");
  assertOkxSuccess(inst, "GET instruments");
  const tick = {};
  for (const x of (inst.data || [])) tick[x.instId] = String(x.tickSz);

  const p = await req("GET", "/api/v5/account/positions?instType=SWAP");
  assertOkxSuccess(p, "GET positions");
  const pos = (p.data || []).filter(x => Math.abs(+x.pos) > 0);
  const ocoResponse = await req("GET", "/api/v5/trade/orders-algo-pending?instType=SWAP&ordType=oco");
  const trailResponse = await req("GET", "/api/v5/trade/orders-algo-pending?instType=SWAP&ordType=move_order_stop");
  assertOkxSuccess(ocoResponse, "GET pending OCO");
  assertOkxSuccess(trailResponse, "GET pending trailing");
  const oco = ocoResponse.data || [];
  const trails = trailResponse.data || [];

  for (const x of pos) {
    const instId = x.instId, avg = +x.avgPx, sz = String(Math.abs(+x.pos));
    const side = (String(x.posSide) === "short" || +x.pos < 0) ? "short" : "long";
    const closeSide = side === "short" ? "buy" : "sell";
    const tk = tick[instId];
    if (!tk) { console.log("??", instId, "tick inconnu, sauté"); continue; }
    const t = Number(tk);
    const exp = side === "short"
      ? { tp: roundTick(avg * 0.975, tk), sl: roundTick(avg * 1.010, tk), act: roundTick(avg * 0.995, tk) }
      : { tp: roundTick(avg * 1.025, tk), sl: roundTick(avg * 0.990, tk), act: roundTick(avg * 1.005, tk) };

    /* --- OCO (TP/SL) --- */
    for (const a of oco.filter(o => o.instId === instId && isHermesOwnedAlgo(o))) {
      const dTp = Math.abs(+a.tpTriggerPx - +exp.tp), dSl = Math.abs(+a.slTriggerPx - +exp.sl);
      if (dTp <= 1.5 * t && dSl <= 1.5 * t) { console.log("ok ", instId, "OCO déjà au tick"); continue; }
      const nv = await req("POST", "/api/v5/trade/order-algo", {
        instId, tdMode: "isolated", side: closeSide, ordType: "oco", sz,
        algoClOrdId: newHermesClientId("oco"),
        tpTriggerPx: exp.tp, tpOrdPx: "-1", slTriggerPx: exp.sl, slOrdPx: "-1", reduceOnly: true
      });
      try { assertOkxSuccess(nv, "POST order-algo OCO"); } catch (e) { console.log("ERR", instId, "OCO", e.message); continue; }
      if (nv?.data?.[0]?.algoId) {
        assertOkxSuccess(await req("POST", "/api/v5/trade/cancel-algos", [{ algoId: a.algoId, instId }]), "POST cancel OCO");
        console.log("FIX", instId, "OCO", a.tpTriggerPx + "/" + a.slTriggerPx, "->", exp.tp + "/" + exp.sl);
      } else console.log("ERR", instId, "OCO", JSON.stringify(nv?.data?.[0] || nv));
      await sleep(250);
    }

    /* --- Trailing (uniquement si pas encore actif) --- */
    for (const a of trails.filter(o => o.instId === instId && isHermesOwnedAlgo(o))) {
      if (+a.moveTriggerPx > 0) { console.log("ok ", instId, "trail ACTIF, non touché (trigger " + a.moveTriggerPx + ")"); continue; }
      const dAct = Math.abs((+a.activePx || 0) - +exp.act);
      if (a.activePx && dAct <= 1.5 * t) { console.log("ok ", instId, "trail déjà au tick"); continue; }
      const nv = await req("POST", "/api/v5/trade/order-algo", {
        instId, tdMode: "isolated", side: closeSide, ordType: "move_order_stop", sz,
        algoClOrdId: newHermesClientId("trail"),
        callbackRatio: "0.005", activePx: exp.act, reduceOnly: true
      });
      try { assertOkxSuccess(nv, "POST order-algo trailing"); } catch (e) { console.log("ERR", instId, "trail", e.message); continue; }
      if (nv?.data?.[0]?.algoId) {
        assertOkxSuccess(await req("POST", "/api/v5/trade/cancel-algos", [{ algoId: a.algoId, instId }]), "POST cancel trailing");
        console.log("FIX", instId, "trail activation", a.activePx, "->", exp.act);
      } else console.log("ERR", instId, "trail", JSON.stringify(nv?.data?.[0] || nv));
      await sleep(250);
    }
  }
  console.log("TERMINE");
}

main().catch(e => { console.error("FATAL", e.message); process.exit(1); });
