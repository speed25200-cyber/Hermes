// SCAN inv_memoire passe 3 — shortlist (les cryptos où la mémoire des niveaux VIT : vieux alts)
// Axes restants, grossiers : MINK {2,3} (force d'approche mini) · SMOOTH {0,1} (dépôt du pivot
// aussi sur les tranches voisines à demi-poids : un niveau est une ZONE) ; modes m0 (matched) + a0 (any).
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));

const SHORT = ["ORDI", "GRAM", "RENDER", "EGLD", "ZEC", "ICP", "ZEN", "TRB", "ATOM", "DASH", "ETC", "INJ", "UNI", "VVV", "ENS", "AAVE", "COMP", "GMX"];

const LNB = Math.log(1.0025);
const WREF = 96, VCAP = 4, S = 3, F = 6, WARM = 600;
const LS = [6, 12];
const HALFS = [24, 48];
const MS = [1.5, 3];
const DS = [0.003, 0.006];
const DECS = [0.5, 999];
const MODES = ["m0", "a0"];
const MINKS = [2, 3];
const SMOOTHS = [0, 1];
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};

function precalc(c5) {
  const n = c5.length;
  const avgV = new Float64Array(n).fill(NaN), avgA = new Float64Array(n).fill(NaN);
  let sv = 0, sa = 0; const qv = [], qa = [];
  for (let i = 0; i < n; i++) {
    if (qv.length >= WREF) { avgV[i] = sv / qv.length; avgA[i] = sa / qa.length; }
    const v = +c5[i][5] || 0;
    qv.push(v); sv += v; if (qv.length > WREF) sv -= qv.shift();
    if (i > 0) { const d = Math.abs(c5[i][4] - c5[i - 1][4]); qa.push(d); sa += d; if (qa.length > WREF) sa -= qa.shift(); }
  }
  return { avgV, avgA };
}

function pivots(c5, L) {
  const out = [];
  const n = c5.length;
  for (let j = L; j < n - L; j++) {
    const h = c5[j][2], l = c5[j][3];
    let ph = true, pl = true;
    for (let k = 1; k <= L && (ph || pl); k++) {
      if (c5[j - k][2] >= h || c5[j + k][2] > h) ph = false;
      if (c5[j - k][3] <= l || c5[j + k][3] < l) pl = false;
    }
    if (ph) out.push({ conf: j + L, j, price: h, isHigh: true });
    if (pl) out.push({ conf: j + L, j, price: l, isHigh: false });
  }
  out.sort((a, b) => a.conf - b.conf);
  return out;
}

function passe(c5, pre, pvs, HALF, MINK, SMOOTH) {
  const n = c5.length;
  const decay = Math.pow(0.5, 1 / (HALF * 12));
  const bins = new Map(); // bin -> [sLow, sHigh, lastIdx]
  const sigs = {};
  for (const M of MS) for (const D of DS) for (const DEC of DECS) for (const mo of MODES)
    sigs[M + "|" + D + "|" + DEC + "|" + mo] = [];
  let pi = 0;
  const lnC = new Float64Array(n);
  for (let i = 0; i < n; i++) lnC[i] = Math.log(c5[i][4]);
  const dep = (b, w, isHigh, j) => {
    let e = bins.get(b);
    if (e) { const d = Math.pow(decay, j - e[2]); e[0] *= d; e[1] *= d; e[2] = j; }
    else { e = [0, 0, j]; bins.set(b, e); }
    if (isHigh) e[1] += w; else e[0] += w;
  };
  const readAt = (b, i) => {
    const e = bins.get(b);
    if (!e) return null;
    const d = Math.pow(decay, i - e[2]);
    return [e[0] * d, e[1] * d];
  };
  for (let i = 0; i < n; i++) {
    while (pi < pvs.length && pvs[pi].conf === i) {
      const p = pvs[pi++];
      const va = pre.avgV[p.j];
      const w = (va > 0 && !Number.isNaN(va)) ? Math.min((+c5[p.j][5] || 0) / va, VCAP) : 1;
      const b = Math.floor(Math.log(p.price) / LNB);
      dep(b, w, p.isHigh, p.j);
      if (SMOOTH) { dep(b - 1, w / 2, p.isHigh, p.j); dep(b + 1, w / 2, p.isHigh, p.j); }
    }
    if (i < WARM || i >= n - 2) continue;
    const noise = pre.avgA[i];
    if (!(noise > 0)) continue;
    const vPrev = c5[i - S][4] - c5[i - 2 * S][4];
    const vNow = c5[i][4] - c5[i - S][4];
    if (Math.abs(vPrev) < MINK * noise) continue;
    const dirApp = vPrev > 0 ? 1 : -1;
    const lnc = lnC[i], b0 = Math.floor(lnc / LNB);
    for (const D of DS) {
      let bestB = -1, bestTot = 0, bestE = null;
      for (let b = b0 - 3; b <= b0 + 3; b++) {
        const ctr = (b + 0.5) * LNB, dd = ctr - lnc;
        if (Math.abs(dd) > D) continue;
        if (dirApp < 0 && dd > 0.5 * LNB) continue;
        if (dirApp > 0 && dd < -0.5 * LNB) continue;
        const e = readAt(b, i);
        if (!e) continue;
        const tot = e[0] + e[1];
        if (tot > bestTot) { bestTot = tot; bestB = b; bestE = e; }
      }
      if (bestB < 0) continue;
      const ctr = (bestB + 0.5) * LNB;
      if (Math.abs(lnC[i - F] - ctr) <= D) continue;
      const sMatch = dirApp < 0 ? bestE[0] : bestE[1];
      for (const mo of MODES) {
        const score = mo === "a0" ? bestTot : sMatch;
        for (const M of MS) {
          if (score < M) continue;
          for (const DEC of DECS) {
            if (Math.abs(vNow) > DEC * Math.abs(vPrev)) continue;
            sigs[M + "|" + D + "|" + DEC + "|" + mo].push({ i5: i, dir: -dirApp });
          }
        }
      }
    }
  }
  return sigs;
}

const res = [];
for (const sym of SHORT) {
  const instId = sym + "-USDT-SWAP";
  let c5; try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
  if (!Array.isArray(c5) || c5.length < 3000) continue;
  const pre = precalc(c5);
  for (const L of LS) {
    const pvs = pivots(c5, L);
    for (const HALF of HALFS) for (const MINK of MINKS) for (const SMOOTH of SMOOTHS) {
      const sigs = passe(c5, pre, pvs, HALF, MINK, SMOOTH);
      for (const key of Object.keys(sigs)) {
        const list = sigs[key];
        if (list.length < 25) continue;
        for (const ex of Object.keys(EXITS)) {
          const r = evaluer({ exits: EXITS[ex], detect: () => list }, c5);
          if (!r.A || !r.B) continue;
          const worst = Math.min(r.A.esp, r.B.esp);
          const valide = r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15;
          res.push({ instId, L, HALF, MINK, SMOOTH, key, ex, espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n, pfOOS: r.B.pf, wrOOS: r.B.wr, worst: +worst.toFixed(2), valide });
        }
      }
    }
  }
  console.error("fait " + sym);
}
res.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "rapports", "inv_memoire_scan3_resultats.json"), JSON.stringify(res, null, 1));
console.log("lignes: " + res.length + " · valides: " + res.filter(r => r.valide).length);
for (const r of res.filter(r => r.valide).slice(0, 45)) console.log(JSON.stringify(r));
