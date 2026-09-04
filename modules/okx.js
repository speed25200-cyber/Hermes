"use strict";

/* === ENV AUTOLOAD START === */
(function(){
  try{
    if (process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_PASSPHRASE) return;
    const fs = require("fs"); const path = require("path");
    function findUp(name, start){
      let d = start, root = path.parse(d).root;
      for(;;){
        const p = path.join(d, name);
        if (fs.existsSync(p)) return p;
        if (d === root) return null;
        d = path.dirname(d);
      }
    }
    function loadEnv(p){
      if(!p) return;
      try{
        const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
        for(const line of lines){
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
          if(!m) continue;
          const k = m[1];
          let v = m[2].replace(/^['"]|['"]$/g,"");
          if (!process.env[k]) process.env[k] = v;
        }
      }catch(_){}
    }
    const startCwd = process.cwd();
    loadEnv(findUp(".env.local", startCwd) || findUp(".env.local", __dirname));
    loadEnv(findUp(".env",       startCwd) || findUp(".env",       __dirname));
  }catch(_){}
})();
/* === ENV AUTOLOAD END === */
const https  = require("https");
const crypto = require("crypto");
const { URL } = require("url");

const BASE = (process.env.OKX_BASE_URL || "https://www.okx.com").replace(/\/+$/,"");

function sign(ts, method, requestPath, body, secret){
  const prehash = ts + method.toUpperCase() + requestPath + (body || "");
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

// Private endpoints we use (trade/*, account/*) => exigent auth
function isPrivatePath(p){ return /^\/api\/v5\/(trade|account)\b/.test(p); }

function request(method, path, { qs, body } = {}){
  return new Promise((resolve, reject)=>{
    try{
      // Build request path + query
      const q = qs && Object.keys(qs).length ? ("?" + new URLSearchParams(qs).toString()) : "";
      const reqPath = path + q;
      const url = new URL(BASE + reqPath);

      // Body (POST only)
      const strBody = (method.toUpperCase()==="GET" || body==null) ? "" : JSON.stringify(body);

      // Headers de base
      const headers = { "Content-Type": "application/json" };
      if (String(process.env.OKX_SIMULATED||"") === "1" || String(process.env.OKX_SIMULATED||"").toLowerCase()==="true") {
        headers["x-simulated-trading"] = "1";
      }

      // Auth si nécessaire
      const needAuth = isPrivatePath(path) || !!process.env.OKX_API_KEY;
      if (needAuth){
        const key  = process.env.OKX_API_KEY;
        const sec  = process.env.OKX_API_SECRET;
        const pass = process.env.OKX_PASSPHRASE;
        if (!key || !sec || !pass) {
          return reject(new Error("OKX API keys missing: set OKX_API_KEY, OKX_API_SECRET, OKX_PASSPHRASE"));
        }
        const ts = new Date().toISOString(); // ISO millisecondes, p.ex. 2020-12-08T09:08:57.715Z
        headers["OK-ACCESS-KEY"]        = key;
        headers["OK-ACCESS-PASSPHRASE"] = pass;
        headers["OK-ACCESS-TIMESTAMP"]  = ts;
        headers["OK-ACCESS-SIGN"]       = sign(ts, method, reqPath, strBody, sec);
      }

      const opts = {
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname + (url.search || ""),
        headers
      };

      const req = https.request(opts, (res)=>{
        let buf = "";
        res.on("data", c => buf += c);
        res.on("end", ()=>{
          let parsed = null;
          try { parsed = buf ? JSON.parse(buf) : null; }
          catch(e){ return reject(new Error("Invalid JSON from OKX: " + e.message)); }
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        });
      });
      req.on("error", reject);
      if (strBody) req.write(strBody);
      req.end();
    }catch(e){ reject(e); }
  });
}

async function okxGET(path, params){ return request("GET",  path, { qs: params }); }
const LEGACY_REDUCE_ONLY_CREATIONS = new Set([
  "/api/v5/trade/order",
  "/api/v5/trade/order-algo",
  "/api/v5/trade/batch-orders",
]);
const LEGACY_CANCELLATIONS = new Set([
  "/api/v5/trade/cancel-order",
  "/api/v5/trade/cancel-batch-orders",
  "/api/v5/trade/cancel-algos",
]);
function assertLegacyTradeMutationAllowed(method, targetPath, body){
  if(String(method).toUpperCase()!=="POST") return;
  const route=String(targetPath||"").split("?",1)[0];
  if(!route.startsWith("/api/v5/trade/")) return;
  if(LEGACY_CANCELLATIONS.has(route)) return;
  if(LEGACY_REDUCE_ONLY_CREATIONS.has(route)){
    const rows=Array.isArray(body)?body:[body];
    if(rows.length && rows.every((row)=>row?.reduceOnly===true)) return;
  }
  const error = new Error(LEGACY_REDUCE_ONLY_CREATIONS.has(route)
    ? "LEGACY_REAL_ENTRY_DISABLED_REDUCE_ONLY_REQUIRED"
    : "LEGACY_TRADE_MUTATION_DISABLED_USE_APP_MAIN_GATED_EXECUTOR");
  error.code = "LEGACY_ENTRY_DISABLED";
  throw error;
}
async function okxPOST(path, body){
  assertLegacyTradeMutationAllowed("POST", path, body);
  return request("POST", path, { body });
}

module.exports = { okxGET, okxPOST, assertLegacyTradeMutationAllowed };
