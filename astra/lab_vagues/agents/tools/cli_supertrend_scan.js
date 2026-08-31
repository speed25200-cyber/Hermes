// SuperTrend v4 (LazyBear-style, script exact fourni par le client, 3e bloc de Indicateurs.txt) :
// ATR(10) Wilder x3 sur hl2, bandes up/dn portées causalement, trend flip. Le FLIP simple est mort
// (ronde 4 : "SuperTrend flip" listé dans "ne pas re-porter"). On scanne 3 lectures jamais faites :
//   A = FADE du flip (contre-pied du Buy/Sell — hypothèse : flip en marché plat = piège)
//   B = distance au ST en percentile EXTRÊME (calibration causale bloc-jour, 7j/14j, comme x2_adaptatif)
//       -> surextension -> FADE (modes X=croisement, R=reclaim après extrême)
//   C = flip + confirmation VOLUME >= mult x moyenne récente (flip suivi dans le sens, pas fade)
// Univers : data/ moins blocklist actions moins instId déjà réclamés par un candidates/*.js existant,
// plancher de liquidité 100k$/24h (notionnel estimé vol*close sur les 288 dernières bougies).
const fs = require("fs");
const path = require("path");
const { chargerCandles, sim, agg } = require("../harness_lib.js");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const CAND_DIR = path.join(__dirname, "..", "candidates");
const OOS_JOURS = 10;

// ---------- blocklist actions/ETF/commo (README + additions vues en ronde) ----------
const BLOCK = new Set(`AAPL SPX TSLA NVDA MSTR SKHYNIX SKHY SNDK CRCL HOOD COIN GOOG GOOGL META AMZN MSFT AMD INTC
QQQ GLD XAUT TRUMP AXTI MRVL MU NBIS SOXL SOXS TQQQ EWY CXMT SAMSUNG XIAOMI UNITREE ZHIPU MINIMAX
XAU XAG XCU BEAT BZ CBRS CL CC CHIP DRAM SLX ROBO SPCX SPACE LITE OPG BARD SKDD SNXX AAOI AVGO TSM
SPY BILL ASML HPE OKTA XBI ZM XPT USDC`.split(/\s+/).filter(Boolean));

function baseTicker(instId) { return instId.replace(/-USDT-SWAP$/, ""); }

// ---------- instId déjà réclamés par un candidates/*.js (règle 1 stratégie/crypto) ----------
const claimed = new Set();
for (const f of fs.readdirSync(CAND_DIR).filter(x => x.endsWith(".js"))) {
  const txt = fs.readFileSync(path.join(CAND_DIR, f), "utf8");
  const m = txt.match(/instId\s*:\s*"([^"]+)"/);
  if (m) claimed.add(m[1]);
}

// ---------- SuperTrend v4 exact ----------
function computeSuperTrend(c5, Periods = 10, Mult = 3.0) {
  const n = c5.length;
  const hl2 = new Float64Array(n), tr = new Float64Array(n), atr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = c5[i][2], l = c5[i][3], cl = c5[i][4];
    hl2[i] = (h + l) / 2;
    tr[i] = i === 0 ? (h - l) : Math.max(h - l, Math.abs(h - c5[i - 1][4]), Math.abs(l - c5[i - 1][4]));
  }
  // RMA (Wilder) : seed = SMA des Periods premiers TR, puis lissage (n-1)/n
  let seed = 0;
  for (let i = 0; i < Periods; i++) seed += tr[i];
  atr[Periods - 1] = seed / Periods;
  for (let i = Periods; i < n; i++) atr[i] = (atr[i - 1] * (Periods - 1) + tr[i]) / Periods;
  for (let i = 0; i < Periods - 1; i++) atr[i] = atr[Periods - 1]; // warmup

  const up = new Float64Array(n), dn = new Float64Array(n), trend = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const rawUp = hl2[i] - Mult * atr[i];
    const rawDn = hl2[i] + Mult * atr[i];
    const up1 = i > 0 ? up[i - 1] : rawUp;
    const dn1 = i > 0 ? dn[i - 1] : rawDn;
    up[i] = (i > 0 && c5[i - 1][4] > up1) ? Math.max(rawUp, up1) : rawUp;
    dn[i] = (i > 0 && c5[i - 1][4] < dn1) ? Math.min(rawDn, dn1) : rawDn;
    const prevTrend = i > 0 ? trend[i - 1] : 1;
    const close = c5[i][4];
    trend[i] = (prevTrend === -1 && close > dn1) ? 1 : (prevTrend === 1 && close < up1) ? -1 : prevTrend;
  }
  // distance de surextension dans le sens du trend (positif = étiré au-delà de la ligne)
  const dist = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const close = c5[i][4];
    dist[i] = trend[i] === 1 ? (close - up[i]) / close : (dn[i] - close) / close;
  }
  return { up, dn, trend, dist, atr };
}

function flips(trend) {
  const out = [];
  for (let i = 1; i < trend.length; i++) if (trend[i] !== trend[i - 1]) out.push({ i, dir: trend[i] }); // dir=+1 buySignal, -1 sellSignal
  return out;
}

// ---------- calibration percentile bloc-jour causale (CALIB bougies avant le jour, recalibré chaque jour) ----------
function dailyThresholds(c5, dist, calibN) {
  const n = c5.length;
  const dayOf = new Int32Array(n);
  for (let i = 0; i < n; i++) dayOf[i] = Math.floor(c5[i][0] / 86400000);
  const thr85 = new Float64Array(n).fill(NaN), thr90 = new Float64Array(n).fill(NaN), thr95 = new Float64Array(n).fill(NaN);
  let dayStart = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || dayOf[i] !== dayOf[dayStart]) {
      // nouveau jour à partir de i (ou fin de série) : calibrer sur [dayStart-calibN, dayStart)
      const lo = Math.max(0, dayStart - calibN);
      if (dayStart - lo >= 500) { // minimum de données pour un percentile stable
        const win = Array.from(dist.subarray(lo, dayStart)).sort((a, b) => a - b);
        const L = win.length;
        const p85 = win[Math.floor(0.85 * (L - 1))], p90 = win[Math.floor(0.90 * (L - 1))], p95 = win[Math.floor(0.95 * (L - 1))];
        for (let k = dayStart; k < i; k++) { thr85[k] = p85; thr90[k] = p90; thr95[k] = p95; }
      }
      dayStart = i;
    }
  }
  return { thr85, thr90, thr95 };
}

// ---------- évaluation IS/OOS directe (identique à harness_lib.evaluer) ----------
function evalSignals(c5, sigs) {
  const tOOS = c5[c5.length - 1][0] - OOS_JOURS * 86400 * 1000;
  const is = [], oos = [];
  let busy = -1;
  for (const s of sigs) {
    if (s.i5 <= busy || s.i5 >= c5.length - 2 || !s.dir) continue;
    const t = sim(c5, s.i5, s.dir, s.exits);
    busy = s.i5 + t.dur;
    (c5[s.i5][0] >= tOOS ? oos : is).push(t);
  }
  return { A: agg(is), B: agg(oos) };
}

const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
};

// ---------- univers ----------
const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
let univ = files.map(f => f.replace(/\.json$/, ""))
  .filter(id => !BLOCK.has(baseTicker(id).toUpperCase()))
  .filter(id => !claimed.has(id));

console.error(`univers filtré : ${univ.length} / ${files.length}`);

const rows = [];
let processed = 0;
for (const instId of univ) {
  processed++;
  let c5;
  try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
  if (c5.length < 3000) continue;

  // plancher de liquidité : notionnel estimé sur les 288 dernières bougies
  const N = c5.length;
  let notional = 0;
  for (let i = Math.max(0, N - 288); i < N; i++) notional += c5[i][5] * c5[i][4];
  if (notional < 100000) continue;

  const st = computeSuperTrend(c5);
  const fl = flips(st.trend);
  if (fl.length < 15) continue;

  // volume: moyenne mobile causale (avgWindow bougies précédentes, exclut la bougie courante)
  function volAvgArr(w) {
    const out = new Float64Array(N);
    let s = 0;
    for (let i = 0; i < N; i++) {
      if (i > w) s -= c5[i - w - 1][5];
      if (i > 0) s += c5[i - 1][5];
      out[i] = i >= w ? s / w : NaN;
    }
    return out;
  }

  // === A : FADE du flip (avec / sans filtre "marché plat") ===
  // flatness = |close[i]-close[i-24]| / (atr[i]*24) petit => marché plat récemment
  function isFlat(i, thresh) {
    if (i < 24) return false;
    const move = Math.abs(c5[i][4] - c5[i - 24][4]);
    return move / (st.atr[i] * 24 + 1e-12) < thresh;
  }
  for (const exK of Object.keys(EXITS)) {
    for (const flatFilter of [null, 1.0, 1.5]) {
      const sigs = [];
      for (const f of fl) {
        if (f.i < 30) continue;
        if (flatFilter !== null && !isFlat(f.i, flatFilter)) continue;
        sigs.push({ i5: f.i, dir: -f.dir, exits: EXITS[exK] }); // FADE : contre-pied du flip
      }
      if (sigs.length < 20) continue;
      const r = evalSignals(c5, sigs);
      if (!r.A || !r.B) continue;
      rows.push({ fam: "A_fade", instId, params: `flat=${flatFilter ?? "none"}`, ex: exK, ...pack(r) });
    }
  }

  // === B : distance percentile extrême -> FADE (mode X=croisement, R=reclaim) ===
  for (const calibDays of [7, 14]) {
    const calibN = calibDays * 288;
    const { thr85, thr90, thr95 } = dailyThresholds(c5, st.dist, calibN);
    for (const [pname, thrArr] of [["p85", thr85], ["p90", thr90], ["p95", thr95]]) {
      for (const mode of ["X", "R"]) {
        for (const exK of Object.keys(EXITS)) {
          const sigs = [];
          for (let i = 30; i < N - 2; i++) {
            const th = thrArr[i];
            if (Number.isNaN(th)) continue;
            const above = st.dist[i] >= th, prevAbove = st.dist[i - 1] >= th;
            let fire = false;
            if (mode === "X") fire = above && !prevAbove;
            else fire = !above && prevAbove; // reclaim : retombe sous le seuil
            if (!fire) continue;
            const dir = st.trend[i] === 1 ? -1 : 1; // surextension du trend -> fade (contre le trend)
            sigs.push({ i5: i, dir, exits: EXITS[exK] });
          }
          if (sigs.length < 20) continue;
          const r = evalSignals(c5, sigs);
          if (!r.A || !r.B) continue;
          rows.push({ fam: "B_dist", instId, params: `calib=${calibDays}j,${pname},${mode}`, ex: exK, ...pack(r) });
        }
      }
    }
  }

  // === C : flip + confirmation volume >= mult x moyenne récente (suivi, PAS fade) ===
  for (const w of [10, 20, 50]) {
    const va = volAvgArr(w);
    for (const mult of [1.5, 2.0, 3.0]) {
      for (const exK of Object.keys(EXITS)) {
        const sigs = [];
        for (const f of fl) {
          if (f.i < 60 || Number.isNaN(va[f.i])) continue;
          if (c5[f.i][5] < mult * va[f.i]) continue;
          sigs.push({ i5: f.i, dir: f.dir, exits: EXITS[exK] }); // suivi du flip, confirmé volume
        }
        if (sigs.length < 15) continue;
        const r = evalSignals(c5, sigs);
        if (!r.A || !r.B) continue;
        rows.push({ fam: "C_vol", instId, params: `w=${w},mult=${mult}`, ex: exK, ...pack(r) });
      }
    }
  }

  if (processed % 50 === 0) console.error(`... ${processed}/${univ.length} instruments, ${rows.length} lignes`);
}

function pack(r) {
  return {
    espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
    wrOOS: r.B.wr, pfOOS: r.B.pf,
    worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
    valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15,
  };
}

rows.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "rapports", "cli_supertrend_scan_resultats.json"), JSON.stringify(rows, null, 1));
console.error(`TOTAL : ${rows.length} lignes, ${rows.filter(r => r.valide).length} valides.`);
console.log(JSON.stringify(rows.filter(r => r.valide).slice(0, 60), null, 1));
