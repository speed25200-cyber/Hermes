// h14_regime_scan.js — LA RECETTE REINE (GPS 4/4) appliquée au territoire vierge (~190 cryptos
// jamais scannées : absentes de profond_tous_resultats.json, hors blocklist actions README, hors registre).
// 4 signaux simples (mèche60%+vol2x / z-score SMA48 ±2.5σ / RSI14 extrême 25/75 / 5 bougies consécutives)
// pris UNIQUEMENT dans la moitié favorable du range 24h (long moitié basse, short moitié haute).
// Exit standard UNIQUE : tp80/sl30/act30/cb5/hold12 (pas de balayage de sorties).
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require("../harness_lib.js");

const EXIT = { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 };

// ---- univers cible ----
const dataDir = path.join(__dirname, "..", "..", "data");
const dataFiles = fs.readdirSync(dataDir).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
const profond = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "profond_tous_resultats.json"), "utf8")).map(x => x.instId));
const README_BLOCK = "AAPL SPX TSLA NVDA MSTR SKHYNIX SKHY SNDK CRCL HOOD COIN GOOG GOOGL META AMZN MSFT AMD INTC QQQ GLD XAUT TRUMP AXTI MRVL MU NBIS SOXL SOXS TQQQ EWY CXMT SAMSUNG XIAOMI UNITREE ZHIPU MINIMAX XAU XAG XCU BEAT BZ CBRS CL CC CHIP DRAM SLX ROBO SPCX SPACE LITE OPG BARD SKDD SNXX AAOI AVGO TSM SPY BILL".split(/\s+/);
const REGISTRY_FORBID = ["PIEVERSE","ENSO","USELESS","SOON","GRASS","NES","GPS","AXS","MANA","LUNA","MEGA","BASED","PLUME","ALLO","SOPH","O","YGG","HUMA","STABLE"];
const cat3 = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, "_terra_cat3.json"), "utf8"))); // actions/ETF/commodités confirmées par instCategory OKX
const base = id => id.split("-")[0];
const blockSet = new Set(README_BLOCK), regSet = new Set(REGISTRY_FORBID);

const target = dataFiles.filter(id => {
  if (profond.has(id)) return false;
  if (blockSet.has(base(id))) return false;
  if (regSet.has(base(id))) return false;
  return true;
});
console.error(`Univers cible (absent profond_tous, hors blocklist README + registre) : ${target.length}`);

// ---- indicateurs partagés (une passe par crypto) ----
function buildContext(c5) {
  const n = c5.length;
  const closes = c5.map(x => x[4]);
  // volume SMA20
  const vs = new Array(n).fill(null);
  { let s = 0; for (let i = 0; i < n; i++) { s += c5[i][5]; if (i >= 20) s -= c5[i - 20][5]; if (i >= 19) vs[i] = s / 20; } }
  // range24h position rolling (288 bougies)
  const R = 288, pos = new Array(n).fill(null);
  { const dqH = [], dqL = [];
    for (let i = 0; i < n; i++) {
      while (dqH.length && c5[dqH[dqH.length - 1]][2] <= c5[i][2]) dqH.pop(); dqH.push(i);
      while (dqL.length && c5[dqL[dqL.length - 1]][3] >= c5[i][3]) dqL.pop(); dqL.push(i);
      while (dqH[0] <= i - R) dqH.shift();
      while (dqL[0] <= i - R) dqL.shift();
      if (i >= R - 1) { const hh = c5[dqH[0]][2], ll = c5[dqL[0]][3]; pos[i] = hh > ll ? (c5[i][4] - ll) / (hh - ll) : 0.5; }
    }
  }
  // z-score SMA48 / SMA96
  function zscore(P) {
    const z = new Array(n).fill(null); let s = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      s += closes[i]; s2 += closes[i] * closes[i];
      if (i >= P) { s -= closes[i - P]; s2 -= closes[i - P] * closes[i - P]; }
      if (i >= P - 1) { const m = s / P, v = Math.max(s2 / P - m * m, 1e-18); z[i] = (closes[i] - m) / Math.sqrt(v); }
    }
    return z;
  }
  const z48 = zscore(48), z96 = zscore(96);
  // RSI14 Wilder
  const rsi = new Array(n).fill(null);
  { const p = 14; let g = 0, pr = 0;
    for (let i = 1; i < n; i++) {
      const d = closes[i] - closes[i - 1];
      if (i <= p) { if (d > 0) g += d; else pr -= d; if (i === p) rsi[i] = 100 - 100 / (1 + (g / p) / ((pr / p) || 1e-12)); continue; }
      g = (g * (p - 1) + Math.max(d, 0)) / p;
      pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
      rsi[i] = 100 - 100 / (1 + g / (pr || 1e-12));
    }
  }
  // run de bougies consécutives (signe close[i]-close[i-1])
  const run = new Array(n).fill(0), sgn = new Array(n).fill(0);
  { let r = 0, s = 0;
    for (let i = 1; i < n; i++) {
      const d = Math.sign(closes[i] - closes[i - 1]);
      if (d !== 0 && d === s) r++; else { r = 1; s = d; }
      run[i] = r; sgn[i] = s;
    }
  }
  return { c5, closes, vs, pos, z48, z96, rsi, run, sgn };
}

// ---- 4 familles de detect(), paramétrées, filtre range24h intégré ----
function detMeche(ctx, wick, vol) {
  const { c5, vs, pos } = ctx, out = [];
  for (let i = 300; i < c5.length; i++) {
    const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4], range = h - l;
    if (!(range > 0) || vs[i] == null || !(vs[i] > 0) || pos[i] == null) continue;
    const wLo = (Math.min(o, c) - l) / range, wHi = (h - Math.max(o, c)) / range, vm = c5[i][5] / vs[i];
    if (wLo >= wick && vm >= vol && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
    else if (wHi >= wick && vm >= vol && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
  }
  return out;
}
function detZ(ctx, P, thr) {
  const { c5, pos } = ctx, z = P === 48 ? ctx.z48 : ctx.z96, out = [];
  for (let i = 300; i < c5.length; i++) {
    if (z[i] == null || pos[i] == null) continue;
    if (z[i] < -thr && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
    else if (z[i] > thr && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
  }
  return out;
}
function detRsi(ctx, lo, hi) {
  const { c5, pos, rsi } = ctx, out = [];
  for (let i = 300; i < c5.length; i++) {
    if (rsi[i] == null || pos[i] == null) continue;
    if (rsi[i] < lo && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
    else if (rsi[i] > hi && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
  }
  return out;
}
function detRun(ctx, need) {
  const { c5, pos, run, sgn } = ctx, out = [];
  for (let i = 300; i < c5.length; i++) {
    if (pos[i] == null || run[i] < need || sgn[i] === 0) continue;
    const dir = -sgn[i];
    if (dir > 0 && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
    else if (dir < 0 && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
  }
  return out;
}

const FAMILIES = [
  { fam: "meche", label: (p) => `w${p.wick}v${p.vol}`, primary: { wick: 0.6, vol: 2 },
    neighbors: [
      { wick: 0.5, vol: 1.5 }, { wick: 0.5, vol: 2 }, { wick: 0.5, vol: 2.5 },
      { wick: 0.6, vol: 1.5 }, { wick: 0.6, vol: 2.5 },
      { wick: 0.7, vol: 1.5 }, { wick: 0.7, vol: 2 }, { wick: 0.7, vol: 2.5 },
    ],
    detect: (ctx, p) => detMeche(ctx, p.wick, p.vol) },
  { fam: "zscore", label: (p) => `P${p.P}thr${p.thr}`, primary: { P: 48, thr: 2.5 },
    neighbors: [
      { P: 48, thr: 2.0 }, { P: 48, thr: 3.0 }, { P: 48, thr: 3.5 },
      { P: 96, thr: 2.0 }, { P: 96, thr: 2.5 }, { P: 96, thr: 3.0 },
    ],
    detect: (ctx, p) => detZ(ctx, p.P, p.thr) },
  { fam: "rsi", label: (p) => `${p.lo}/${p.hi}`, primary: { lo: 25, hi: 75 },
    neighbors: [{ lo: 20, hi: 80 }, { lo: 30, hi: 70 }],
    detect: (ctx, p) => detRsi(ctx, p.lo, p.hi) },
  { fam: "run5", label: (p) => `run${p.need}`, primary: { need: 5 },
    neighbors: [{ need: 4 }, { need: 6 }, { need: 7 }],
    detect: (ctx, p) => detRun(ctx, p.need) },
];

function evalCombo(c5, sigs) {
  const mod = { exits: EXIT, detect: () => sigs };
  const r = evaluer(mod, c5);
  return {
    espIS: r.A ? r.A.esp : null, espOOS: r.B ? r.B.esp : null,
    nIS: r.A ? r.A.n : 0, nOOS: r.B ? r.B.n : 0,
    wrOOS: r.B ? r.B.wr : null, pfOOS: r.B ? r.B.pf : null,
    worst: (r.A && r.B) ? Math.min(r.A.esp, r.B.esp) : null,
    valide: !!(r.A && r.B && r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15),
  };
}

const results = [];
let done = 0;
for (const instId of target) {
  let c5;
  try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
  if (!c5 || c5.length < 400) continue;
  const ctx = buildContext(c5);
  for (const F of FAMILIES) {
    const primSigs = F.detect(ctx, F.primary);
    const primR = evalCombo(c5, primSigs);
    const neighborRs = F.neighbors.map(p => ({ p, r: evalCombo(c5, F.detect(ctx, p)) }));
    results.push({
      instId, fam: F.fam, param: F.label(F.primary), ...primR,
      neighbors: neighborRs.map(x => ({ param: F.label(x.p), worst: x.r.worst, espIS: x.r.espIS, espOOS: x.r.espOOS, nIS: x.r.nIS, nOOS: x.r.nOOS, valide: x.r.valide })),
    });
  }
  done++;
  if (done % 20 === 0) console.error(`... ${done}/${target.length}`);
}

fs.writeFileSync(path.join(__dirname, "rapports", "h14_regime_scan_resultats.json"), JSON.stringify(results, null, 1));
console.error(`Total lignes : ${results.length}`);

// tri: valides, worst desc
const valides = results.filter(r => r.valide).sort((a, b) => b.worst - a.worst);
console.error(`Valides : ${valides.length}`);
for (const r of valides.slice(0, 40)) {
  console.error(`${r.instId.padEnd(20)} ${r.fam.padEnd(7)} ${r.param.padEnd(10)} worst=${r.worst.toFixed(2).padStart(6)} IS=${r.espIS.toFixed(2)}/${r.nIS} OOS=${r.espOOS.toFixed(2)}/${r.nOOS} pfOOS=${r.pfOOS} cat3=${cat3.has(r.instId)}`);
}
