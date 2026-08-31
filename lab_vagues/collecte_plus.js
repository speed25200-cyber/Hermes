// Extension du gisement de données (demande client 31/08) — 3 axes :
//  1) PROFONDEUR : 365 jours de bougies 5m pour les cryptos assez anciennes
//     (champions + majors) -> data365/ = une 3e fenêtre vierge (jours 180-365).
//  2) LARGEUR : les perpétuels USDT d'OKX AU-DELÀ du top 250 -> data/ (30 j).
//  3) CONTRE-VALIDATION : mêmes cryptos sur BINANCE (klines publiques) -> databinance/
//     (90 j 5m) = même stratégie, autre place de marché, autre microstructure.
const https = require("https");
const fs = require("fs");
const path = require("path");

const D365 = path.join(__dirname, "data365");
const DBIN = path.join(__dirname, "databinance");
const D30 = path.join(__dirname, "data");
[D365, DBIN].forEach(d => fs.mkdirSync(d, { recursive: true }));

const CIBLES = ["PIEVERSE","ENSO","GRASS","GPS","SOON","O","USELESS","AXS","MANA","LUNA","MEGA","NES","BTC","ETH","SOL","XRP","DOT","MANA","KSM","ONDO","PENGU"]
  .filter((v, i, a) => a.indexOf(v) === i).map(x => x + "-USDT-SWAP");

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

async function axe1_profondeur() {
  console.log("=== AXE 1 : 365 jours pour", CIBLES.length, "cryptos ===");
  const depuis = Date.now() - 365 * 86400 * 1000;
  for (const id of CIBLES) {
    const f = path.join(D365, id + ".json");
    if (fs.existsSync(f)) { continue; }
    let rows = [], after = "";
    for (let page = 0; page < 1100; page++) {
      const q = `/api/v5/market/history-candles?instId=${id}&bar=5m&limit=100` + (after ? `&after=${after}` : "");
      const r = await okx(q); const d = r.data || [];
      if (!d.length) break;
      for (const c of d) rows.push([+c[0], +c[1], +c[2], +c[3], +c[4], +c[5]]);
      const old = +d[d.length - 1][0];
      if (old < depuis) break;
      after = String(old); await sleep(150);
    }
    rows = rows.filter(c => c[0] >= depuis).sort((a, b) => a[0] - b[0]);
    fs.writeFileSync(f, JSON.stringify(rows));
    console.log(id.replace("-USDT-SWAP", ""), rows.length, "bougies (", Math.round(rows.length / 288), "jours d'existence )");
  }
}

async function axe2_largeur() {
  console.log("=== AXE 2 : au-delà du top 250 ===");
  const tk = await okx("/api/v5/market/tickers?instType=SWAP");
  const tous = (tk.data || []).filter(t => t.instId.endsWith("-USDT-SWAP")).map(t => t.instId);
  const deja = new Set(fs.readdirSync(D30).map(f => f.replace(".json", "")));
  const manquants = tous.filter(id => !deja.has(id));
  console.log("instruments supplémentaires:", manquants.length);
  const depuis = Date.now() - 30 * 86400 * 1000;
  for (const id of manquants) {
    let rows = [], after = "";
    for (let page = 0; page < 120; page++) {
      const q = `/api/v5/market/history-candles?instId=${id}&bar=5m&limit=100` + (after ? `&after=${after}` : "");
      const r = await okx(q); const d = r.data || [];
      if (!d.length) break;
      for (const c of d) rows.push([+c[0], +c[1], +c[2], +c[3], +c[4], +c[5], +c[6]]);
      const old = +d[d.length - 1][0];
      if (old < depuis) break;
      after = String(old); await sleep(150);
    }
    rows = rows.filter(c => c[0] >= depuis).sort((a, b) => a[0] - b[0]);
    fs.writeFileSync(path.join(D30, id + ".json"), JSON.stringify(rows));
    await sleep(150);
  }
  console.log("axe 2 terminé");
}

async function axe3_binance() {
  console.log("=== AXE 3 : contre-validation Binance (90 j 5m) ===");
  for (const id of CIBLES) {
    const sym = id.replace("-USDT-SWAP", "") + "USDT";
    const f = path.join(DBIN, sym + ".json");
    if (fs.existsSync(f)) continue;
    let rows = [], start = Date.now() - 90 * 86400 * 1000;
    try {
      for (let page = 0; page < 30; page++) {
        const r = await get("fapi.binance.com", `/fapi/v1/klines?symbol=${sym}&interval=5m&limit=1000&startTime=${start}`);
        if (!Array.isArray(r) || !r.length) break;
        for (const c of r) rows.push([+c[0], +c[1], +c[2], +c[3], +c[4], +c[5]]);
        start = r[r.length - 1][0] + 300000;
        if (r.length < 1000) break;
        await sleep(250);
      }
    } catch (e) { console.log(sym, "indisponible sur Binance:", e.message.slice(0, 40)); continue; }
    if (rows.length > 1000) { fs.writeFileSync(f, JSON.stringify(rows)); console.log(sym, rows.length, "bougies Binance"); }
    else console.log(sym, "PAS listé sur Binance Futures (", rows.length, ")");
    await sleep(250);
  }
}

(async () => {
  await axe1_profondeur();
  await axe3_binance();
  await axe2_largeur();
  console.log("COLLECTE PLUS TERMINEE");
})();
