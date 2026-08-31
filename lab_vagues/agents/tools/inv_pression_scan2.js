// SCAN PRESSION DES MÈCHES — passe 2 : plus de DÉBIT (mode état S, portes élargies), conf jetée.
// Variantes : Xp (franchissement + pos 0.8) · Xl (franchissement + pos 0.7) · S8/S7 (état) · R7/R6 (relâchement).
const fs = require("fs");
const path = require("path");
const AG = "C:/Users/Administrator/Desktop/HERMES_V4_LIVE/lab_vagues/agents";
const { chargerCandles, evaluer } = require(path.join(AG, "harness_lib.js"));

const DATA_DIR = path.join(AG, "..", "data");
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};
const WS = [6, 12, 24];
const TS = [1, 1.5, 2];
const VARS = ["Xp", "Xl", "S8", "S7", "R7", "R6"];
const WREF = 96, ZW = 288, WPOS = 288, WARM = 600;
const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY GOOGL " +
  "INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK SNXX SOXL SOXS " +
  "SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD").split(" "));

function positions(c5) {
  const n = c5.length, pos = new Float64Array(n).fill(NaN);
  const qMin = [], qMax = [];
  for (let i = 0; i < n; i++) {
    while (qMin.length && c5[qMin[qMin.length - 1]][3] >= c5[i][3]) qMin.pop();
    qMin.push(i);
    while (qMax.length && c5[qMax[qMax.length - 1]][2] <= c5[i][2]) qMax.pop();
    qMax.push(i);
    const lo = i - WPOS + 1;
    while (qMin[0] < lo) qMin.shift();
    while (qMax[0] < lo) qMax.shift();
    if (i >= WPOS - 1) {
      const mn = c5[qMin[0]][3], mx = c5[qMax[0]][2];
      if (mx > mn) pos[i] = (c5[i][4] - mn) / (mx - mn);
    }
  }
  return pos;
}

function pressionSeries(c5) {
  const n = c5.length, s = new Float64Array(n).fill(0);
  let sumR = 0, sumV = 0; const qR = [], qV = [];
  for (let i = 0; i < n; i++) {
    const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4], v = +c5[i][5] || 0;
    const atr = qR.length >= WREF ? sumR / qR.length : NaN;
    const vAvg = qV.length >= WREF ? sumV / qV.length : NaN;
    if (!Number.isNaN(atr) && atr > 0) {
      const wh = h - Math.max(o, c), wb = Math.min(o, c) - l;
      const pv = (!Number.isNaN(vAvg) && vAvg > 0) ? Math.min(v / vAvg, 4) : 1;
      s[i] = (wh - wb) / atr * pv;
    }
    qR.push(h - l); sumR += h - l; if (qR.length > WREF) sumR -= qR.shift();
    qV.push(v); sumV += v; if (qV.length > WREF) sumV -= qV.shift();
  }
  return s;
}

function zSeries(s, W) {
  const n = s.length, P = new Float64Array(n).fill(NaN), Z = new Float64Array(n).fill(NaN);
  let ps = 0;
  for (let i = 0; i < n; i++) {
    ps += s[i]; if (i >= W) ps -= s[i - W];
    if (i >= W - 1) P[i] = ps / W;
  }
  let m = 0, m2 = 0, cnt = 0; const q = [];
  for (let i = 0; i < n; i++) {
    if (cnt >= ZW) {
      const mu = m / cnt, va = m2 / cnt - mu * mu;
      if (va > 1e-12 && !Number.isNaN(P[i])) Z[i] = (P[i] - mu) / Math.sqrt(va);
    }
    if (!Number.isNaN(P[i])) {
      q.push(P[i]); m += P[i]; m2 += P[i] * P[i]; cnt++;
      if (cnt > ZW) { const old = q.shift(); m -= old; m2 -= old * old; cnt--; }
    }
  }
  return Z;
}

function signaux(c5, pos, Z, T, vr) {
  const out = [];
  for (let i = WARM; i < c5.length - 2; i++) {
    const z = Z[i], zp = Z[i - 1], p = pos[i];
    if (Number.isNaN(z) || Number.isNaN(zp) || Number.isNaN(p)) continue;
    let d = 0;
    if (vr === "Xp" || vr === "Xl") {
      const pg = vr === "Xp" ? 0.8 : 0.7;
      if (z >= T && zp < T && p >= pg) d = -1;
      else if (z <= -T && zp > -T && p <= 1 - pg) d = 1;
    } else if (vr === "S8" || vr === "S7") {
      const pg = vr === "S8" ? 0.8 : 0.7;
      if (z >= T && p >= pg) d = -1;
      else if (z <= -T && p <= 1 - pg) d = 1;
    } else { // R7 / R6 : relâchement après pic
      const pg = vr === "R7" ? 0.7 : 0.6;
      if (zp >= T && z < T && p >= pg) d = -1;
      else if (zp <= -T && z > -T && p <= 1 - pg) d = 1;
    }
    if (d) out.push({ i5: i, dir: d });
  }
  return out;
}

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith("-USDT-SWAP.json"));
const res = [];
let done = 0;
for (const f of files) {
  const inst = f.replace(".json", "");
  const base = inst.replace("-USDT-SWAP", "");
  if (BLOCK.has(base)) continue;
  let c5; try { c5 = chargerCandles("data", inst); } catch (e) { continue; }
  if (!c5 || c5.length < 4000) continue;
  const pos = positions(c5), s = pressionSeries(c5);
  for (const W of WS) {
    const Z = zSeries(s, W);
    for (const T of TS) for (const vr of VARS) {
      const sigs = signaux(c5, pos, Z, T, vr);
      if (sigs.length < 30) continue;
      for (const ex of Object.keys(EXITS)) {
        const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
        if (!r.A || !r.B) continue;
        res.push({
          inst, W, T, vr, ex,
          espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
          wrOOS: r.B.wr, pfOOS: r.B.pf,
          worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
          valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15
        });
      }
    }
  }
  done++;
  if (done % 40 === 0) console.error(`... ${done} cryptos`);
}
res.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "inv_pression_scan2_resultats.json"), JSON.stringify(res, null, 1));
console.log(JSON.stringify({ cryptos: done, lignes: res.length, valides: res.filter(r => r.valide).length, top: res.filter(r => r.valide).slice(0, 30) }, null, 1));
