// SCAN VOLUME PROFILE — PASSE 2 (agent volprofile_, 30/08).
// La doctrine du volume profile dit que le fade vers le POC ne vaut que dans un profil
// ÉQUILIBRÉ (balanced) ; passe 1 (signaux nus) plafonne à ~6. Ici : mêmes profils
// incrémentaux 24 h / tranches 0,25 % / VA 70 % +
//   nouveau mode varej : mèche qui PERCE le bord de la zone de valeur en séance mais
//     referme DEDANS la même bougie (rejet classique du bord), encore du côté sorti
//   filtre adx  : ADX14 sur 15 m < 25 (régime plat — leçon BSB/Fisher, alignement quart d'heure, zéro futur)
//   filtre stab : POC stable = amplitude du POC sur les 12 dernières bougies (1 h) <= 0,5 % (profil accepté)
// Grille : 6 signaux {pocrec 2/3 %, poccnf 2/3 %, varec, varej} × filtres {aucun (varej seul), adx, stab} × 2 exits fondateurs.
const fs = require("fs");
const path = require("path");
const ti = require("technicalindicators");
const { chargerCandles, evaluer } = require("../harness_lib.js");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const W = 288, LN = Math.log(1.0025), VA = 0.70;
const ADX_MAX = 25, STAB_BARS = 12, STAB_TOL = 0.005;
const DS = [0.02, 0.03];
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};
const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY GOOGL " +
  "INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK SNXX SOXL SOXS " +
  "SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD").split(" "));

const bucketOf = p => Math.floor(Math.log(p) / LN);
const centre = b => Math.exp((b + 0.5) * LN);
const bordHaut = b => Math.exp((b + 1) * LN);
const bordBas = b => Math.exp(b * LN);

function parts(c) {
  const v = Math.max(c[5], 0);
  if (!(v > 0)) return null;
  const bLo = bucketOf(c[3]), bHi = bucketOf(c[2]);
  return { bLo, bHi, share: v / (bHi - bLo + 1) };
}

function profilSeries(c5) {
  const n = c5.length;
  const poc = new Float64Array(n).fill(NaN), vah = new Float64Array(n).fill(NaN), val = new Float64Array(n).fill(NaN);
  const vol = new Map();
  for (let i = 0; i < n; i++) {
    const add = parts(c5[i]);
    if (add) for (let b = add.bLo; b <= add.bHi; b++) vol.set(b, (vol.get(b) || 0) + add.share);
    if (i >= W) {
      const rem = parts(c5[i - W]);
      if (rem) for (let b = rem.bLo; b <= rem.bHi; b++) {
        const nv = (vol.get(b) || 0) - rem.share;
        if (nv <= 1e-9) vol.delete(b); else vol.set(b, nv);
      }
    }
    if (i < W - 1 || vol.size === 0) continue;
    let pocB = 0, maxV = -1, total = 0, minB = Infinity, maxB = -Infinity;
    for (const [b, v] of vol) {
      total += v;
      if (v > maxV) { maxV = v; pocB = b; }
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    if (!(total > 0)) continue;
    let lo = pocB, hi = pocB, cum = maxV;
    const cible = VA * total;
    while (cum < cible && (lo > minB || hi < maxB)) {
      const vUp = hi < maxB ? (vol.get(hi + 1) || 0) : -1;
      const vDn = lo > minB ? (vol.get(lo - 1) || 0) : -1;
      if (vUp >= vDn) { hi++; cum += vUp; } else { lo--; cum += vDn; }
    }
    poc[i] = centre(pocB); vah[i] = bordHaut(hi); val[i] = bordBas(lo);
  }
  return { poc, vah, val };
}

// ADX14 15 m projeté sur l'index 5 m (valeur dispo à la clôture de la 3e bougie du quart d'heure)
function adxMap5m(c5) {
  const N = c5.length;
  const h15 = [], l15 = [], c15 = [], e15 = [];
  for (let i = 0; i + 2 < N; ) {
    const t0 = c5[i][0];
    if (t0 % 900000 !== 0) { i++; continue; }
    if (c5[i + 1][0] - t0 !== 300000 || c5[i + 2][0] - t0 !== 600000) { i++; continue; }
    h15.push(Math.max(c5[i][2], c5[i + 1][2], c5[i + 2][2]));
    l15.push(Math.min(c5[i][3], c5[i + 1][3], c5[i + 2][3]));
    c15.push(c5[i + 2][4]); e15.push(i + 2);
    i += 3;
  }
  const adxArr = ti.adx({ high: h15, low: l15, close: c15, period: 14 });
  const oA = c15.length - adxArr.length;
  const map = new Array(N).fill(null);
  let m = 0, cur = null;
  for (let i = 0; i < N; i++) {
    while (m < e15.length && e15[m] <= i) { const j = m - oA; if (j >= 0) cur = adxArr[j].adx; m++; }
    map[i] = cur;
  }
  return map;
}

function signauxBruts(c5, p, mode, D) {
  const out = [], n = c5.length;
  for (let i = 300; i < n; i++) {
    const pc = p.poc[i], pcP = p.poc[i - 1];
    if (Number.isNaN(pc) || Number.isNaN(pcP)) continue;
    const cl = c5[i][4], clP = c5[i - 1][4];
    if (mode === "pocrec") {
      const d = cl / pc - 1, dP = clP / pcP - 1;
      if (dP > D && d <= D && d > 0) out.push({ i5: i, dir: -1 });
      else if (dP < -D && d >= -D && d < 0) out.push({ i5: i, dir: 1 });
    } else if (mode === "poccnf") {
      const d = cl / pc - 1;
      if (d > D && cl < c5[i][1]) out.push({ i5: i, dir: -1 });
      else if (d < -D && cl > c5[i][1]) out.push({ i5: i, dir: 1 });
    } else if (mode === "varec") {
      const vh = p.vah[i], vl = p.val[i], vhP = p.vah[i - 1], vlP = p.val[i - 1];
      if (Number.isNaN(vh) || Number.isNaN(vhP)) continue;
      if (clP > vhP && cl <= vh && cl > pc) out.push({ i5: i, dir: -1 });
      else if (clP < vlP && cl >= vl && cl < pc) out.push({ i5: i, dir: 1 });
    } else { // varej : mèche perce le bord de la VA, clôture revient dedans la même bougie
      const vh = p.vah[i], vl = p.val[i];
      if (Number.isNaN(vh)) continue;
      if (c5[i][2] > vh && cl <= vh && cl > pc && clP <= vh) out.push({ i5: i, dir: -1 });
      else if (c5[i][3] < vl && cl >= vl && cl < pc && clP >= vl) out.push({ i5: i, dir: 1 });
    }
  }
  return out;
}

function pocStable(p, i) {
  let mn = Infinity, mx = -Infinity;
  for (let k = i - STAB_BARS; k <= i; k++) {
    const v = p.poc[k];
    if (Number.isNaN(v)) return false;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return mx / mn - 1 <= STAB_TOL;
}

const fichiers = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
const res = [];
let fait = 0;
for (const f of fichiers) {
  const instId = f.replace(".json", "");
  const nom = instId.replace("-USDT-SWAP", "");
  if (BLOCK.has(nom)) continue;
  let c5;
  try { c5 = chargerCandles("data", instId); } catch { continue; }
  if (!c5 || c5.length < 5000) continue;
  const p = profilSeries(c5);
  const adx = adxMap5m(c5);
  const modes = [];
  for (const D of DS) { modes.push(["pocrec", D]); modes.push(["poccnf", D]); }
  modes.push(["varec", 0]); modes.push(["varej", 0]);
  for (const [mode, D] of modes) {
    const bruts = signauxBruts(c5, p, mode, D);
    if (!bruts.length) continue;
    const jeux = [];
    if (mode === "varej") jeux.push(["nu", bruts]);
    jeux.push(["adx", bruts.filter(s => adx[s.i5] !== null && adx[s.i5] < ADX_MAX)]);
    jeux.push(["stab", bruts.filter(s => pocStable(p, s.i5))]);
    for (const [filtre, sigs] of jeux) {
      if (sigs.length < 20) continue;
      for (const [exNom, ex] of Object.entries(EXITS)) {
        const stub = { instId, exits: ex, detect: () => sigs };
        const r = evaluer(stub, c5);
        if (!r.A || !r.B) continue;
        const valide = r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15;
        const worst = Math.min(r.A.esp, r.B.esp);
        res.push({ instId: nom, mode, D, filtre, exit: exNom, espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n, wrOOS: r.B.wr, pfOOS: r.B.pf, worst, valide });
      }
    }
  }
  fait++;
  if (fait % 25 === 0) console.error(`... ${fait} cryptos`);
}

res.sort((a, b) => b.worst - a.worst);
const outFile = process.argv[2] || path.join(__dirname, "rapports", "volprofile_scan2_resultats.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(res));
const valides = res.filter(r => r.valide);
console.log(`lignes: ${res.length} · valides: ${valides.length} · cryptos scannées: ${fait}`);
console.log("TOP 40 valides par worst :");
for (const r of valides.slice(0, 40))
  console.log(`${r.instId.padEnd(10)} ${r.mode} D${r.D} ${r.filtre} ${r.exit}  worst ${r.worst.toFixed(2)}  IS ${r.espIS}/${r.nIS}  OOS ${r.espOOS}/${r.nOOS}  pfOOS ${r.pfOOS}`);
