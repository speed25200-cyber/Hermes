// SCAN "CM Williams Vix Fix" (agent tv2_vixfix_, Pack RETOURNEMENT, 31/08) — TradingView communautaire (Chris Moody).
// Formule EXACTE (tradingview.com "CM_Williams_Vix_Fix_Finds_Market_Bottoms", Pine v4/v5) :
//   wvf = ((highest(close, pd) - low) / highest(close, pd)) * 100        [VIX synthétique de FOND]
//   midLine = sma(wvf, bbl) ; sDev = mult * stdev(wvf, bbl) ; upperBand = midLine + sDev
//   signal historique (Chris Moody) : wvf perce sa propre bande de Bollinger supérieure = capitulation -> LONG.
// Symétrique inversé pour les TOPS (demandé par le client, jamais publié tel quel sur TV) :
//   wvfTop = ((high - lowest(close, pd)) / lowest(close, pd)) * 100      [VIX synthétique de SOMMET]
//   même Bollinger (midLine/upperBand propres) -> perce sa bande = euphorie -> SHORT.
// mode X = franchissement (le wvf VIENT de dépasser la bande, on trade le pic lui-même)
// mode R = relâchement/reclaim (le wvf ÉTAIT au-dessus, retombe sous la bande = capitulation CONFIRMÉE,
//          cf. leçon "reclaim > touch" reconfirmée 6x dans le journal).
// Aucun repaint : hc/lc/mid/sd tout causal (fenêtres [i-len+1..i]), signal évalué à la bougie i close.
const fs = require("fs");
const path = require("path");
const AG = "C:/Users/Administrator/Desktop/HERMES_V4_LIVE/lab_vagues/agents";
const { chargerCandles, evaluer } = require(path.join(AG, "harness_lib.js"));

const DATA_DIR = path.join(AG, "..", "data");
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};
const PDS = [14, 22, 30];      // lookback plus haut/plus bas close (classique TV = 22)
const BBLS = [14, 20, 26];     // longueur Bollinger (classique TV = 20)
const MULTS = [1.5, 2.0, 2.5]; // multiplicateur d'écart-type (classique TV = 2.0)
const MODES = ["X", "R"];
const WARM = 300;
const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY GOOGL " +
  "INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK SNXX SOXL SOXS " +
  "SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD " +
  // règle "1 strat/crypto" : cryptos déjà championnes au registre, à éviter (assignation de l'orchestrateur
  "PIEVERSE ENSO GRASS GPS SOON O USELESS AXS MANA LUNA MEGA NES").split(" "));

function rollingMax(arr, len) { // causal, fenêtre [i-len+1, i]
  const n = arr.length, out = new Float64Array(n).fill(NaN), dq = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && arr[dq[dq.length - 1]] <= arr[i]) dq.pop();
    dq.push(i);
    while (dq[0] <= i - len) dq.shift();
    if (i >= len - 1) out[i] = arr[dq[0]];
  }
  return out;
}
function rollingMin(arr, len) {
  const n = arr.length, out = new Float64Array(n).fill(NaN), dq = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && arr[dq[dq.length - 1]] >= arr[i]) dq.pop();
    dq.push(i);
    while (dq[0] <= i - len) dq.shift();
    if (i >= len - 1) out[i] = arr[dq[0]];
  }
  return out;
}
function rollingMeanStd(arr, len) { // causal, retourne {mean, std} arrays
  // NB: arr contient des NaN en préfixe (avant pd-1) ; une somme cumulative naïve serait
  // contaminée à vie par NaN+x=NaN (même après "soustraction"). On ne cumule que le FINI et
  // on compte les valeurs valides dans la fenêtre ; la bande n'existe que fenêtre pleine.
  const n = arr.length, mean = new Float64Array(n).fill(NaN), std = new Float64Array(n).fill(NaN);
  let s = 0, s2 = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (!Number.isNaN(v)) { s += v; s2 += v * v; cnt++; }
    if (i >= len) {
      const vOut = arr[i - len];
      if (!Number.isNaN(vOut)) { s -= vOut; s2 -= vOut * vOut; cnt--; }
    }
    if (cnt === len) {
      const m = s / len, va = Math.max(0, s2 / len - m * m);
      mean[i] = m; std[i] = Math.sqrt(va);
    }
  }
  return { mean, std };
}

function genSignals(wvf, mean, std, mult, mode, dirSign, warm) {
  const out = [];
  for (let i = warm; i < wvf.length; i++) {
    const u = mean[i] + mult * std[i], up1 = mean[i - 1] + mult * std[i - 1];
    if (Number.isNaN(u) || Number.isNaN(up1) || Number.isNaN(wvf[i]) || Number.isNaN(wvf[i - 1])) continue;
    let hit = false;
    if (mode === "X") hit = wvf[i] > u && wvf[i - 1] <= up1;
    else hit = wvf[i - 1] > up1 && wvf[i] <= u;
    if (hit) out.push({ i5: i, dir: dirSign });
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

  for (const pd of PDS) {
    const hc = rollingMax(close, pd), lc = rollingMin(close, pd);
    const wvfLow = new Float64Array(c5.length).fill(NaN), wvfTop = new Float64Array(c5.length).fill(NaN);
    for (let i = 0; i < c5.length; i++) {
      if (!Number.isNaN(hc[i]) && hc[i] > 0) wvfLow[i] = (hc[i] - low[i]) / hc[i] * 100;
      if (!Number.isNaN(lc[i]) && lc[i] > 0) wvfTop[i] = (high[i] - lc[i]) / lc[i] * 100;
    }
    for (const bbl of BBLS) {
      const bLow = rollingMeanStd(wvfLow, bbl), bTop = rollingMeanStd(wvfTop, bbl);
      for (const mult of MULTS) {
        for (const mode of MODES) {
          const sigLong = genSignals(wvfLow, bLow.mean, bLow.std, mult, mode, 1, WARM);
          const sigShort = genSignals(wvfTop, bTop.mean, bTop.std, mult, mode, -1, WARM);
          const sigs = sigLong.concat(sigShort);
          if (sigs.length < 25) continue;
          for (const ex of Object.keys(EXITS)) {
            const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
            if (!r.A || !r.B) continue;
            res.push({
              inst, pd, bbl, mult, mode, ex,
              espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
              nLong: sigLong.length, nShort: sigShort.length,
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
const out = path.join(__dirname, "tv2_vixfix_scan1_resultats.json");
fs.writeFileSync(out, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ cryptos: done, lignes: res.length, valides: res.filter(r => r.valide).length, top: res.filter(r => r.valide).slice(0, 25) }, null, 1));
