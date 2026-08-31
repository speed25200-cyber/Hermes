// BANC v3 "ancienne stratégie" — CORRECTION DU LOOK-AHEAD de l'itération 1.
//
// Modèle d'exécution HONNÊTE (aligné sur le module ombre, implémentable tel quel) :
//   - le signal tombe à ts, à l'intérieur de la bougie 5m iSig (open = floor(ts/5m)) ;
//   - on ATTEND la clôture de iSig (t5+5min) : à cet instant les features de iSig
//     (volume spike, range 24h, RSI, mèches) sont intégralement connues ;
//   - l'ENTRÉE se fait à l'OPEN de la bougie iSig+1 (premier prix imprimé strictement
//     APRÈS toute l'information utilisée) — jamais au close de iSig ;
//   - la simulation parcourt iSig+1..fin : l'entrée étant l'open de iSig+1, ses
//     high/low sont valides pour SL/TP (pire-cas : SL testé avant TP).
// delay D optionnel : entrée à l'open de iSig+1+D (features toujours celles de iSig).
//
// Le reste est identique au banc v1 : bougies fusionnées (dédup), garde de contiguïté
// 288 bougies, anti-chevauchement par instrument, splits aout_IS / aout_OOS / epoque2.
// Usage : node tools_fable_ancienne_banc3.js <grille>
const fs = require("fs");
const path = require("path");
const LAB = __dirname;
const LEV = 15, COUT_PX = +(process.env.COUT || 0.0012), STEP = 300000;
const E1 = { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 };

/* ---------- bougies ---------- */
const cacheC = {};
function chargerCandles(instId) {
  if (instId in cacheC) return cacheC[instId];
  const seen = new Map();
  for (const d of ["data_fable", "data365", "data90", "data"]) {
    const f = path.join(LAB, d, instId + ".json");
    if (!fs.existsSync(f)) continue;
    try {
      const c = JSON.parse(fs.readFileSync(f));
      for (const row of c) if (!seen.has(row[0])) seen.set(row[0], row);
    } catch {}
  }
  const all = [...seen.values()].sort((a, b) => a[0] - b[0]);
  return (cacheC[instId] = all.length > 300 ? all : null);
}
function idxOf(c5, t5) {
  let lo = 0, hi = c5.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c5[m][0] === t5) return m; if (c5[m][0] < t5) lo = m + 1; else hi = m - 1; }
  return -1;
}

/* ---------- features (fenêtre [i-287..i], connues à la CLÔTURE de la bougie i) ---------- */
function features(c5, i, ts) {
  if (i < 288 || c5[i - 288][0] !== c5[i][0] - 288 * STEP) return null;
  let hh = -Infinity, ll = Infinity;
  const vols = new Array(288);
  for (let k = i - 287, j = 0; k <= i; k++, j++) {
    if (c5[k][2] > hh) hh = c5[k][2];
    if (c5[k][3] < ll) ll = c5[k][3];
    vols[j] = c5[k][5];
  }
  vols.sort((a, b) => a - b);
  const med = (vols[143] + vols[144]) / 2;
  const p = 14; let g = 0, pr = 0;
  for (let k = i - 44; k <= i; k++) {
    const d = c5[k][4] - c5[k - 1][4];
    if (k <= i - 44 + p) { if (d > 0) g += d; else pr -= d; continue; }
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
  }
  const o = c5[i][1], h = c5[i][2], l = c5[i][3], cl = c5[i][4], rng = h - l;
  return {
    volSpike: med > 0 ? c5[i][5] / med : 0,
    rangePos: hh > ll ? (cl - ll) / (hh - ll) : 0.5,
    rsi: 100 - 100 / (1 + g / (pr || 1e-12)),
    hour: new Date(ts).getUTCHours(),
    mecheHaute: rng > 0 ? (h - Math.max(o, cl)) / rng : 0,
    mecheBasse: rng > 0 ? (Math.min(o, cl) - l) / rng : 0,
    ret1h: c5[i - 12] ? cl / c5[i - 12][4] - 1 : 0
  };
}

/* ---------- simulation : ENTRÉE À L'OPEN de la bougie k0 (pire-cas : SL avant TP) ---------- */
function sim(c5, k0, dir, ex) {
  const entry = c5[k0][1]; // OPEN — premier prix postérieur à l'information de décision
  const tpPx = ex.tp / LEV, slPx0 = ex.sl / LEV, actPx = ex.act / LEV, cbPx = ex.cb / LEV;
  const hold = Math.round(ex.holdH * 12);
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  let sl = dir > 0 ? entry * (1 - slPx0) : entry * (1 + slPx0);
  let best = entry;
  let end = Math.min(c5.length - 1, k0 + hold);
  for (let k = k0; k <= end; k++) {
    if (k > k0 && c5[k][0] !== c5[k - 1][0] + STEP) { end = k - 1; break; } // trou : sortie au close précédent
    const hi = c5[k][2], lo = c5[k][3];
    if (dir > 0 ? lo <= sl : hi >= sl) return { pnl: (dir > 0 ? sl / entry - 1 : 1 - sl / entry) - COUT_PX, fin: k };
    if (dir > 0 ? hi >= tp : lo <= tp) return { pnl: tpPx - COUT_PX, fin: k };
    const close = c5[k][4];
    if (dir > 0 ? close > best : close < best) best = close;
    if ((dir > 0 ? best / entry - 1 : 1 - best / entry) >= actPx) {
      const t = dir > 0 ? best * (1 - cbPx) : best * (1 + cbPx);
      if (dir > 0 ? t > sl : t < sl) sl = t;
    }
  }
  return { pnl: (dir > 0 ? c5[end][4] / entry - 1 : 1 - c5[end][4] / entry) - COUT_PX, fin: end };
}

/* ---------- corpus ---------- */
function chargerCorpus() {
  const sig = JSON.parse(fs.readFileSync(path.join(LAB, "fable_signaux.json")));
  const parInst = {};
  for (const s of sig) (parInst[s[1]] = parInst[s[1]] || []).push(s);
  const corpus = {};
  let ok = 0, sans = 0, aoutMin = Infinity, aoutMax = -Infinity;
  for (const [instId, list] of Object.entries(parInst)) {
    const c5 = chargerCandles(instId);
    if (!c5) { sans += list.length; continue; }
    const rows = [];
    for (const s of list) {
      const t5 = s[0] - (s[0] % STEP);
      const i = idxOf(c5, t5);          // bougie CONTENANT le signal (close à t5+5min > ts)
      if (i < 0) continue;
      const f = features(c5, i, s[0]);  // connues à la clôture de i, AVANT l'entrée en i+1
      if (!f) continue;
      if (i + 1 >= c5.length || c5[i + 1][0] !== c5[i][0] + STEP) continue; // pas de bougie d'entrée contiguë
      if (i >= c5.length - 24 || c5[i + 24] && c5[i + 24][0] !== c5[i][0] + 24 * STEP) continue; // >=2h devant
      rows.push({ ts: s[0], i, dir: s[2], score: Math.abs(s[3]), f });
      ok++;
      if (s[0] >= Date.parse("2026-08-01")) { if (s[0] < aoutMin) aoutMin = s[0]; if (s[0] > aoutMax) aoutMax = s[0]; }
    }
    if (rows.length) corpus[instId] = { c5, sigs: rows };
  }
  const midAout = (aoutMin + aoutMax) / 2;
  console.log(`corpus : ${ok} signaux évaluables · ${sans} sans bougies · split août @ ${new Date(midAout).toISOString()}`);
  return { corpus, midAout };
}

/* ---------- évaluation ---------- */
// variante = {nom, ex?, exKey?, delay?, lockHold?, cooldown?, decide(dir, score, f) -> dir tradé | 0}
function evaluer(corpus, midAout, variantes) {
  const res = variantes.map(() => ({ aout_IS: [], aout_OOS: [], epoque2: [], _ts: variantes.length <= 6 ? [] : null }));
  for (const inst of Object.values(corpus)) {
    const { c5, sigs } = inst;
    const busy = variantes.map(() => -1);
    const memo = new Map();
    for (const s of sigs) {
      variantes.forEach((V, k) => {
        const dir = V.decide(s.dir, s.score, s.f);
        if (!dir) return;
        const iE = s.i + 1 + (V.delay || 0); // ENTRÉE à l'open de iSig+1(+delay)
        if (iE <= busy[k] || iE >= c5.length - 1) return;
        if (c5[iE][0] !== c5[s.i][0] + (1 + (V.delay || 0)) * STEP) return; // contiguïté jusqu'à l'entrée
        const key = iE + ":" + dir + ":" + (V.exKey || "E1");
        let t = memo.get(key);
        if (!t) { t = sim(c5, iE, dir, V.ex || E1); memo.set(key, t); }
        busy[k] = V.lockBars ? iE + V.lockBars : (V.lockHold ? iE + Math.round((V.ex || E1).holdH * 12) : t.fin + (V.cooldown || 0));
        const era = s.ts >= Date.parse("2026-08-01") ? (s.ts <= midAout ? "aout_IS" : "aout_OOS") : "epoque2";
        res[k][era].push(t.pnl);
        if (res[k]._ts) res[k]._ts.push([s.ts, t.pnl]);
      });
    }
  }
  return res;
}
const agg = l => { const n = l.length; if (!n) return { n: 0 }; const w = l.filter(p => p > 0).length, s = l.reduce((a, b) => a + b, 0); return { n, wr: +(100 * w / n).toFixed(1), esp: +(100 * s / n * LEV).toFixed(2) }; };
function afficher(variantes, res) {
  const fmt = a => a.n ? `${String(a.esp).padStart(7)}% wr${String(a.wr).padStart(5)} n${String(a.n).padStart(4)}` : "        —              ";
  console.log("\nvariante".padEnd(46), "aout_IS".padStart(20), "aout_OOS".padStart(24), "epoque2".padStart(24));
  variantes.forEach((V, k) => {
    console.log(V.nom.padEnd(45), fmt(agg(res[k].aout_IS)), " |", fmt(agg(res[k].aout_OOS)), " |", fmt(agg(res[k].epoque2)));
  });
}

module.exports = { chargerCorpus, evaluer, afficher, agg, sim, E1, LEV };

/* ---------- grilles ---------- */
if (require.main === module) {
  const grille = process.argv[2] || "controles";
  const { corpus, midAout } = chargerCorpus();
  let variantes = [];

  if (grille === "controles") {
    // Les 4 contrôles-clés de l'itération 1, ré-mesurés SANS look-ahead.
    const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
    variantes.push({ nom: "ORIGINAL s>=2", decide: (d) => d });
    variantes.push({ nom: "INVERSE s>=2", decide: (d) => -d });
    variantes.push({ nom: "candidat it1: INV vol>=2 + range accord", lockHold: true, ex: { ...E1, cb: 0.10 }, exKey: "EXF", decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2 && acc(nd, f.rangePos) ? nd : 0; } });
    variantes.push({ nom: "piste verte it0: INV s>=2.1 vol>=2", decide: (d, s, f) => (s >= 2.1 && f.volSpike >= 2) ? -d : 0 });
    variantes.push({ nom: "range SEUL (ignore dir): pos<0.5 long", lockHold: true, decide: (d, s, f) => f.volSpike >= 2 ? (f.rangePos < 0.5 ? 1 : -1) : 0 });
  }

  if (grille === "stage1") {
    for (const S of [2.0, 2.1, 2.2, 2.3, 2.4, 2.5])
      for (const V of [0, 1.5, 2, 2.5, 3])
        variantes.push({ nom: `INV s>=${S} vol>=${V || "-"}`, decide: (d, s, f) => (s >= S && f.volSpike >= V) ? -d : 0 });
  }

  if (grille === "candidat") {
    const acc = (nd, p, lo, hi) => (nd > 0 && p < lo) || (nd < 0 && p > hi);
    for (const V of [1.5, 2, 2.5, 3])
      for (const [rn, lo, hi] of [["0.5", 0.5, 0.5], ["0.4/0.6", 0.4, 0.6], ["0.25/0.75", 0.25, 0.75]])
        for (const [ln, lk] of [["hold12h", { lockHold: true }], ["cool3h", { cooldown: 36 }]])
          variantes.push({ nom: `INV vol>=${V} range<${rn} ${ln}`, ...lk, decide: (d, s, f) => { const nd = -d; return f.volSpike >= V && acc(nd, f.rangePos, lo, hi) ? nd : 0; } });
  }

  const res = evaluer(corpus, midAout, variantes);
  afficher(variantes, res);
}
