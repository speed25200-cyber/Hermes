// CHANTIER PRÉCISION 1 MINUTE — étape 1 : collecte des bougies 1 m OKX.
// Télécharge 7 jours de bougies 1 m (public, /api/v5/market/history-candles bar=1m)
// pour les cryptos des meilleurs candidats du banc 30 j, dans ../../data1m/.
// Usage : node tools/collecte1m.js          (depuis lab_vagues/agents)
// Format de sortie : [[ts,o,h,l,c,vol],...] ascendant — même convention que data/ et data90/.
const fs = require("fs");
const path = require("path");
const https = require("https");

const DATA1M = path.join(__dirname, "..", "..", "data1m");
const JOURS = 7;
const PAUSE_MS = 300; // respect du rate-limit OKX

// Meilleurs candidats du banc 30 j (JOURNAL_RECHERCHE 30/08) + le record ENSO (60 j).
// worst30 = min(espIS, espOOS) documenté, à titre indicatif seulement.
const CIBLES = [
  { mod: "candidates/web_structure_1.js", instId: "PIEVERSE-USDT-SWAP", worst30: 12.58 },
  { mod: "candidates/web_orb_1.js",       instId: "GPS-USDT-SWAP",      worst30: 11.48 },
  { mod: "candidates/web_vwap_1.js",      instId: "SOON-USDT-SWAP",     worst30: 9.97 },
  { mod: "candidates/web_squeeze_1.js",   instId: "DOT-USDT-SWAP",      worst30: 7.38 },
  { mod: "candidates/web_squeeze_2.js",   instId: "MERL-USDT-SWAP",     worst30: 7.17 },
  { mod: "candidates/web_vwap_2.js",      instId: "ESP-USDT-SWAP",      worst30: 6.96 },
  { mod: "candidates/web_orb_2.js",       instId: "ZAMA-USDT-SWAP",     worst30: 6.62 },
  { mod: "candidates/web_orb_3.js",       instId: "JTO-USDT-SWAP",      worst30: 6.52 },
  { mod: "candidates/web_squeeze_3.js",   instId: "MOODENG-USDT-SWAP",  worst30: 6.48 },
  { mod: "candidates/_record_enso.js",    instId: "ENSO-USDT-SWAP",     worst30: 6.1 },
];

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
    try {
      const r = await get(p);
      if (r.code === "0") return r;
      if (r.code === "50011") { await sleep(1500 * (i + 1)); continue; } // rate-limit
      return r;
    } catch { await sleep(900 * (i + 1)); }
  }
  return { code: "ERR", data: [] };
}

async function collecter1m(instId, depuisTs) {
  const f = path.join(DATA1M, instId + ".json");
  if (fs.existsSync(f)) {
    const rows = JSON.parse(fs.readFileSync(f));
    console.log(`  ${instId} : déjà présent (${rows.length} bougies) — skip`);
    return rows;
  }
  let rows = [], after = "";
  for (let page = 0; page < 250; page++) { // 7 j × 1440 = 10 080 bougies ≈ 101 pages
    const q = `/api/v5/market/history-candles?instId=${instId}&bar=1m&limit=100` + (after ? `&after=${after}` : "");
    const r = await getRetry(q);
    const d = r.data || [];
    if (!d.length) break;
    for (const c of d) rows.push([+c[0], +c[1], +c[2], +c[3], +c[4], +c[5]]);
    const old = +d[d.length - 1][0];
    if (old < depuisTs) break;
    after = String(old);
    await sleep(PAUSE_MS);
  }
  rows = rows.filter(c => c[0] >= depuisTs).sort((a, b) => a[0] - b[0]);
  // dédoublonnage par ts (sécurité pagination)
  const dedup = []; let prev = -1;
  for (const c of rows) { if (c[0] !== prev) dedup.push(c); prev = c[0]; }
  fs.writeFileSync(f, JSON.stringify(dedup));
  const span = dedup.length ? `${new Date(dedup[0][0]).toISOString()} -> ${new Date(dedup[dedup.length - 1][0]).toISOString()}` : "VIDE";
  console.log(`  ${instId} : ${dedup.length} bougies 1m (${span})`);
  return dedup;
}

async function main() {
  fs.mkdirSync(DATA1M, { recursive: true });
  const depuisTs = Date.now() - JOURS * 86400 * 1000;
  console.log(`Collecte 1m OKX — ${JOURS} jours depuis ${new Date(depuisTs).toISOString()} — ${CIBLES.length} instruments`);
  const bilan = [];
  for (const c of CIBLES) {
    const rows = await collecter1m(c.instId, depuisTs);
    bilan.push({ instId: c.instId, bougies: rows.length, de: rows[0]?.[0] ?? null, a: rows[rows.length - 1]?.[0] ?? null });
  }
  const rapDir = path.join(__dirname, "rapports");
  fs.mkdirSync(rapDir, { recursive: true });
  fs.writeFileSync(path.join(rapDir, "minute_collecte.json"),
    JSON.stringify({ genere: new Date().toISOString(), jours: JOURS, depuisTs, bilan }, null, 1));
  console.log("Bilan écrit dans tools/rapports/minute_collecte.json");
}

module.exports = { CIBLES, DATA1M };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
