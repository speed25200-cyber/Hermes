// Territoire vierge : applique les 4 familles PROUVEES du registre aux cryptos FRAICHES
// (au-dela du top 250, jamais scannees). Grilles GROSSIERES, exits FONDATEURS uniquement
// (E1 tp80/act30/hold12, E2 tp60/act20/hold8 - pas de balayage de sorties a posteriori).
const fs = require("fs");
const path = require("path");
const ti = require("technicalindicators");
const { evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));

const DATA = path.join(__dirname, "..", "..", "data");
const ids = JSON.parse(fs.readFileSync(path.join(__dirname, "_terra_fresh.json"), "utf8"));

const E1 = { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 };
const E2 = { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 };
const E3 = { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 };
const E4 = { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 24 };
const EXITS = [["E1", E1], ["E2", E2], ["E3", E3], ["E4", E4]];

// ---------- indicateurs partages (calcules une fois par crypto) ----------
function precalc(c5) {
  const N = c5.length;
  const h = new Array(N), l = new Array(N), c = new Array(N), v = new Array(N);
  for (let i = 0; i < N; i++) { h[i] = +c5[i][2]; l[i] = +c5[i][3]; c[i] = +c5[i][4]; v[i] = +c5[i][5]; }

  // volume SMA20
  const vs = new Array(N).fill(null);
  { let s = 0; for (let i = 0; i < N; i++) { s += v[i]; if (i >= 20) s -= v[i - 20]; if (i >= 19) vs[i] = s / 20; } }

  // position dans le range 24h (deque min/max glissant R=288)
  const R = 288, pos = new Array(N).fill(null);
  { const dqH = [], dqL = [];
    for (let i = 0; i < N; i++) {
      while (dqH.length && h[dqH[dqH.length - 1]] <= h[i]) dqH.pop(); dqH.push(i);
      while (dqL.length && l[dqL[dqL.length - 1]] >= l[i]) dqL.pop(); dqL.push(i);
      while (dqH[0] <= i - R) dqH.shift();
      while (dqL[0] <= i - R) dqL.shift();
      if (i >= R - 1) { const hh = h[dqH[0]], ll = l[dqL[0]]; pos[i] = hh > ll ? (c[i] - ll) / (hh - ll) : 0.5; }
    }
  }

  // VWAP session (ancre jour UTC) + sigma pondere volume
  const DAY = 86400000;
  const vwap = new Array(N).fill(null), sig = new Array(N).fill(null), bod = new Array(N).fill(0);
  { let day = -1, cv = 0, cpv = 0, cpv2 = 0, k = 0;
    for (let i = 0; i < N; i++) {
      const d = Math.floor(c5[i][0] / DAY);
      if (d !== day) { day = d; cv = 0; cpv = 0; cpv2 = 0; k = 0; }
      const tp = (h[i] + l[i] + c[i]) / 3, vv = Math.max(v[i], 0);
      cv += vv; cpv += tp * vv; cpv2 += tp * tp * vv; k++; bod[i] = k;
      if (cv > 0) { const m = cpv / cv; vwap[i] = m; sig[i] = Math.sqrt(Math.max(cpv2 / cv - m * m, 0)); }
    }
  }

  // RSI14
  const rsiArr = ti.rsi({ period: 14, values: c });
  const rsi = new Array(N).fill(null);
  { const off = N - rsiArr.length; for (let i = 0; i < rsiArr.length; i++) rsi[off + i] = rsiArr[i]; }

  // Keltner EMA20/50 +- mult*ATR10, mult 2 et 3
  const kc20_2 = ti.keltnerchannels({ high: h, low: l, close: c, maPeriod: 20, atrPeriod: 10, multiplier: 2, useSMA: false });
  const kc20_3 = ti.keltnerchannels({ high: h, low: l, close: c, maPeriod: 20, atrPeriod: 10, multiplier: 3, useSMA: false });
  const kc50_2 = ti.keltnerchannels({ high: h, low: l, close: c, maPeriod: 50, atrPeriod: 10, multiplier: 2, useSMA: false });
  const kc50_3 = ti.keltnerchannels({ high: h, low: l, close: c, maPeriod: 50, atrPeriod: 10, multiplier: 3, useSMA: false });

  return { N, h, l, c, v, vs, pos, vwap, sig, bod, rsi, kc20_2, kc20_3, kc50_2, kc50_3 };
}

// ---------- familles ----------
function famStructure(c5, P, TOL, BOUNCE) {
  const W = 144, GAP = 12, out = [];
  const { h, l, c, N } = P;
  for (let i = Math.max(200, W); i < N; i++) {
    let mn = Infinity, mx = -Infinity, iMn = -1, iMx = -1;
    for (let k = i - W; k <= i - GAP; k++) {
      if (l[k] < mn) { mn = l[k]; iMn = k; }
      if (h[k] > mx) { mx = h[k]; iMx = k; }
    }
    const o = c5[i][1], hh = h[i], ll = l[i], cc = c[i];
    if (ll >= mn * (1 - TOL) && ll <= mn * (1 + TOL) && cc > o) {
      let rb = -Infinity; for (let k = iMn + 1; k < i; k++) if (c[k] > rb) rb = c[k];
      if (rb >= mn * (1 + BOUNCE)) out.push({ i5: i, dir: 1 });
    }
    if (hh <= mx * (1 + TOL) && hh >= mx * (1 - TOL) && cc < o) {
      let rb = Infinity; for (let k = iMx + 1; k < i; k++) if (c[k] < rb) rb = c[k];
      if (rb <= mx * (1 - BOUNCE)) out.push({ i5: i, dir: -1 });
    }
  }
  return out;
}

function famKeltner(c5, P, maPeriod, mult) {
  const key = "kc" + maPeriod + "_" + mult;
  const kc = P[key];
  const { c, N } = P, out = [];
  const oK = N - kc.length;
  for (let i = Math.max(400, oK + 1); i < N - 2; i++) {
    const j = i - oK;
    if (c[i - 1] < kc[j - 1].lower && c[i] > kc[j].lower) out.push({ i5: i, dir: 1 });
    if (c[i - 1] > kc[j - 1].upper && c[i] < kc[j].upper) out.push({ i5: i, dir: -1 });
  }
  return out;
}

function famVwap(c5, P, K) {
  const { vwap, sig, bod, c, N } = P, out = [], WARM = 36;
  for (let i = 101; i < N; i++) {
    const w = vwap[i], s = sig[i];
    if (w == null || !(s > 0) || bod[i] < WARM) continue;
    if (vwap[i - 1] == null || !(sig[i - 1] > 0)) continue;
    const z = (c[i] - w) / s, zPrev = (c[i - 1] - vwap[i - 1]) / sig[i - 1];
    if (zPrev <= -K && z > -K && z < 0) out.push({ i5: i, dir: 1 });
    else if (zPrev >= K && z < K && z > 0) out.push({ i5: i, dir: -1 });
  }
  return out;
}

function famMecheRegime(c5, P, wickThresh, volMult) {
  const { h, l, c, vs, pos, N } = P, out = [];
  for (let i = 300; i < N; i++) {
    const o = c5[i][1], hh = h[i], ll = l[i], cc = c[i], range = hh - ll;
    if (!(range > 0) || vs[i] == null || !(vs[i] > 0) || pos[i] == null) continue;
    const wLo = (Math.min(o, cc) - ll) / range, wHi = (hh - Math.max(o, cc)) / range, vm = P.v[i] / vs[i];
    if (wLo >= wickThresh && vm >= volMult && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
    else if (wHi >= wickThresh && vm >= volMult && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
  }
  return out;
}

function famRsiRegime(c5, P, lo, hi) {
  const { rsi, pos, N } = P, out = [];
  for (let i = 300; i < N; i++) {
    if (rsi[i] == null || rsi[i - 1] == null || pos[i] == null) continue;
    if (rsi[i - 1] >= lo && rsi[i] < lo && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
    else if (rsi[i - 1] <= hi && rsi[i] > hi && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
  }
  return out;
}

// ---------- orchestrateur ----------
const rows = [];
let done = 0;
for (const id of ids) {
  const f = path.join(DATA, id + ".json");
  if (!fs.existsSync(f)) continue;
  let c5;
  try { c5 = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
  if (!Array.isArray(c5) || c5.length < 2000) continue;
  let P;
  try { P = precalc(c5); } catch (e) { console.error(id, "precalc erreur", e.message); continue; }
  done++;

  const combos = [];
  for (const TOL of [0.003, 0.006]) for (const BOUNCE of [0.01, 0.02])
    combos.push(["struct", `tol${TOL} bnc${BOUNCE}`, () => famStructure(c5, P, TOL, BOUNCE)]);
  for (const ma of [20, 50]) for (const mult of [2, 3]) combos.push(["keltner", `ema${ma} x${mult}`, () => famKeltner(c5, P, ma, mult)]);
  combos.push(["vwap", "K2", () => famVwap(c5, P, 2)]);
  for (const wt of [0.5, 0.6]) for (const vm of [1.5, 2]) combos.push(["meche", `w${wt} v${vm}`, () => famMecheRegime(c5, P, wt, vm)]);
  for (const [lo, hi] of [[25, 75], [30, 70]]) combos.push(["rsi", `${lo}/${hi}`, () => famRsiRegime(c5, P, lo, hi)]);

  for (const [fam, desc, fn] of combos) {
    let sigs;
    try { sigs = fn(); } catch (e) { continue; }
    if (!sigs.length) continue;
    for (const [exName, ex] of EXITS) {
      const mod = { instId: id, exits: ex, detect: () => sigs };
      let r;
      try { r = evaluer(mod, c5); } catch { continue; }
      if (!r.A || !r.B) continue;
      const worst = Math.min(r.A.esp, r.B.esp);
      const valide = r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15;
      if (valide && worst >= 4) {
        rows.push({ id, fam, desc, ex: exName, worst, espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n, pfOOS: r.B.pf });
      }
    }
  }
}

rows.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "rapports", "x1_terra_scan_resultats.json"), JSON.stringify(rows, null, 1));
console.log("cryptos scannees:", done, "/ lignes valides >=4:", rows.length);
console.log("TOP 30:");
for (const r of rows.slice(0, 30)) {
  console.log(r.id.padEnd(22), r.fam.padEnd(8), r.desc.padEnd(14), r.ex, "worst", r.worst.toFixed(2), "IS", r.espIS, "OOS", r.espOOS, "nIS", r.nIS, "nOOS", r.nOOS, "pfOOS", r.pfOOS);
}
