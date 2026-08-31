// fableR_stress.js — AUDIT ANGLE 2, volet 3 : réalisme portefeuille + biais de survivance.
//   A. grappes d'entrées simultanées : pnl par fenêtre 30 min, moyenne équipondérée par jour
//   B. contrainte de capacité : max 10 positions ouvertes en même temps (spec client) -> esp réel
//   C. borne de survivance : conversion signaux->trades des instruments MORTS au rythme observé,
//      scénarios (tous SL / comme le pire jour / moyenne des jours)
const fs = require("fs");
const path = require("path");
const LAB = __dirname;
const STEP = 300000, LEV = 15;

const cache = {};
function candles(instId) {
  if (instId in cache) return cache[instId];
  const seen = new Map();
  for (const d of ["data_fable", "data365", "data90", "data"]) {
    const f = path.join(LAB, d, instId + ".json");
    if (!fs.existsSync(f)) continue;
    try { for (const r of JSON.parse(fs.readFileSync(f))) if (!seen.has(r[0])) seen.set(r[0], r); } catch {}
  }
  const all = [...seen.values()].sort((a, b) => a[0] - b[0]);
  return (cache[instId] = all.length > 300 ? all : null);
}
function idxOf(c5, t5) {
  let lo = 0, hi = c5.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c5[m][0] === t5) return m; if (c5[m][0] < t5) lo = m + 1; else hi = m - 1; }
  return -1;
}
function feat(c5, i) {
  if (i < 288 || c5[i - 288][0] !== c5[i][0] - 288 * STEP) return null;
  let hh = -Infinity, ll = Infinity;
  const vols = [];
  for (let k = i - 287; k <= i; k++) { if (c5[k][2] > hh) hh = c5[k][2]; if (c5[k][3] < ll) ll = c5[k][3]; vols.push(c5[k][5]); }
  vols.sort((a, b) => a - b);
  const med = (vols[143] + vols[144]) / 2;
  return { volSpike: med > 0 ? c5[i][5] / med : 0, rangePos: hh > ll ? (c5[i][4] - ll) / (hh - ll) : 0.5 };
}
const P = { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.10, holdH: 12, cout: 0.0012 };
function sim(c5, i, entry, dir) {
  const tpPx = P.tp / LEV, slPx = P.sl / LEV, actPx = P.act / LEV, cbPx = P.cb / LEV;
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  let sl = dir > 0 ? entry * (1 - slPx) : entry * (1 + slPx);
  let best = entry;
  let end = Math.min(c5.length - 1, i + 144);
  for (let k = i + 1; k <= end; k++) {
    if (c5[k][0] !== c5[k - 1][0] + STEP) { end = k - 1; break; }
    if (dir > 0 ? c5[k][3] <= sl : c5[k][2] >= sl) return { pnl: (dir > 0 ? sl / entry - 1 : 1 - sl / entry) - P.cout, kFin: k };
    if (dir > 0 ? c5[k][2] >= tp : c5[k][3] <= tp) return { pnl: tpPx - P.cout, kFin: k };
    const cl = c5[k][4];
    if (dir > 0 ? cl > best : cl < best) best = cl;
    if ((dir > 0 ? best / entry - 1 : 1 - best / entry) >= actPx) {
      const t = dir > 0 ? best * (1 - cbPx) : best * (1 + cbPx);
      if (dir > 0 ? t > sl : t < sl) sl = t;
    }
  }
  return { pnl: (dir > 0 ? c5[end][4] / entry - 1 : 1 - c5[end][4] / entry) - P.cout, kFin: end };
}

(async () => {
  const rl = require("readline").createInterface({ input: fs.createReadStream(path.join(LAB, "..", "data", "sim-logs.jsonl")) });
  const sigs = [];
  for await (const l of rl) {
    try {
      const j = JSON.parse(l);
      if (!j.dir || Math.abs(j.score) < 2) continue;
      const ts = Date.parse(j.ts);
      if (ts >= Date.parse("2026-08-01")) continue;
      sigs.push([ts, j.instId, (j.dir === "long" || j.dir === 1 || j.dir > 0) ? 1 : -1]);
    } catch {}
  }
  sigs.sort((a, b) => a[0] - b[0]);

  // trades de la formule, avec instant d'entrée et de sortie en temps
  const lockUntil = {};
  const trades = [];
  const parInstJourMappe = new Map(); // (inst|jour) mappé -> nb signaux mappés / nb trades
  for (const s of sigs) {
    const [ts, inst, dirSig] = s;
    const c5 = candles(inst);
    if (!c5) continue;
    const t5 = ts - (ts % STEP);
    const i = idxOf(c5, t5);
    if (i < 0) continue;
    const f = feat(c5, i);
    if (!f) continue;
    if (i >= c5.length - 24 || (c5[i + 24] && c5[i + 24][0] !== c5[i][0] + 24 * STEP)) continue;
    const key = inst + "|" + new Date(ts).toISOString().slice(0, 10);
    const rec = parInstJourMappe.get(key) || { sig: 0, tr: 0 };
    rec.sig++;
    const nd = -dirSig;
    if (f.volSpike >= 2 && ((nd > 0 && f.rangePos < 0.5) || (nd < 0 && f.rangePos > 0.5)) && (t5 + STEP) >= (lockUntil[inst] || 0)) {
      const r = sim(c5, i, c5[i][4], nd);
      lockUntil[inst] = t5 + STEP + 12 * 3600e3;
      trades.push({ ts, tEnt: t5 + STEP, tFin: c5[Math.min(r.kFin, c5.length - 1)][0] + STEP, inst, pnl: r.pnl });
      rec.tr++;
    }
    parInstJourMappe.set(key, rec);
  }
  const agg = t => { const n = t.length; const s = t.reduce((a, x) => a + x.pnl, 0); return { n, esp: +(100 * LEV * s / n).toFixed(2), tot: +(100 * LEV * s).toFixed(1) }; };
  console.log("contrôle : base =", JSON.stringify(agg(trades)));

  /* A. pnl par fenêtre 30 min */
  const buckets = {};
  for (const t of trades) { const b = Math.floor(t.tEnt / 1.8e6); (buckets[b] = buckets[b] || []).push(t); }
  console.log("\n--- A. grappes 30 min (unité de décision réelle) ---");
  const rows = Object.entries(buckets).map(([b, l]) => [new Date(+b * 1.8e6).toISOString().slice(0, 16), l.length, +(100 * LEV * l.reduce((a, x) => a + x.pnl, 0)).toFixed(1)]);
  rows.sort((a, b) => a[0] < b[0] ? -1 : 1);
  for (const r of rows) console.log(` ${r[0]}  n ${String(r[1]).padStart(3)} · total ${String(r[2]).padStart(8)} pts · moy/trade ${(r[2] / r[1]).toFixed(1)}%`);
  const clMeans = rows.map(r => r[2] / r[1]);
  console.log(`grappes positives : ${clMeans.filter(m => m > 0).length}/${clMeans.length} · moyenne équipondérée par grappe : ${(clMeans.reduce((a, b) => a + b, 0) / clMeans.length).toFixed(2)}%`);

  /* B. capacité : max 10 positions simultanées (premier arrivé, premier servi) */
  for (const CAP of [10, 5]) {
    const open = []; // tFin des positions ouvertes
    const kept = [];
    for (const t of trades) {
      for (let k = open.length - 1; k >= 0; k--) if (open[k] <= t.tEnt) open.splice(k, 1);
      if (open.length >= CAP) continue;
      open.push(t.tFin);
      kept.push(t);
    }
    const a = agg(kept);
    console.log(`\n--- B. cap ${CAP} positions simultanées --- esp ${a.esp}% · n ${a.n} · total ${a.tot} pts (vs ${agg(trades).tot} sans cap)`);
  }

  /* C. borne de survivance */
  console.log("\n--- C. instruments morts (sans bougies) ---");
  const morts = {};
  for (const s of sigs) if (!candles(s[1])) { const k = s[1] + "|" + new Date(s[0]).toISOString().slice(0, 10); morts[k] = (morts[k] || 0) + 1; }
  const pairesMortes = Object.keys(morts).length;
  const sigMorts = Object.values(morts).reduce((a, b) => a + b, 0);
  // taux de conversion observé par paire (inst,jour) mappée
  let pairesMappees = 0, tradesMappes = 0;
  for (const { tr } of parInstJourMappe.values()) { pairesMappees++; tradesMappes += tr; }
  const tauxPaire = tradesMappes / pairesMappees;
  const nFantome = Math.round(pairesMortes * tauxPaire);
  console.log(`paires (instrument x jour) mortes : ${pairesMortes} (${sigMorts} signaux) · taux trades/paire observé : ${tauxPaire.toFixed(3)}`);
  console.log(`-> trades fantômes estimés : ~${nFantome}`);
  const base = agg(trades);
  const scen = [
    ["tous en SL (-30,18 pts)", -0.30 / LEV - P.cout],
    ["comme le pire jour (fév : -2,61 pts)", -2.61 / LEV / 100],
    ["neutres (0)", 0],
  ];
  for (const [nom, pnlF] of scen) {
    const tot = trades.reduce((a, x) => a + x.pnl, 0) + nFantome * pnlF;
    const n = trades.length + nFantome;
    console.log(` scénario ${nom.padEnd(38)} esp ${(100 * LEV * tot / n).toFixed(2)}% · n ${n}`);
  }
})();
