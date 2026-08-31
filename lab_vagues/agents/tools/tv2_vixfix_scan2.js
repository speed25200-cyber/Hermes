// SCAN "Mass Index" (agent tv2_vixfix_, Pack RETOURNEMENT, 31/08) — Donald Dorsey (1992), formule EXACTE :
//   singleEMA = EMA(high-low, len) ; doubleEMA = EMA(singleEMA, len) ; ratio = singleEMA/doubleEMA
//   massIndex = somme glissante de ratio sur sumLen bougies (classique len=9, sumLen=25)
// "Reversal Bulge" (Dorsey) : massIndex FRANCHIT hi (classique 27) PUIS retombe sous lo (classique 26,5)
//   = le range s'est élargi puis re-comprimé = retournement de tendance imminent (signal SANS direction
//   propre chez Dorsey — la direction se lit sur le mouvement de prix PENDANT le renflement lui-même :
//   prix monté pendant le renflement -> l'expansion/compression étouffe la hausse -> SHORT ; symétrique LONG).
// EMA causale (seed = 1re valeur, comme le reste du repo, cf. tv_transforms_1.js) ; renflement suivi par
// une machine à états causale (armé au franchissement de hi, tire au repli sous lo, jamais de futur).
const fs = require("fs");
const path = require("path");
const AG = "C:/Users/Administrator/Desktop/HERMES_V4_LIVE/lab_vagues/agents";
const { chargerCandles, evaluer } = require(path.join(AG, "harness_lib.js"));

const DATA_DIR = path.join(AG, "..", "data");
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};
const EMA_LENS = [9, 12];              // classique Dorsey = 9
const SUM_LENS = [25, 20];             // classique = 25
const PAIRS = [[27, 26.5], [26, 25.5], [28, 27]]; // [hi, lo] classique 27/26.5
const MIN_MOVE = 0.003;                // filtre bruit : |netMove| pendant le renflement >= 0.3%
const WARM = 200;
const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY GOOGL " +
  "INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK SNXX SOXL SOXS " +
  "SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD " +
  "PIEVERSE ENSO GRASS GPS SOON O USELESS AXS MANA LUNA MEGA NES").split(" "));

function emaSeries(src, len) {
  const n = src.length, out = new Float64Array(n), a = 2 / (len + 1);
  out[0] = src[0];
  for (let i = 1; i < n; i++) out[i] = a * src[i] + (1 - a) * out[i - 1];
  return out;
}
function massIndexSeries(high, low, emaLen, sumLen) {
  const n = high.length, diff = new Float64Array(n);
  for (let i = 0; i < n; i++) diff[i] = high[i] - low[i];
  const s1 = emaSeries(diff, emaLen), s2 = emaSeries(s1, emaLen);
  const ratio = new Float64Array(n);
  for (let i = 0; i < n; i++) ratio[i] = s2[i] > 1e-12 ? s1[i] / s2[i] : 1;
  const mi = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += ratio[i];
    if (i >= sumLen) sum -= ratio[i - sumLen];
    if (i >= sumLen - 1) mi[i] = sum;
  }
  return mi;
}
// machine à états causale : franchissement hi -> armé (mémorise l'index/prix de franchissement) ;
// repli sous lo -> signal tiré à l'index courant, direction = sens du prix PENDANT le renflement.
function genSignals(mi, close, hi, lo, warm) {
  const out = [];
  let armed = false, startIdx = -1;
  for (let i = warm; i < mi.length; i++) {
    if (Number.isNaN(mi[i]) || Number.isNaN(mi[i - 1])) continue;
    if (!armed && mi[i - 1] <= hi && mi[i] > hi) { armed = true; startIdx = i; }
    else if (armed && mi[i - 1] > lo && mi[i] <= lo) {
      const net = (close[i] - close[startIdx]) / close[startIdx];
      if (Math.abs(net) >= MIN_MOVE) out.push({ i5: i, dir: net > 0 ? -1 : 1 });
      armed = false;
    }
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
  const high = c5.map(x => x[2]), low = c5.map(x => x[3]), close = c5.map(x => x[4]);

  for (const emaLen of EMA_LENS) {
    for (const sumLen of SUM_LENS) {
      const mi = massIndexSeries(high, low, emaLen, sumLen);
      for (const [hi, lo] of PAIRS) {
        const sigs = genSignals(mi, close, hi, lo, WARM);
        if (sigs.length < 25) continue;
        for (const ex of Object.keys(EXITS)) {
          const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
          if (!r.A || !r.B) continue;
          res.push({
            inst, emaLen, sumLen, hi, lo, ex,
            espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
            wrOOS: r.B.wr, pfOOS: r.B.pf,
            worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
            valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15
          });
        }
      }
    }
  }
  done++;
  if (done % 40 === 0) console.error(`... ${done} cryptos`);
}
res.sort((a, b) => b.worst - a.worst);
const out = path.join(__dirname, "tv2_vixfix_scan2_resultats.json");
fs.writeFileSync(out, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ cryptos: done, lignes: res.length, valides: res.filter(r => r.valide).length, top: res.filter(r => r.valide).slice(0, 25) }, null, 1));
