// Raffinement : plateau (grille complète) sur les meilleurs candidats de cli_macdmtf_scan.js
// + sonde famille B à seuils K plus bas (fréquence) pour trancher si elle est vraiment morte.
const path = require("path");
const lib = require("./cli_macdmtf_lib.js");
const { chargerCandles, evaluer } = lib;

const SHORTLIST = ["PIEVERSE-USDT-SWAP", "ALLO-USDT-SWAP", "KGEN-USDT-SWAP", "OSCR-USDT-SWAP", "H-USDT-SWAP",
  "BIO-USDT-SWAP", "WLFI-USDT-SWAP", "EGLD-USDT-SWAP", "KMNO-USDT-SWAP", "UB-USDT-SWAP"];

const EXIT_STD = { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 };
const EXIT_ALT = { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 24 };

function ev(sigs, c5, exits) {
  const r = evaluer({ detect: () => sigs, exits }, c5);
  if (!r.A || !r.B) return null;
  return { espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n, pfOOS: r.B.pf,
    worst: +Math.min(r.A.esp, r.B.esp).toFixed(2), valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15 };
}

console.log("=== Grille complète Famille A + C sur shortlist (STD puis ALT) ===");
for (const instId of SHORTLIST) {
  let c5; try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
  const bars = lib.agreger1h(c5);
  console.log(`\n--- ${instId} ---`);
  for (const mode of ["raw", "fade"]) {
    const sigs = lib.sigsA(bars, mode);
    for (const [exN, ex] of [["STD", EXIT_STD], ["ALT", EXIT_ALT]]) {
      const r = ev(sigs, c5, ex);
      if (r) console.log(`A ${mode} ${exN} : worst=${r.worst} IS=${r.espIS} OOS=${r.espOOS} n=${r.nIS}+${r.nOOS} valide=${r.valide}`);
    }
  }
  for (const mode of ["trend", "contra"]) {
    for (const rsiN of [7, 14]) {
      for (const [lo, hi] of [[30, 70], [25, 75]]) {
        const sigs = lib.sigsC(c5, bars, mode, rsiN, lo, hi);
        for (const [exN, ex] of [["STD", EXIT_STD], ["ALT", EXIT_ALT]]) {
          const r = ev(sigs, c5, ex);
          if (r) console.log(`C ${mode} r${rsiN}_${lo}-${hi} ${exN} : worst=${r.worst} IS=${r.espIS} OOS=${r.espOOS} n=${r.nIS}+${r.nOOS} valide=${r.valide}`);
        }
      }
    }
  }
}

console.log("\n=== Sonde Famille B à seuils bas (K1/K1.2, L24/L50) sur univers restreint ===");
const fs = require("fs");
const ids = fs.readdirSync(path.join(__dirname, "..", "..", "data")).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
let rows = [];
for (const instId of ids) {
  let c5; try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
  if (!c5 || c5.length < 2000) continue;
  const bars = lib.agreger1h(c5);
  if (bars.closes.length < 60) continue;
  for (const mode of ["exhaustion", "continuation"]) {
    for (const K of [1.0, 1.2]) {
      for (const L of [24, 50]) {
        const sigs = lib.sigsB(bars, mode, K, L);
        const r = ev(sigs, c5, EXIT_STD);
        if (r && r.valide) rows.push({ mode, K, L, instId, ...r });
      }
    }
  }
}
rows.sort((a, b) => b.worst - a.worst);
console.log(`Famille B seuils bas : ${rows.length} lignes valides (n>=60,nOOS>=15,esp>0 des 2 côtés)`);
console.log(JSON.stringify(rows.slice(0, 15), null, 1));
