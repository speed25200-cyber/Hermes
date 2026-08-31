// SCANNER h14_keltner — recette VICE-CHAMPIONNE (SOON 4/4) transplantée sur les ~190 cryptos
// jamais scannées (absentes de profond_tous_resultats.json). Recette prouvée (journal, ronde
// ti_arsenal + x1_terra + mixB) : reclaim du canal de Keltner -- une clôture qui sort du canal
// EMA(N) +/- MULT*ATR10 est un excès, la 1re clôture qui rentre à nouveau DANS le canal signe
// l'échec de l'excès -> mean-reversion (contre-pied) dans le sens du retour.
// Grille GROSSIÈRE (anti-triche) : MA{20,50} x MULT{2,3} (ATR10 fixe) x hold{8,12}
// (tp80/sl30/act30/cb5 fixe, comme demandé). Univers restreint au territoire vierge.
"use strict";
const fs = require("fs");
const path = require("path");
const ti = require("technicalindicators");
const { chargerCandles, evaluer } = require("../harness_lib.js");

const WARMUP = 400;
const MIN_EVENTS = 30;

// ---- Blocklist actions (README, littéral) --------------------------------
const BLOCKLIST_ACTIONS = new Set([
  "AAPL", "SPX", "TSLA", "NVDA", "MSTR", "SKHYNIX", "SKHY", "SNDK", "CRCL", "HOOD", "COIN",
  "GOOG", "GOOGL", "META", "AMZN", "MSFT", "AMD", "INTC", "QQQ", "GLD", "XAUT", "TRUMP",
  "AXTI", "MRVL", "MU", "NBIS", "SOXL", "SOXS", "TQQQ", "EWY", "CXMT", "SAMSUNG", "XIAOMI",
  "UNITREE", "ZHIPU", "MINIMAX", "XAU", "XAG", "XCU", "BEAT", "BZ", "CBRS", "CL", "CC", "CHIP",
  "DRAM", "SLX", "ROBO", "SPCX", "SPACE", "LITE", "OPG", "BARD", "SKDD", "SNXX", "AAOI", "AVGO",
  "TSM", "SPY", "BILL"
]);

// ---- Cryptos du registre déjà attribuées (champions/recalées) : interdites ----
const REGISTRE_BANNED = new Set([
  "PIEVERSE", "ENSO", "USELESS", "SOON", "GRASS", "NES", "GPS", "AXS", "MANA", "LUNA", "MEGA",
  "BASED", "PLUME", "ALLO", "SOPH", "O", "YGG", "STABLE", "HUMA"
]);

function base(instId) { return instId.replace("-USDT-SWAP", ""); }

// Instruments déjà revendiqués par un candidates/*.js existant (toute famille d'agent) : à
// éviter (règle "1 stratégie/crypto" observée dans tout le labo, ex. tools/mix_scan_mixB.js).
function loadClaimedInstIds() {
  const dir = path.join(__dirname, "..", "candidates");
  const claimed = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    try {
      const mod = require(path.join(dir, f));
      if (mod && mod.instId) claimed.add(mod.instId);
    } catch (e) { /* module cassé, ignoré */ }
  }
  return claimed;
}

function buildUniverse() {
  const dataDir = path.join(__dirname, "..", "..", "data");
  const dataFiles = fs.readdirSync(dataDir).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
  const prof = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "profond_tous_resultats.json")));
  const tested = new Set(prof.map(p => p.instId));
  const claimed = loadClaimedInstIds();
  return dataFiles
    .filter(id => !tested.has(id))
    .filter(id => !BLOCKLIST_ACTIONS.has(base(id)))
    .filter(id => !REGISTRE_BANNED.has(base(id)))
    .filter(id => !claimed.has(id))
    .sort();
}

// ---- Variantes Keltner (grille grossière) --------------------------------
const VARIANTS = [
  { key: "ma20x3", maPeriod: 20, atrPeriod: 10, multiplier: 3 },
  { key: "ma20x2", maPeriod: 20, atrPeriod: 10, multiplier: 2 },
  { key: "ma50x3", maPeriod: 50, atrPeriod: 10, multiplier: 3 }
];
const EXITS = {
  hold8: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 8 },
  hold12: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 }
};

function reclaimEvents(c5, variant) {
  const n = c5.length;
  const h = new Array(n), l = new Array(n), c = new Array(n);
  for (let i = 0; i < n; i++) { h[i] = +c5[i][2]; l[i] = +c5[i][3]; c[i] = +c5[i][4]; }
  const kc = ti.keltnerchannels({ high: h, low: l, close: c, maPeriod: variant.maPeriod, atrPeriod: variant.atrPeriod, multiplier: variant.multiplier, useSMA: false });
  const oK = n - kc.length;
  const out = [];
  for (let i = Math.max(WARMUP, oK + 1); i < n - 2; i++) {
    const j = i - oK;
    if (!kc[j - 1] || !kc[j]) continue;
    if (c[i - 1] < kc[j - 1].lower && c[i] > kc[j].lower) out.push({ i5: i, dir: 1 });
    else if (c[i - 1] > kc[j - 1].upper && c[i] < kc[j].upper) out.push({ i5: i, dir: -1 });
  }
  return out;
}

function scanCrypto(instId, results) {
  let c5;
  try { c5 = chargerCandles("data", instId); } catch (e) { return; }
  if (!c5 || c5.length < WARMUP + 200) return;

  for (const variant of VARIANTS) {
    let events;
    try { events = reclaimEvents(c5, variant); } catch (e) { continue; }
    if (events.length < MIN_EVENTS) continue;

    for (const exitName of Object.keys(EXITS)) {
      const mod = { exits: EXITS[exitName], detect: () => events };
      const r = evaluer(mod, c5);
      if (!r.A || !r.B) continue;
      const espIS = r.A.esp, espOOS = r.B.esp, nIS = r.A.n, nOOS = r.B.n;
      const worst = Math.min(espIS, espOOS);
      const valide = espIS > 0 && espOOS > 0 && (nIS + nOOS) >= 60 && nOOS >= 15;
      results.push({
        instId, variant: variant.key, exit: exitName,
        espIS, espOOS, nIS, nOOS, wrOOS: r.B.wr, pfOOS: r.B.pf, worst, valide
      });
    }
  }
}

function main() {
  const universe = buildUniverse();
  console.error(`Univers vierge retenu : ${universe.length} cryptos.`);
  const results = [];
  const t0 = Date.now();
  for (let k = 0; k < universe.length; k++) {
    scanCrypto(universe[k], results);
    if ((k + 1) % 20 === 0) console.error(`  ... ${k + 1}/${universe.length} cryptos scannées (${results.length} lignes, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  console.error(`Scan terminé : ${results.length} lignes en ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

  // Index pour contrôle de plateau : voisin = même crypto/exit, autre variant Keltner ;
  // et même crypto/variant, autre exit (hold).
  const idx = new Map();
  for (const r of results) idx.set(`${r.instId}|${r.variant}|${r.exit}`, r);
  const variantKeys = VARIANTS.map(v => v.key);
  const exitKeys = Object.keys(EXITS);
  function neighborsPositive(r) {
    const otherVariants = variantKeys.filter(v => v !== r.variant)
      .map(v => idx.get(`${r.instId}|${v}|${r.exit}`)).filter(Boolean);
    const otherExit = exitKeys.find(e => e !== r.exit);
    const nExit = idx.get(`${r.instId}|${r.variant}|${otherExit}`);
    const anyVariantPositive = otherVariants.some(n => n.espIS > 0 && n.espOOS > 0);
    const exitPositive = !!(nExit && nExit.espIS > 0 && nExit.espOOS > 0);
    return { plateau: anyVariantPositive || exitPositive, anyVariantPositive, exitPositive, nExit };
  }

  const valides = results.filter(r => r.valide);
  for (const r of valides) {
    const pl = neighborsPositive(r);
    r.plateau = pl.plateau;
    r.voisinExit = pl.nExit ? +pl.nExit.worst.toFixed(2) : null;
  }
  const survivants = valides.filter(r => r.plateau).sort((a, b) => b.worst - a.worst);

  // 1 stratégie / crypto : garde le meilleur worst par instId
  const bestParCrypto = new Map();
  for (const r of survivants) {
    const cur = bestParCrypto.get(r.instId);
    if (!cur || r.worst > cur.worst) bestParCrypto.set(r.instId, r);
  }
  const top = [...bestParCrypto.values()].sort((a, b) => b.worst - a.worst);

  const outDir = path.join(__dirname, "rapports");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "h14_keltner_valides.json"), JSON.stringify(valides, null, 1));
  fs.writeFileSync(path.join(outDir, "h14_keltner_top.json"), JSON.stringify(top, null, 1));
  console.error(`Valides (esp>0 IS/OOS, n>=60, nOOS>=15) : ${valides.length}`);
  console.error(`Survivants plateau : ${survivants.length}`);
  console.error(`Top par crypto (1 stratégie/crypto) : ${top.length}`);
  console.log(JSON.stringify(top.slice(0, 30), null, 1));
}

main();
