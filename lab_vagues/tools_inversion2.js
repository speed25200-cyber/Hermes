// SAUVETAGE v2 de la stratégie d'origine (demande client) : sévérité du score graduée,
// ajout d'indicateurs de confirmation, exits alternatifs — sur la piste verte du test 1
// (INVERSION + filtre de range 24 h : +1,21 %) et sur l'original pour contrôle.
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const LEV = 15, COUT_PX = 0.0012;
const LAB = __dirname;

function chargerCandles(instId) {
  for (const d of ["data365", "data90", "data"]) {
    const f = path.join(LAB, d, instId + ".json");
    if (fs.existsSync(f)) { try { const c = JSON.parse(fs.readFileSync(f)); if (c.length > 500) return c; } catch {} }
  }
  return null;
}
function sim(c5, i5, dir, ex) {
  const entry = c5[i5][4];
  const tpPx = ex.tp / LEV, slPx0 = ex.sl / LEV, actPx = ex.act / LEV, cbPx = ex.cb / LEV;
  const hold = ex.holdH * 12;
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  let sl = dir > 0 ? entry * (1 - slPx0) : entry * (1 + slPx0);
  let best = entry;
  const end = Math.min(c5.length - 1, i5 + hold);
  for (let k = i5 + 1; k <= end; k++) {
    const hi = c5[k][2], lo = c5[k][3];
    if (dir > 0 ? lo <= sl : hi >= sl) return (dir > 0 ? sl / entry - 1 : 1 - sl / entry) - COUT_PX;
    if (dir > 0 ? hi >= tp : lo <= tp) return tpPx - COUT_PX;
    const close = c5[k][4];
    if (dir > 0 ? close > best : close < best) best = close;
    if ((dir > 0 ? best / entry - 1 : 1 - best / entry) >= actPx) {
      const t = dir > 0 ? best * (1 - cbPx) : best * (1 + cbPx);
      if (dir > 0 ? t > sl : t < sl) sl = t;
    }
  }
  return (dir > 0 ? c5[end][4] / entry - 1 : 1 - c5[end][4] / entry) - COUT_PX;
}
function rangePosAt(c5, i) {
  if (i < 288) return null;
  let hh = -Infinity, ll = Infinity;
  for (let k = i - 287; k <= i; k++) { if (c5[k][2] > hh) hh = c5[k][2]; if (c5[k][3] < ll) ll = c5[k][3]; }
  return hh > ll ? (c5[i][4] - ll) / (hh - ll) : 0.5;
}
function rsiAt(c5, i) {
  if (i < 60) return null;
  const p = 14; let g = 0, pr = 0;
  for (let k = i - 44; k <= i; k++) {
    const d = c5[k][4] - c5[k - 1][4];
    if (k <= i - 44 + p) { if (d > 0) g += d; else pr -= d; continue; }
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
  }
  return 100 - 100 / (1 + g / (pr || 1e-12));
}
function volSpikeAt(c5, i) {
  if (i < 288) return null;
  const v = [];
  for (let k = i - 287; k <= i; k++) v.push(c5[k][5]);
  v.sort((a, b) => a - b);
  const med = v.length % 2 ? v[v.length >> 1] : (v[(v.length >> 1) - 1] + v[v.length >> 1]) / 2;
  return med > 0 ? c5[i][5] / med : null;
}

const E1 = { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 };
const E2 = { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 };

/* Chaque variante : {nom, exits, decide(dirSignal, score, c5, i) -> dir|0} */
function rangeOk(dir, p) { return p != null && ((dir > 0 && p < 0.5) || (dir < 0 && p > 0.5)); }
function rangeStrict(dir, p) { return p != null && ((dir > 0 && p < 0.25) || (dir < 0 && p > 0.75)); }
const VARIANTES = [
  { nom: "INV_RANGE (référence)", ex: E1, f: (d, s, c, i) => { const nd = -d; return rangeOk(nd, rangePosAt(c, i)) ? nd : 0; } },
  { nom: "INV_RANGE sévérité 2.1", ex: E1, f: (d, s, c, i) => { if (Math.abs(s) < 2.1) return 0; const nd = -d; return rangeOk(nd, rangePosAt(c, i)) ? nd : 0; } },
  { nom: "INV_RANGE sévérité 2.2", ex: E1, f: (d, s, c, i) => { if (Math.abs(s) < 2.2) return 0; const nd = -d; return rangeOk(nd, rangePosAt(c, i)) ? nd : 0; } },
  { nom: "INV_RANGE strict (quartiles)", ex: E1, f: (d, s, c, i) => { const nd = -d; return rangeStrict(nd, rangePosAt(c, i)) ? nd : 0; } },
  { nom: "INV_RANGE + RSI accord", ex: E1, f: (d, s, c, i) => { const nd = -d; if (!rangeOk(nd, rangePosAt(c, i))) return 0; const r = rsiAt(c, i); if (r == null) return 0; return (nd > 0 && r < 35) || (nd < 0 && r > 65) ? nd : 0; } },
  { nom: "INV_RANGE + volume 2x", ex: E1, f: (d, s, c, i) => { const nd = -d; if (!rangeOk(nd, rangePosAt(c, i))) return 0; const v = volSpikeAt(c, i); return v != null && v >= 2 ? nd : 0; } },
  { nom: "INV_RANGE exits courts", ex: E2, f: (d, s, c, i) => { const nd = -d; return rangeOk(nd, rangePosAt(c, i)) ? nd : 0; } },
  { nom: "ORIG_RANGE (contrôle)", ex: E1, f: (d, s, c, i) => rangeOk(d, rangePosAt(c, i)) ? d : 0 },
  { nom: "ORIG sévérité 2.2 (contrôle)", ex: E1, f: (d, s) => Math.abs(s) >= 2.2 ? d : 0 },
  { nom: "RANGE seul SANS signal (contrôle-clé)", ex: E1, f: null } // géré à part : entre à CHAQUE bougie extrême de range, sans signal
];

(async () => {
  const signaux = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(LAB, "..", "data", "sim-logs.jsonl")) });
  for await (const l of rl) {
    try { const j = JSON.parse(l); if (j.dir && Math.abs(j.score) >= 2) signaux.push({ ts: Date.parse(j.ts), instId: j.instId, dir: j.dir === "long" || j.dir === 1 || j.dir > 0 ? 1 : -1, score: Math.abs(j.score) }); } catch {}
  }
  signaux.sort((a, b) => a.ts - b.ts);
  const scores = signaux.map(s => s.score).sort((a, b) => a - b);
  console.log("signaux:", signaux.length, "· score médian:", scores[scores.length >> 1].toFixed(2), "· p90:", scores[Math.floor(scores.length * 0.9)].toFixed(2), "· max:", scores[scores.length - 1].toFixed(2));

  const parInst = {};
  for (const s of signaux) (parInst[s.instId] = parInst[s.instId] || []).push(s);
  const res = VARIANTES.map(() => []);
  for (const [instId, sigs] of Object.entries(parInst)) {
    const c5 = chargerCandles(instId);
    if (!c5) continue;
    const t0 = c5[0][0], step = 300000;
    const busy = VARIANTES.map(() => -1);
    for (const s of sigs) {
      const i = Math.floor((s.ts - t0) / step);
      if (i < 290 || i >= c5.length - 20) continue;
      if (!c5[i] || Math.abs(c5[i][0] - (s.ts - (s.ts % step))) >= step * 2) continue;
      VARIANTES.forEach((V, k) => {
        if (!V.f) return;
        const dir = V.f(s.dir, s.score, c5, i);
        if (!dir || i <= busy[k]) return;
        const pnl = sim(c5, i, dir, V.ex);
        busy[k] = i + V.ex.holdH * 12;
        res[k].push(pnl);
      });
    }
    // contrôle-clé : le filtre de range SEUL, sans aucun signal (échantillonné toutes les 12 bougies)
    const k = VARIANTES.length - 1;
    for (let i = 300; i < c5.length - 20; i += 12) {
      if (i <= busy[k]) continue;
      const p = rangePosAt(c5, i);
      let dir = 0;
      if (p != null && p < 0.5) dir = 1; else if (p != null && p > 0.5) dir = -1;
      if (!dir) continue;
      const pnl = sim(c5, i, dir, E1);
      busy[k] = i + E1.holdH * 12;
      res[k].push(pnl);
    }
  }
  console.log("\n=== SAUVETAGE v2 (esp % marge/trade net) ===");
  VARIANTES.forEach((V, k) => {
    const l = res[k];
    if (l.length < 30) { console.log(V.nom.padEnd(34), "n insuffisant (" + l.length + ")"); return; }
    const n = l.length, w = l.filter(p => p > 0).length, s = l.reduce((a, b) => a + b, 0);
    console.log(V.nom.padEnd(34), ("esp " + (100 * s / n * LEV).toFixed(2) + "%").padStart(12), ("wr " + (100 * w / n).toFixed(1) + "%").padStart(10), ("n=" + n).padStart(8));
  });
})();
