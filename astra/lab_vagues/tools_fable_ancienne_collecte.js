// Collecte ciblée OKX (public, aucune clé) : bougies 5m autour des JOURS où des signaux
// |score|>=2 existent (5 jours discrets : 2025-09-15/17, 2025-10-02, 2025-10-12, 2026-02-07,
// + fenêtre continue 2026-08-29 -> maintenant), pour CHAQUE instrument signalé.
// Fenêtre par jour : [jour - 25h ; jour + 38h] (24h de lookback volume + 12h de hold + marge).
// Sortie : lab_vagues/data_fable/<instId>.json = [[ts,o,h,l,c,vol,volCcy],...] trié, dédupliqué (avec trous entre fenêtres).
const https = require("https");
const fs = require("fs");
const path = require("path");
const LAB = __dirname;
const OUT = path.join(LAB, "data_fable");
fs.mkdirSync(OUT, { recursive: true });

const PAUSE_MS = 140;
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
  for (let i = 0; i < 6; i++) {
    try {
      const r = await get(p);
      if (r.code === "0") return r;
      if (r.code === "50011") { await sleep(1200 * (i + 1)); continue; }
      return r;
    } catch { await sleep(900 * (i + 1)); }
  }
  return { code: "ERR", data: [] };
}

// récupère [de;a] en paginant en arrière depuis "a"
async function fetchWindow(instId, de, a) {
  let rows = [], after = String(a);
  for (let page = 0; page < 60; page++) {
    const q = `/api/v5/market/history-candles?instId=${instId}&bar=5m&limit=100&after=${after}`;
    const r = await getRetry(q);
    const d = r.data || [];
    if (!d.length) break;
    for (const c of d) rows.push([+c[0], +c[1], +c[2], +c[3], +c[4], +c[5], +c[6]]);
    const plusVieux = +d[d.length - 1][0];
    if (plusVieux <= de) break;
    after = String(plusVieux);
    await sleep(PAUSE_MS);
  }
  return rows.filter(c => c[0] >= de && c[0] <= a);
}

(async () => {
  const sig = JSON.parse(fs.readFileSync(path.join(LAB, "fable_signaux.json")));
  const J = 86400000, H = 3600000;
  // fenêtres par instrument : jours (UTC) distincts ayant des signaux -> [jour-25h ; jour+38h], fusion des chevauchements
  const parInst = {};
  for (const s of sig) {
    const day = Math.floor(s[0] / J) * J;
    (parInst[s[1]] = parInst[s[1]] || new Set()).add(day);
  }
  const now = Date.now();
  const travaux = [];
  for (const [instId, days] of Object.entries(parInst)) {
    const wins = [...days].sort((a, b) => a - b).map(d => [d - 25 * H, d + 38 * H]);
    const merged = [];
    for (const w of wins) {
      if (merged.length && w[0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], w[1]);
      else merged.push(w);
    }
    for (const m of merged) m[1] = Math.min(m[1], now);
    travaux.push([instId, merged]);
  }
  const totalWin = travaux.reduce((a, t) => a + t[1].length, 0);
  console.log("instruments:", travaux.length, "· fenêtres à collecter:", totalWin);

  // sharding optionnel : SHARD=k/N -> ne traite que les instruments d'index k modulo N
  const sh = (process.env.SHARD || "0/1").split("/");
  const K = +sh[0], N = +sh[1];
  let done = 0;
  for (let ti = 0; ti < travaux.length; ti++) {
    if (ti % N !== K) { done++; continue; }
    const [instId, wins] = travaux[ti];
    const fout = path.join(OUT, instId + ".json");
    if (fs.existsSync(fout)) { done++; continue; } // reprise
    let all = [];
    for (const [de, a] of wins) all = all.concat(await fetchWindow(instId, de, a));
    const seen = new Set();
    all = all.filter(c => !seen.has(c[0]) && seen.add(c[0])).sort((a, b) => a[0] - b[0]);
    fs.writeFileSync(fout, JSON.stringify(all));
    done++;
    if (done % 10 === 0) console.log(`${done}/${travaux.length}`, instId, all.length, "bougies");
    await sleep(PAUSE_MS);
  }
  console.log("COLLECTE_FABLE_TERMINEE:", done, "instruments dans", OUT);
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
