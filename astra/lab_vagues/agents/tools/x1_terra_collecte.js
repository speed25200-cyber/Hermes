// Collecte 30 j 5m pour les cryptos FRAICHES (au-dela du top 250, hors actions/commodites
// tokenisees identifiees via instCategory OKX == "1"). Ecrit dans ../../data (partage avec le banc).
const https = require("https");
const fs = require("fs");
const path = require("path");

const D30 = path.join(__dirname, "..", "..", "data");
const LISTE = path.join(__dirname, "_terra_fresh.json");

function get(host, p) {
  return new Promise((res, rej) => {
    https.get({ hostname: host, path: p, headers: { "User-Agent": "hermes-lab" } }, r => {
      let d = ""; r.on("data", c => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function okx(p) {
  for (let i = 0; i < 6; i++) {
    try { const r = await get("www.okx.com", p); if (r.code === "0") return r; if (r.code === "50011") { await sleep(1500 * (i + 1)); continue; } return r; }
    catch { await sleep(900 * (i + 1)); }
  }
  return { code: "ERR", data: [] };
}

async function un(id) {
  const f = path.join(D30, id + ".json");
  if (fs.existsSync(f)) return "skip";
  const depuis = Date.now() - 30 * 86400 * 1000;
  let rows = [], after = "";
  for (let page = 0; page < 120; page++) {
    const q = `/api/v5/market/history-candles?instId=${id}&bar=5m&limit=100` + (after ? `&after=${after}` : "");
    const r = await okx(q); const d = r.data || [];
    if (!d.length) break;
    for (const c of d) rows.push([+c[0], +c[1], +c[2], +c[3], +c[4], +c[5], +c[6]]);
    const old = +d[d.length - 1][0];
    if (old < depuis) break;
    after = String(old); await sleep(280);
  }
  rows = rows.filter(c => c[0] >= depuis).sort((a, b) => a[0] - b[0]);
  if (rows.length < 2000) { console.log(id, "INSUFFISANT", rows.length); return "vide"; }
  fs.writeFileSync(f, JSON.stringify(rows));
  console.log(id, rows.length, "bougies");
  return "ok";
}

async function worker(queue, stats) {
  while (queue.length) {
    const id = queue.shift();
    try { stats[await un(id)]++; } catch (e) { console.log(id, "ERREUR", e.message); stats.err++; }
  }
}

async function main() {
  const ids = JSON.parse(fs.readFileSync(LISTE, "utf8"));
  const queue = ids.slice();
  const stats = { ok: 0, skip: 0, vide: 0, err: 0 };
  const CONC = 2;
  await Promise.all(new Array(CONC).fill(0).map(() => worker(queue, stats)));
  console.log("TERMINE. ok=", stats.ok, "skip=", stats.skip, "insuffisant=", stats.vide, "erreurs=", stats.err);
}
main();
