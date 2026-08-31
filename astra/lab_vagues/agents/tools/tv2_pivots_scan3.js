// SCAN "bandes STARC" (Stoller Average Range Channel, agent tv2_pivots_, Pack PIVOTS, 31/08).
// Formule EXACTE (Manning Stoller, reprise TradingView "STARC Bands") :
//   basis = SMA(close, N) ; bande = basis ± mult * ATR(N)   [ATR = moyenne mobile simple du True Range]
// mode RECLAIM uniquement (demandé) : la clôture ÉTAIT hors de la bande au i-1, REVIENT dedans au i
// -> le débordement de volatilité vient de culminer et de refluer (cf. leçon "reclaim > touch"
// reconfirmée 7x dans le journal, jamais testée sur STARC). Bande basse = support (fade LONG),
// bande haute = résistance (fade SHORT). Aucun repaint : SMA/ATR/bandes tout causal (fenêtre
// [i-N+1..i]), warm-up 320 barres.
const fs = require("fs");
const path = require("path");
const AG = "C:/Users/Administrator/Desktop/HERMES_V4_LIVE/lab_vagues/agents";
const { chargerCandles, evaluer } = require(path.join(AG, "harness_lib.js"));
const { starcBands, genLevelSignals } = require("./tv2_pivots_lib.js");

const DATA_DIR = path.join(AG, "..", "data");
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};
const NS = [14, 20, 30];
const MULTS = [1.5, 2.0, 2.5];
const WARM = 320;
const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY GOOGL " +
  "INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK SNXX SOXL SOXS " +
  "SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD " +
  "PIEVERSE ENSO GRASS GPS SOON O USELESS AXS MANA LUNA MEGA NES").split(" "));

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith("-USDT-SWAP.json"));
const res = [];
let done = 0;
for (const f of files) {
  const inst = f.replace(".json", "");
  const base = inst.replace("-USDT-SWAP", "");
  if (BLOCK.has(base)) continue;
  let c5; try { c5 = chargerCandles("data", inst); } catch (e) { continue; }
  if (!c5 || c5.length < 4000) continue;

  for (const N of NS) {
    for (const mult of MULTS) {
      const { upper, lower, high, low, close } = starcBands(c5, N, mult);
      const sigLong = genLevelSignals(lower, close, high, low, "sup", "R", WARM, false);
      const sigShort = genLevelSignals(upper, close, high, low, "res", "R", WARM, false);
      const sigs = sigLong.concat(sigShort);
      if (sigs.length < 25) continue;
      for (const ex of Object.keys(EXITS)) {
        const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
        if (!r.A || !r.B) continue;
        res.push({
          inst, N, mult, ex,
          espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
          nLong: sigLong.length, nShort: sigShort.length,
          wrOOS: r.B.wr, pfOOS: r.B.pf,
          worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
          valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15
        });
      }
    }
  }
  done++;
  if (done % 40 === 0) console.error(`... ${done} cryptos`);
}
res.sort((a, b) => b.worst - a.worst);
const out = path.join(__dirname, "tv2_pivots_scan3_resultats.json");
fs.writeFileSync(out, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ cryptos: done, lignes: res.length, valides: res.filter(r => r.valide).length, top: res.filter(r => r.valide).slice(0, 25) }, null, 1));
