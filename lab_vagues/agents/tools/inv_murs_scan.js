// SCAN inv_murs — ÉLASTICITÉ PRIX-VOLUME (détecteur de murs d'ordres invisibles). INVENTION.
// Indicateur CR (Collapse Ratio) : élasticité de fenêtre = (Σ|Δclose| / Σvol) sur W bougies,
// rapportée à l'élasticité de référence des 288 bougies AVANT la fenêtre (zéro look-ahead).
// CR bas = beaucoup de volume échangé pour un prix figé = mur d'ordres invisible.
// Déclencheur : effondrement (CR croise sous R : mode "hit") ou fin d'effondrement (CR ressort : mode "rel"),
// volume de fenêtre chargé (>= Q x moyenne), et un vrai mouvement d'approche qui bute (|app| >= A x bruit x sqrt(L)).
// Sens : FADE du mouvement qui bute (le mur absorbe). Option bougie de confirmation.
// Grille GROSSIÈRE, exits FONDATEURS E1/E2 uniquement (pas de balayage de sorties).
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));

const BLOCK = new Set(("AAPL SPX TSLA NVDA MSTR SKHYNIX SKHY SNDK CRCL HOOD COIN GOOGL GOOG META AMZN QQQ GLD XAUT TRUMP " +
  "AXTI MRVL MU NBIS SOXL SOXS TQQQ EWY CXMT SAMSUNG XIAOMI UNITREE ZHIPU MINIMAX XAU XAG XCU " +
  "AAOI AVGO TSM SPY BILL BEAT BZ CBRS CL CC CHIP DRAM SLX ROBO SPCX SPACE LITE OPG BARD SKDD SNXX " +
  "AMD MSFT INTC").split(/\s+/));

const N_BASE = 288;        // référence : 288 bougies (24 h) AVANT la fenêtre
const WARM = 500;
const WS = [6, 12, 24];    // fenêtre du mur : 30 min / 1 h / 2 h
const RS = [0.3, 0.5];     // seuil d'effondrement du ratio d'élasticité
const QS = [1.0, 1.5];     // charge en volume de la fenêtre (x moyenne 24 h)
const AS = [1, 2];         // approche mini en unités de bruit (x mean|d5m| x sqrt(L)), L = 4W
const MODES = ["hit", "rel"];
const CONFS = [0, 1];
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};

function precalc(c5) {
  const n = c5.length;
  const dC = new Float64Array(n), vol = new Float64Array(n);
  for (let i = 1; i < n; i++) dC[i] = Math.abs(c5[i][4] - c5[i - 1][4]);
  for (let i = 0; i < n; i++) vol[i] = +c5[i][5] || 0;
  // préfixes (index 0..n) : PD[k] = somme dC[0..k-1]
  const PD = new Float64Array(n + 1), PV = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { PD[i + 1] = PD[i] + dC[i]; PV[i + 1] = PV[i] + vol[i]; }
  return { n, PD, PV };
}

// CR et vcharge pour une fenêtre W, à l'index i (bougies i-W+1..i), référence = 288 bougies finissant à i-W
function series(c5, pre, W) {
  const { n, PD, PV } = pre;
  const CR = new Float64Array(n).fill(NaN), VC = new Float64Array(n).fill(NaN), NOISE = new Float64Array(n).fill(NaN);
  const start = N_BASE + W + 1;
  for (let i = start; i < n; i++) {
    const dispW = PD[i + 1] - PD[i + 1 - W], volW = PV[i + 1] - PV[i + 1 - W];
    const dispB = PD[i + 1 - W] - PD[i + 1 - W - N_BASE], volB = PV[i + 1 - W] - PV[i + 1 - W - N_BASE];
    if (volW > 0 && volB > 0 && dispB > 0) {
      CR[i] = (dispW / volW) / (dispB / volB);
      VC[i] = (volW / W) / (volB / N_BASE);
      NOISE[i] = dispB / N_BASE; // bruit moyen par bougie (unités prix)
    }
  }
  return { CR, VC, NOISE };
}

function detecter(c5, S, W, R, Q, A, mode, conf) {
  const L = 4 * W, sqL = Math.sqrt(L);
  const out = [];
  for (let i = WARM; i < c5.length - 2; i++) {
    const cr = S.CR[i], crp = S.CR[i - 1];
    if (Number.isNaN(cr) || Number.isNaN(crp)) continue;
    let fired = false, vc;
    if (mode === "hit") { fired = cr <= R && crp > R; vc = S.VC[i]; }
    else { fired = cr > R && crp <= R; vc = S.VC[i - 1]; }
    if (!fired || Number.isNaN(vc) || vc < Q) continue;
    const app = c5[i][4] - c5[i - L][4];
    const th = A * S.NOISE[i] * sqL;
    if (!(Math.abs(app) >= th) || th <= 0) continue;
    const dir = app > 0 ? -1 : 1; // fade du mouvement qui bute sur le mur
    if (conf) { const body = c5[i][4] - c5[i][1]; if (dir > 0 ? body <= 0 : body >= 0) continue; }
    out.push({ i5: i, dir });
  }
  return out;
}

const dataDir = path.join(__dirname, "..", "..", "data");
const insts = fs.readdirSync(dataDir).filter(f => f.endsWith("-USDT-SWAP.json"))
  .map(f => f.replace(".json", ""))
  .filter(id => !BLOCK.has(id.replace("-USDT-SWAP", "")));

const lignes = [];
let done = 0;
for (const inst of insts) {
  let c5;
  try { c5 = chargerCandles("data", inst); } catch (e) { continue; }
  if (!c5 || c5.length < 3000) continue;
  const pre = precalc(c5);
  for (const W of WS) {
    const S = series(c5, pre, W);
    for (const R of RS) for (const Q of QS) for (const A of AS) for (const mode of MODES) for (const conf of CONFS) {
      const sigs = detecter(c5, S, W, R, Q, A, mode, conf);
      if (sigs.length < 25) continue;
      for (const ex of Object.keys(EXITS)) {
        const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
        if (!r.A || !r.B) continue;
        const nT = r.A.n + r.B.n;
        if (nT < 30) continue;
        lignes.push({
          inst, W, R, Q, A, mode, conf, ex,
          espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
          wrOOS: r.B.wr, pfOOS: r.B.pf,
          worst: Math.min(r.A.esp, r.B.esp),
          valide: r.A.esp > 0 && r.B.esp > 0 && nT >= 60 && r.B.n >= 15
        });
      }
    }
  }
  done++;
  if (done % 25 === 0) console.error(`... ${done}/${insts.length} cryptos`);
}

lignes.sort((a, b) => (b.valide - a.valide) || (b.worst - a.worst));
const outFile = path.join(__dirname, "rapports", "inv_murs_scan_resultats.json");
fs.writeFileSync(outFile, JSON.stringify({ meta: { date: new Date().toISOString(), nInsts: done, nLignes: lignes.length, grille: { WS, RS, QS, AS, MODES, CONFS, exits: Object.keys(EXITS) } }, lignes }, null, 1));
console.error(`OK ${done} cryptos, ${lignes.length} lignes -> ${outFile}`);
const valides = lignes.filter(l => l.valide);
console.log(JSON.stringify({ nValides: valides.length, top25: valides.slice(0, 25) }, null, 1));
