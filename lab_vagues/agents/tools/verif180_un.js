// 2e TEST ACIDE — VERSION UNITAIRE : rejoue UN module candidat TEL QUEL sur la fenêtre
// J-180 -> J-90 (data180/, figée par _meta.json — même fenêtre que verif180.js).
// Collecte les bougies manquantes via la même logique que tools/collecte180.js
// (pagination history-candles en arrière depuis t90, pause 300 ms, retry 50011).
// Particularité famille btclag_ : les modules chargent BTC depuis data90/ + data/
// (chemins codés en dur) ; on intercepte EN MÉMOIRE la lecture de data90/BTC-USDT-SWAP.json
// pour y fusionner les bougies BTC de data180/ (aucun fichier existant modifié) — sinon
// beta=NaN sur toute la fenêtre ancienne et « zéro signal » serait un artefact de données.
// Barres identiques à verif90/verif180 : SURVIT si esp > 0 et n >= 25 ;
// HISTORIQUE_INSUFFISANT si < 15 000 bougies. Pas de coupure : fenêtre 100 % vierge, r.all.
// Usage : node tools/verif180_un.js candidates/mon_module.js
const fs = require("fs");
const path = require("path");
const https = require("https");
const { evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));

const DATA180 = path.join(__dirname, "..", "..", "data180");
const DATA90 = path.join(__dirname, "..", "..", "data90");
fs.mkdirSync(DATA180, { recursive: true });
const MIN_BOUGIES = 15000;

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

async function assurer180(instId, meta) {
  const f = path.join(DATA180, instId + ".json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f));
  const { t90, t180 } = meta;
  const seen = new Map();
  let after = String(t90), pages = 0;
  for (; pages < 330; pages++) {
    const q = `/api/v5/market/history-candles?instId=${instId}&bar=5m&limit=100&after=${after}`;
    const r = await getRetry(q); const d = r.data || [];
    if (!d.length) break;
    for (const c of d) seen.set(+c[0], [+c[0], +c[1], +c[2], +c[3], +c[4], +c[5]]);
    const old = +d[d.length - 1][0];
    if (old < t180) break;
    after = String(old); await sleep(300);
  }
  const rows = [...seen.values()].filter(c => c[0] >= t180 && c[0] < t90).sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(f, JSON.stringify(rows));
  let gaps = 0; for (let i = 1; i < rows.length; i++) if (rows[i][0] - rows[i - 1][0] !== 300000) gaps++;
  meta.insts[instId] = {
    bougies: rows.length, pages, gaps,
    de: rows.length ? new Date(rows[0][0]).toISOString() : null,
    a: rows.length ? new Date(rows[rows.length - 1][0]).toISOString() : null,
    couverture_pct: +(100 * rows.length / 25920).toFixed(1)
  };
  fs.writeFileSync(path.join(DATA180, "_meta.json"), JSON.stringify(meta, null, 1));
  return rows;
}

(async () => {
  const modPath = process.argv[2];
  if (!modPath) { console.error("usage: node tools/verif180_un.js <candidates/module.js>"); process.exit(1); }
  const meta = JSON.parse(fs.readFileSync(path.join(DATA180, "_meta.json")));
  const mod = require(path.resolve(__dirname, "..", modPath));

  // BTC de la fenêtre ancienne (requis par la famille btclag_) + fusion en mémoire
  const btc180 = await assurer180("BTC-USDT-SWAP", meta);
  const btc90F = path.join(DATA90, "BTC-USDT-SWAP.json");
  const btc90 = fs.existsSync(btc90F) ? JSON.parse(fs.readFileSync(btc90F)) : [];
  const btcFusion = JSON.stringify(btc180.concat(btc90));
  const origRead = fs.readFileSync;
  fs.readFileSync = function (f, ...args) {
    const s = String(f).replace(/\\/g, "/");
    if (/\/data90\/BTC-USDT-SWAP\.json$/.test(s)) return btcFusion;
    return origRead.call(fs, f, ...args);
  };

  const c5 = await assurer180(mod.instId, meta);
  if (c5.length < MIN_BOUGIES) {
    console.log(JSON.stringify({
      instId: mod.instId, fenetre: { de: new Date(meta.t180).toISOString(), a: new Date(meta.t90).toISOString() },
      verdict: "HISTORIQUE_INSUFFISANT", bougies: c5.length, couverture_pct: +(100 * c5.length / 25920).toFixed(1)
    }, null, 1));
    return;
  }
  const T = evaluer(mod, c5).all;  // fenêtre entièrement vierge -> tout agrégé, pas de coupure
  console.log(JSON.stringify({
    instId: mod.instId, bougies: c5.length,
    fenetre: { de: new Date(meta.t180).toISOString(), a: new Date(meta.t90).toISOString() },
    esp180: T?.esp ?? null, wr180: T?.wr ?? null, n180: T?.n ?? 0, pf180: T?.pf ?? null,
    verdict: (T && T.esp > 0 && T.n >= 25) ? "SURVIT" : "RECALE"
  }, null, 1));
})();
