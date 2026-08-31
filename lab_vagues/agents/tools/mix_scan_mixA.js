// Agent mixA — scanner systématique : croise les 10 primitives PAR PAIRES (A extrême, B confirmation,
// direction = fade de A confirmé par B ; l'AND est symétrique donc A/B ne sont que des étiquettes), sur
// l'univers liquide & libre (univers.json ∩ data/, blocklist actions du README, cryptos du REGISTRE exclues).
// 45 paires × 4 combinaisons de réglages (2×2) × 2 exits, testé crypto par crypto avec harness_lib (mêmes
// règles que tout le banc : coûts, pire cas, IS 20j/OOS 10j, blocage par symbole).
// Anti-coup-de-chance : une paire n'est retenue que si (1) valide au sens test_harness (esp>0 IS ET OOS,
// n>=60, nOOS>=15) ET (2) PLATEAU — le réglage voisin de A (B fixé) et le réglage voisin de B (A fixé)
// restent tous les deux à esp>0 IS et OOS.
"use strict";
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require("../harness_lib.js");
const { PRIMS, NAMES } = require("./mix_primitives_mixA.js");

const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------------------------------
// Univers : univers.json ∩ data/, blocklist actions (README) + blocklist cryptos du REGISTRE (1 stratégie
// par crypto — le registre = celles qui ont déjà un champion).
const uni = require(path.join(ROOT, "..", "univers.json"));
const dataFiles = new Set(fs.readdirSync(path.join(ROOT, "..", "data")).filter(f => f.endsWith(".json")).map(f => f.replace(".json", "")));

const STOCK_BLOCK = new Set([
  "AAPL", "SPX", "TSLA", "NVDA", "MSTR", "SKHYNIX", "SKHY", "SNDK", "CRCL", "HOOD", "COIN", "GOOG", "GOOGL",
  "META", "AMZN", "MSFT", "AMD", "INTC", "QQQ", "GLD", "XAUT", "TRUMP",
  "AXTI", "MRVL", "MU", "NBIS", "SOXL", "SOXS", "TQQQ", "EWY", "CXMT", "SAMSUNG", "XIAOMI", "UNITREE",
  "ZHIPU", "MINIMAX", "XAU", "XAG", "XCU", "BEAT", "BZ", "CBRS", "CL", "CC", "CHIP", "DRAM", "SLX", "ROBO",
  "SPCX", "SPACE", "LITE", "OPG", "BARD", "SKDD", "SNXX", "AAOI", "AVGO", "TSM", "SPY", "BILL",
]);

const REGISTRE_BLOCK = new Set([
  // champions actuels (REGISTRE_STRATEGIES.json "champions")
  "PIEVERSE", "ENSO", "USELESS", "SOON", "GRASS", "NES", "GPS", "AXS", "MANA", "LUNA", "MEGA",
  // recales_60j_ne_pas_reprendre + maj_vague2 morts (déjà essayés sur ce registre, à ne pas reprendre)
  "BASED", "PLUME", "ALLO", "SOPH", "O", "YGG", "HUMA", "STABLE",
  "ARX", "DOT", "MERL", "ESP", "BSB", "ZAMA", "MOODENG",
]);

function sym(instId) { return instId.replace(/-USDT-SWAP$/, ""); }

// Bonus non demandé par le contrat mais cohérent avec la convention "1 stratégie/crypto" suivie par TOUT
// le labo (candidates/*.js) : on lit dynamiquement les instId déjà utilisés par un candidat existant pour
// ne pas resservir une crypto qui a déjà un champion plus fort ailleurs. Le contrat n'exige que le blocage
// du REGISTRE ; ceci est une couche de prudence supplémentaire, pas une substitution.
const CANDIDATES_DIR = path.join(ROOT, "candidates");
const DEJA_PRIS = new Set();
for (const f of fs.readdirSync(CANDIDATES_DIR)) {
  if (!f.endsWith(".js")) continue;
  try {
    const txt = fs.readFileSync(path.join(CANDIDATES_DIR, f), "utf8");
    const m = txt.match(/instId:\s*"([A-Z0-9]+)-USDT-SWAP"/);
    if (m) DEJA_PRIS.add(m[1]);
  } catch (e) { /* ignore */ }
}

const N_UNIVERS = 100;
const univers = uni
  .filter(u => dataFiles.has(u.instId))
  .filter(u => !STOCK_BLOCK.has(sym(u.instId)))
  .filter(u => !REGISTRE_BLOCK.has(sym(u.instId)))
  .filter(u => !DEJA_PRIS.has(sym(u.instId)))
  .sort((a, b) => b.volUsd - a.volUsd)
  .slice(0, N_UNIVERS)
  .map(u => u.instId);

// ---------------------------------------------------------------------------------------------------
// Exits : standard imposé (E1) + 1 variante grossière (E2, style "fondateurs" déjà en usage dans le labo).
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

function evalPair(c5, instId, arrs, nameA, sA, nameB, sB, exitKey) {
  const sigs = detectFromArrays(arrs[`${nameA}_${sA}`], arrs[`${nameB}_${sB}`]);
  if (sigs.length < 20) return null; // filtre grossier avant le coût du sim
  const r = evaluer({ exits: EXITS[exitKey], detect: () => sigs }, c5);
  return r;
}

console.log(`Univers libre/liquide : ${univers.length} cryptos. ${PAIRS.length} paires × 4 réglages × ${Object.keys(EXITS).length} exits.`);

const results = []; // toutes les paires valide:true
const t0 = Date.now();
let done = 0;

for (const instId of univers) {
  let c5;
  try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
  if (!c5 || c5.length < 2000) continue;

  // précalcule les 10 primitives × 2 réglages = 20 paires de tableaux long/short (fait une seule fois par crypto)
  const arrs = {};
  for (const name of NAMES) {
    arrs[`${name}_0`] = buildLongShortArrays(c5, name, 0);
    arrs[`${name}_1`] = buildLongShortArrays(c5, name, 1);
  }

  for (const [nameA, nameB] of PAIRS) {
    for (const sA of [0, 1]) {
      for (const sB of [0, 1]) {
        for (const exitKey of Object.keys(EXITS)) {
          const r = evalPair(c5, instId, arrs, nameA, sA, nameB, sB, exitKey);
          if (!r || !passOk(r)) continue;
          // Plateau : voisin de A (sA -> 1-sA, B fixé) et voisin de B (sB -> 1-sB, A fixé) doivent rester
          // à esp>0 des deux côtés (IS et OOS).
          const rNeighA = evalPair(c5, instId, arrs, nameA, 1 - sA, nameB, sB, exitKey);
          const rNeighB = evalPair(c5, instId, arrs, nameA, sA, nameB, 1 - sB, exitKey);
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

// 1 meilleure paire par crypto (convention "1 stratégie/crypto" du labo), puis top global
const bestParCrypto = new Map();
for (const r of results) {
  const cur = bestParCrypto.get(r.instId);
  if (!cur || r.worst > cur.worst) bestParCrypto.set(r.instId, r);
}
const top = [...bestParCrypto.values()].sort((a, b) => b.worst - a.worst);

const outPath = path.join(__dirname, "rapports", "mix_scan_mixA_resultats.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ univers_n: univers.length, pairs_n: PAIRS.length, results_n: results.length, top }, null, 1));
console.log(`Rapport écrit : ${outPath}`);
console.log("TOP 15 (1/crypto) :");
for (const r of top.slice(0, 15)) {
  console.log(`  ${r.instId} ${r.nameA}@${r.sA} × ${r.nameB}@${r.sB} ${r.exitKey} : worst ${r.worst.toFixed(2)} (IS ${r.espIS.toFixed(2)}/${r.nIS} OOS ${r.espOOS.toFixed(2)}/${r.nOOS} pfOOS ${r.pfOOS})`);
}
