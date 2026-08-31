// TEST ACIDE : rejoue un module candidat TEL QUEL sur les 60 jours PRÉCÉDANT la
// fenêtre d'étude (jamais vus). Télécharge 90 j de bougies 5 m si nécessaire.
// Usage : node verif90_harness.js candidates/mon_idee.js
const fs = require("fs");
const path = require("path");
const https = require("https");
const { evaluer } = require("./harness_lib.js");

const DATA90 = path.join(__dirname, "..", "data90");
fs.mkdirSync(DATA90, { recursive: true });

function get(p) {
  return new Promise((res, rej) => {
    https.get({ hostname: "www.okx.com", path: p, headers: { "User-Agent": "hermes-lab" } }, r => {
      let d = ""; r.on("data", c => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getRetry(p) {
  for (let i = 0; i < 6; i++) {
    try { const r = await get(p); if (r.code === "0") return r; if (r.code === "50011") { await sleep(1500 * (i + 1)); continue; } return r; }
    catch { await sleep(900 * (i + 1)); }
  }
  return { code: "ERR", data: [] };
}

async function assurer90j(instId) {
  const f = path.join(DATA90, instId + ".json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f));
  const depuis = Date.now() - 90 * 86400 * 1000;
  let rows = [], after = "";
  for (let page = 0; page < 300; page++) {
    const q = `/api/v5/market/history-candles?instId=${instId}&bar=5m&limit=100` + (after ? `&after=${after}` : "");
    const r = await getRetry(q); const d = r.data || [];
    if (!d.length) break;
    for (const c of d) rows.push([+c[0], +c[1], +c[2], +c[3], +c[4], +c[5]]);
    const old = +d[d.length - 1][0];
    if (old < depuis) break;
    after = String(old); await sleep(300);
  }
  rows = rows.filter(c => c[0] >= depuis).sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(f, JSON.stringify(rows));
  return rows;
}

(async () => {
  const modPath = process.argv[2];
  if (!modPath) { console.error("usage: node verif90_harness.js <module.js>"); process.exit(1); }
  const mod = require(path.resolve(__dirname, modPath));
  const c5 = await assurer90j(mod.instId);
  if (c5.length < 15000) { console.log(JSON.stringify({ instId: mod.instId, verdict: "HISTORIQUE_INSUFFISANT", bougies: c5.length })); return; }
  const coupure = c5[c5.length - 1][0] - 30 * 86400 * 1000;   // exclut la fenêtre d'étude
  const r = evaluer(mod, c5, { coupureTs: coupure });
  const T = r.all;   // sur la période "vierge", A/B n'ont pas de sens -> tout agrégé
  const out = {
    instId: mod.instId, bougies: c5.length,
    esp60: T?.esp ?? null, wr60: T?.wr ?? null, n60: T?.n ?? 0, pf60: T?.pf ?? null,
    verdict: (T && T.esp > 0 && T.n >= 25) ? "SURVIT" : "RECALE"
  };
  console.log(JSON.stringify(out, null, 1));
})();
