// Agent x2_adaptatif : SEUILS ADAPTATIFS PAR CRYPTO (jamais testé).
// Au lieu de seuils absolus (z>2.5, mèche>0.4%), le seuil est calibré sur LA distribution
// PROPRE de CHAQUE crypto : percentile empirique glissant 7 j (2016 bougies 5m), recalibré
// chaque jour (causal : la fenêtre [d-2016, d) ne contient jamais la journée courante).
// 4 familles de déclencheurs simples, toutes en FADE (mean-reversion) :
//   MECHE  : mèche dominante (haute ou basse) > percentile P de SES mèches -> fade
//   RANGE  : range de bougie (H-L)/C > percentile P de SES ranges -> fade la bougie
//   SERIE  : |retour cumulé du run en cours| > percentile P de SES runs -> fade le run
//   EXCES  : |retour sur W bougies| > percentile P de SES excès W-bougies -> fade
// Confirmation optionnelle : volume (volCcy) > percentile P85 de SON volume (même calibrage).
// Exits FONDATEURS seulement (pas de balayage de sorties a posteriori) :
//   E1 tp80/act30/hold12, E2 tp60/act20/hold8.
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require("../harness_lib.js");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const CAND_DIR = path.join(__dirname, "..", "candidates");

const BLOCKLIST = new Set(["AAPL","SPX","TSLA","NVDA","MSTR","SKHYNIX","SKHY","SNDK","CRCL","HOOD","COIN",
  "GOOG","GOOGL","META","AMZN","MSFT","AMD","INTC","QQQ","GLD","XAUT","TRUMP","AXTI","MRVL","MU","NBIS",
  "SOXL","SOXS","TQQQ","EWY","CXMT","SAMSUNG","XIAOMI","UNITREE","ZHIPU","MINIMAX","XAU","XAG","XCU",
  "BEAT","BZ","CBRS","CL","CC","CHIP","DRAM","SLX","ROBO","SPCX","SPACE","LITE","OPG","BARD","SKDD",
  "SNXX","AAOI","AVGO","TSM","SPY","BILL"]);

function dejaChampionnees() {
  const used = new Set();
  for (const f of fs.readdirSync(CAND_DIR)) {
    if (!f.endsWith(".js")) continue;
    try {
      const mod = require(path.join(CAND_DIR, f));
      if (mod && mod.instId) used.add(mod.instId);
    } catch (e) { /* module cassé (ex _opt_O.js) : ignoré */ }
  }
  return used;
}

const E1 = { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 };
const E2 = { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 };
const EXITS = { E1, E2 };

const CALIB = 2016; // 7 j glissants (288 bougies/j * 7)
const STEP = 288;   // recalibrage quotidien

function percentileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return Infinity;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sorted[idx];
}

// Précalcule toutes les métriques causales + les seuils par bloc-jour pour une crypto.
function precompute(c5) {
  const n = c5.length;
  const o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n);
  for (let i = 0; i < n; i++) { o[i] = c5[i][1]; h[i] = c5[i][2]; l[i] = c5[i][3]; c[i] = c5[i][4]; }
  const volCcy = new Float64Array(n);
  for (let i = 0; i < n; i++) volCcy[i] = c5[i][6];

  const wickDom = new Float64Array(n);   // mèche dominante en % du close
  const lowerW = new Float64Array(n), upperW = new Float64Array(n);
  const rangePct = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lw = (Math.min(o[i], c[i]) - l[i]) / c[i] * 100;
    const uw = (h[i] - Math.max(o[i], c[i])) / c[i] * 100;
    lowerW[i] = lw; upperW[i] = uw;
    wickDom[i] = Math.max(lw, uw);
    rangePct[i] = (h[i] - l[i]) / c[i] * 100;
  }

  const runLen = new Int32Array(n);
  const runRetAbs = new Float64Array(n);
  const runSign = new Int8Array(n);
  let prevSign = 0;
  for (let i = 1; i < n; i++) {
    const ret = c[i] / c[i - 1] - 1;
    let s = ret > 0 ? 1 : (ret < 0 ? -1 : prevSign);
    if (s === prevSign && s !== 0) runLen[i] = runLen[i - 1] + 1;
    else runLen[i] = 1;
    runSign[i] = s;
    prevSign = s;
    const startBase = i - runLen[i]; // index juste AVANT le début du run (>=0 garanti car runLen[i]<=i)
    const base = startBase >= 0 ? c[startBase] : c[0];
    runRetAbs[i] = Math.abs(c[i] / base - 1) * 100;
  }

  const W_LIST = [24, 48];
  const retW = {};
  for (const W of W_LIST) {
    const arr = new Float64Array(n);
    for (let i = W; i < n; i++) arr[i] = (c[i] / c[i - W] - 1) * 100;
    retW[W] = arr;
  }

  // Seuils par bloc-jour (causal, fenêtre [d-CALIB, d))
  const nBlocks = Math.max(0, Math.floor((n - CALIB) / STEP) + 1);
  const th = {
    wick90: new Float64Array(nBlocks), wick95: new Float64Array(nBlocks),
    range90: new Float64Array(nBlocks), range95: new Float64Array(nBlocks),
    serie90: new Float64Array(nBlocks), serie95: new Float64Array(nBlocks),
    exces24_90: new Float64Array(nBlocks), exces24_95: new Float64Array(nBlocks),
    exces48_90: new Float64Array(nBlocks), exces48_95: new Float64Array(nBlocks),
    vol85: new Float64Array(nBlocks),
  };
  for (let b = 0; b < nBlocks; b++) {
    const d = CALIB + b * STEP;
    const ws = d - CALIB, we = d; // [ws, we)
    const wick = Array.from(wickDom.slice(ws, we)).sort((a, b2) => a - b2);
    const rng = Array.from(rangePct.slice(ws, we)).sort((a, b2) => a - b2);
    const ser = Array.from(runRetAbs.slice(ws, we)).sort((a, b2) => a - b2);
    const e24 = Array.from(retW[24].slice(ws, we)).map(Math.abs).sort((a, b2) => a - b2);
    const e48 = Array.from(retW[48].slice(ws, we)).map(Math.abs).sort((a, b2) => a - b2);
    const vol = Array.from(volCcy.slice(ws, we)).sort((a, b2) => a - b2);
    th.wick90[b] = percentileSorted(wick, 90); th.wick95[b] = percentileSorted(wick, 95);
    th.range90[b] = percentileSorted(rng, 90); th.range95[b] = percentileSorted(rng, 95);
    th.serie90[b] = percentileSorted(ser, 90); th.serie95[b] = percentileSorted(ser, 95);
    th.exces24_90[b] = percentileSorted(e24, 90); th.exces24_95[b] = percentileSorted(e24, 95);
    th.exces48_90[b] = percentileSorted(e48, 90); th.exces48_95[b] = percentileSorted(e48, 95);
    th.vol85[b] = percentileSorted(vol, 85);
  }

  return { n, o, c, h, l, volCcy, lowerW, upperW, rangePct, runLen, runRetAbs, runSign, retW, th, nBlocks };
}

function blockOf(i, nBlocks) {
  const b = Math.floor((i - CALIB) / STEP);
  if (b < 0) return -1;
  return b < nBlocks ? b : nBlocks - 1;
}

function detectWick(P, pct, volConfirm) {
  return (c5) => {
    const out = [];
    const key90 = "wick90", key95 = "wick95";
    const wkKey = pct === 90 ? key90 : key95;
    for (let i = CALIB; i < c5.length - 2; i++) {
      const b = blockOf(i, P.nBlocks);
      if (b < 0) continue;
      const thw = P.th[wkKey][b];
      if (!isFinite(thw)) continue;
      if (volConfirm) {
        const thv = P.th.vol85[b];
        if (!(P.volCcy[i] > thv)) continue;
      }
      if (P.lowerW[i] > thw) out.push({ i5: i, dir: 1 });
      else if (P.upperW[i] > thw) out.push({ i5: i, dir: -1 });
    }
    return out;
  };
}

function detectRange(P, pct, volConfirm) {
  const rkKey = pct === 90 ? "range90" : "range95";
  return (c5) => {
    const out = [];
    for (let i = CALIB; i < c5.length - 2; i++) {
      const b = blockOf(i, P.nBlocks);
      if (b < 0) continue;
      const thr = P.th[rkKey][b];
      if (!isFinite(thr)) continue;
      if (P.rangePct[i] <= thr) continue;
      if (volConfirm && !(P.volCcy[i] > P.th.vol85[b])) continue;
      const o = P.o[i], c = P.c[i];
      if (c > o) out.push({ i5: i, dir: -1 });
      else if (c < o) out.push({ i5: i, dir: 1 });
    }
    return out;
  };
}

function detectSerie(P, pct, volConfirm) {
  const skKey = pct === 90 ? "serie90" : "serie95";
  return (c5) => {
    const out = [];
    for (let i = CALIB; i < c5.length - 2; i++) {
      if (P.runLen[i] < 2) continue;
      const b = blockOf(i, P.nBlocks);
      if (b < 0) continue;
      const ths = P.th[skKey][b];
      if (!isFinite(ths)) continue;
      if (P.runRetAbs[i] <= ths) continue;
      if (volConfirm && !(P.volCcy[i] > P.th.vol85[b])) continue;
      out.push({ i5: i, dir: P.runSign[i] > 0 ? -1 : 1 });
    }
    return out;
  };
}

function detectExces(P, pct, W) {
  const ekKey = (W === 24 ? "exces24_" : "exces48_") + pct;
  return (c5) => {
    const out = [];
    const arr = P.retW[W];
    for (let i = CALIB; i < c5.length - 2; i++) {
      const b = blockOf(i, P.nBlocks);
      if (b < 0) continue;
      const the = P.th[ekKey][b];
      if (!isFinite(the)) continue;
      const v = arr[i];
      if (Math.abs(v) <= the) continue;
      out.push({ i5: i, dir: v > 0 ? -1 : 1 });
    }
    return out;
  };
}

function scoreOf(c5, detectFn, exits) {
  const r = evaluer({ instId: "x", exits, detect: detectFn }, c5);
  const espIS = r.A ? r.A.esp : null, espOOS = r.B ? r.B.esp : null;
  const nIS = r.A ? r.A.n : 0, nOOS = r.B ? r.B.n : 0;
  const pfOOS = r.B ? r.B.pf : null, wrOOS = r.B ? r.B.wr : null;
  const worst = (espIS != null && espOOS != null) ? Math.min(espIS, espOOS) : null;
  const valide = !!(espIS != null && espOOS != null && espIS > 0 && espOOS > 0 && (nIS + nOOS) >= 60 && nOOS >= 15);
  return { espIS, espOOS, nIS, nOOS, pfOOS, wrOOS, worst, valide };
}

function main() {
  const used = dejaChampionnees();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
  const onlyFree = process.argv.includes("--free-only");
  const results = [];
  let done = 0;
  for (const f of files) {
    const instId = f.replace(/\.json$/, "");
    const tok = instId.split("-")[0];
    if (BLOCKLIST.has(tok)) continue;
    if (onlyFree && used.has(instId)) continue;
    let c5;
    try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
    if (!Array.isArray(c5) || c5.length < CALIB + 500) continue;
    const P = precompute(c5);
    if (P.nBlocks < 5) continue;

    const combos = [];
    for (const pct of [90, 95]) for (const vc of [0, 1]) for (const ek of ["E1", "E2"])
      combos.push({ fam: "MECHE", pct, vc, exitK: ek, fn: detectWick(P, pct, vc) });
    for (const pct of [90, 95]) for (const vc of [0, 1]) for (const ek of ["E1", "E2"])
      combos.push({ fam: "RANGE", pct, vc, exitK: ek, fn: detectRange(P, pct, vc) });
    for (const pct of [90, 95]) for (const vc of [0, 1]) for (const ek of ["E1", "E2"])
      combos.push({ fam: "SERIE", pct, vc, exitK: ek, fn: detectSerie(P, pct, vc) });
    for (const pct of [90, 95]) for (const W of [24, 48]) for (const ek of ["E1", "E2"])
      combos.push({ fam: "EXCES", pct, W, exitK: ek, fn: detectExces(P, pct, W) });

    for (const combo of combos) {
      const s = scoreOf(c5, combo.fn, EXITS[combo.exitK]);
      if (s.worst == null) continue;
      if (s.worst >= 3) {
        results.push({
          instId, fam: combo.fam, pct: combo.pct, vc: combo.vc ?? null, W: combo.W ?? null, exit: combo.exitK,
          dejaChampionnee: used.has(instId),
          ...s
        });
      }
    }
    done++;
    if (done % 20 === 0) console.error(`... ${done}/${files.length} cryptos scannées`);
  }
  results.sort((a, b) => b.worst - a.worst);
  fs.writeFileSync(path.join(__dirname, "rapports", "x2_adaptatif_scan_resultats.json"), JSON.stringify(results, null, 1));
  console.log(`Total lignes worst>=3 : ${results.length}`);
  console.log("Top 40 :");
  for (const r of results.slice(0, 40)) {
    console.log(`${r.instId.padEnd(20)} ${r.fam.padEnd(6)} pct${r.pct} vc${r.vc} W${r.W ?? "-"} ${r.exit} worst=${r.worst.toFixed(2)} IS=${r.espIS.toFixed(2)} OOS=${r.espOOS.toFixed(2)} n=${r.nIS}+${r.nOOS} pfOOS=${r.pfOOS} valide=${r.valide} deja=${r.dejaChampionnee}`);
  }
}

main();
