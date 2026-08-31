// Collecte des bougies 5m (30 jours) de tous les perpétuels USDT d'OKX,
// classés par volume 24h. Données publiques uniquement — aucune clé, aucun ordre.
// Sortie : lab_vagues/data/<instId>.json  = [[ts,o,h,l,c,vol,volCcy], ...] du plus ancien au plus récent.
const https = require("https");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "data");
fs.mkdirSync(OUT, { recursive: true });

const JOURS = 30;
const TOP = 250;
const BAR = "5m";
const PAUSE_MS = 130; // ~7,5 req/s, marge sous la limite publique (20 req / 2 s)

function get(p) {
  return new Promise((res, rej) => {
    https.get({ hostname: "www.okx.com", path: p, headers: { "User-Agent": "hermes-lab" } }, r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getRetry(p) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await get(p);
      if (r.code === "0") return r;
      if (r.code === "50011") { await sleep(1200 * (i + 1)); continue; } // rate limit
      return r;
    } catch { await sleep(800 * (i + 1)); }
  }
  return { code: "ERR", data: [] };
}

async function main() {
  const tk = await getRetry("/api/v5/market/tickers?instType=SWAP");
  const univers = (tk.data || [])
    .filter(t => t.instId.endsWith("-USDT-SWAP"))
    .map(t => ({ instId: t.instId, volUsd: Number(t.volCcy24h) * Number(t.last) || 0 }))
    .sort((a, b) => b.volUsd - a.volUsd)
    .slice(0, TOP);
  fs.writeFileSync(path.join(__dirname, "univers.json"), JSON.stringify(univers, null, 1));
  console.log("univers:", univers.length, "instruments (top volume 24h)");

  const depuis = Date.now() - JOURS * 86400 * 1000;
  let done = 0;
  for (const u of univers) {
    const fout = path.join(OUT, u.instId + ".json");
    if (fs.existsSync(fout)) { done++; continue; } // reprise possible après coupure
    let rows = [], after = "";
    for (let page = 0; page < 120; page++) {
      const q = `/api/v5/market/history-candles?instId=${u.instId}&bar=${BAR}&limit=100` + (after ? `&after=${after}` : "");
      const r = await getRetry(q);
      const d = r.data || [];
      if (!d.length) break;
      for (const c of d) rows.push([+c[0], +c[1], +c[2], +c[3], +c[4], +c[5], +c[6]]);
      const plusVieux = +d[d.length - 1][0];
      if (plusVieux < depuis) break;
      after = String(plusVieux);
      await sleep(PAUSE_MS);
    }
    rows = rows.filter(c => c[0] >= depuis).sort((a, b) => a[0] - b[0]);
    fs.writeFileSync(fout, JSON.stringify(rows));
    done++;
    if (done % 10 === 0) console.log(`${done}/${univers.length}`, u.instId, rows.length, "bougies");
    await sleep(PAUSE_MS);
  }
  console.log("COLLECTE TERMINEE:", done, "instruments dans", OUT);
}

main().catch(e => { console.error("FATAL", e.message); process.exit(1); });
