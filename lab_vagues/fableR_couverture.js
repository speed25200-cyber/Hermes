// fableR_couverture.js — AUDIT ANGLE 2 (époque 2) : couverture réelle + intégrité du mapping signal->bougie.
// Indépendant du banc : relit data/sim-logs.jsonl directement, recharge les bougies lui-même.
// Mesures :
//   1. par jour d'époque 2 : signaux bruts (|score|>=2, dir), instruments, % avec bougies, % évaluables
//   2. mapping : le px du signal (prix live loggé) tombe-t-il dans [low, high] de la bougie mappée ?
//   3. désaccord entre sources de bougies (même ts, OHLC différents) — corruption éventuelle
//   4. alignement : bougies % 5min == 0 ?
const fs = require("fs");
const path = require("path");
const LAB = __dirname;
const STEP = 300000;

const SOURCES = ["data_fable", "data365", "data90", "data"];
function chargerFusion(instId) {
  const seen = new Map();
  let conflits = 0, compare = 0;
  for (const d of SOURCES) {
    const f = path.join(LAB, d, instId + ".json");
    if (!fs.existsSync(f)) continue;
    try {
      const c = JSON.parse(fs.readFileSync(f));
      for (const row of c) {
        if (seen.has(row[0])) {
          const p = seen.get(row[0]);
          compare++;
          // désaccord sur close > 0,1 %
          if (Math.abs(p[4] - row[4]) / p[4] > 0.001) conflits++;
        } else seen.set(row[0], row);
      }
    } catch {}
  }
  const all = [...seen.values()].sort((a, b) => a[0] - b[0]);
  return { c5: all, conflits, compare };
}
function idxOf(c5, t5) {
  let lo = 0, hi = c5.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c5[m][0] === t5) return m; if (c5[m][0] < t5) lo = m + 1; else hi = m - 1; }
  return -1;
}

(async () => {
  // 1. lecture directe des signaux époque 2
  const rl = require("readline").createInterface({ input: fs.createReadStream(path.join(LAB, "..", "data", "sim-logs.jsonl")) });
  const sigs = []; // [ts, instId, dir, score, px]
  for await (const l of rl) {
    try {
      const j = JSON.parse(l);
      if (!j.dir || Math.abs(j.score) < 2) continue;
      const ts = Date.parse(j.ts);
      if (ts >= Date.parse("2026-08-01")) continue; // époque 2 seulement
      sigs.push([ts, j.instId, (j.dir === "long" || j.dir === 1 || j.dir > 0) ? 1 : -1, j.score, j.px]);
    } catch {}
  }
  sigs.sort((a, b) => a[0] - b[0]);
  console.log("signaux époque 2 bruts (|score|>=2, dir):", sigs.length);

  // comparaison avec fable_signaux.json (leur extraction)
  const leurs = JSON.parse(fs.readFileSync(path.join(LAB, "fable_signaux.json"))).filter(s => s[0] < Date.parse("2026-08-01"));
  console.log("dans fable_signaux.json (époque 2):", leurs.length, sigs.length === leurs.length ? "== OK" : "!= DIVERGENCE");

  // 2. par jour x instrument : couverture
  const parJour = {};
  const parInst = {};
  for (const s of sigs) {
    const j = new Date(s[0]).toISOString().slice(0, 10);
    (parJour[j] = parJour[j] || []).push(s);
    (parInst[s[1]] = parInst[s[1]] || []).push(s);
  }

  const cache = {};
  const getC = id => cache[id] || (cache[id] = chargerFusion(id));

  let pxOK = 0, pxHors = 0, pxManque = 0, alignBad = 0, totConf = 0, totComp = 0;
  const horsExemples = [];
  console.log("\n--- par jour d'époque 2 ---");
  console.log("jour        | sig bruts | instrums | inst sans bougies | sig sans bougie mappée | sig mappés");
  for (const j of Object.keys(parJour).sort()) {
    const L = parJour[j];
    const instJ = new Set(L.map(s => s[1]));
    let sansB = new Set(), sansMap = 0, mappes = 0;
    for (const s of L) {
      const { c5 } = getC(s[1]);
      if (c5.length < 300) { sansB.add(s[1]); sansMap++; continue; }
      const t5 = s[0] - (s[0] % STEP);
      const i = idxOf(c5, t5);
      if (i < 0) { sansMap++; continue; }
      mappes++;
      // check px dans [low, high] de la bougie (tolérance 0,5 % pour le spread/mid)
      const lo = c5[i][3], hi = c5[i][2];
      if (typeof s[4] === "number" && s[4] > 0) {
        if (s[4] >= lo * 0.995 && s[4] <= hi * 1.005) pxOK++;
        else { pxHors++; if (horsExemples.length < 8) horsExemples.push([new Date(s[0]).toISOString(), s[1], s[4], lo, hi]); }
      } else pxManque++;
    }
    console.log(j, "|", String(L.length).padStart(8), "|", String(instJ.size).padStart(7), "|", String(sansB.size).padStart(15), "|", String(sansMap).padStart(20), "|", mappes);
  }

  // alignement + conflits sur les instruments touchés
  for (const id of Object.keys(parInst)) {
    const { c5, conflits, compare } = getC(id);
    totConf += conflits; totComp += compare;
    for (const r of c5) if (r[0] % STEP !== 0) { alignBad++; break; }
  }
  console.log("\n--- intégrité ---");
  console.log("px dans [low;high] bougie mappée :", pxOK, "· hors bougie :", pxHors, "· px absent :", pxManque,
    "(taux hors =", (100 * pxHors / (pxOK + pxHors || 1)).toFixed(2) + "%)");
  if (horsExemples.length) { console.log("exemples hors bougie :"); for (const e of horsExemples) console.log("  ", e.join(" ")); }
  console.log("instruments avec bougies non alignées 5min :", alignBad);
  console.log("désaccords close>0,1% entre sources (sur", totComp, "ts partagés):", totConf);

  // 3. instruments d'époque 2 : couverture data365 vs data_fable vs rien
  const d365 = new Set(fs.readdirSync(path.join(LAB, "data365")).map(f => f.replace(".json", "")));
  let n365 = 0, nFable = 0, nRien = 0, sigRien = 0, sig365 = 0;
  const morts = [];
  for (const [id, L] of Object.entries(parInst)) {
    const { c5 } = getC(id);
    if (c5.length < 300) { nRien++; sigRien += L.length; morts.push(id + "(" + L.length + ")"); }
    else if (d365.has(id)) { n365++; sig365 += L.length; }
    else nFable++;
  }
  console.log("\n--- univers époque 2 ---");
  console.log("instruments signalés époque 2 :", Object.keys(parInst).length);
  console.log("  couverts par data365 (20 cryptos):", n365, "· par data_fable/data90/data seulement:", nFable, "· SANS bougies (délistés):", nRien);
  console.log("  signaux bruts sur instruments SANS bougies:", sigRien, "/", sigs.length, "=", (100 * sigRien / sigs.length).toFixed(1) + "%",
    "· sur data365:", (100 * sig365 / sigs.length).toFixed(1) + "%");
  console.log("  délistés/intestables:", morts.join(" "));
})();
