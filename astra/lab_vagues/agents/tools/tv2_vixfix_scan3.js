// SCAN "Ultimate Oscillator - divergence" (agent tv2_vixfix_, Pack RETOURNEMENT, 31/08) — Larry Williams (1976),
// formule EXACTE : BP=close-min(low,close[1]) ; TR=max(high,close[1])-min(low,close[1])
//   avg_p = somme(BP,p)/somme(TR,p) ; UO = 100*(4*avg7+2*avg14+avg28)/7   (périodes classiques 7/14/28)
// Divergence : pivot fractal CAUSAL (aile L bougies de chaque côté, confirmé à j+L — zéro futur, même
//   technique que inv_memoire) ; creux de prix plus BAS que le creux précédent MAIS UO plus HAUT (survente
//   qui s'estompe) + UO sous le seuil de survente -> LONG. Symétrique : sommet de prix plus HAUT, UO plus
//   BAS, UO au-dessus du seuil de surachat -> SHORT.
const fs = require("fs");
const path = require("path");
const AG = "C:/Users/Administrator/Desktop/HERMES_V4_LIVE/lab_vagues/agents";
const { chargerCandles, evaluer } = require(path.join(AG, "harness_lib.js"));

const DATA_DIR = path.join(AG, "..", "data");
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};
const PERIOD_SETS = [[7, 14, 28], [5, 10, 20]]; // classique Larry Williams + variante rapide
const LS = [4, 6, 8];                            // demi-fenêtre du pivot fractal
const MAXGAPS = [96, 192, 288];                  // écart max entre 2 pivots comparés (8h/16h/24h)
const THRESH = [[30, 70], [35, 65], [40, 60]];   // [survente, surachat]
const WARM = 300;
const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY GOOGL " +
  "INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK SNXX SOXL SOXS " +
  "SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD " +
  "PIEVERSE ENSO GRASS GPS SOON O USELESS AXS MANA LUNA MEGA NES").split(" "));

function rollingSum(arr, len) {
  const n = arr.length, out = new Float64Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += arr[i];
    if (i >= len) s -= arr[i - len];
    if (i >= len - 1) out[i] = s;
  }
  return out;
}
function uoSeries(high, low, close, p1, p2, p3) {
  const n = close.length, BP = new Float64Array(n), TR = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const pc = close[i - 1];
    const lo = Math.min(low[i], pc), hi = Math.max(high[i], pc);
    BP[i] = close[i] - lo; TR[i] = hi - lo;
  }
  const sBP1 = rollingSum(BP, p1), sTR1 = rollingSum(TR, p1);
  const sBP2 = rollingSum(BP, p2), sTR2 = rollingSum(TR, p2);
  const sBP3 = rollingSum(BP, p3), sTR3 = rollingSum(TR, p3);
  const uo = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(sTR1[i]) || Number.isNaN(sTR2[i]) || Number.isNaN(sTR3[i])) continue;
    if (sTR1[i] <= 0 || sTR2[i] <= 0 || sTR3[i] <= 0) continue;
    const a1 = sBP1[i] / sTR1[i], a2 = sBP2[i] / sTR2[i], a3 = sBP3[i] / sTR3[i];
    uo[i] = 100 * (4 * a1 + 2 * a2 + a3) / 7;
  }
  return uo;
}
// pivots fractals causaux : pivLow/pivHigh = liste de {j, r} où r = j+L = index de CONFIRMATION.
function pivots(close, L) {
  const n = close.length, lowDq = [], highDq = [];
  const pivLow = [], pivHigh = [];
  for (let r = 0; r < n; r++) {
    while (lowDq.length && close[lowDq[lowDq.length - 1]] >= close[r]) lowDq.pop();
    lowDq.push(r);
    while (highDq.length && close[highDq[highDq.length - 1]] <= close[r]) highDq.pop();
    highDq.push(r);
    const winStart = r - 2 * L;
    while (lowDq[0] < winStart) lowDq.shift();
    while (highDq[0] < winStart) highDq.shift();
    if (r >= 2 * L) {
      const j = r - L;
      if (lowDq[0] === j) pivLow.push({ j, r });
      if (highDq[0] === j) pivHigh.push({ j, r });
    }
  }
  return { pivLow, pivHigh };
}
function genSignals(close, uo, pivLow, pivHigh, maxGap, oversold, overbought, warm) {
  const out = [];
  for (let k = 1; k < pivLow.length; k++) {
    const cur = pivLow[k], prev = pivLow[k - 1];
    if (cur.r < warm || cur.j - prev.j > maxGap) continue;
    if (Number.isNaN(uo[cur.j]) || Number.isNaN(uo[prev.j])) continue;
    if (close[cur.j] < close[prev.j] && uo[cur.j] > uo[prev.j] && uo[cur.j] <= oversold) {
      out.push({ i5: cur.r, dir: 1 });
    }
  }
  for (let k = 1; k < pivHigh.length; k++) {
    const cur = pivHigh[k], prev = pivHigh[k - 1];
    if (cur.r < warm || cur.j - prev.j > maxGap) continue;
    if (Number.isNaN(uo[cur.j]) || Number.isNaN(uo[prev.j])) continue;
    if (close[cur.j] > close[prev.j] && uo[cur.j] < uo[prev.j] && uo[cur.j] >= overbought) {
      out.push({ i5: cur.r, dir: -1 });
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

  const pivByL = {};
  for (const L of LS) pivByL[L] = pivots(close, L);

  for (const [p1, p2, p3] of PERIOD_SETS) {
    const uo = uoSeries(high, low, close, p1, p2, p3);
    for (const L of LS) {
      const { pivLow, pivHigh } = pivByL[L];
      for (const maxGap of MAXGAPS) {
        for (const [oversold, overbought] of THRESH) {
          const sigs = genSignals(close, uo, pivLow, pivHigh, maxGap, oversold, overbought, WARM);
          if (sigs.length < 25) continue;
          for (const ex of Object.keys(EXITS)) {
            const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
            if (!r.A || !r.B) continue;
            res.push({
              inst, p: `${p1}/${p2}/${p3}`, L, maxGap, os: oversold, ob: overbought, ex,
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
  done++;
  if (done % 40 === 0) console.error(`... ${done} cryptos`);
}
res.sort((a, b) => b.worst - a.worst);
const out = path.join(__dirname, "tv2_vixfix_scan3_resultats.json");
fs.writeFileSync(out, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ cryptos: done, lignes: res.length, valides: res.filter(r => r.valide).length, top: res.filter(r => r.valide).slice(0, 25) }, null, 1));
