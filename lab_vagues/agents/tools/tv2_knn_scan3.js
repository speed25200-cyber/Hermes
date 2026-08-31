// Agent tv2_knn — port causal simplifié de "Machine Learning: Lorentzian Classification" (jdehorty, TradingView).
// A chaque bougie : vecteur [RSI14, z-score(close vs SMA48), position range 24h, ratio volume vs SMA20],
// features squashées 0..1 (tanh) pour comparabilité. Recherche des k=20 plus proches voisins CAUSAUX
// (Manhattan ou Lorentzienne ln(1+|d|)) dans les <=2000 bougies passées dont le label (retour à +12 bougies)
// est déjà connu. Vote = somme des signes (+1/-1) des k voisins ; signal si vote net >= seuil (majorité forte).
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
  "AAOI","AVGO","TSM","SPY","BILL","GOOGL","AMD","MSFT","INTC"
]);

// Cryptos déjà championnes / déjà porteuses d'un module candidat (règle 1 strat/crypto, liste partagée entre agents).
const TAKEN = new Set([
  "2Z","ACU","AEON","AIXBT","ALLO","APE","ARKM","ARX","AVNT","AXS","BASED","BERA","BICO","BSB","CAP","CRO","CRV","DOS","DOT",
  "EDEN","EDGE","EGLD","ENA","ENSO","ESP","ETHFI","FARTCOIN","FOGO","GPS","GRAM","GRASS","H","HMSTR","HUMA","ICP","JTO","KAITO",
  "KMNO","LAB","LDO","LINEA","LINK","MEGA","MERL","MINA","MMT","MON","MOODENG","MUBARAK","NEAR","NEIRO","NES","O","ORDI",
  "PENDLE","PEOPLE","PIEVERSE","PIPPIN","PLUME","PUMP","RE","RIVER","RLS","SHIB","SOON","SOPH","SPK","SSV","STABLE","TAO",
  "TRIA","UB","USELESS","YGG","ZAMA","ZEN","ZRO","MANA","LUNA","UNI","AAVE","ENS","APR"
]);

function baseId(instId) { return instId.replace(/-USDT-SWAP$/, ""); }

let univers_ids = univers
  .slice() // déjà trié par volume décroissant dans le fichier source
  .map(x => x.instId)
  .filter(id => { const b = baseId(id); return !BLOCKLIST.has(b) && !TAKEN.has(b); });
if (process.env.KNN_LIMIT) univers_ids = univers_ids.slice(0, parseInt(process.env.KNN_LIMIT, 10));

console.error(`Univers libre : ${univers_ids.length} / ${univers.length}`);

// ---------- Indicateurs causaux ----------
function rsi(closes, period) {
  const n = closes.length, out = new Float64Array(n).fill(NaN);
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

// z-score causal de close vs SMA48 (rolling mean/std, fenêtre W)
function zscoreCloseVsSma(closes, W) {
  const n = closes.length, out = new Float64Array(n).fill(NaN);
  let sum = 0, sumsq = 0;
  for (let i = 0; i < n; i++) {
    sum += closes[i]; sumsq += closes[i] * closes[i];
    if (i >= W) { sum -= closes[i - W]; sumsq -= closes[i - W] * closes[i - W]; }
    if (i >= W - 1) {
      const mean = sum / W;
      const variance = Math.max(0, sumsq / W - mean * mean);
      const sd = Math.sqrt(variance);
      out[i] = sd === 0 ? 0 : (closes[i] - mean) / sd;
    }
  }
  return out;
}

// position dans le range (haut/bas) des W dernières bougies (24h = 288 x 5m)
function posInRange(highs, lows, closes, W) {
  const n = highs.length, out = new Float64Array(n).fill(NaN);
  // deques monotones pour min(low)/max(high) glissants O(n)
  const maxDeq = [], minDeq = [];
  for (let i = 0; i < n; i++) {
    while (maxDeq.length && highs[maxDeq[maxDeq.length - 1]] <= highs[i]) maxDeq.pop();
    maxDeq.push(i);
    while (minDeq.length && lows[minDeq[minDeq.length - 1]] >= lows[i]) minDeq.pop();
    minDeq.push(i);
    while (maxDeq[0] <= i - W) maxDeq.shift();
    while (minDeq[0] <= i - W) minDeq.shift();
    if (i >= W - 1) {
      const hi = highs[maxDeq[0]], lo = lows[minDeq[0]];
      out[i] = hi === lo ? 0.5 : (closes[i] - lo) / (hi - lo);
    }
  }
  return out;
}

function volRatio(vols, W) {
  const n = vols.length, out = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += vols[i];
    if (i >= W) sum -= vols[i - W];
    if (i >= W - 1) { const m = sum / W; out[i] = m === 0 ? 1 : vols[i] / m; }
  }
  return out;
}

function tanhSquash(x, scale) { return 0.5 + 0.5 * Math.tanh(x / scale); }

// ---------- Construction des features (4 dims, 0..1) ----------
const RSI_P = 14, SMA_W = 48, RANGE_W = 288, VOL_W = 20;
const START = RANGE_W + 5; // warmup le plus long (position range 24h)
const HORIZON = 12;        // bougies futures pour le label du voisin
const POOL = 2000;         // fenêtre de recherche max
const K = 20;               // nb de voisins

function buildFeatures(c5) {
  const n = c5.length;
  const closes = new Float64Array(n), highs = new Float64Array(n), lows = new Float64Array(n), vols = new Float64Array(n);
  for (let i = 0; i < n; i++) { highs[i] = c5[i][2]; lows[i] = c5[i][3]; closes[i] = c5[i][4]; vols[i] = c5[i][6] ?? c5[i][5]; }
  const r = rsi(closes, RSI_P);
  const z = zscoreCloseVsSma(closes, SMA_W);
  const pr = posInRange(highs, lows, closes, RANGE_W);
  const vr = volRatio(vols, VOL_W);
  const f1 = new Float64Array(n), f2 = new Float64Array(n), f3 = new Float64Array(n), f4 = new Float64Array(n);
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(r[i]) || Number.isNaN(z[i]) || Number.isNaN(pr[i]) || Number.isNaN(vr[i])) continue;
    f1[i] = r[i] / 100;
    f2[i] = tanhSquash(z[i], 2);
    f3[i] = Math.min(1, Math.max(0, pr[i]));
    f4[i] = tanhSquash(vr[i] - 1, 1);
    valid[i] = 1;
  }
  return { closes, f1, f2, f3, f4, valid };
}

// ---------- kNN causal : vote net (-20..+20) par bougie, pour un type de distance donné ----------
function computeVotes(feats, closes, n, distType) {
  const { f1, f2, f3, f4, valid } = feats;
  const voteSum = new Int8Array(n); // -20..+20 tient dans un int8
  // buffers réutilisés pour les k plus proches (insertion bornée)
  const topDist = new Float64Array(K);
  const topLabel = new Int8Array(K);

  for (let i = START; i < n; i++) {
    if (!valid[i]) continue;
    const jMax = i - HORIZON; // le label du voisin j (retour à j+HORIZON) doit être connu au plus tard à i
    if (jMax < START) continue;
    const jMin = Math.max(START, i - POOL);
    let cnt = 0, worst = Infinity, worstIdx = -1;
    const a1 = f1[i], a2 = f2[i], a3 = f3[i], a4 = f4[i];
    for (let j = jMin; j <= jMax; j++) {
      if (!valid[j]) continue;
      let d;
      if (distType === "manhattan") {
        d = Math.abs(a1 - f1[j]) + Math.abs(a2 - f2[j]) + Math.abs(a3 - f3[j]) + Math.abs(a4 - f4[j]);
      } else { // lorentzian
        d = Math.log(1 + Math.abs(a1 - f1[j])) + Math.log(1 + Math.abs(a2 - f2[j])) +
            Math.log(1 + Math.abs(a3 - f3[j])) + Math.log(1 + Math.abs(a4 - f4[j]));
      }
      if (cnt < K) {
        topDist[cnt] = d;
        topLabel[cnt] = closes[j + HORIZON] >= closes[j] ? 1 : -1;
        cnt++;
        if (cnt === K) { // trouver le pire pour la suite
          worst = -Infinity;
          for (let t = 0; t < K; t++) if (topDist[t] > worst) { worst = topDist[t]; worstIdx = t; }
        }
      } else if (d < worst) {
        topDist[worstIdx] = d;
        topLabel[worstIdx] = closes[j + HORIZON] >= closes[j] ? 1 : -1;
        worst = -Infinity;
        for (let t = 0; t < K; t++) if (topDist[t] > worst) { worst = topDist[t]; worstIdx = t; }
      }
    }
    if (cnt < K) continue; // pas assez d'historique valide
    let s = 0;
    for (let t = 0; t < K; t++) s += topLabel[t];
    voteSum[i] = s;
  }
  return voteSum;
}

// ---------- Exits fondateurs (mêmes 4 presets que les autres agents du lab) ----------
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  E3: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  E4: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 24 }
};

// seuils de majorité (netSum sur 20 voisins) : 6->65%, 8->70%, 10->75%, 12->80%, 14->85%
const THRESHOLDS = [6, 8, 10, 12, 14, 16];
const DIST_TYPES = ["manhattan", "lorentzian"];

const results = [];
let done = 0;
const t0 = Date.now();
for (const instId of univers_ids) {
  let c5;
  try {
    c5 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, instId + ".json"), "utf8"));
  } catch (e) { continue; }
  if (!Array.isArray(c5) || c5.length < 2500) continue;
  done++;
  const feats = buildFeatures(c5);
  const n = c5.length;
  for (const distType of DIST_TYPES) {
    const votes = computeVotes(feats, feats.closes, n, distType);
    for (const T of THRESHOLDS) {
     for (const conf of [0, 1]) {
      const sigs = [];
      for (let i = START; i < n; i++) {
        if (votes[i] >= T) { if (conf && !(feats.closes[i] > c5[i][1])) continue; sigs.push({ i5: i, dir: 1 }); }
        else if (votes[i] <= -T) { if (conf && !(feats.closes[i] < c5[i][1])) continue; sigs.push({ i5: i, dir: -1 }); }
      }
      if (sigs.length < 20) continue;
      const mod = { instId, detect: () => sigs };
      for (const [exitName, ex] of Object.entries(EXITS)) {
        mod.exits = ex;
        const r = evaluer(mod, c5);
        if (!r.A || !r.B) continue;
        const worst = Math.min(r.A.esp, r.B.esp);
        const valide = r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15;
        if (worst < 3) continue;
        results.push({
          instId, distType, T, conf, exit: exitName,
          espIS: r.A.esp, espOOS: r.B.esp, wrOOS: r.B.wr, nIS: r.A.n, nOOS: r.B.n, pfOOS: r.B.pf,
          worst, valide
        });
      }
     }
    }
  }
  if (done % 20 === 0) console.error(`... ${done}/${univers_ids.length} cryptos scannées (${((Date.now()-t0)/1000).toFixed(0)}s)`);
}

console.error(`Cryptos scannées : ${done} — lignes >= +3 : ${results.length} — temps total ${((Date.now()-t0)/1000).toFixed(0)}s`);
results.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "rapports", "tv2_knn_scan3_resultats.json"), JSON.stringify(results, null, 1));

const bestPerCrypto = new Map();
for (const r of results) {
  if (!r.valide) continue;
  const cur = bestPerCrypto.get(r.instId);
  if (!cur || r.worst > cur.worst) bestPerCrypto.set(r.instId, r);
}
const top = [...bestPerCrypto.values()].sort((a, b) => b.worst - a.worst).slice(0, 30);
console.log(JSON.stringify(top, null, 1));
