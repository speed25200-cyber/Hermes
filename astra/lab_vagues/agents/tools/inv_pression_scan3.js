// SCAN PRESSION DES MÈCHES — passe 3 : shortlist cryptos libres/battues, axes W48 + porte S6 + ±volume.
const fs = require("fs");
const path = require("path");
const AG = "C:/Users/Administrator/Desktop/HERMES_V4_LIVE/lab_vagues/agents";
const { chargerCandles, evaluer } = require(path.join(AG, "harness_lib.js"));

const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};
const INSTS = ["FARTCOIN", "EDEN", "RE", "ZRO", "COAI", "LIGHT", "MMT", "POL", "XPL", "ORDI"];
const WS = [6, 12, 24, 48];
const TS = [1, 1.5, 2];
const VARS = ["S6", "S7", "S8", "R6", "R7", "Xl"];
const VOLS = [1, 0]; // 1 = pondération volume cap4 (invention), 0 = sans volume
const WREF = 96, ZW = 288, WPOS = 288, WARM = 600;

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

function pressionSeries(c5, avecVol) {
  const n = c5.length, s = new Float64Array(n).fill(0);
  let sumR = 0, sumV = 0; const qR = [], qV = [];
  for (let i = 0; i < n; i++) {
    const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4], v = +c5[i][5] || 0;
    const atr = qR.length >= WREF ? sumR / qR.length : NaN;
    const vAvg = qV.length >= WREF ? sumV / qV.length : NaN;
    if (!Number.isNaN(atr) && atr > 0) {
      const wh = h - Math.max(o, c), wb = Math.min(o, c) - l;
      const pv = avecVol && !Number.isNaN(vAvg) && vAvg > 0 ? Math.min(v / vAvg, 4) : 1;
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
    if (vr === "Xl") {
      if (z >= T && zp < T && p >= 0.7) d = -1;
      else if (z <= -T && zp > -T && p <= 0.3) d = 1;
    } else if (vr[0] === "S") {
      const pg = vr === "S8" ? 0.8 : vr === "S7" ? 0.7 : 0.6;
      if (z >= T && p >= pg) d = -1;
      else if (z <= -T && p <= 1 - pg) d = 1;
    } else {
      const pg = vr === "R7" ? 0.7 : 0.6;
      if (zp >= T && z < T && p >= pg) d = -1;
      else if (zp <= -T && z > -T && p <= 1 - pg) d = 1;
    }
    if (d) out.push({ i5: i, dir: d });
  }
  return out;
}

const res = [];
for (const nom of INSTS) {
  const inst = nom + "-USDT-SWAP";
  let c5; try { c5 = chargerCandles("data", inst); } catch (e) { continue; }
  const pos = positions(c5);
  for (const vol of VOLS) {
    const s = pressionSeries(c5, vol);
    for (const W of WS) {
      const Z = zSeries(s, W);
      for (const T of TS) for (const vr of VARS) {
        const sigs = signaux(c5, pos, Z, T, vr);
        if (sigs.length < 30) continue;
        for (const ex of Object.keys(EXITS)) {
          const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
          if (!r.A || !r.B) continue;
          res.push({
            inst: nom, vol, W, T, vr, ex,
            espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
            wrOOS: r.B.wr, pfOOS: r.B.pf,
            worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
            valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15
          });
        }
      }
    }
  }
}
res.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "inv_pression_scan3_resultats.json"), JSON.stringify(res, null, 1));
const v = res.filter(r => r.valide);
console.log("lignes", res.length, "valides", v.length);
for (const x of v.slice(0, 40)) console.log(x.inst, "vol" + x.vol, x.vr, "W" + x.W, "T" + x.T, x.ex, "worst", x.worst, "IS", x.espIS, "OOS", x.espOOS, "n", x.nIS + "+" + x.nOOS, "pf", x.pfOOS);
