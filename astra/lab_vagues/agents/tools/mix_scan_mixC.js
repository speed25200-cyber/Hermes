// Agent mixC — scanner systématique : croise les 10 primitives (Parabolic SAR, ADX14, Aroon, MACD hist,
// KST, ForceIndex13, OBV pente24, EOM, série de bougies consécutives, ratio mèche/corps) PAR PAIRES
// (A/B non ordonnées, AND symétrique — direction = fade des deux côtés en accord simultané), sur
// l'univers liquide & libre (univers.json + territoire "extra" ∩ data/, blocklist actions du README,
// cryptos déjà prises par un candidat existant OU par le REGISTRE exclues). 45 paires × 4 combinaisons
// de réglages (2×2) × 2 exits, testé crypto par crypto avec harness_lib (mêmes règles que tout le banc :
// coûts, pire cas, IS 20j/OOS 10j, blocage par symbole).
// Anti-coup-de-chance : une paire n'est retenue que si (1) valide au sens test_harness (esp>0 IS ET OOS,
// n>=60, nOOS>=15) ET (2) PLATEAU — le réglage voisin de A (B fixé) et le réglage voisin de B (A fixé)
// restent tous les deux à esp>0 IS et OOS.
"use strict";
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require("../harness_lib.js");
const { PRIMS, NAMES } = require("./mix_primitives_mixC.js");

const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------------------------------
// Univers : univers.json (+ instruments "extra" présents dans data/ mais hors top 250 classé, volume
// estimé depuis les bougies déjà téléchargées) ∩ data/, blocklist actions (README, étendue par le
// journal), cryptos déjà réclamées par un module candidates/*.js existant OU par le REGISTRE exclues
// (règle "1 stratégie/crypto" suivie par tout le labo, cf. mixA/mixB).
const BLOCKLIST_ACTIONS = new Set([
  "AAPL", "SPX", "TSLA", "NVDA", "MSTR", "SKHYNIX", "SKHY", "SNDK", "CRCL", "HOOD", "COIN",
  "GOOG", "GOOGL", "META", "AMZN", "MSFT", "AMD", "INTC", "QQQ", "GLD", "XAUT", "TRUMP",
  "AXTI", "MRVL", "MU", "NBIS", "SOXL", "SOXS", "TQQQ", "EWY", "CXMT", "SAMSUNG", "XIAOMI",
  "UNITREE", "ZHIPU", "MINIMAX", "XAU", "XAG", "XCU", "BEAT", "BZ", "CBRS", "CL", "CC", "CHIP",
  "DRAM", "SLX", "ROBO", "SPCX", "SPACE", "LITE", "OPG", "BARD", "SKDD", "SNXX", "AAOI", "AVGO",
  "TSM", "SPY", "BILL",
  "F", "SHELL", "PROS", "IREN", "RKLB", "ASTS", "TER", "RDDT", "IBM", "NFLX", "PLTR", "GME",
  "MARA", "RIOT",
  "ASML", "HPE", "OKTA", "XBI", "ZM", "XPT", "USDC",
]);

const REGISTRE_BLOCK = new Set([
  "PIEVERSE", "ENSO", "USELESS", "SOON", "GRASS", "NES", "GPS", "AXS", "MANA", "LUNA", "MEGA",
  "BASED", "PLUME", "ALLO", "SOPH", "O", "YGG", "HUMA", "STABLE",
  "ARX", "DOT", "MERL", "ESP", "BSB", "ZAMA", "MOODENG",
]);

function sym(instId) { return instId.replace(/-USDT-SWAP$/, ""); }

function loadClaimedInstIds() {
  const dir = path.join(ROOT, "candidates");
  const claimed = new Set(REGISTRE_BLOCK);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    try {
      const mod = require(path.join(dir, f));
      if (mod && mod.instId) claimed.add(sym(mod.instId));
    } catch (e) { /* module cassé, pas notre souci */ }
  }
  return claimed;
}

function estimVol(dataDir, instId) {
  try {
    const c5 = JSON.parse(fs.readFileSync(path.join(dataDir, instId + ".json")));
    const tail = c5.slice(-288);
    let s = 0;
    for (const c of tail) s += c[6] || 0;
    return s;
  } catch (e) { return 0; }
}

function buildUniverse(limit) {
  const uni = require(path.join(ROOT, "..", "univers.json"));
  const claimed = loadClaimedInstIds();
  const dataDir = path.join(ROOT, "..", "data");
  const dataFiles = fs.readdirSync(dataDir).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
  const avail = new Set(dataFiles);
  const uSet = new Set(uni.map(u => u.instId));

  const ranked = uni.filter(u => avail.has(u.instId)).map(u => ({ instId: u.instId, volUsd: u.volUsd }));
  const extra = dataFiles.filter(f => !uSet.has(f)).map(f => ({ instId: f, volUsd: estimVol(dataDir, f) }));

  const VOL_FLOOR = 100000;
  const rows = ranked.concat(extra)
    .filter(u => !BLOCKLIST_ACTIONS.has(sym(u.instId)))
    .filter(u => !claimed.has(sym(u.instId)))
    .filter(u => u.volUsd >= VOL_FLOOR)
    .sort((a, b) => b.volUsd - a.volUsd);
  return rows.slice(0, limit).map(r => r.instId);
}

const univers = buildUniverse(100);

// ---------------------------------------------------------------------------------------------------
// Exits : standard imposé (E1) + 1 variante grossière (E2).
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
};

// 45 paires non ordonnées parmi les 10 primitives
const PAIRS = [];
for (let a = 0; a < NAMES.length; a++)
  for (let b = a + 1; b < NAMES.length; b++)
    PAIRS.push([NAMES[a], NAMES[b]]);

function buildLongShortArrays(c5, name, setting) {
  const n = c5.length;
  const fn = PRIMS[name].fn;
  const long = new Uint8Array(n), short = new Uint8Array(n);
  for (let i = 100; i < n; i++) {
    const st = fn(c5, i, setting);
    if (st.long) long[i] = 1;
    if (st.short) short[i] = 1;
  }
  return { long, short };
}

function detectFromArrays(arrA, arrB) {
  const n = arrA.long.length;
  const out = [];
  for (let i = 100; i < n; i++) {
    if (arrA.long[i] && arrB.long[i]) out.push({ i5: i, dir: 1 });
    else if (arrA.short[i] && arrB.short[i]) out.push({ i5: i, dir: -1 });
  }
  return out;
}

function passOk(r) {
  return !!(r.A && r.B && r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15);
}
function directionOk(r) { // critère allégé pour le voisinage plateau (pas de contrainte de n)
  return !!(r && r.A && r.B && r.A.esp > 0 && r.B.esp > 0);
}

function evalPair(c5, arrs, nameA, sA, nameB, sB, exitKey) {
  const sigs = detectFromArrays(arrs[`${nameA}_${sA}`], arrs[`${nameB}_${sB}`]);
  if (sigs.length < 20) return null; // filtre grossier avant le coût du sim
  return evaluer({ exits: EXITS[exitKey], detect: () => sigs }, c5);
}

console.log(`mixC — Univers libre/liquide : ${univers.length} cryptos. ${PAIRS.length} paires × 4 réglages × ${Object.keys(EXITS).length} exits.`);

const results = [];
const t0 = Date.now();
let done = 0;

for (const instId of univers) {
  let c5;
  try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
  if (!c5 || c5.length < 2000) continue;

  const arrs = {};
  for (const name of NAMES) {
    arrs[`${name}_0`] = buildLongShortArrays(c5, name, 0);
    arrs[`${name}_1`] = buildLongShortArrays(c5, name, 1);
  }

  for (const [nameA, nameB] of PAIRS) {
    for (const sA of [0, 1]) {
      for (const sB of [0, 1]) {
        for (const exitKey of Object.keys(EXITS)) {
          const r = evalPair(c5, arrs, nameA, sA, nameB, sB, exitKey);
          if (!r || !passOk(r)) continue;
          const rNeighA = evalPair(c5, arrs, nameA, 1 - sA, nameB, sB, exitKey);
          const rNeighB = evalPair(c5, arrs, nameA, sA, nameB, 1 - sB, exitKey);
          const plateau = directionOk(rNeighA) && directionOk(rNeighB);
          if (!plateau) continue;
          results.push({
            instId, nameA, sA, nameB, sB, exitKey,
            espIS: r.A.esp, espOOS: r.B.esp, wrOOS: r.B.wr, pfOOS: r.B.pf,
            nIS: r.A.n, nOOS: r.B.n, nTotal: r.A.n + r.B.n,
            worst: Math.min(r.A.esp, r.B.esp),
          });
        }
      }
    }
  }
  done++;
  if (done % 10 === 0) console.log(`  ${done}/${univers.length} cryptos scannées (${((Date.now() - t0) / 1000).toFixed(0)}s), ${results.length} paires plateau+valide jusqu'ici`);
}

console.log(`Scan terminé en ${((Date.now() - t0) / 1000).toFixed(0)}s. ${results.length} paires valide+plateau.`);

results.sort((a, b) => b.worst - a.worst);

const bestParCrypto = new Map();
for (const r of results) {
  const cur = bestParCrypto.get(r.instId);
  if (!cur || r.worst > cur.worst) bestParCrypto.set(r.instId, r);
}
const top = [...bestParCrypto.values()].sort((a, b) => b.worst - a.worst);

const outPath = path.join(__dirname, "rapports", "mix_scan_mixC_resultats.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ univers_n: univers.length, pairs_n: PAIRS.length, results_n: results.length, top }, null, 1));
console.log(`Rapport écrit : ${outPath}`);
console.log("TOP 20 (1/crypto) :");
for (const r of top.slice(0, 20)) {
  console.log(`  ${r.instId} ${r.nameA}@${r.sA} × ${r.nameB}@${r.sB} ${r.exitKey} : worst ${r.worst.toFixed(2)} (IS ${r.espIS.toFixed(2)}/${r.nIS} OOS ${r.espOOS.toFixed(2)}/${r.nOOS} pfOOS ${r.pfOOS})`);
}
