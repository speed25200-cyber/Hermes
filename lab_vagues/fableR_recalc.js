// fableR_recalc.js — AUDIT ANGLE 2 : recalcul INDÉPENDANT de l'époque 2 (+19,26 %, n=155 annoncé).
// Réimplémentation from scratch (ne réutilise PAS le banc) :
//   signaux relus de data/sim-logsl.jsonl -> non, directement sim-logs.jsonl ; bougies rechargées ;
//   features recodées ; verrou 12h en TEMPS (pas en index) ; sim recodée.
// Sorties : chiffre central, par jour, par instrument, par côté, raisons de sortie, troncatures,
//   leave-one-day-out, bootstrap par GRAPPE (jour), sensibilité ±1 cran, modèle d'entrée open(i+1), slippage stops.
const fs = require("fs");
const path = require("path");
const LAB = __dirname;
const STEP = 300000, LEV = 15;

/* ---- bougies (fusion identique en esprit : data_fable prioritaire, dédup ts) ---- */
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

/* ---- features 24h à la clôture de la bougie i (fenêtre i-287..i, contiguïté exigée) ---- */
function feat(c5, i) {
  if (i < 288 || c5[i - 288][0] !== c5[i][0] - 288 * STEP) return null;
  let hh = -Infinity, ll = Infinity;
  const vols = [];
  for (let k = i - 287; k <= i; k++) {
    if (c5[k][2] > hh) hh = c5[k][2];
    if (c5[k][3] < ll) ll = c5[k][3];
    vols.push(c5[k][5]);
  }
  vols.sort((a, b) => a - b);
  const med = (vols[143] + vols[144]) / 2;
  return { volSpike: med > 0 ? c5[i][5] / med : 0, rangePos: hh > ll ? (c5[i][4] - ll) / (hh - ll) : 0.5 };
}

/* ---- sim pire-cas (SL avant TP), sortie au close sur trou/fin ---- */
function sim(c5, iEntry, entry, dir, P) {
  const tpPx = P.tp / LEV, slPx = P.sl / LEV, actPx = P.act / LEV, cbPx = P.cb / LEV;
  const slip = P.slipStop || 0; // slippage adverse sur exécution des stops (fraction de prix)
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  let sl = dir > 0 ? entry * (1 - slPx) : entry * (1 + slPx);
  let best = entry, trailed = false;
  let end = Math.min(c5.length - 1, iEntry + Math.round(P.holdH * 12));
  for (let k = iEntry + 1; k <= end; k++) {
    if (c5[k][0] !== c5[k - 1][0] + STEP) return fin(c5[k - 1][4], "GAP", k - 1);
    if (dir > 0 ? c5[k][3] <= sl : c5[k][2] >= sl) {
      const px = dir > 0 ? sl * (1 - slip) : sl * (1 + slip);
      return fin(px, trailed ? "TRAIL" : "SL", k);
    }
    if (dir > 0 ? c5[k][2] >= tp : c5[k][3] <= tp) return fin(tp, "TP", k);
    const cl = c5[k][4];
    if (dir > 0 ? cl > best : cl < best) best = cl;
    if ((dir > 0 ? best / entry - 1 : 1 - best / entry) >= actPx) {
      const t = dir > 0 ? best * (1 - cbPx) : best * (1 + cbPx);
      if (dir > 0 ? t > sl : t < sl) { sl = t; trailed = true; }
    }
  }
  return fin(c5[end][4], end < iEntry + Math.round(P.holdH * 12) ? "EDGE" : "HOLD", end);
  function fin(px, raison, k) {
    return { pnl: (dir > 0 ? px / entry - 1 : 1 - px / entry) - P.cout, raison, kFin: k };
  }
}

/* ---- moteur : applique la formule sur les signaux époque 2 ---- */
function run(sigs, P) {
  const lockUntil = {}; // instId -> ts fin de verrou (12h après l'ENTRÉE, en temps réel)
  const trades = [];
  for (const s of sigs) {
    const [ts, inst, dirSig] = s;
    const nd = -dirSig;
    const c5 = candles(inst);
    if (!c5) continue;
    const t5 = ts - (ts % STEP);
    const i = idxOf(c5, t5);
    if (i < 0) continue;
    const f = feat(c5, i);
    if (!f) continue;
    // garde "2h de bougies devant" (comme le banc, pour comparabilité)
    if (i >= c5.length - 24 || (c5[i + 24] && c5[i + 24][0] !== c5[i][0] + 24 * STEP)) continue;
    if (f.volSpike < P.vol) continue;
    if (!((nd > 0 && f.rangePos < P.rLo) || (nd < 0 && f.rangePos > P.rHi))) continue;
    const tClose = t5 + STEP; // instant de l'entrée (clôture de la bougie signal)
    if (tClose < (lockUntil[inst] || 0)) continue;
    let iE = i, entry;
    if (P.entryMode === "openNext") {
      if (i + 1 >= c5.length || c5[i + 1][0] !== t5 + STEP) continue;
      iE = i + 1; entry = c5[i + 1][1];
      // sim doit inclure la bougie d'entrée elle-même pour openNext : on décale
      const r = simOpen(c5, iE, entry, nd, P);
      lockUntil[inst] = tClose + P.lockH * 3600e3;
      trades.push({ ts, inst, dir: nd, ...r });
      continue;
    }
    entry = c5[i][4];
    const r = sim(c5, iE, entry, nd, P);
    lockUntil[inst] = tClose + P.lockH * 3600e3;
    trades.push({ ts, inst, dir: nd, ...r });
  }
  return trades;
}
// variante openNext : la bougie d'entrée (achetée à l'open) est parcourue elle-même pour SL/TP
function simOpen(c5, k0, entry, dir, P) {
  const c5b = c5; // même logique que sim mais en commençant à k0 (high/low de k0 valides après l'open)
  const tpPx = P.tp / LEV, slPx = P.sl / LEV, actPx = P.act / LEV, cbPx = P.cb / LEV;
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  let sl = dir > 0 ? entry * (1 - slPx) : entry * (1 + slPx);
  let best = entry, trailed = false;
  let end = Math.min(c5b.length - 1, k0 + Math.round(P.holdH * 12));
  for (let k = k0; k <= end; k++) {
    if (k > k0 && c5b[k][0] !== c5b[k - 1][0] + STEP) return fin(c5b[k - 1][4], "GAP", k - 1);
    if (dir > 0 ? c5b[k][3] <= sl : c5b[k][2] >= sl) return fin(sl, trailed ? "TRAIL" : "SL", k);
    if (dir > 0 ? c5b[k][2] >= tp : c5b[k][3] <= tp) return fin(tp, "TP", k);
    const cl = c5b[k][4];
    if (dir > 0 ? cl > best : cl < best) best = cl;
    if ((dir > 0 ? best / entry - 1 : 1 - best / entry) >= actPx) {
      const t = dir > 0 ? best * (1 - cbPx) : best * (1 + cbPx);
      if (dir > 0 ? t > sl : t < sl) { sl = t; trailed = true; }
    }
  }
  return fin(c5b[end][4], end < k0 + Math.round(P.holdH * 12) ? "EDGE" : "HOLD", end);
  function fin(px, raison, k) { return { pnl: (dir > 0 ? px / entry - 1 : 1 - px / entry) - P.cout, raison, kFin: k }; }
}

const agg = t => {
  const n = t.length;
  if (!n) return { n: 0, esp: NaN, wr: NaN };
  const s = t.reduce((a, x) => a + x.pnl, 0);
  return { n, esp: +(100 * LEV * s / n).toFixed(2), wr: +(100 * t.filter(x => x.pnl > 0).length / n).toFixed(1), tot: +(100 * LEV * s).toFixed(1) };
};

(async () => {
  /* ---- signaux époque 2, relus à la source ---- */
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

  const BASE = { vol: 2, rLo: 0.5, rHi: 0.5, tp: 0.80, sl: 0.30, act: 0.30, cb: 0.10, holdH: 12, lockH: 12, cout: 0.0012, entryMode: "close" };
  const T = run(sigs, BASE);
  const A = agg(T);
  console.log("=== RECALCUL INDÉPENDANT ÉPOQUE 2 (formule figée, verrou 12h TEMPS réel) ===");
  console.log(`esp ${A.esp}% · wr ${A.wr}% · n ${A.n} · pnl total ${A.tot} pts de marge   (annoncé : +19,26 % · n 155)`);

  /* ---- vérif du verrou : deux entrées même instrument < 12h ? ---- */
  const last = {}; let viol = 0;
  for (const t of T) { if (last[t.inst] != null && t.ts - last[t.inst] < 12 * 3600e3) viol++; last[t.inst] = t.ts; }
  console.log("violations du verrou 12h dans MA liste de trades :", viol);

  /* ---- par jour + leave-one-day-out ---- */
  const parJour = {};
  for (const t of T) (parJour[new Date(t.ts).toISOString().slice(0, 10)] = parJour[new Date(t.ts).toISOString().slice(0, 10)] || []).push(t);
  console.log("\n--- par jour ---");
  for (const j of Object.keys(parJour).sort()) {
    const a = agg(parJour[j]);
    console.log(` ${j}  esp ${String(a.esp).padStart(7)}% · wr ${String(a.wr).padStart(5)}% · n ${String(a.n).padStart(3)} · total ${String(a.tot).padStart(8)} pts`);
  }
  console.log("--- leave-one-day-out ---");
  for (const j of Object.keys(parJour).sort()) {
    const rest = T.filter(t => new Date(t.ts).toISOString().slice(0, 10) !== j);
    const a = agg(rest);
    console.log(` sans ${j} : esp ${a.esp}% · n ${a.n}`);
  }

  /* ---- bootstrap par grappe (jour) — l'unité indépendante est le JOUR, pas le trade ---- */
  const jours = Object.keys(parJour);
  const means = [];
  for (let b = 0; b < 8000; b++) {
    let s = 0, n = 0;
    for (let k = 0; k < jours.length; k++) {
      const J = parJour[jours[(Math.random() * jours.length) | 0]];
      for (const t of J) { s += t.pnl; n++; }
    }
    means.push(100 * LEV * s / n);
  }
  means.sort((a, b) => a - b);
  console.log(`\nbootstrap par GRAPPE-JOUR (5 grappes, 8000 tirages) : IC90 [${means[400].toFixed(2)}% ; ${means[7600].toFixed(2)}%] · P(esp<0) = ${(100 * means.filter(m => m < 0).length / means.length).toFixed(1)}%`);

  /* ---- concentration par instrument ---- */
  const parInst = {};
  for (const t of T) (parInst[t.inst] = parInst[t.inst] || []).push(t);
  const rows = Object.entries(parInst).map(([id, l]) => [id, l.reduce((a, x) => a + x.pnl, 0) * LEV * 100, l.length]).sort((a, b) => b[1] - a[1]);
  const tot = rows.reduce((a, r) => a + r[1], 0);
  console.log(`\n--- concentration (${rows.length} instruments, total ${tot.toFixed(0)} pts) ---`);
  console.log("top5 :", rows.slice(0, 5).map(r => `${r[0].replace("-USDT-SWAP", "")} +${r[1].toFixed(0)} (n${r[2]})`).join(" · "));
  const top3 = rows.slice(0, 3).map(r => r[0]);
  const sans3 = T.filter(t => !top3.includes(t.inst));
  const a3 = agg(sans3);
  console.log(`sans le top-3 instruments : esp ${a3.esp}% · n ${a3.n}`);
  const posInst = rows.filter(r => r[1] > 0).length;
  console.log(`instruments positifs : ${posInst}/${rows.length}`);

  /* ---- côtés + raisons de sortie + troncatures ---- */
  const L = T.filter(t => t.dir > 0), S = T.filter(t => t.dir < 0);
  console.log(`\nlongs : esp ${agg(L).esp}% n ${L.length} · shorts : esp ${agg(S).esp}% n ${S.length}`);
  const rais = {};
  for (const t of T) rais[t.raison] = (rais[t.raison] || 0) + 1;
  console.log("raisons de sortie :", rais);

  /* ---- simultanéité : entrées groupées dans la même fenêtre 30 min (corrélation de grappe) ---- */
  const buckets = {};
  for (const t of T) { const b = Math.floor(t.ts / (30 * 60e3)); (buckets[b] = buckets[b] || []).push(t); }
  const sizes = Object.values(buckets).map(l => l.length).sort((a, b) => b - a);
  console.log(`fenêtres 30min distinctes : ${sizes.length} · plus grosses grappes : ${sizes.slice(0, 6).join(", ")}`);

  /* ---- SENSIBILITÉ ±1 cran (déviations une-à-une de la formule) ---- */
  console.log("\n--- sensibilité ±1 cran (époque 2) ---");
  const devs = [
    ["BASE (rappel)", {}],
    ["vol>=1.5", { vol: 1.5 }],
    ["vol>=2.5", { vol: 2.5 }],
    ["range 0.4/0.6", { rLo: 0.4, rHi: 0.6 }],
    ["cb 0.05", { cb: 0.05 }],
    ["cb 0.15", { cb: 0.15 }],
    ["sl 0.20", { sl: 0.20 }],
    ["tp 0.50", { tp: 0.50 }],
    ["tp 1.20", { tp: 1.20 }],
    ["hold 6h", { holdH: 6 }],
    ["hold 24h (verrou 24h)", { holdH: 24, lockH: 24 }],
    ["coûts 0.18%", { cout: 0.0018 }],
    ["slippage stops 0.1% px", { slipStop: 0.001 }],
    ["slippage stops 0.3% px", { slipStop: 0.003 }],
    ["ENTRÉE open(i+1) (banc3)", { entryMode: "openNext" }],
  ];
  for (const [nom, d] of devs) {
    const a = agg(run(sigs, { ...BASE, ...d }));
    console.log(` ${nom.padEnd(26)} esp ${String(a.esp).padStart(7)}% · wr ${String(a.wr).padStart(5)}% · n ${String(a.n).padStart(3)}`);
  }
})();
