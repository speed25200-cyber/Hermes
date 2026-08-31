// Agent tv2_oscillo2 — Pack OSCILLATEURS 2 (StochRSI extrême, Awesome Oscillator twin peaks,
// Aroon 100/0 épuisé, Chande Momentum ±50, Ease of Movement extrême pondéré volume).
// Combinaisons simples (1 indicateur, 1 confirmation max), exits FONDATEURS seulement.
"use strict";
const fs = require("fs");
const path = require("path");
const { evaluer } = require("../harness_lib.js");

const ROOT = path.join(__dirname, "..", ".."); // lab_vagues/
const DATA_DIR = path.join(ROOT, "data");
const univers = JSON.parse(fs.readFileSync(path.join(ROOT, "univers.json"), "utf8"));

const BLOCKLIST = new Set([
  "AAPL","SPX","TSLA","NVDA","MSTR","SKHYNIX","SKHY","SNDK","CRCL","HOOD","COIN","GOOG","META","AMZN","QQQ","GLD","XAUT","TRUMP",
  "AXTI","MRVL","MU","NBIS","SOXL","SOXS","TQQQ","EWY","CXMT","SAMSUNG","XIAOMI","UNITREE","ZHIPU","MINIMAX","XAU","XAG","XCU",
  "BEAT","BZ","CBRS","CL","CC","CHIP","DRAM","SLX","ROBO","SPCX","SPACE","LITE","OPG","BARD","SKDD","SNXX",
  "AAOI","AVGO","TSM","SPY","BILL"
]);

// Cryptos déjà championnes / déjà porteuses d'un module candidat (règle 1 strat/crypto).
const TAKEN = new Set([
  "2Z","ACU","AEON","AIXBT","ALLO","APE","ARKM","ARX","AVNT","AXS","BASED","BERA","BICO","BSB","CAP","CRO","CRV","DOS","DOT",
  "EDEN","EDGE","EGLD","ENA","ENSO","ESP","ETHFI","FARTCOIN","FOGO","GPS","GRAM","GRASS","H","HMSTR","HUMA","ICP","JTO","KAITO",
  "KMNO","LAB","LDO","LINEA","LINK","MEGA","MERL","MINA","MMT","MON","MOODENG","MUBARAK","NEAR","NEIRO","NES","O","ORDI",
  "PENDLE","PEOPLE","PIEVERSE","PIPPIN","PLUME","PUMP","RE","RIVER","RLS","SHIB","SOON","SOPH","SPK","SSV","STABLE","TAO",
  "TRIA","UB","USELESS","YGG","ZAMA","ZEN","ZRO","MANA","LUNA"
]);

function baseId(instId) { return instId.replace(/-USDT-SWAP$/, ""); }

const univers_ids = univers.map(x => x.instId).filter(id => {
  const b = baseId(id);
  return !BLOCKLIST.has(b) && !TAKEN.has(b);
});

console.error(`Univers libre : ${univers_ids.length} / ${univers.length}`);

// ---------- Indicateurs causaux ----------
function rsi(closes, period) {
  const n = closes.length, out = new Array(n).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= period && i < n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d >= 0 ? d : 0, l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function sma(arr, period) {
  const n = arr.length, out = new Array(n).fill(null);
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (arr[i] == null) { sum = 0; cnt = 0; continue; }
    sum += arr[i]; cnt++;
    if (i >= period) { if (arr[i - period] != null) { sum -= arr[i - period]; cnt--; } }
    if (cnt >= period) out[i] = sum / period;
  }
  return out;
}

function stochRsiKD(closes, rsiPeriod, stochPeriod, kSmooth, dSmooth) {
  const r = rsi(closes, rsiPeriod);
  const n = closes.length, raw = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (r[i] == null) continue;
    let lo = Infinity, hi = -Infinity, ok = true;
    for (let k = i - stochPeriod + 1; k <= i; k++) {
      if (k < 0 || r[k] == null) { ok = false; break; }
      if (r[k] < lo) lo = r[k];
      if (r[k] > hi) hi = r[k];
    }
    if (!ok) continue;
    raw[i] = hi === lo ? 50 : 100 * (r[i] - lo) / (hi - lo);
  }
  const K = sma(raw, kSmooth), D = sma(K, dSmooth);
  return { K, D };
}

function awesomeOsc(highs, lows) {
  const n = highs.length, med = new Array(n);
  for (let i = 0; i < n; i++) med[i] = (highs[i] + lows[i]) / 2;
  const s5 = sma(med, 5), s34 = sma(med, 34);
  const ao = new Array(n).fill(null);
  for (let i = 0; i < n; i++) if (s5[i] != null && s34[i] != null) ao[i] = s5[i] - s34[i];
  return ao;
}

// pics/creux confirmés causalement (fenêtre L de chaque côté)
function extremesConfirmed(series, L) {
  const n = series.length, peaks = [], troughs = [];
  for (let i = L; i < n; i++) {
    const p = i - L; // candidat confirmé à l'index i (= p+L), causal
    if (series[p] == null) continue;
    let isMax = true, isMin = true, ok = true;
    for (let k = p - L; k <= p + L; k++) {
      if (k < 0 || k >= n || series[k] == null) { ok = false; break; }
      if (k === p) continue;
      if (series[k] > series[p]) isMax = false;
      if (series[k] < series[p]) isMin = false;
    }
    if (!ok) continue;
    if (isMax) peaks.push({ i, p, val: series[p] });
    else if (isMin) troughs.push({ i, p, val: series[p] });
  }
  return { peaks, troughs };
}

function aroon(highs, lows, period) {
  const n = highs.length, up = new Array(n).fill(null), down = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    let hiIdx = i, loIdx = i, hiV = -Infinity, loV = Infinity;
    for (let k = i - period; k <= i; k++) {
      if (highs[k] > hiV) { hiV = highs[k]; hiIdx = k; }
      if (lows[k] < loV) { loV = lows[k]; loIdx = k; }
    }
    up[i] = 100 * (period - (i - hiIdx)) / period;
    down[i] = 100 * (period - (i - loIdx)) / period;
  }
  return { up, down };
}

function cmo(closes, period) {
  const n = closes.length, out = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    let up = 0, down = 0;
    for (let k = i - period + 1; k <= i; k++) {
      const d = closes[k] - closes[k - 1];
      if (d >= 0) up += d; else down -= d;
    }
    out[i] = (up + down) === 0 ? 0 : 100 * (up - down) / (up + down);
  }
  return out;
}

function easeOfMovement(highs, lows, vols, period) {
  const n = highs.length, raw = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const distMoved = (highs[i] + lows[i]) / 2 - (highs[i - 1] + lows[i - 1]) / 2;
    const range = highs[i] - lows[i];
    if (range <= 0) continue;
    const boxRatio = (vols[i] / 1e8) / range;
    if (boxRatio === 0) continue;
    raw[i] = distMoved / boxRatio;
  }
  return sma(raw, period);
}

function zscore(series, W) {
  const n = series.length, out = new Array(n).fill(null);
  for (let i = W; i < n; i++) {
    let sum = 0, cnt = 0, ok = true;
    for (let k = i - W; k < i; k++) { if (series[k] == null) { ok = false; break; } sum += series[k]; cnt++; }
    if (!ok || cnt < W || series[i] == null) continue;
    const mean = sum / cnt;
    let sq = 0;
    for (let k = i - W; k < i; k++) sq += (series[k] - mean) ** 2;
    const sd = Math.sqrt(sq / cnt);
    if (sd === 0) continue;
    out[i] = (series[i] - mean) / sd;
  }
  return out;
}

// ---------- Détecteurs (signaux causaux) ----------
function detStochRsi(c5, opts) {
  const closes = c5.map(x => x[4]);
  const { K, D } = stochRsiKD(closes, 14, 14, 3, 3);
  const T = opts.T, conf = opts.conf, out = [];
  for (let i = 101; i < c5.length; i++) {
    if (K[i] == null || D[i] == null || K[i - 1] == null || D[i - 1] == null) continue;
    // croisement K/D EN ZONE extrême (survente/surachat)
    const crossUp = K[i - 1] <= D[i - 1] && K[i] > D[i] && K[i] < T;
    const crossDown = K[i - 1] >= D[i - 1] && K[i] < D[i] && K[i] > (100 - T);
    if (crossUp) { if (conf && !(c5[i][4] > c5[i - 1][4])) continue; out.push({ i5: i, dir: 1 }); }
    else if (crossDown) { if (conf && !(c5[i][4] < c5[i - 1][4])) continue; out.push({ i5: i, dir: -1 }); }
  }
  return out;
}

function detAoTwinPeaks(c5, opts) {
  const highs = c5.map(x => x[2]), lows = c5.map(x => x[3]);
  const ao = awesomeOsc(highs, lows);
  const { peaks, troughs } = extremesConfirmed(ao, opts.L);
  const conf = opts.conf, out = [];
  for (let k = 1; k < peaks.length; k++) {
    const a = peaks[k - 1], b = peaks[k];
    if (a.val > 0 && b.val > 0 && b.val < a.val) {
      const i = b.i;
      if (conf && !(c5[i][4] < c5[i - 1][4])) continue;
      out.push({ i5: i, dir: -1 });
    }
  }
  for (let k = 1; k < troughs.length; k++) {
    const a = troughs[k - 1], b = troughs[k];
    if (a.val < 0 && b.val < 0 && b.val > a.val) {
      const i = b.i;
      if (conf && !(c5[i][4] > c5[i - 1][4])) continue;
      out.push({ i5: i, dir: 1 });
    }
  }
  return out;
}

function detAroonExhaust(c5, opts) {
  const highs = c5.map(x => x[2]), lows = c5.map(x => x[3]);
  const { up, down } = aroon(highs, lows, opts.period);
  const S = opts.sustain, conf = opts.conf, out = [];
  let streakUp = 0, streakDown = 0;
  for (let i = 0; i < c5.length; i++) {
    if (up[i] == null) continue;
    const wasFullUp = streakUp >= S, wasFullDown = streakDown >= S;
    if (wasFullUp && up[i] < 100) {
      if (!conf || c5[i][4] < c5[i - 1][4]) out.push({ i5: i, dir: -1 });
    }
    if (wasFullDown && down[i] < 100) {
      if (!conf || c5[i][4] > c5[i - 1][4]) out.push({ i5: i, dir: 1 });
    }
    streakUp = (up[i] === 100 && down[i] === 0) ? streakUp + 1 : 0;
    streakDown = (down[i] === 100 && up[i] === 0) ? streakDown + 1 : 0;
  }
  return out;
}

function detCmoReclaim(c5, opts) {
  const closes = c5.map(x => x[4]);
  const c = cmo(closes, opts.period);
  const T = opts.T, conf = opts.conf, out = [];
  for (let i = opts.period + 1; i < c5.length; i++) {
    if (c[i] == null || c[i - 1] == null) continue;
    if (c[i - 1] <= -T && c[i] > -T) {
      if (conf && !(c5[i][4] > c5[i - 1][4])) continue;
      out.push({ i5: i, dir: 1 });
    } else if (c[i - 1] >= T && c[i] < T) {
      if (conf && !(c5[i][4] < c5[i - 1][4])) continue;
      out.push({ i5: i, dir: -1 });
    }
  }
  return out;
}

function detEomExtreme(c5, opts) {
  const highs = c5.map(x => x[2]), lows = c5.map(x => x[3]), vols = c5.map(x => x[5]);
  const eom = easeOfMovement(highs, lows, vols, 14);
  const z = zscore(eom, opts.W);
  const T = opts.T, conf = opts.conf, out = [];
  for (let i = 1; i < c5.length; i++) {
    if (z[i] == null || z[i - 1] == null) continue;
    if (z[i - 1] <= -T && z[i] > -T) {
      if (conf && !(c5[i][4] > c5[i - 1][4])) continue;
      out.push({ i5: i, dir: 1 });
    } else if (z[i - 1] >= T && z[i] < T) {
      if (conf && !(c5[i][4] < c5[i - 1][4])) continue;
      out.push({ i5: i, dir: -1 });
    }
  }
  return out;
}

// ---------- Exits fondateurs (grilles grossières, pas de balayage a posteriori) ----------
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  E3: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  E4: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 24 }
};

const FAMILIES = [
  { fam: "stochrsi", det: detStochRsi, grid: () => { const g = []; for (const T of [5, 7, 10, 15]) for (const conf of [0, 1]) g.push({ T, conf }); return g; } },
  { fam: "ao_twin", det: detAoTwinPeaks, grid: () => { const g = []; for (const L of [3, 5, 8]) for (const conf of [0, 1]) g.push({ L, conf }); return g; } },
  { fam: "aroon_exh", det: detAroonExhaust, grid: () => { const g = []; for (const period of [14, 20, 25]) for (const sustain of [3, 5]) for (const conf of [0, 1]) g.push({ period, sustain, conf }); return g; } },
  { fam: "cmo_reclaim", det: detCmoReclaim, grid: () => { const g = []; for (const period of [14, 20]) for (const T of [40, 50, 60]) for (const conf of [0, 1]) g.push({ period, T, conf }); return g; } },
  { fam: "eom_extreme", det: detEomExtreme, grid: () => { const g = []; for (const W of [48, 96, 144, 288]) for (const T of [1.5, 2, 2.5]) for (const conf of [0, 1]) g.push({ W, T, conf }); return g; } }
];

const results = [];
let done = 0;
for (const instId of univers_ids) {
  let c5;
  try {
    c5 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, instId + ".json"), "utf8"));
  } catch (e) { continue; }
  if (!Array.isArray(c5) || c5.length < 2000) continue;
  done++;
  for (const F of FAMILIES) {
    for (const opts of F.grid()) {
      let sigs;
      try { sigs = F.det(c5, opts); } catch (e) { continue; }
      if (!sigs || sigs.length < 20) continue;
      const mod = { instId, detect: () => sigs };
      for (const [exitName, ex] of Object.entries(EXITS)) {
        mod.exits = ex;
        const r = evaluer(mod, c5);
        if (!r.A || !r.B) continue;
        const worst = Math.min(r.A.esp, r.B.esp);
        const valide = r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15;
        if (worst < 3) continue; // ne garder que ce qui approche la barre
        results.push({
          fam: F.fam, instId, opts, exit: exitName,
          espIS: r.A.esp, espOOS: r.B.esp, wrOOS: r.B.wr, nIS: r.A.n, nOOS: r.B.n, pfOOS: r.B.pf,
          worst, valide
        });
      }
    }
  }
  if (done % 40 === 0) console.error(`... ${done}/${univers_ids.length} cryptos scannées`);
}

console.error(`Cryptos scannées : ${done} — lignes >= +3 : ${results.length}`);
results.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "rapports", "tv2_oscillo2_scan_resultats.json"), JSON.stringify(results, null, 1));

// top par crypto (une seule ligne, la meilleure)
const bestPerCrypto = new Map();
for (const r of results) {
  if (!r.valide) continue;
  const cur = bestPerCrypto.get(r.instId);
  if (!cur || r.worst > cur.worst) bestPerCrypto.set(r.instId, r);
}
const top = [...bestPerCrypto.values()].sort((a, b) => b.worst - a.worst).slice(0, 30);
console.log(JSON.stringify(top, null, 1));
