// SCANNER SYSTÉMATIQUE — agent mixB.
// Croise les 10 primitives (mix_primitives_mixB.js) PAR PAIRES : A = setup extrême (reclaim),
// B = confirmation/filtre au même instant, direction = fade de A. Simule avec harness_lib
// (mêmes règles : coûts, pire cas, IS20/OOS10, blocage par symbole) sur ~100 cryptos libres.
"use strict";
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require("../harness_lib.js");
const { buildContext, PRIMS, R288 } = require("./mix_primitives_mixB.js");

const WARMUP = 300;
const MIN_EVENTS_FOR_SIM = 30; // filtre rapide : sous ce seuil, n>=60 est structurellement hors de portée

// ---- Univers -----------------------------------------------------------
const BLOCKLIST_ACTIONS = new Set([
  // README
  "AAPL", "SPX", "TSLA", "NVDA", "MSTR", "SKHYNIX", "SKHY", "SNDK", "CRCL", "HOOD", "COIN",
  "GOOG", "GOOGL", "META", "AMZN", "MSFT", "AMD", "INTC", "QQQ", "GLD", "XAUT", "TRUMP",
  "AXTI", "MRVL", "MU", "NBIS", "SOXL", "SOXS", "TQQQ", "EWY", "CXMT", "SAMSUNG", "XIAOMI",
  "UNITREE", "ZHIPU", "MINIMAX", "XAU", "XAG", "XCU", "BEAT", "BZ", "CBRS", "CL", "CC", "CHIP",
  "DRAM", "SLX", "ROBO", "SPCX", "SPACE", "LITE", "OPG", "BARD", "SKDD", "SNXX", "AAOI", "AVGO",
  "TSM", "SPY", "BILL",
  // journal (instCategory=3 confirmées, x1_terra)
  "F", "SHELL", "PROS", "IREN", "RKLB", "ASTS", "TER", "RDDT", "IBM", "NFLX", "PLTR", "GME",
  "MARA", "RIOT",
  // repérées en construisant l'univers étendu (au-delà de univers.json) : actions/ETF/commodité tokenisés
  "ASML", "HPE", "OKTA", "XBI", "ZM", "XPT", "USDC"
]);

function loadClaimedInstIds() {
  const dir = path.join(__dirname, "..", "candidates");
  const claimed = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    try {
      const mod = require(path.join(dir, f));
      if (mod && mod.instId) claimed.add(mod.instId.replace("-USDT-SWAP", ""));
    } catch (e) { /* module cassé (ex. _opt_O.js) : ignoré, pas notre souci */ }
  }
  // Registre (profond2 EN_LIVE non couvertes par un fichier candidates dédié)
  ["MANA", "LUNA", "NES", "GPS", "AXS", "SOON", "MEGA"].forEach(x => claimed.add(x));
  return claimed;
}

// Estime un volume grossier pour les instruments absents de univers.json (au-delà du top 250 déjà
// classé) : somme des volCcy des 288 dernières bougies (~24h) du fichier data/ déjà téléchargé.
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
  const univers = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "univers.json")));
  const claimed = loadClaimedInstIds();
  const dataDir = path.join(__dirname, "..", "..", "data");
  const dataFiles = fs.readdirSync(dataDir).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
  const avail = new Set(dataFiles);
  const uSet = new Set(univers.map(u => u.instId));

  const ranked = univers
    .map(u => ({ instId: u.instId, volUsd: u.volUsd, sym: u.instId.replace("-USDT-SWAP", "") }))
    .filter(u => avail.has(u.instId));

  // Instruments présents dans data/ mais absents de univers.json (au-delà du top 250 classé,
  // ex. territoire vierge x1_terra) : volume estimé depuis les bougies déjà téléchargées.
  const extra = dataFiles
    .filter(f => !uSet.has(f))
    .map(f => ({ instId: f, volUsd: estimVol(dataDir, f), sym: f.replace("-USDT-SWAP", "") }));

  const VOL_FLOOR = 100000; // notional 24h minimum (USDT) : exclut les tickers quasi morts (ex. CGNX ~194$, WDC ~1500$)
  const rows = ranked.concat(extra)
    .filter(u => !BLOCKLIST_ACTIONS.has(u.sym))
    .filter(u => !claimed.has(u.sym))
    .filter(u => u.volUsd >= VOL_FLOOR)
    .sort((a, b) => b.volUsd - a.volUsd);
  return rows.slice(0, limit).map(r => r.instId);
}

// ---- Exits (standard + 1 variante grossière, imposés) -------------------
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};

// ---- Événements de reclaim pour une primitive directionnelle ------------
function reclaimEvents(state) {
  const n = state.long.length, evL = [], evS = [];
  for (let i = WARMUP; i < n; i++) {
    if (state.long[i - 1] === 1 && state.long[i] === 0) evL.push(i);
    if (state.short[i - 1] === 1 && state.short[i] === 0) evS.push(i);
  }
  return { evL, evS };
}

function scanCrypto(instId, results) {
  let c5;
  try { c5 = chargerCandles("data", instId); } catch (e) { return; }
  if (!c5 || c5.length < WARMUP + 200) return;
  const ctx = buildContext(c5);

  // Précalcule les 20 variantes (10 primitives x 2 niveaux)
  const variants = []; // { pKey, level, directional, state:{long,short}, events:{evL,evS}|null }
  for (const prim of PRIMS) {
    for (let lv = 0; lv < prim.levels.length; lv++) {
      const state = prim.build(ctx, prim.levels[lv]);
      const events = prim.directional ? reclaimEvents(state) : null;
      variants.push({ pKey: prim.key, level: lv, directional: prim.directional, state, events });
    }
  }

  const aVariants = variants.filter(v => v.directional);

  for (const A of aVariants) {
    // Fusionne les événements long (dir+1) et short (dir-1) de A, triés (déjà ascendants séparément)
    const baseEvents = [];
    for (const i of A.events.evL) baseEvents.push({ i5: i, dir: 1 });
    for (const i of A.events.evS) baseEvents.push({ i5: i, dir: -1 });
    baseEvents.sort((a, b) => a.i5 - b.i5);
    if (baseEvents.length < MIN_EVENTS_FOR_SIM) continue;

    for (const B of variants) {
      if (B.pKey === A.pKey) continue; // pas de confirmation par soi-même
      const filtered = [];
      for (const e of baseEvents) {
        const ok = e.dir === 1 ? B.state.long[e.i5] === 1 : B.state.short[e.i5] === 1;
        if (ok) filtered.push(e);
      }
      if (filtered.length < MIN_EVENTS_FOR_SIM) continue;

      for (const exitName of Object.keys(EXITS)) {
        const mod = { exits: EXITS[exitName], detect: () => filtered };
        const r = evaluer(mod, c5);
        if (!r.A || !r.B) continue;
        const espIS = r.A.esp, espOOS = r.B.esp, nIS = r.A.n, nOOS = r.B.n;
        const worst = Math.min(espIS, espOOS);
        const valide = espIS > 0 && espOOS > 0 && (nIS + nOOS) >= 60 && nOOS >= 15;
        results.push({
          instId, A: A.pKey, Alevel: A.level, B: B.pKey, Blevel: B.level, exit: exitName,
          espIS, espOOS, nIS, nOOS, wrOOS: r.B.wr, pfOOS: r.B.pf, worst, valide
        });
      }
    }
  }
}

function main() {
  const N = parseInt(process.argv[2] || "100", 10);
  const universe = buildUniverse(N);
  console.error(`Univers retenu : ${universe.length} cryptos.`);
  const results = [];
  const t0 = Date.now();
  for (let k = 0; k < universe.length; k++) {
    scanCrypto(universe[k], results);
    if ((k + 1) % 10 === 0) console.error(`  ... ${k + 1}/${universe.length} cryptos scannées (${results.length} lignes, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  console.error(`Scan terminé : ${results.length} lignes en ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

  // Index pour le contrôle de plateau : voisin = même crypto/B/exit avec l'autre niveau de A,
  // et même crypto/A/exit avec l'autre niveau de B.
  const idx = new Map();
  for (const r of results) idx.set(`${r.instId}|${r.A}|${r.Alevel}|${r.B}|${r.Blevel}|${r.exit}`, r);
  function neighborsPositive(r) {
    const otherA = r.Alevel === 0 ? 1 : 0, otherB = r.Blevel === 0 ? 1 : 0;
    const nA = idx.get(`${r.instId}|${r.A}|${otherA}|${r.B}|${r.Blevel}|${r.exit}`);
    const nB = idx.get(`${r.instId}|${r.A}|${r.Alevel}|${r.B}|${otherB}|${r.exit}`);
    const okA = nA && nA.espIS > 0 && nA.espOOS > 0;
    const okB = nB && nB.espIS > 0 && nB.espOOS > 0;
    return { okA, okB, plateau: !!(okA && okB), nA, nB };
  }

  const valides = results.filter(r => r.valide);
  for (const r of valides) { const pl = neighborsPositive(r); r.plateau = pl.plateau; r.voisinA = pl.nA ? +pl.nA.worst.toFixed(2) : null; r.voisinB = pl.nB ? +pl.nB.worst.toFixed(2) : null; }
  const survivants = valides.filter(r => r.plateau).sort((a, b) => b.worst - a.worst);

  // Règle 1 stratégie/crypto : garde le meilleur par instId
  const bestParCrypto = new Map();
  for (const r of survivants) {
    const cur = bestParCrypto.get(r.instId);
    if (!cur || r.worst > cur.worst) bestParCrypto.set(r.instId, r);
  }
  const top = [...bestParCrypto.values()].sort((a, b) => b.worst - a.worst);

  const outDir = path.join(__dirname, "rapports");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "mix_scan_mixB_valides.json"), JSON.stringify(valides, null, 1));
  fs.writeFileSync(path.join(outDir, "mix_scan_mixB_top.json"), JSON.stringify(top, null, 1));
  console.error(`Valides (esp>0 IS/OOS, n>=60, nOOS>=15) : ${valides.length}`);
  console.error(`Survivants plateau : ${survivants.length}`);
  console.error(`Top par crypto (1 stratégie/crypto) : ${top.length}`);
  console.log(JSON.stringify(top.slice(0, 20), null, 1));
}

main();
