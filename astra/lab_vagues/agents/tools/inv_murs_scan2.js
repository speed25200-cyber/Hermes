// SCAN inv_murs passe 2 — leçons passe 1 : le croisement exact est trop rare (6 valides, plafond 5,42),
// R 0,3 / Q 1,5 / conf tuent le n. Ici : mode "etat" (CR effondré à i, le blocage par symbole dédoublonne),
// W3 ajouté, R élargi {0,5, 0,7}, Q {1,0, 1,3}, et DEUX sens : F = fade du mouvement qui bute (concept),
// C = percée (le mur est mangé, continuation) — même dualité que inv_efficacite M/A.
// Exits FONDATEURS E1/E2 uniquement.
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));

const BLOCK = new Set(("AAPL SPX TSLA NVDA MSTR SKHYNIX SKHY SNDK CRCL HOOD COIN GOOGL GOOG META AMZN QQQ GLD XAUT TRUMP " +
  "AXTI MRVL MU NBIS SOXL SOXS TQQQ EWY CXMT SAMSUNG XIAOMI UNITREE ZHIPU MINIMAX XAU XAG XCU " +
  "AAOI AVGO TSM SPY BILL BEAT BZ CBRS CL CC CHIP DRAM SLX ROBO SPCX SPACE LITE OPG BARD SKDD SNXX " +
  "AMD MSFT INTC").split(/\s+/));

const N_BASE = 288;
const WARM = 500;
const WS = [3, 6, 12];
const RS = [0.5, 0.7];
const QS = [1.0, 1.3];
const AS = [1, 2];
const MODES = ["etat", "hit", "rel"];
const SENS = ["F", "C"];
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};

function precalc(c5) {
  const n = c5.length;
  const dC = new Float64Array(n), vol = new Float64Array(n);
  for (let i = 1; i < n; i++) dC[i] = Math.abs(c5[i][4] - c5[i - 1][4]);
  for (let i = 0; i < n; i++) vol[i] = +c5[i][5] || 0;
  const PD = new Float64Array(n + 1), PV = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { PD[i + 1] = PD[i] + dC[i]; PV[i + 1] = PV[i] + vol[i]; }
  return { n, PD, PV };
}

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
      NOISE[i] = dispB / N_BASE;
    }
  }
  return { CR, VC, NOISE };
}

function detecter(c5, S, W, R, Q, A, mode, sens) {
  const L = 4 * W, sqL = Math.sqrt(L);
  const out = [];
  for (let i = WARM; i < c5.length - 2; i++) {
    const cr = S.CR[i], crp = S.CR[i - 1];
    if (Number.isNaN(cr) || Number.isNaN(crp)) continue;
    let fired = false, vc;
    if (mode === "etat") { fired = cr <= R; vc = S.VC[i]; }
    else if (mode === "hit") { fired = cr <= R && crp > R; vc = S.VC[i]; }
    else { fired = cr > R && crp <= R; vc = S.VC[i - 1]; }
    if (!fired || Number.isNaN(vc) || vc < Q) continue;
    const app = c5[i][4] - c5[i - L][4];
    const th = A * S.NOISE[i] * sqL;
    if (!(Math.abs(app) >= th) || th <= 0) continue;
    const dir = sens === "F" ? (app > 0 ? -1 : 1) : (app > 0 ? 1 : -1);
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
    for (const R of RS) for (const Q of QS) for (const A of AS) for (const mode of MODES) for (const sens of SENS) {
      const sigs = detecter(c5, S, W, R, Q, A, mode, sens);
      if (sigs.length < 25) continue;
      for (const ex of Object.keys(EXITS)) {
        const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
        if (!r.A || !r.B) continue;
        const nT = r.A.n + r.B.n;
        if (nT < 30) continue;
        lignes.push({
          inst, W, R, Q, A, mode, sens, ex,
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
const outFile = path.join(__dirname, "rapports", "inv_murs_scan2_resultats.json");
fs.writeFileSync(outFile, JSON.stringify({ meta: { date: new Date().toISOString(), nInsts: done, nLignes: lignes.length, grille: { WS, RS, QS, AS, MODES, SENS, exits: Object.keys(EXITS) } }, lignes }, null, 1));
console.error(`OK ${done} cryptos, ${lignes.length} lignes -> ${outFile}`);
const valides = lignes.filter(l => l.valide);
console.log(JSON.stringify({ nValides: valides.length, top30: valides.slice(0, 30) }, null, 1));
