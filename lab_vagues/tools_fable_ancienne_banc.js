// BANC "ancienne stratégie" (moteur à score) — harnais commun.
// - signaux réels : fable_signaux.json (extrait de data/sim-logs.jsonl, |score|>=2, dir non-null)
// - bougies : fusion data_fable (collecte ciblée) + data365 + data90 + data, dédup par ts
// - alignement signal->bougie par RECHERCHE BINAIRE sur ts exact (pas d'hypothèse de grille continue)
// - garde de contiguïté : 288 bougies d'historique contigu (features 24h) + arrêt de sim sur trou
// - anti-chevauchement par instrument et par variante (busy = index de sortie réel)
// - splits : aout_IS (1re moitié de la période d'août par timestamp), aout_OOS (2e), epoque2 (tout < 2026-08)
// Usage : node tools_fable_ancienne_banc.js <grille>   (grille = stage1 | filtres | exits | plateau | final)
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
function idxOf(c5, t5) { // recherche binaire du ts exact
  let lo = 0, hi = c5.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c5[m][0] === t5) return m; if (c5[m][0] < t5) lo = m + 1; else hi = m - 1; }
  return -1;
}

/* ---------- features (fenêtre [i-287..i], connue à la clôture de la bougie i) ---------- */
function features(c5, i, ts) {
  if (i < 288 || c5[i - 288][0] !== c5[i][0] - 288 * STEP) return null; // historique non contigu
  let hh = -Infinity, ll = Infinity;
  const vols = new Array(288);
  for (let k = i - 287, j = 0; k <= i; k++, j++) {
    if (c5[k][2] > hh) hh = c5[k][2];
    if (c5[k][3] < ll) ll = c5[k][3];
    vols[j] = c5[k][5];
  }
  vols.sort((a, b) => a - b);
  const med = (vols[143] + vols[144]) / 2;
  // RSI14 lissé sur les 45 dernières clôtures
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

/* ---------- simulation (pire-cas dans la bougie : SL testé avant TP) ---------- */
function sim(c5, i5, dir, ex, entryOverride) {
  const entry = entryOverride || c5[i5][4];
  const tpPx = ex.tp / LEV, slPx0 = ex.sl / LEV, actPx = ex.act / LEV, cbPx = ex.cb / LEV;
  const hold = Math.round(ex.holdH * 12);
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  let sl = dir > 0 ? entry * (1 - slPx0) : entry * (1 + slPx0);
  let best = entry;
  let end = Math.min(c5.length - 1, i5 + hold);
  for (let k = i5 + 1; k <= end; k++) {
    if (c5[k][0] !== c5[k - 1][0] + STEP) { end = k - 1; break; } // trou de données : sortie au close précédent
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

/* ---------- corpus : signaux enrichis, prêts à évaluer ---------- */
function chargerCorpus() {
  const sig = JSON.parse(fs.readFileSync(path.join(LAB, "fable_signaux.json")));
  const parInst = {};
  for (const s of sig) (parInst[s[1]] = parInst[s[1]] || []).push(s);
  const corpus = {}; // instId -> {c5, sigs:[{ts,i,dir,score,f}]}
  let ok = 0, sans = 0, aoutMin = Infinity, aoutMax = -Infinity;
  for (const [instId, list] of Object.entries(parInst)) {
    const c5 = chargerCandles(instId);
    if (!c5) { sans += list.length; continue; }
    const rows = [];
    for (const s of list) {
      const t5 = s[0] - (s[0] % STEP);
      const i = idxOf(c5, t5);
      if (i < 0) continue;
      const f = features(c5, i, s[0]);
      if (!f) continue;
      if (i >= c5.length - 24 || c5[i + 24] && c5[i + 24][0] !== c5[i][0] + 24 * STEP) continue; // >=2h de bougies devant
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

/* ---------- évaluation d'une liste de variantes ---------- */
// variante = {nom, ex, delay?, decide(dir, score, f) -> dir tradé | 0}
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
        const iE = s.i + (V.delay || 0);
        if (iE <= busy[k] || iE >= c5.length - 2) return;
        if (V.delay && c5[iE] && c5[iE][0] !== c5[s.i][0] + V.delay * STEP) return;
        const key = iE + ":" + dir + ":" + (V.exKey || "E1");
        let t = memo.get(key);
        if (!t) { t = sim(c5, iE, dir, V.ex || E1); memo.set(key, t); }
        busy[k] = V.lockHold ? iE + Math.round((V.ex || E1).holdH * 12) : t.fin + (V.cooldown || 0);
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
  const grille = process.argv[2] || "stage1";
  const { corpus, midAout } = chargerCorpus();
  let variantes = [];

  if (grille === "stage1") {
    // contrôles
    variantes.push({ nom: "ORIGINAL s>=2", decide: (d) => d });
    variantes.push({ nom: "INVERSE s>=2", decide: (d) => -d });
    // grille verte : INVERSE + seuil score + volume
    for (const S of [2.0, 2.1, 2.2, 2.3, 2.4, 2.5])
      for (const V of [0, 1.5, 2, 2.5, 3])
        variantes.push({ nom: `INV s>=${S} vol>=${V || "-"}`, decide: (d, s, f) => (s >= S && f.volSpike >= V) ? -d : 0 });
  }

  if (grille === "candidat") {
    // Candidat : INV + vol>=V + accord range-24h, verrou 12h. Contrôles de direction + plateau.
    const acc = (nd, p, lo, hi) => (nd > 0 && p < lo) || (nd < 0 && p > hi);
    // contrôles de direction sur le MÊME jeu d'entrées (vol>=2, verrou 12h)
    variantes.push({ nom: "G. dir = -signal si accord range (candidat)", lockHold: true, decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2 && acc(nd, f.rangePos, 0.5, 0.5) ? nd : 0; } });
    variantes.push({ nom: "H. dir = pure range (ignore le signal)", lockHold: true, decide: (d, s, f) => f.volSpike >= 2 ? (f.rangePos < 0.5 ? 1 : -1) : 0 });
    variantes.push({ nom: "I. dir = +signal si accord range (anti)", lockHold: true, decide: (d, s, f) => f.volSpike >= 2 && acc(d, f.rangePos, 0.5, 0.5) ? d : 0 });
    variantes.push({ nom: "J. candidat sans volume (range seul)", lockHold: true, decide: (d, s, f) => { const nd = -d; return acc(nd, f.rangePos, 0.5, 0.5) ? nd : 0; } });
    // plateau : volume x sévérité du range x verrou
    for (const V of [1.5, 2, 2.5, 3])
      for (const [rn, lo, hi] of [["0.5", 0.5, 0.5], ["0.4/0.6", 0.4, 0.6], ["0.25/0.75", 0.25, 0.75]])
        for (const [ln, lk] of [["hold12h", { lockHold: true }], ["cool3h", { cooldown: 36 }]])
          variantes.push({ nom: `INV vol>=${V} range<${rn} ${ln}`, ...lk, decide: (d, s, f) => { const nd = -d; return f.volSpike >= V && acc(nd, f.rangePos, lo, hi) ? nd : 0; } });
  }

  if (grille === "raffinage") {
    // familles les moins mauvaises d'août / fortes en ep2, x verrous x retard
    const fam = {
      "s2.1+range": (d, s, f) => { const nd = -d; return s >= 2.1 && ((nd > 0 && f.rangePos < 0.5) || (nd < 0 && f.rangePos > 0.5)) ? nd : 0; },
      "vol2+range": (d, s, f) => { const nd = -d; return f.volSpike >= 2 && ((nd > 0 && f.rangePos < 0.5) || (nd < 0 && f.rangePos > 0.5)) ? nd : 0; },
      "s2.1vol2": (d, s, f) => (s >= 2.1 && f.volSpike >= 2) ? -d : 0,
      "s2.2vol2.5": (d, s, f) => (s >= 2.2 && f.volSpike >= 2.5) ? -d : 0
    };
    for (const [fn, ff] of Object.entries(fam))
      for (const [ln, lo] of [["exit", {}], ["cool1h", { cooldown: 12 }], ["cool3h", { cooldown: 36 }], ["hold12h", { lockHold: true }]])
        for (const delay of [0, 2])
          variantes.push({ nom: `INV ${fn} lock=${ln} ret${delay}`, delay, ...lo, decide: ff });
  }

  if (grille === "controles") {
    // Où vit l'edge ? direction du score vs timing du spike vs structure de sortie.
    const spike = (s, f, S, V) => s >= S && f.volSpike >= V;
    variantes.push({ nom: "A. INV s>=2.1 vol>=2 (piste verte)", decide: (d, s, f) => spike(s, f, 2.1, 2) ? -d : 0 });
    variantes.push({ nom: "B. mêmes entrées, dir = fade ret1h", decide: (d, s, f) => spike(s, f, 2.1, 2) ? (f.ret1h > 0 ? -1 : 1) : 0 });
    variantes.push({ nom: "C. mêmes entrées, dir = suit ret1h", decide: (d, s, f) => spike(s, f, 2.1, 2) ? (f.ret1h > 0 ? 1 : -1) : 0 });
    variantes.push({ nom: "D. mêmes entrées, dir pseudo-aléa", decide: (d, s, f) => spike(s, f, 2.1, 2) ? ((Math.abs(Math.sin(s * 1e4)) > 0.5) ? 1 : -1) : 0 });
    variantes.push({ nom: "E. vol>=2 SEUL (score>=2 requis)", decide: (d, s, f) => f.volSpike >= 2 ? -d : 0 });
    variantes.push({ nom: "F. ORIGINAL s>=2.1 vol>=2", decide: (d, s, f) => spike(s, f, 2.1, 2) ? d : 0 });
  }

  if (grille === "lock") {
    // effet du verrou anti-réentrée sur la piste verte (S x V restreint)
    for (const S of [2.0, 2.1, 2.2])
      for (const V of [1.5, 2])
        for (const L of [["exit", {}], ["hold12h", { lockHold: true }], ["cool1h", { cooldown: 12 }], ["cool3h", { cooldown: 36 }]])
          variantes.push({ nom: `INV s>=${S} vol>=${V} lock=${L[0]}`, ...L[1], decide: (d, s, f) => (s >= S && f.volSpike >= V) ? -d : 0 });
  }

  if (grille === "filtres") {
    const base = (S, V) => (d, s, f) => (s >= S && f.volSpike >= V) ? -d : 0;
    variantes.push({ nom: "réf INV s>=2.1 vol>=2", decide: base(2.1, 2) });
    // volume seul (1 filtre), sens par côté
    variantes.push({ nom: "INV vol>=2 (sans seuil score)", decide: (d, s, f) => f.volSpike >= 2 ? -d : 0 });
    variantes.push({ nom: "INV s>=2.1 vol>=2 LONGS seulement", decide: (d, s, f) => (s >= 2.1 && f.volSpike >= 2 && -d > 0) ? -d : 0 });
    variantes.push({ nom: "INV s>=2.1 vol>=2 SHORTS seulement", decide: (d, s, f) => (s >= 2.1 && f.volSpike >= 2 && -d < 0) ? -d : 0 });
    // alternatives au 2e filtre (score + X)
    variantes.push({ nom: "INV s>=2.1 + range accord", decide: (d, s, f) => { const nd = -d; return s >= 2.1 && ((nd > 0 && f.rangePos < 0.5) || (nd < 0 && f.rangePos > 0.5)) ? nd : 0; } });
    variantes.push({ nom: "INV s>=2.1 + RSI extreme", decide: (d, s, f) => { const nd = -d; return s >= 2.1 && ((nd > 0 && f.rsi < 35) || (nd < 0 && f.rsi > 65)) ? nd : 0; } });
    variantes.push({ nom: "INV s>=2.1 + meche accord", decide: (d, s, f) => { const nd = -d; return s >= 2.1 && ((nd > 0 && f.mecheBasse >= 0.4) || (nd < 0 && f.mecheHaute >= 0.4)) ? nd : 0; } });
    // volume + X (sans seuil score au-delà de 2.0)
    variantes.push({ nom: "INV vol>=2 + range accord", decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2 && ((nd > 0 && f.rangePos < 0.5) || (nd < 0 && f.rangePos > 0.5)) ? nd : 0; } });
    variantes.push({ nom: "INV vol>=2 + ret1h contre", decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2 && ((nd > 0 && f.ret1h < -0.01) || (nd < 0 && f.ret1h > 0.01)) ? nd : 0; } });
    // entrée retardée
    variantes.push({ nom: "INV s>=2.1 vol>=2 retard1", delay: 1, decide: base(2.1, 2) });
    variantes.push({ nom: "INV s>=2.1 vol>=2 retard2", delay: 2, decide: base(2.1, 2) });
    // heures
    for (const [h0, h1] of [[0, 8], [8, 16], [16, 24]])
      variantes.push({ nom: `INV s>=2.1 vol>=2 h${h0}-${h1}`, decide: (d, s, f) => (s >= 2.1 && f.volSpike >= 2 && f.hour >= h0 && f.hour < h1) ? -d : 0 });
  }

  if (grille === "exits") {
    const decide = process.env.FAM === "range"
      ? (d, s, f) => { const nd = -d; return f.volSpike >= 2 && ((nd > 0 && f.rangePos < 0.5) || (nd < 0 && f.rangePos > 0.5)) ? nd : 0; }
      : ((S, V) => (d, s, f) => (s >= S && f.volSpike >= V) ? -d : 0)(+(process.env.S || 2.1), +(process.env.V || 2));
    const lockHold = process.env.FAM === "range";
    const exs = [];
    for (const tp of [0.5, 0.8, 1.2]) for (const sl of [0.2, 0.3]) for (const act of [0.2, 0.3, 0.5]) for (const hold of [6, 12, 24])
      exs.push({ tp, sl, act, cb: 0.05, holdH: hold });
    exs.push({ tp: 0.8, sl: 0.3, act: 0.3, cb: 0.1, holdH: 12 });
    exs.push({ tp: 0.8, sl: 0.3, act: 0.3, cb: 0.15, holdH: 12 });
    exs.push({ tp: 9.9, sl: 0.3, act: 0.3, cb: 0.05, holdH: 12 }); // sans TP (trail pur)
    variantes = exs.map(ex => ({ nom: `tp${ex.tp} sl${ex.sl} act${ex.act} cb${ex.cb} h${ex.holdH}`, ex, exKey: JSON.stringify(ex), lockHold, decide }));
  }

  const res = evaluer(corpus, midAout, variantes);
  afficher(variantes, res);
}
