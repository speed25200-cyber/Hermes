// CHANTIER TIMEFRAMES 4H/DAILY — scan des signaux de retournement calculés sur bougies
// agrégées (1h / 4h / 1j) depuis les 5 m de data90/ (90 j), exécutés sur les 5 m suivantes.
// Zéro look-ahead : une bougie agrégée n'est utilisable qu'une fois son bucket UTC terminé
// (dernière 5 m du bucket = i5 du signal ; en live on connaît la frontière par l'horloge).
// Exits FONDATEURS fixés a priori (leçon du registre : pas de balayage de sorties) :
//   E1 tp80/sl30/act30/cb5/hold12  ·  E2 tp80/sl30/act30/cb5/hold24 (horizon 4h plus long)
// Triple fenêtre : esp60 (60 j antérieurs) + espIS/espOOS (30 derniers jours, 20/10) — score = min des trois.
const fs = require("fs");
const path = require("path");
const { sim, agg } = require("../harness_lib.js");

const D90 = path.join(__dirname, "..", "..", "data90");
const BLOCK = new Set(["CBRS-USDT-SWAP"]); // action tokenisée (Cerebras) — blocklist journal
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
};
const H4 = 4 * 3600 * 1000, H1 = 3600 * 1000, D1 = 24 * 3600 * 1000;

// ---------- agrégation sans look-ahead ----------
function aggreger(c5, ms) {
  const out = [];
  let cur = null;
  for (let i = 0; i < c5.length; i++) {
    const b = Math.floor(c5[i][0] / ms);
    if (!cur || b !== cur.b) {
      if (cur) out.push(cur); // le bucket précédent est clos dès qu'un bucket plus récent commence
      cur = { b, ts: b * ms, o: c5[i][1], h: c5[i][2], l: c5[i][3], c: c5[i][4], last: i };
    } else {
      if (c5[i][2] > cur.h) cur.h = c5[i][2];
      if (c5[i][3] < cur.l) cur.l = c5[i][3];
      cur.c = c5[i][4]; cur.last = i;
    }
  }
  return out; // le bucket en cours (non clos) n'est jamais poussé
}
// pour chaque 5m i : index de la dernière bougie agrégée STRICTEMENT antérieure au bucket de i
function mapCloses(c5, A, ms) {
  const m = new Array(c5.length).fill(-1);
  let k = 0;
  for (let i = 0; i < c5.length; i++) {
    const b = Math.floor(c5[i][0] / ms);
    while (k < A.length && A[k].b < b) k++;
    m[i] = k - 1; // A[m[i]] est close au moment de la bougie 5m i
  }
  return m;
}

// ---------- indicateurs (aucun futur) ----------
function rsiWilder(closes, p) {
  const r = new Array(closes.length).fill(null);
  let g = 0, pr = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (i <= p) { if (d > 0) g += d; else pr -= d; if (i === p) r[i] = 100 - 100 / (1 + (g / p) / ((pr / p) || 1e-12)); continue; }
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
    r[i] = 100 - 100 / (1 + g / (pr || 1e-12));
  }
  return r;
}
function zScore(closes, N) {
  const z = new Array(closes.length).fill(null);
  let s = 0, s2 = 0;
  for (let i = 0; i < closes.length; i++) {
    s += closes[i]; s2 += closes[i] * closes[i];
    if (i >= N) { const o = closes[i - N]; s -= o; s2 -= o * o; }
    if (i >= N - 1) {
      const m = s / N, v = Math.max(s2 / N - m * m, 1e-18);
      z[i] = (closes[i] - m) / Math.sqrt(v);
    }
  }
  return z;
}
function atrWilder(A, p) {
  const a = new Array(A.length).fill(null);
  let acc = 0;
  for (let i = 1; i < A.length; i++) {
    const tr = Math.max(A[i].h - A[i].l, Math.abs(A[i].h - A[i - 1].c), Math.abs(A[i].l - A[i - 1].c));
    if (i <= p) { acc += tr; if (i === p) a[i] = acc / p; continue; }
    a[i] = (a[i - 1] * (p - 1) + tr) / p;
  }
  return a;
}

// ---------- familles de signaux sur série agrégée A -> [{i5,dir}] ----------
// mode "close"   : entrée à la clôture de la bougie TF signal
// mode "reclaim" : l'indicateur repasse DANS la zone normale -> entrée à cette clôture TF
// mode "trig5"   : zone TF active (dernière bougie TF close) + déclencheur RSI14-5m extrême <25/>75
// mode "conf5"   : après signal TF, 1re bougie 5m de reprise (close>open et >close préc.) sous 2 h
function famRsi(A, th, mode, ctx) {
  const r = rsiWilder(A.map(x => x.c), 14), out = [];
  if (mode === "close" || mode === "reclaim") {
    for (let k = 20; k < A.length; k++) {
      if (mode === "close") {
        if (r[k] != null && r[k] <= th) out.push({ i5: A[k].last, dir: 1 });
        else if (r[k] != null && r[k] >= 100 - th) out.push({ i5: A[k].last, dir: -1 });
      } else {
        if (r[k - 1] != null && r[k - 1] < th && r[k] >= th && r[k] < 50) out.push({ i5: A[k].last, dir: 1 });
        else if (r[k - 1] != null && r[k - 1] > 100 - th && r[k] <= 100 - th && r[k] > 50) out.push({ i5: A[k].last, dir: -1 });
      }
    }
    return out;
  }
  const zone = k => (r[k] == null ? 0 : r[k] <= th ? 1 : r[k] >= 100 - th ? -1 : 0);
  return zonesVersSignaux(A, ctx, zone, mode);
}
function famZ(A, N, th, mode, ctx) {
  const z = zScore(A.map(x => x.c), N), out = [];
  if (mode === "close" || mode === "reclaim") {
    for (let k = N + 1; k < A.length; k++) {
      if (mode === "close") {
        if (z[k] != null && z[k] <= -th) out.push({ i5: A[k].last, dir: 1 });
        else if (z[k] != null && z[k] >= th) out.push({ i5: A[k].last, dir: -1 });
      } else {
        if (z[k - 1] != null && z[k - 1] <= -th && z[k] > -th && z[k] < 0) out.push({ i5: A[k].last, dir: 1 });
        else if (z[k - 1] != null && z[k - 1] >= th && z[k] < th && z[k] > 0) out.push({ i5: A[k].last, dir: -1 });
      }
    }
    return out;
  }
  const zone = k => (z[k] == null ? 0 : z[k] <= -th ? 1 : z[k] >= th ? -1 : 0);
  return zonesVersSignaux(A, ctx, zone, mode);
}
function famWick(A, frac, mult, mode, ctx) {
  const atr = atrWilder(A, 14), out = [];
  const sig = k => {
    if (k < 16 || atr[k - 1] == null) return 0;
    const rg = A[k].h - A[k].l;
    if (rg <= 0 || rg < mult * atr[k - 1]) return 0;
    const wLo = Math.min(A[k].o, A[k].c) - A[k].l, wHi = A[k].h - Math.max(A[k].o, A[k].c);
    if (wLo / rg >= frac) return 1;
    if (wHi / rg >= frac) return -1;
    return 0;
  };
  if (mode === "close") {
    for (let k = 16; k < A.length; k++) { const d = sig(k); if (d) out.push({ i5: A[k].last, dir: d }); }
    return out;
  }
  return confVersSignaux(A, ctx, sig);
}
function famDbl(A, W, tol, rb, mode, ctx) {
  const out = [], G = 3, SEP = 6;
  const sig = k => {
    if (k < W + G) return 0;
    let lo = Infinity, hi = -Infinity, kLo = -1, kHi = -1;
    for (let j = k - W; j <= k - G; j++) {
      if (A[j].l < lo) { lo = A[j].l; kLo = j; }
      if (A[j].h > hi) { hi = A[j].h; kHi = j; }
    }
    // double creux : retest du plus bas ±tol, rebond intermédiaire >= rb, bougie de reprise
    if (k - kLo >= SEP && Math.abs(A[k].l - lo) / lo <= tol && A[k].c > A[k].o) {
      let rebond = -Infinity;
      for (let j = kLo + 1; j < k; j++) rebond = Math.max(rebond, A[j].c);
      if (rebond >= lo * (1 + rb)) return 1;
    }
    if (k - kHi >= SEP && Math.abs(hi - A[k].h) / hi <= tol && A[k].c < A[k].o) {
      let creux = Infinity;
      for (let j = kHi + 1; j < k; j++) creux = Math.min(creux, A[j].c);
      if (creux <= hi * (1 - rb)) return 1 * -1;
    }
    return 0;
  };
  if (mode === "close") {
    for (let k = W + G; k < A.length; k++) { const d = sig(k); if (d) out.push({ i5: A[k].last, dir: d }); }
    return out;
  }
  return confVersSignaux(A, ctx, sig);
}
// zone TF -> déclencheur RSI14-5m extrême dans le même sens
function zonesVersSignaux(A, ctx, zone, mode) {
  const { c5, map, rsi5 } = ctx, out = [];
  for (let i = 300; i < c5.length; i++) {
    const k = map[i];
    if (k < 20) continue;
    const d = zone(k);
    if (!d) continue;
    if (mode === "trig5") {
      if (d > 0 && rsi5[i] != null && rsi5[i] < 25) out.push({ i5: i, dir: 1 });
      else if (d < 0 && rsi5[i] != null && rsi5[i] > 75) out.push({ i5: i, dir: -1 });
    }
  }
  return out;
}
// signal TF ponctuel -> 1re bougie 5m de reprise dans les 24 bougies (2 h) qui suivent
function confVersSignaux(A, ctx, sig) {
  const { c5 } = ctx, out = [];
  for (let k = 16; k < A.length; k++) {
    const d = sig(k);
    if (!d) continue;
    const i0 = A[k].last;
    for (let i = i0 + 1; i <= Math.min(i0 + 24, c5.length - 2); i++) {
      const rev = d > 0 ? (c5[i][4] > c5[i][1] && c5[i][4] > c5[i - 1][4]) : (c5[i][4] < c5[i][1] && c5[i][4] < c5[i - 1][4]);
      if (rev) { out.push({ i5: i, dir: d }); break; }
    }
  }
  return out;
}

// ---------- évaluation triple fenêtre (blocage par symbole, règles harness) ----------
function evalTriple(c5, sigs, exits) {
  const lastTs = c5[c5.length - 1][0];
  const coup60 = lastTs - 30 * 86400 * 1000;          // avant = fenêtre 60 j antérieure
  const tOOS = lastTs - 10 * 86400 * 1000;            // 10 derniers jours = OOS du banc
  const w60 = [], is = [], oos = [];
  let busy = -1;
  for (const s of sigs.sort((a, b) => a.i5 - b.i5)) {
    if (s.i5 <= busy || s.i5 >= c5.length - 2 || !s.dir) continue;
    const t = sim(c5, s.i5, s.dir, exits);
    busy = s.i5 + t.dur;
    const ts = c5[s.i5][0];
    if (ts < coup60) w60.push(t);
    else if (ts >= tOOS) oos.push(t);
    else is.push(t);
  }
  return { W: agg(w60), A: agg(is), B: agg(oos) };
}

// ---------- scan ----------
const insts = fs.readdirSync(D90).filter(f => f.endsWith(".json")).map(f => f.replace(".json", "")).filter(x => !BLOCK.has(x));
const rows = [];
for (const inst of insts) {
  const c5 = JSON.parse(fs.readFileSync(path.join(D90, inst + ".json")));
  if (c5.length < 20000) continue;
  const rsi5 = rsiWilder(c5.map(x => x[4]), 14);
  const TFS = { "1h": H1, "4h": H4, "1d": D1 };
  const series = {};
  for (const [tf, ms] of Object.entries(TFS)) {
    const A = aggreger(c5, ms);
    series[tf] = { A, ctx: { c5, map: mapCloses(c5, A, ms), rsi5 } };
  }
  const jobs = [];
  for (const tf of ["1h", "4h", "1d"]) {
    const { A, ctx } = series[tf];
    for (const th of [30, 25]) for (const mode of ["close", "reclaim", "trig5"])
      jobs.push({ tf, fam: "rsi", p: `th${th}`, mode, sigs: () => famRsi(A, th, mode, ctx) });
    for (const N of [20, 42]) for (const th of [2, 2.5]) for (const mode of ["close", "reclaim", "trig5"]) {
      if (tf === "1d" && N === 42) continue; // 90 bougies daily : N42 = pas de warm-up utile
      jobs.push({ tf, fam: "z", p: `N${N}t${th}`, mode, sigs: () => famZ(A, N, th, mode, ctx) });
    }
    for (const mult of [1.5, 2]) for (const mode of ["close", "conf5"])
      jobs.push({ tf, fam: "wick", p: `f60x${mult}`, mode, sigs: () => famWick(A, 0.6, mult, mode, ctx) });
    if (tf !== "1d") for (const tol of [0.005, 0.01]) for (const mode of ["close", "conf5"])
      jobs.push({ tf, fam: "dbl", p: `W42tol${tol * 1000}`, mode, sigs: () => famDbl(A, 42, tol, 0.02, mode, ctx) });
  }
  // baseline 5 m native pour comparaison (mêmes familles, déjà connues de profond2 — repère uniquement)
  const A5 = c5.map((x, i) => ({ b: i, ts: x[0], o: x[1], h: x[2], l: x[3], c: x[4], last: i }));
  const ctx5 = { c5, map: c5.map((_, i) => i - 1), rsi5 };
  jobs.push({ tf: "5m", fam: "rsi", p: "th25", mode: "close", sigs: () => famRsi(A5, 25, "close", ctx5) });
  jobs.push({ tf: "5m", fam: "z", p: "N48t2.5", mode: "close", sigs: () => famZ(A5, 48, 2.5, "close", ctx5) });

  for (const j of jobs) {
    let sigs;
    try { sigs = j.sigs(); } catch (e) { continue; }
    if (!sigs.length) continue;
    for (const [ex, exits] of Object.entries(EXITS)) {
      const r = evalTriple(c5, sigs.map(s => ({ ...s })), exits);
      const esp60 = r.W?.esp ?? null, espIS = r.A?.esp ?? null, espOOS = r.B?.esp ?? null;
      const worst3 = (esp60 != null && espIS != null && espOOS != null) ? Math.min(esp60, espIS, espOOS) : null;
      rows.push({
        inst, tf: j.tf, fam: j.fam, p: j.p, mode: j.mode, ex,
        n60: r.W?.n ?? 0, esp60, nIS: r.A?.n ?? 0, espIS, nOOS: r.B?.n ?? 0, espOOS,
        pfOOS: r.B?.pf ?? null, worst3
      });
    }
  }
  process.stderr.write(inst + " ");
}
process.stderr.write("\n");

const OUT = process.argv[2] || path.join(__dirname, "rapports", "tf4h_scan.json");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(rows));

// synthèse par timeframe (même signal, même exit) : la comparaison demandée 5m/1h/4h/1d
const parTf = {};
for (const r of rows) {
  if (r.worst3 == null) continue;
  const k = `${r.tf}`;
  (parTf[k] = parTf[k] || []).push(r);
}
console.log("=== Comparaison par timeframe (lignes à triple fenêtre complète) ===");
for (const [tf, l] of Object.entries(parTf)) {
  const pos = l.filter(r => r.worst3 > 0).length;
  const mEsp = l.reduce((s, r) => s + (r.esp60 ?? 0), 0) / l.length;
  console.log(`${tf}: ${l.length} lignes · worst3>0: ${pos} (${(100 * pos / l.length).toFixed(1)} %) · esp60 moyen ${mEsp.toFixed(2)}`);
}
console.log("\n=== Top 40 par worst3 (min esp60/espIS/espOOS), nTot>=40 ===");
const top = rows.filter(r => r.worst3 != null && (r.n60 + r.nIS + r.nOOS) >= 40 && r.nOOS >= 10)
  .sort((a, b) => b.worst3 - a.worst3).slice(0, 40);
for (const r of top) console.log(JSON.stringify(r));
