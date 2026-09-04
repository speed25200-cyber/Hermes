/* Ancienne preuve manuelle OKX, neutralisee pour les ouvertures.
   La seule operation reelle conservee est une fermeture reduce-only explicite :
   node PREUVE_protections.js --close */
require("dotenv").config({ path: process.cwd() + "/.env" });
const crypto = require("crypto"), https = require("https");
const INST = "SOL-USDT-SWAP";

function call(method, path, body) {
  if (String(method).toUpperCase() === "POST"
      && /^\/api\/v5\/trade\/order(?:-algo)?$/.test(String(path))
      && body?.reduceOnly !== true) {
    throw new Error("LEGACY_REAL_ENTRY_DISABLED_REDUCE_ONLY_REQUIRED");
  }
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
  if (!process.argv.includes("--close")) {
    console.error("[HERMES] PREUVE_protections: ouverture reelle desactivee; seul --close reduce-only est autorise.");
    process.exitCode = 2;
    return;
  }
  const cfg = await call("GET", "/api/v5/account/config");
  const posMode = cfg.data?.[0]?.posMode;
  const hedge = posMode === "long_short_mode";
  console.log("Compte:", posMode);

  const pos = await call("GET", "/api/v5/account/positions?instId=" + INST);
  const p0 = pos.data?.[0];
  if (!p0 || Number(p0.pos) === 0) { console.log("Aucune position a fermer."); return; }
  const side = Number(p0.pos) < 0 ? "buy" : "sell";
  const c = await call("POST", "/api/v5/trade/order", { instId: INST, tdMode: "isolated", side,
    ordType: "market", sz: String(Math.abs(Number(p0.pos))), reduceOnly: true, ...(hedge ? { posSide: p0.posSide } : {}) });
  console.log("Fermeture reduce-only:", c.code, c.data?.[0]?.sMsg || "OK");
})().catch(e => console.log("ERREUR:", e.message));
