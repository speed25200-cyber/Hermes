// Télécharge 90 j de bougies 5 m BTC-USDT-SWAP dans data90/ (même logique que
// verif90_harness.assurer90j) — nécessaire aux candidats btclag_ (signal relatif au BTC)
// pour que la future verif90 dispose du BTC sur toute la fenêtre vierge.
const fs = require("fs");
const path = require("path");
const https = require("https");

const DATA90 = path.join(__dirname, "..", "..", "data90");
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

(async () => {
  const instId = "BTC-USDT-SWAP";
  const f = path.join(DATA90, instId + ".json");
  if (fs.existsSync(f)) { console.log("déjà présent:", f, JSON.parse(fs.readFileSync(f)).length, "bougies"); return; }
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
  let gaps = 0; for (let i = 1; i < rows.length; i++) if (rows[i][0] - rows[i - 1][0] !== 300000) gaps++;
  console.log("OK", rows.length, "bougies, gaps:", gaps, new Date(rows[0][0]).toISOString(), "->", new Date(rows[rows.length - 1][0]).toISOString());
})();
