/* PREUVE réelle que les protections tiennent sur OKX (spec client).
   Place UN ordre minimal réel (SOL-USDT-SWAP, taille mini ≈ 1 USDT de notionnel),
   avec TP +50% / SL -20% ATTACHÉS à l'entrée + trailing exchange-side, puis affiche
   les ordres de protection RÉELLEMENT actifs côté OKX. Compte en mode net.
   Lancer :  node PREUVE_protections.js
   Fermer ensuite la mini-position :  node PREUVE_protections.js --close */
require("dotenv").config({ path: process.cwd() + "/.env" });
const crypto = require("crypto"), https = require("https");
const INST = "SOL-USDT-SWAP", LEV = 20;
const SPEC = { tp: 0.50, sl: 0.20, act: 0.10, callback: 0.005 }; // % de marge → prix = /levier ; callback 0,5% prix = 10% marge

function call(method, path, body) {
  return new Promise((res, rej) => {
    const ts = new Date().toISOString();
    const b = body ? JSON.stringify(body) : "";
    const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET).update(ts + method + path + b).digest("base64");
    const req = https.request({ hostname: "www.okx.com", path, method, timeout: 15000, headers: {
      "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
      "Content-Type": "application/json" } },
      r => { let d = ""; r.on("data", c => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch { res({ raw: d.slice(0, 200) }); } }); });
    req.on("error", rej); req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
    if (b) req.write(b); req.end();
  });
}

(async () => {
  const cfg = await call("GET", "/api/v5/account/config");
  const posMode = cfg.data?.[0]?.posMode;
  const hedge = posMode === "long_short_mode";
  console.log("Compte:", posMode);

  if (process.argv.includes("--close")) {
    const pos = await call("GET", "/api/v5/account/positions?instId=" + INST);
    const p0 = pos.data?.[0];
    if (!p0 || Number(p0.pos) === 0) { console.log("Aucune position à fermer."); return; }
    const side = Number(p0.pos) < 0 ? "buy" : "sell";
    const c = await call("POST", "/api/v5/trade/order", { instId: INST, tdMode: "isolated", side,
      ordType: "market", sz: String(Math.abs(Number(p0.pos))), reduceOnly: true, ...(hedge ? { posSide: p0.posSide } : {}) });
    console.log("Fermeture:", c.code, c.data?.[0]?.sMsg || "OK");
    return;
  }

  const mi = await call("GET", "/api/v5/public/instruments?instType=SWAP&instId=" + INST);
  const m = mi.data[0];
  const tk = await call("GET", "/api/v5/market/ticker?instId=" + INST);
  const px = Number(tk.data[0].last);
  const dec = m.tickSz.includes(".") ? m.tickSz.split(".")[1].length : 0, t = Number(m.tickSz);
  const r = x => (Math.round(x / t) * t).toFixed(dec);
  const tp = r(px * (1 + SPEC.tp / LEV)), sl = r(px * (1 - SPEC.sl / LEV)), act = r(px * (1 + SPEC.act / LEV));
  console.log(`Prix ${px} → TP ${tp} (+2,5%), SL ${sl} (-1%), activation trail ${act} (+0,5%)`);

  await call("POST", "/api/v5/account/set-leverage", { instId: INST, lever: String(LEV), mgnMode: "isolated", ...(hedge ? { posSide: "long" } : {}) });

  const ord = await call("POST", "/api/v5/trade/order", {
    instId: INST, tdMode: "isolated", side: "buy", ordType: "market", sz: m.minSz,
    clOrdId: "hmproof" + Date.now().toString(36), ...(hedge ? { posSide: "long" } : {}),
    attachAlgoOrds: [{ tpTriggerPx: tp, tpOrdPx: "-1", slTriggerPx: sl, slOrdPx: "-1", tpTriggerPxType: "last", slTriggerPxType: "last" }]
  });
  console.log("ENTRÉE:", ord.code, ord.data?.[0]?.sMsg || "OK", "ordId", ord.data?.[0]?.ordId || "-");
  if (ord.code !== "0") return console.log("→ ordre refusé, arrêt.");

  const tr = await call("POST", "/api/v5/trade/order-algo", {
    instId: INST, tdMode: "isolated", side: "sell", ordType: "move_order_stop", sz: m.minSz,
    callbackRatio: String(SPEC.callback), activePx: act, reduceOnly: true, ...(hedge ? { posSide: "long" } : {}) });
  console.log("TRAILING:", tr.code, tr.data?.[0]?.sMsg || "OK", "algoId", tr.data?.[0]?.algoId || "-");

  await new Promise(x => setTimeout(x, 1500));
  console.log("\n=== PROTECTIONS ACTIVES SUR OKX ===");
  for (const ot of ["oco", "move_order_stop"]) {
    const ap = await call("GET", "/api/v5/trade/orders-algo-pending?instType=SWAP&ordType=" + ot);
    for (const a of (ap.data || []).filter(a => a.instId === INST))
      console.log(`[${ot}] TP=${a.tpTriggerPx || "-"} SL=${a.slTriggerPx || "-"} callback=${a.callbackRatio || "-"} activation=${a.activePx || "-"} taille=${a.sz}`);
  }
  const pos = await call("GET", "/api/v5/account/positions?instId=" + INST);
  const p0 = pos.data?.[0];
  console.log("POSITION:", p0 ? `${p0.pos} contrat(s) @ ${p0.avgPx} · levier ${p0.lever}` : "aucune");
  console.log("\nPour fermer cette mini-position de test :  node PREUVE_protections.js --close");
})().catch(e => console.log("ERREUR:", e.message));
