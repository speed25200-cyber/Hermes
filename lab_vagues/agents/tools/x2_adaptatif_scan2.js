// x2_adaptatif — passe 2 : raffinement (grille de percentiles plus fine, fenêtres de
// calibrage alternatives, bougie de confirmation optionnelle après le franchissement du
// seuil adaptatif). Toujours : seuil = percentile empirique glissant de LA métrique de
// LA crypto elle-même, recalibré causalement chaque jour. Exits fondateurs uniquement.
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
    try { const mod = require(path.join(CAND_DIR, f)); if (mod && mod.instId) used.add(mod.instId); } catch (e) {}
  }
  return used;
}

const E1 = { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 };
const E2 = { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 };
const EXITS = { E1, E2 };
const STEP = 288;

function percentileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return Infinity;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sorted[idx];
}

function precompute(c5, CALIB) {
  const n = c5.length;
  const o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n);
  for (let i = 0; i < n; i++) { o[i] = c5[i][1]; h[i] = c5[i][2]; l[i] = c5[i][3]; c[i] = c5[i][4]; }
  const volCcy = new Float64Array(n);
  for (let i = 0; i < n; i++) volCcy[i] = c5[i][6];

  const wickDom = new Float64Array(n), lowerW = new Float64Array(n), upperW = new Float64Array(n);
  const rangePct = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lw = (Math.min(o[i], c[i]) - l[i]) / c[i] * 100;
    const uw = (h[i] - Math.max(o[i], c[i])) / c[i] * 100;
    lowerW[i] = lw; upperW[i] = uw; wickDom[i] = Math.max(lw, uw);
    rangePct[i] = (h[i] - l[i]) / c[i] * 100;
  }

  const runLen = new Int32Array(n), runRetAbs = new Float64Array(n), runSign = new Int8Array(n);
  let prevSign = 0;
  for (let i = 1; i < n; i++) {
    const ret = c[i] / c[i - 1] - 1;
    let s = ret > 0 ? 1 : (ret < 0 ? -1 : prevSign);
    runLen[i] = (s === prevSign && s !== 0) ? runLen[i - 1] + 1 : 1;
    runSign[i] = s; prevSign = s;
    const base = c[Math.max(0, i - runLen[i])];
    runRetAbs[i] = Math.abs(c[i] / base - 1) * 100;
  }

  const W_LIST = [12, 24, 48, 96];
  const retW = {};
  for (const W of W_LIST) {
    const arr = new Float64Array(n);
    for (let i = W; i < n; i++) arr[i] = (c[i] / c[i - W] - 1) * 100;
    retW[W] = arr;
  }

  const nBlocks = Math.max(0, Math.floor((n - CALIB) / STEP) + 1);
  const PCTS = [85, 90, 93, 95, 97];
  const th = { wick: {}, range: {}, serie: {}, exces: {}, vol85: new Float64Array(nBlocks) };
  for (const p of PCTS) { th.wick[p] = new Float64Array(nBlocks); th.range[p] = new Float64Array(nBlocks); th.serie[p] = new Float64Array(nBlocks); }
  for (const W of W_LIST) { th.exces[W] = {}; for (const p of PCTS) th.exces[W][p] = new Float64Array(nBlocks); }

  for (let b = 0; b < nBlocks; b++) {
    const d = CALIB + b * STEP, ws = d - CALIB, we = d;
    const wick = Array.from(wickDom.slice(ws, we)).sort((a, b2) => a - b2);
    const rng = Array.from(rangePct.slice(ws, we)).sort((a, b2) => a - b2);
    const ser = Array.from(runRetAbs.slice(ws, we)).sort((a, b2) => a - b2);
    const vol = Array.from(volCcy.slice(ws, we)).sort((a, b2) => a - b2);
    th.vol85[b] = percentileSorted(vol, 85);
    for (const p of PCTS) {
      th.wick[p][b] = percentileSorted(wick, p);
      th.range[p][b] = percentileSorted(rng, p);
      th.serie[p][b] = percentileSorted(ser, p);
    }
    for (const W of W_LIST) {
      const e = Array.from(retW[W].slice(ws, we)).map(Math.abs).sort((a, b2) => a - b2);
      for (const p of PCTS) th.exces[W][p][b] = percentileSorted(e, p);
    }
  }
  return { n, o, c, h, l, volCcy, lowerW, upperW, rangePct, runLen, runRetAbs, runSign, retW, th, nBlocks, CALIB };
}

function blockOf(i, P) { const b = Math.floor((i - P.CALIB) / STEP); if (b < 0) return -1; return b < P.nBlocks ? b : P.nBlocks - 1; }

function detectWick(P, pct, volConfirm, conf) {
  return (c5) => {
    const out = [];
    for (let i = P.CALIB; i < c5.length - 3; i++) {
      const b = blockOf(i, P); if (b < 0) continue;
      const thw = P.th.wick[pct][b]; if (!isFinite(thw)) continue;
      if (volConfirm && !(P.volCcy[i] > P.th.vol85[b])) continue;
      let dir = 0;
      if (P.lowerW[i] > thw) dir = 1; else if (P.upperW[i] > thw) dir = -1;
      if (!dir) continue;
      if (!conf) { out.push({ i5: i, dir }); continue; }
      const j = i + 1;
      const moved = dir > 0 ? P.c[j] > P.c[i] : P.c[j] < P.c[i];
      if (moved) out.push({ i5: j, dir });
    }
    return out;
  };
}

function detectRange(P, pct, volConfirm, conf) {
  return (c5) => {
    const out = [];
    for (let i = P.CALIB; i < c5.length - 3; i++) {
      const b = blockOf(i, P); if (b < 0) continue;
      const thr = P.th.range[pct][b]; if (!isFinite(thr) || P.rangePct[i] <= thr) continue;
      if (volConfirm && !(P.volCcy[i] > P.th.vol85[b])) continue;
      let dir = 0;
      if (P.c[i] > P.o[i]) dir = -1; else if (P.c[i] < P.o[i]) dir = 1;
      if (!dir) continue;
      if (!conf) { out.push({ i5: i, dir }); continue; }
      const j = i + 1;
      const moved = dir > 0 ? P.c[j] > P.c[i] : P.c[j] < P.c[i];
      if (moved) out.push({ i5: j, dir });
    }
    return out;
  };
}

function detectSerie(P, pct, minLen, conf) {
  return (c5) => {
    const out = [];
    for (let i = P.CALIB; i < c5.length - 3; i++) {
      if (P.runLen[i] < minLen) continue;
      const b = blockOf(i, P); if (b < 0) continue;
      const ths = P.th.serie[pct][b]; if (!isFinite(ths) || P.runRetAbs[i] <= ths) continue;
      const dir = P.runSign[i] > 0 ? -1 : 1;
      if (!conf) { out.push({ i5: i, dir }); continue; }
      const j = i + 1;
      const moved = dir > 0 ? P.c[j] > P.c[i] : P.c[j] < P.c[i];
      if (moved) out.push({ i5: j, dir });
    }
    return out;
  };
}

function detectExces(P, pct, W, conf) {
  return (c5) => {
    const out = [];
    const arr = P.retW[W];
    for (let i = P.CALIB; i < c5.length - 3; i++) {
      const b = blockOf(i, P); if (b < 0) continue;
      const the = P.th.exces[W][pct][b]; if (!isFinite(the)) continue;
      const v = arr[i]; if (Math.abs(v) <= the) continue;
      const dir = v > 0 ? -1 : 1;
      if (!conf) { out.push({ i5: i, dir }); continue; }
      const j = i + 1;
      const moved = dir > 0 ? P.c[j] > P.c[i] : P.c[j] < P.c[i];
      if (moved) out.push({ i5: j, dir });
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
  const CALIBS = [2016, 4032]; // 7 j et 14 j glissants
  for (const f of files) {
    const instId = f.replace(/\.json$/, "");
    const tok = instId.split("-")[0];
    if (BLOCKLIST.has(tok)) continue;
    if (onlyFree && used.has(instId)) continue;
    let c5;
    try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
    if (!Array.isArray(c5) || c5.length < 2016 + 500) continue;

    for (const CALIB of CALIBS) {
      if (c5.length < CALIB + 500) continue;
      const P = precompute(c5, CALIB);
      if (P.nBlocks < 5) continue;
      const combos = [];
      for (const pct of [85, 90, 93, 95, 97]) for (const vc of [0, 1]) for (const conf of [0, 1]) for (const ek of ["E1", "E2"])
        combos.push({ fam: "MECHE", pct, vc, conf, exitK: ek, fn: detectWick(P, pct, vc, conf) });
      for (const pct of [85, 90, 93, 95, 97]) for (const vc of [0, 1]) for (const conf of [0, 1]) for (const ek of ["E1", "E2"])
        combos.push({ fam: "RANGE", pct, vc, conf, exitK: ek, fn: detectRange(P, pct, vc, conf) });
      for (const pct of [85, 90, 93, 95, 97]) for (const minLen of [2, 3]) for (const conf of [0, 1]) for (const ek of ["E1", "E2"])
        combos.push({ fam: "SERIE", pct, minLen, conf, exitK: ek, fn: detectSerie(P, pct, minLen, conf) });
      for (const pct of [90, 95, 97]) for (const W of [12, 24, 48, 96]) for (const conf of [0, 1]) for (const ek of ["E1", "E2"])
        combos.push({ fam: "EXCES", pct, W, conf, exitK: ek, fn: detectExces(P, pct, W, conf) });

      for (const combo of combos) {
        const s = scoreOf(c5, combo.fn, EXITS[combo.exitK]);
        if (s.worst == null) continue;
        if (s.worst >= 5) {
          results.push({
            instId, CALIB, fam: combo.fam, pct: combo.pct, vc: combo.vc ?? null, conf: combo.conf ?? null,
            minLen: combo.minLen ?? null, W: combo.W ?? null, exit: combo.exitK,
            dejaChampionnee: used.has(instId), ...s
          });
        }
      }
    }
    done++;
    if (done % 20 === 0) console.error(`... ${done} cryptos scannées`);
  }
  results.sort((a, b) => b.worst - a.worst);
  fs.writeFileSync(path.join(__dirname, "rapports", "x2_adaptatif_scan2_resultats.json"), JSON.stringify(results, null, 1));
  console.log(`Total lignes worst>=5 : ${results.length}`);
  for (const r of results.slice(0, 60)) {
    console.log(`${r.instId.padEnd(18)} CAL${r.CALIB} ${r.fam.padEnd(6)} p${r.pct} vc${r.vc} conf${r.conf} minL${r.minLen ?? '-'} W${r.W ?? '-'} ${r.exit} worst=${r.worst.toFixed(2)} IS=${r.espIS.toFixed(2)} OOS=${r.espOOS.toFixed(2)} n=${r.nIS}+${r.nOOS} pfOOS=${r.pfOOS} v=${r.valide} deja=${r.dejaChampionnee}`);
  }
}
if (require.main === module) main();
module.exports = { precompute, detectWick, detectRange, detectSerie, detectExces, scoreOf, EXITS, BLOCKLIST, dejaChampionnees };
