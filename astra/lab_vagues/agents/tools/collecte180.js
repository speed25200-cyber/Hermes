// 2e TEST ACIDE — COLLECTE : bougies 5 m OKX de la fenêtre J-180 -> J-90 (90 jours
// ANTÉRIEURS à data90/, donc 100 % vierges de toute optimisation) pour les cryptos du
// REGISTRE. Pagination history-candles en arrière depuis T90 (on ne re-télécharge pas
// les 90 j récents), pause 300 ms, retry 50011 — même logique que verif90_harness.
// Sortie : data180/<INSTID>.json (format [[ts,o,h,l,c,vol],...] ascendant) + data180/_meta.json.
// Les cryptos jeunes (ex. O listée 17/06) n'existaient pas -> fichier court/vide, signalé.
const fs = require("fs");
const path = require("path");
const https = require("https");

const DATA180 = path.join(__dirname, "..", "..", "data180");
fs.mkdirSync(DATA180, { recursive: true });

const INSTS = [
  "PIEVERSE-USDT-SWAP", "ENSO-USDT-SWAP", "O-USDT-SWAP", "GRASS-USDT-SWAP",
  "USELESS-USDT-SWAP", "GPS-USDT-SWAP", "SOON-USDT-SWAP", "ESP-USDT-SWAP"
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
    try { const r = await get(p); if (r.code === "0") return r; if (r.code === "50011") { await sleep(1500 * (i + 1)); continue; } return r; }
    catch { await sleep(900 * (i + 1)); }
  }
  return { code: "ERR", data: [] };
}

(async () => {
  // Fenêtre figée à la 1re exécution (rejouable sans dérive) : [T180, T90)
  const metaF = path.join(DATA180, "_meta.json");
  let meta;
  if (fs.existsSync(metaF)) meta = JSON.parse(fs.readFileSync(metaF));
  else meta = { t90: Date.now() - 90 * 86400 * 1000, t180: Date.now() - 180 * 86400 * 1000, insts: {} };
  const { t90, t180 } = meta;
  console.log("Fenêtre 90->180 j :", new Date(t180).toISOString(), "->", new Date(t90).toISOString());

  for (const instId of INSTS) {
    const f = path.join(DATA180, instId + ".json");
    if (fs.existsSync(f)) {
      console.log(instId.padEnd(22), "déjà présent (", JSON.parse(fs.readFileSync(f)).length, "bougies )");
      continue;
    }
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
    const stat = {
      bougies: rows.length, pages, gaps,
      de: rows.length ? new Date(rows[0][0]).toISOString() : null,
      a: rows.length ? new Date(rows[rows.length - 1][0]).toISOString() : null,
      couverture_pct: +(100 * rows.length / 25920).toFixed(1)
    };
    meta.insts[instId] = stat;
    fs.writeFileSync(metaF, JSON.stringify(meta, null, 1));
    console.log(instId.padEnd(22), rows.length, "bougies", stat.couverture_pct + "%", "gaps:" + gaps,
      stat.de ? stat.de.slice(0, 10) + " -> " + stat.a.slice(0, 10) : "(AUCUNE DONNÉE — n'existait pas)");
  }
  console.log("Collecte terminée.");
})();
