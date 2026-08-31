// TEST DÉCISIF : les 15 stratégies retenues (profond2) sont rejouées TELLES QUELLES
// sur les 60 jours PRÉCÉDANT la fenêtre d'étude (jamais vus, zéro re-sélection).
// Si elles restent rentables là-dessus, la confiance monte d'un vrai cran.
const fs = require("fs");
const path = require("path");
const https = require("https");
const DATA90 = path.join(__dirname, "data90");
fs.mkdirSync(DATA90, { recursive: true });
const LEV = 15, COUT_PX = 0.0012, JOURS = 90;

const TOP = require("./profond2_resultats.json").slice(0, 15);

function get(p) {
  return new Promise((res, rej) => {
    https.get({ hostname: "www.okx.com", path: p, headers: { "User-Agent": "hermes-lab" } }, r => {
      let d = ""; r.on("data", c => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getRetry(p) {
  for (let i = 0; i < 5; i++) {
    try { const r = await get(p); if (r.code === "0") return r; if (r.code === "50011") { await sleep(1200 * (i + 1)); continue; } return r; }
    catch { await sleep(800 * (i + 1)); }
  }
  return { code: "ERR", data: [] };
}

/* ---- mêmes outils que profond2 ---- */
function aggreger(c5, mult) {
  const out = [];
  for (let i = 0; i + mult <= c5.length; i += mult) {
    let o = c5[i][1], h = -Infinity, l = Infinity, v = 0;
    for (let k = i; k < i + mult; k++) { h = Math.max(h, c5[k][2]); l = Math.min(l, c5[k][3]); v += c5[k][5]; }
    out.push([c5[i][0], o, h, l, c5[i + mult - 1][4], v, i + mult - 1]);
  }
  return out;
}
function rsi(closes, p = 14) {
  const out = new Array(closes.length).fill(null); let g = 0, pr = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (i <= p) { if (d > 0) g += d; else pr -= d; if (i === p) out[i] = 100 - 100 / (1 + (g / p) / ((pr / p) || 1e-12)); continue; }
    g = (g * (p - 1) + Math.max(d, 0)) / p; pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = 100 - 100 / (1 + g / (pr || 1e-12));
  }
  return out;
}
function smaStd(closes, p) {
  const sma = new Array(closes.length).fill(null), std = new Array(closes.length).fill(null);
  let s = 0, s2 = 0;
  for (let i = 0; i < closes.length; i++) {
    s += closes[i]; s2 += closes[i] * closes[i];
    if (i >= p) { const x = closes[i - p]; s -= x; s2 -= x * x; }
    if (i >= p - 1) { const m = s / p; sma[i] = m; std[i] = Math.sqrt(Math.max(0, s2 / p - m * m)); }
  }
  return { sma, std };
}
function* signaux(c5) {
  const frames = [
    { nom: "5m", c: c5.map((x, i) => [...x.slice(0, 6), i]) },
    { nom: "15m", c: aggreger(c5, 3) },
    { nom: "1h", c: aggreger(c5, 12) }
  ];
  for (const F of frames) {
    const closes = F.c.map(x => x[4]);
    const r = rsi(closes);
    for (const seuil of [15, 20, 25])
      yield { nom: `RSI14-${F.nom} <${seuil}/>${100 - seuil}`,
        list: F.c.map((x, i) => r[i] == null ? null : (r[i] < seuil ? { i5: x[6], dir: 1 } : (r[i] > 100 - seuil ? { i5: x[6], dir: -1 } : null))).filter(Boolean) };
    for (const p of [48, 96]) {
      if (F.c.length < p + 5) continue;
      const { sma, std } = smaStd(closes, p);
      for (const z of [2.5, 3.5])
        yield { nom: `zScore-SMA${p}-${F.nom} |z|>${z}`,
          list: F.c.map((x, i) => (sma[i] == null || !std[i]) ? null : ((closes[i] - sma[i]) / std[i] > z ? { i5: x[6], dir: -1 } : ((closes[i] - sma[i]) / std[i] < -z ? { i5: x[6], dir: 1 } : null))).filter(Boolean) };
    }
    for (const runN of [5, 7]) {
      const list = []; let run = 0, sgn = 0;
      for (let i = 1; i < F.c.length; i++) {
        const d = Math.sign(F.c[i][4] - F.c[i - 1][4]);
        if (d !== 0 && d === sgn) run++; else { run = 1; sgn = d; }
        if (run >= runN && sgn !== 0) list.push({ i5: F.c[i][6], dir: -sgn });
      }
      yield { nom: `${runN} bougies ${F.nom} (fade)`, list };
    }
    {
      const list = [];
      for (let i = 30; i < F.c.length; i++) {
        const [, o, h, l, cl, v] = F.c[i];
        const corps = Math.abs(cl - o), haut = h - Math.max(o, cl), bas = Math.min(o, cl) - l;
        let mv = 0; const from = Math.max(0, i - 30);
        for (let k = from; k < i; k++) mv += F.c[k][5];
        mv /= (i - from);
        if (v > 2 * mv && haut > 2 * corps && haut > 0.004 * cl) list.push({ i5: F.c[i][6], dir: -1 });
        if (v > 2 * mv && bas > 2 * corps && bas > 0.004 * cl) list.push({ i5: F.c[i][6], dir: 1 });
      }
      yield { nom: `mèche épuisement ${F.nom} + vol 2x`, list };
    }
  }
}
function sim(c5, i5, dir, ex) {
  const entry = c5[i5][4];
  const tpPx = ex.tp / LEV, slPx0 = ex.sl / LEV, actPx = ex.act / LEV, cbPx = ex.cb / LEV;
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  let sl = dir > 0 ? entry * (1 - slPx0) : entry * (1 + slPx0);
  let best = entry;
  const end = Math.min(c5.length - 1, i5 + ex.hold);
  for (let k = i5 + 1; k <= end; k++) {
    const hi = c5[k][2], lo = c5[k][3];
    if (dir > 0 ? lo <= sl : hi >= sl) return { pnl: (dir > 0 ? sl / entry - 1 : 1 - sl / entry) - COUT_PX, dur: k - i5 };
    if (dir > 0 ? hi >= tp : lo <= tp) return { pnl: tpPx - COUT_PX, dur: k - i5 };
    const close = c5[k][4];
    if (dir > 0 ? close > best : close < best) best = close;
    if ((dir > 0 ? best / entry - 1 : 1 - best / entry) >= actPx) {
      const t = dir > 0 ? best * (1 - cbPx) : best * (1 + cbPx);
      if (dir > 0 ? t > sl : t < sl) sl = t;
    }
  }
  return { pnl: (dir > 0 ? c5[end][4] / entry - 1 : 1 - c5[end][4] / entry) - COUT_PX, dur: end - i5 };
}
function agg(l) {
  if (!l.length) return null;
  const n = l.length, w = l.filter(t => t.pnl > 0).length;
  const sum = l.reduce((s, t) => s + t.pnl, 0);
  const gp = l.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gn = -l.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  return { n, wr: +(100 * w / n).toFixed(1), esp: +(100 * sum / n * LEV).toFixed(2), pf: gn > 0 ? +(gp / gn).toFixed(2) : 99 };
}

async function main() {
  const depuis = Date.now() - JOURS * 86400 * 1000;
  for (const t of TOP) {
    const fout = path.join(DATA90, t.instId + ".json");
    if (fs.existsSync(fout)) continue;
    let rows = [], after = "";
    for (let page = 0; page < 300; page++) {
      const q = `/api/v5/market/history-candles?instId=${t.instId}&bar=5m&limit=100` + (after ? `&after=${after}` : "");
      const r = await getRetry(q); const d = r.data || [];
      if (!d.length) break;
      for (const c of d) rows.push([+c[0], +c[1], +c[2], +c[3], +c[4], +c[5], +c[6]]);
      const old = +d[d.length - 1][0];
      if (old < depuis) break;
      after = String(old); await sleep(130);
    }
    rows = rows.filter(c => c[0] >= depuis).sort((a, b) => a[0] - b[0]);
    fs.writeFileSync(fout, JSON.stringify(rows));
    console.log("collecté", t.instId, rows.length, "bougies");
    await sleep(130);
  }

  console.log("\n=== VALIDATION VRAIE HORS-ÉCHANTILLON (60 jours JAMAIS VUS, configs figées) ===");
  const bilan = [];
  for (const t of TOP) {
    const c5 = JSON.parse(fs.readFileSync(path.join(DATA90, t.instId + ".json")));
    if (c5.length < 15000) { console.log(t.instId, "historique insuffisant (" + c5.length + " bougies)"); continue; }
    const finVieux = c5[c5.length - 1][0] - 30 * 86400 * 1000;   // exclut les 30 j déjà étudiés
    const R = t.retenue;
    let match = null;
    for (const sig of signaux(c5)) if (sig.nom === R.sig) { match = sig; break; }
    if (!match) { console.log(t.instId, "signal introuvable:", R.sig); continue; }
    const vieux = [];
    let busy = -1;
    for (const s of match.list) {
      if (s.i5 <= busy || s.i5 >= c5.length - 2) continue;
      if (c5[s.i5][0] >= finVieux) continue;                      // uniquement la période jamais vue
      const tr = sim(c5, s.i5, s.dir, R.ex);
      busy = s.i5 + tr.dur;
      vieux.push(tr);
    }
    const V = agg(vieux);
    bilan.push({ instId: t.instId, etude: { wrIS: R.A.wr, wrOOS: R.B.wr, espIS: R.A.esp, espOOS: R.B.esp }, valid60j: V });
    console.log(t.instId.replace("-USDT-SWAP", "").padEnd(9),
      V ? `60j jamais vus: esp ${V.esp}% | wr ${V.wr}% | pf ${V.pf} | n=${V.n}  (étude: ${R.A.esp}/${R.B.esp}%)` : "aucun trade");
  }
  fs.writeFileSync(path.join(__dirname, "valider90_resultats.json"), JSON.stringify(bilan, null, 1));
  const pos = bilan.filter(b => b.valid60j && b.valid60j.esp > 0).length;
  console.log(`\n=== VERDICT : ${pos}/${bilan.length} stratégies restent rentables sur les 60 jours jamais vus ===`);
}

main().catch(e => { console.error("FATAL", e.message); process.exit(1); });
