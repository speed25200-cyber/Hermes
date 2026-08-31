// Agent x3_combos : COMBOS DE 2 INGRÉDIENTS VALIDÉS (jamais systématisés).
// Croise par paires : {double-extrême, Keltner-out, VWAP-out, série 5 bougies} x
//                      {confirmation bougie de reprise, volume > 2x, position range 24h}
// (mèche+vol est déjà systématisée avec range24h [gen_regime] et avec vol+conf [x2_adaptatif MECHE] -> exclue)
// Univers : cryptos LIBRES (sans champion registre ni candidat existant), majors/stables exclus.
// Grilles GROSSIÈRES : paramètres de base = valeurs déjà validées par les agents précédents
// (Keltner MULT 3 [O.js], VWAP K=2σ [SOON], double W144/tol0.3%/bounce1% [PIEVERSE], série N=5 [profond2]).
// Exits FONDATEURS uniquement (4), choisis AVANT le scan — pas de balayage de sorties a posteriori.
const fs = require("fs");
const path = require("path");
const ti = require("technicalindicators");
const { chargerCandles, evaluer } = require("../harness_lib.js");

const AGENTS_DIR = path.join(__dirname, "..");
const CANDIDATES_DIR = path.join(AGENTS_DIR, "candidates");
const DATA_DIR = path.join(AGENTS_DIR, "..", "data");

const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  E3: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  E4: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 24 },
};

// ---------- univers libre ----------
function claimedInstIds() {
  const claimed = new Set();
  for (const f of fs.readdirSync(CANDIDATES_DIR).filter(f => f.endsWith(".js"))) {
    try {
      delete require.cache[require.resolve(path.join(CANDIDATES_DIR, f))];
      const m = require(path.join(CANDIDATES_DIR, f));
      if (m && m.instId) claimed.add(m.instId);
    } catch (e) { /* module cassé (ex. _opt_O.js), ignoré */ }
  }
  return claimed;
}

const BLOCKLIST = new Set([
  "AAPL","SPX","TSLA","NVDA","MSTR","SKHYNIX","SKHY","SNDK","CRCL","HOOD","COIN","GOOG","GOOGL",
  "META","AMZN","MSFT","AMD","INTC","QQQ","GLD","XAUT","TRUMP","AXTI","MRVL","MU","NBIS","SOXL",
  "SOXS","TQQQ","EWY","CXMT","SAMSUNG","XIAOMI","UNITREE","ZHIPU","MINIMAX","XAU","XAG","XCU",
  "BEAT","BZ","CBRS","CL","CC","CHIP","DRAM","SLX","ROBO","SPCX","SPACE","LITE","OPG","BARD",
  "SKDD","SNXX","AAOI","AVGO","TSM","SPY","BILL",
].map(s => s + "-USDT-SWAP"));

// majors/EN_LIVE-profond2/stables : pas d'edge net (re-confirmé 6-8x au journal) ou déjà pris sans fichier candidat
const MAJORS_ET_LIVE_NON_CLAIMES = new Set([
  "BTC-USDT-SWAP","ETH-USDT-SWAP","SOL-USDT-SWAP","XRP-USDT-SWAP","DOGE-USDT-SWAP","BNB-USDT-SWAP",
  "ADA-USDT-SWAP","LTC-USDT-SWAP","TRX-USDT-SWAP","XLM-USDT-SWAP","AVAX-USDT-SWAP","BCH-USDT-SWAP",
  "ATOM-USDT-SWAP","ETC-USDT-SWAP","MANA-USDT-SWAP","LUNA-USDT-SWAP","USDC-USDT-SWAP",
]);

function universeLibre() {
  const claimed = claimedInstIds();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
  return files.filter(f => !claimed.has(f) && !BLOCKLIST.has(f) && !MAJORS_ET_LIVE_NON_CLAIMES.has(f));
}

// ---------- utilitaires causaux ----------
function volSMA(c5, N) {
  const vs = new Array(c5.length).fill(null);
  let s = 0;
  for (let i = 0; i < c5.length; i++) {
    s += c5[i][5];
    if (i >= N) s -= c5[i - N][5];
    if (i >= N - 1) vs[i] = s / N;
  }
  return vs;
}

function range24Pos(c5, R) {
  const pos = new Array(c5.length).fill(null);
  const dqH = [], dqL = [];
  for (let i = 0; i < c5.length; i++) {
    while (dqH.length && c5[dqH[dqH.length - 1]][2] <= c5[i][2]) dqH.pop();
    dqH.push(i);
    while (dqL.length && c5[dqL[dqL.length - 1]][3] >= c5[i][3]) dqL.pop();
    dqL.push(i);
    while (dqH[0] <= i - R) dqH.shift();
    while (dqL[0] <= i - R) dqL.shift();
    if (i >= R - 1) {
      const hh = c5[dqH[0]][2], ll = c5[dqL[0]][3];
      pos[i] = hh > ll ? (c5[i][4] - ll) / (hh - ll) : 0.5;
    }
  }
  return pos;
}

// ---------- 4 signaux de BASE (ingrédients validés ailleurs) ----------
function baseKeltner(c5, mult) {
  const N = c5.length, out = [];
  const h = new Array(N), l = new Array(N), c = new Array(N);
  for (let i = 0; i < N; i++) { h[i] = +c5[i][2]; l[i] = +c5[i][3]; c[i] = +c5[i][4]; }
  const kc = ti.keltnerchannels({ high: h, low: l, close: c, maPeriod: 20, atrPeriod: 10, multiplier: mult, useSMA: false });
  const oK = N - kc.length;
  for (let i = Math.max(400, oK + 1); i < N - 2; i++) {
    const j = i - oK;
    if (!kc[j - 1] || !kc[j]) continue;
    if (c[i - 1] < kc[j - 1].lower && c[i] > kc[j].lower) out.push({ i, dir: 1 });
    if (c[i - 1] > kc[j - 1].upper && c[i] < kc[j].upper) out.push({ i, dir: -1 });
  }
  return out;
}

function baseVwap(c5, K) {
  const DAY = 86400000, WARM = 36, out = [];
  const N = c5.length;
  const vwap = new Array(N).fill(null), sig = new Array(N).fill(null), bod = new Array(N).fill(0);
  let day = -1, cv = 0, cpv = 0, cpv2 = 0, k = 0;
  for (let i = 0; i < N; i++) {
    const d = Math.floor(c5[i][0] / DAY);
    if (d !== day) { day = d; cv = 0; cpv = 0; cpv2 = 0; k = 0; }
    const tp = (c5[i][2] + c5[i][3] + c5[i][4]) / 3, v = Math.max(c5[i][5], 0);
    cv += v; cpv += tp * v; cpv2 += tp * tp * v; k++;
    bod[i] = k;
    if (cv > 0) { const m = cpv / cv; vwap[i] = m; sig[i] = Math.sqrt(Math.max(cpv2 / cv - m * m, 0)); }
  }
  for (let i = 101; i < N; i++) {
    const w = vwap[i], s = sig[i];
    if (w == null || !(s > 0) || bod[i] < WARM) continue;
    if (vwap[i - 1] == null || !(sig[i - 1] > 0)) continue;
    const z = (c5[i][4] - w) / s, zPrev = (c5[i - 1][4] - vwap[i - 1]) / sig[i - 1];
    if (zPrev <= -K && z > -K && z < 0) out.push({ i, dir: 1 });
    else if (zPrev >= K && z < K && z > 0) out.push({ i, dir: -1 });
  }
  return out;
}

// retest d'extrême SANS exiger la bougie de reprise (contrairement à PIEVERSE) : base "pure"
function baseDouble(c5, W, GAP, TOL, BOUNCE) {
  const out = [];
  for (let i = Math.max(100, W); i < c5.length; i++) {
    let mn = Infinity, mx = -Infinity, iMn = -1, iMx = -1;
    for (let k = i - W; k <= i - GAP; k++) {
      if (c5[k][3] < mn) { mn = c5[k][3]; iMn = k; }
      if (c5[k][2] > mx) { mx = c5[k][2]; iMx = k; }
    }
    const h = c5[i][2], l = c5[i][3];
    if (l >= mn * (1 - TOL) && l <= mn * (1 + TOL)) {
      let rb = -Infinity;
      for (let k = iMn + 1; k < i; k++) if (c5[k][4] > rb) rb = c5[k][4];
      if (rb >= mn * (1 + BOUNCE)) out.push({ i, dir: 1 });
    }
    if (h <= mx * (1 + TOL) && h >= mx * (1 - TOL)) {
      let rb = Infinity;
      for (let k = iMx + 1; k < i; k++) if (c5[k][4] < rb) rb = c5[k][4];
      if (rb <= mx * (1 - BOUNCE)) out.push({ i, dir: -1 });
    }
  }
  return out;
}

function baseSerie(c5, runN) {
  const out = [];
  let run = 0, sgn = 0;
  for (let i = 1; i < c5.length; i++) {
    const d = Math.sign(c5[i][4] - c5[i - 1][4]);
    if (d !== 0 && d === sgn) run++; else { run = 1; sgn = d; }
    if (run >= runN && sgn !== 0) out.push({ i, dir: -sgn });
  }
  return out;
}

// ---------- 3 CONFIRMATIONS (appliquées au signal de base) ----------
function confBougie(c5, base) { // bougie de reprise = la bougie DU SIGNAL clôture dans le sens du retournement
  return base.filter(s => s.dir > 0 ? c5[s.i][4] > c5[s.i][1] : c5[s.i][4] < c5[s.i][1]);
}
function confVol2x(c5, base, vs20) {
  return base.filter(s => vs20[s.i] != null && vs20[s.i] > 0 && c5[s.i][5] >= 2 * vs20[s.i]);
}
function confRange24(c5, base, pos) {
  return base.filter(s => pos[s.i] != null && (s.dir > 0 ? pos[s.i] < 0.5 : pos[s.i] > 0.5));
}

function toSignals(list) { return list.map(s => ({ i5: s.i, dir: s.dir })); }

// ---------- scan ----------
function main() {
  const univers = universeLibre();
  console.error(`univers libre : ${univers.length} cryptos`);
  const results = [];

  // grilles GROSSIÈRES : mêmes valeurs déjà validées par d'autres agents (2 crans max/axe)
  const KELTNER_MULTS = [2, 3];       // H (ti_arsenal_4) et O (ti_arsenal_2)
  const VWAP_KS = [1.5, 2];           // web_vwap : 2σ champion, 1,5σ voisin de grille
  const DOUBLE_GRID = [
    { W: 144, TOL: 0.003, BOUNCE: 0.01 }, // PIEVERSE
    { W: 96, TOL: 0.006, BOUNCE: 0.01 },  // voisin gen_double
  ];
  const SERIE_NS = [5, 7]; // profond2

  const combos = [
    { name: "keltner_conf", base: "keltner", conf: "conf" },
    { name: "keltner_vol2x", base: "keltner", conf: "vol2x" },
    { name: "keltner_range24", base: "keltner", conf: "range24" },
    { name: "vwap_conf", base: "vwap", conf: "conf" },
    { name: "vwap_vol2x", base: "vwap", conf: "vol2x" },
    { name: "vwap_range24", base: "vwap", conf: "range24" },
    { name: "double_vol2x", base: "double", conf: "vol2x" },
    { name: "double_range24", base: "double", conf: "range24" },
    { name: "serie_vol2x", base: "serie", conf: "vol2x" },
  ];

  let done = 0;
  for (const instId of univers) {
    let c5;
    try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
    if (!c5 || c5.length < 500) { done++; continue; }

    const vs20 = volSMA(c5, 20);
    const pos288 = range24Pos(c5, 288);
    const baseVariants = {
      keltner: KELTNER_MULTS.map(m => ({ tag: `mult${m}`, list: baseKeltner(c5, m) })),
      vwap: VWAP_KS.map(k => ({ tag: `K${k}`, list: baseVwap(c5, k) })),
      double: DOUBLE_GRID.map(g => ({ tag: `W${g.W}t${g.TOL}`, list: baseDouble(c5, g.W, 12, g.TOL, g.BOUNCE) })),
      serie: SERIE_NS.map(n => ({ tag: `N${n}`, list: baseSerie(c5, n) })),
    };

    for (const combo of combos) {
      for (const variant of baseVariants[combo.base]) {
      const base = variant.list;
      const comboTag = combo.name + "_" + variant.tag;
      let filtered;
      if (combo.conf === "conf") filtered = confBougie(c5, base);
      else if (combo.conf === "vol2x") filtered = confVol2x(c5, base, vs20);
      else filtered = confRange24(c5, base, pos288);
      if (filtered.length < 30) continue; // trop rare, inutile de tester tous les exits

      const sig = toSignals(filtered);
      for (const [exName, ex] of Object.entries(EXITS)) {
        const mod = { instId, exits: ex, detect: () => sig };
        const r = evaluer(mod, c5);
        if (!r.A || !r.B) continue;
        const worst = Math.min(r.A.esp, r.B.esp);
        const nTot = r.A.n + r.B.n;
        const valide = r.A.esp > 0 && r.B.esp > 0 && nTot >= 60 && r.B.n >= 15;
        if (worst >= 4) {
          results.push({
            instId, combo: comboTag, exit: exName, espIS: r.A.esp, espOOS: r.B.esp,
            wrOOS: r.B.wr, pfOOS: r.B.pf, nIS: r.A.n, nOOS: r.B.n, worst, valide,
          });
        }
      }
      } // fin boucle variant
    }
    done++;
    if (done % 20 === 0) console.error(`... ${done}/${univers.length}`);
  }

  results.sort((a, b) => b.worst - a.worst);
  fs.writeFileSync(path.join(AGENTS_DIR, "tools", "rapports", "x3_combos_scan_resultats.json"), JSON.stringify(results, null, 1));
  console.error(`terminé. ${results.length} lignes worst>=4 écrites.`);
  console.log(JSON.stringify(results.slice(0, 60), null, 1));
}

main();
