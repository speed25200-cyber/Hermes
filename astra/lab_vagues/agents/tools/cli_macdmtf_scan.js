// Scan CM_MacD_Ult_MTF [ChrisMoody] : MACD(12,26,9, signal=SMA!) calculé sur bougies 1h agrégées (5m x12),
// trade déclenché en 5m. 3 lectures (voir cli_macdmtf_lib.js) : (a) croisement 1h brut + fade, (b) histogramme
// 1h qui décélère en zone extrême = épuisement -> contre-pied (+ variante continuation), (c) MACD 1h comme
// FILTRE de sens sur un déclencheur RSI 5m reclaim (trend / contra).
const fs = require("fs");
const path = require("path");
const lib = require("./cli_macdmtf_lib.js");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const BLOCK = new Set(["AAPL","SPX","TSLA","NVDA","MSTR","SKHYNIX","SKHY","SNDK","CRCL","HOOD","COIN","GOOG","GOOGL",
  "META","AMZN","MSFT","AMD","INTC","QQQ","GLD","XAUT","TRUMP","AXTI","MRVL","MU","NBIS","SOXL","SOXS","TQQQ","EWY",
  "CXMT","SAMSUNG","XIAOMI","UNITREE","ZHIPU","MINIMAX","XAU","XAG","XCU","BEAT","BZ","CBRS","CL","CC","CHIP","DRAM",
  "SLX","ROBO","SPCX","SPACE","LITE","OPG","BARD","SKDD","SNXX","AAOI","AVGO","TSM","SPY","BILL"]);

function listeInstruments() {
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => f.replace(".json", ""))
    .filter(id => !BLOCK.has(id.split("-")[0]));
}

const EXIT_STD = { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 };

function evalSignals(sigs, c5, exits) {
  const mod = { detect: () => sigs, exits };
  const r = lib.evaluer(mod, c5);
  if (!r.A || !r.B) return null;
  return {
    espIS: r.A.esp, espOOS: r.B.esp, wrOOS: r.B.wr, nIS: r.A.n, nOOS: r.B.n, pfOOS: r.B.pf,
    worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
    valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15
  };
}

function main() {
  const ids = listeInstruments();
  console.error(`Univers: ${ids.length} instruments`);
  const rows = [];
  let done = 0;
  for (const instId of ids) {
    let c5;
    try { c5 = lib.chargerCandles("data", instId); } catch (e) { continue; }
    if (!c5 || c5.length < 2000) continue;
    const bars = lib.agreger1h(c5);
    if (bars.closes.length < 60) continue;

    for (const mode of ["raw", "fade"]) {
      const sigs = lib.sigsA(bars, mode);
      const res = evalSignals(sigs, c5, EXIT_STD);
      if (res) rows.push({ fam: "A", mode, params: "", instId, ...res });
    }
    for (const mode of ["exhaustion", "continuation"]) {
      for (const K of [1.5, 2, 3]) {
        for (const L of [24, 50]) {
          const sigs = lib.sigsB(bars, mode, K, L);
          const res = evalSignals(sigs, c5, EXIT_STD);
          if (res) rows.push({ fam: "B", mode, params: `K${K}_L${L}`, instId, ...res });
        }
      }
    }
    for (const mode of ["trend", "contra"]) {
      for (const rsiN of [7, 14]) {
        for (const [lo, hi] of [[30, 70], [25, 75]]) {
          const sigs = lib.sigsC(c5, bars, mode, rsiN, lo, hi);
          const res = evalSignals(sigs, c5, EXIT_STD);
          if (res) rows.push({ fam: "C", mode, params: `r${rsiN}_${lo}-${hi}`, instId, ...res });
        }
      }
    }
    done++;
    if (done % 50 === 0) console.error(`... ${done}/${ids.length}`);
  }
  rows.sort((a, b) => b.worst - a.worst);
  const valides = rows.filter(r => r.valide);
  console.error(`Total lignes: ${rows.length}, valides: ${valides.length}`);
  fs.writeFileSync(path.join(__dirname, "rapports", "cli_macdmtf_scan_resultats.json"), JSON.stringify({ top100: rows.slice(0, 100), validesTop60: valides.slice(0, 60) }, null, 1));
  console.log(JSON.stringify(valides.slice(0, 40), null, 1));
}
main();
