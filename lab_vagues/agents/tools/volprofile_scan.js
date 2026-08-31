// SCAN VOLUME PROFILE (agent volprofile_, 30/08) — famille JAMAIS testée :
// profil de volume des 24 h glissantes (288 bougies 5 m), tranches de prix LOG de 0,25 %
// (tranche b = floor(ln(prix)/ln(1.0025)), volume de chaque bougie réparti uniformément
// sur les tranches couvertes par [low, high]). Profil INCRÉMENTAL : ajout bougie i,
// retrait bougie i-288 (mêmes parts recalculées → annulation exacte), POC = tranche au
// volume max, zone de valeur 70 % = expansion classique depuis le POC (côté le plus gros).
// Signaux (bougies closes uniquement, profil à i inclut la bougie i — zéro look-ahead) :
//   pocrec D : la distance au POC repasse SOUS D après l'avoir dépassée, encore du même côté → fade vers le POC (leçon « reclaim > touch »)
//   poccnf D : prix encore à >D du POC + bougie de retournement vers le POC (close vs open) → fade (leçon « bougie de confirmation »)
//   varec    : clôture précédente HORS zone de valeur, clôture courante revenue DEDANS, encore du côté sorti → fade vers le POC
// Grille GROSSIÈRE : D {2 %, 3 %} × 2 exits FONDATEURS (pas de balayage de sorties a posteriori).
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require("../harness_lib.js");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const W = 288;                      // 24 h de bougies 5 m
const LN = Math.log(1.0025);        // largeur de tranche 0,25 %
const VA = 0.70;                    // zone de valeur 70 %
const DS = [0.02, 0.03];
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};
const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY GOOGL " +
  "INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK SNXX SOXL SOXS " +
  "SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD").split(" "));

const bucketOf = p => Math.floor(Math.log(p) / LN);
const centre = b => Math.exp((b + 0.5) * LN);   // prix au centre de la tranche
const bordHaut = b => Math.exp((b + 1) * LN);   // bord supérieur
const bordBas = b => Math.exp(b * LN);          // bord inférieur

// parts d'une bougie : volume réparti uniformément sur les tranches couvertes par [low, high]
function parts(c) {
  const v = Math.max(c[5], 0);
  if (!(v > 0)) return null;
  const bLo = bucketOf(c[3]), bHi = bucketOf(c[2]);
  return { bLo, bHi, share: v / (bHi - bLo + 1) };
}

/* Séries poc/vah/val (prix) pour toute la série de bougies — un seul passage. */
function profilSeries(c5) {
  const n = c5.length;
  const poc = new Float64Array(n).fill(NaN), vah = new Float64Array(n).fill(NaN), val = new Float64Array(n).fill(NaN);
  const vol = new Map();               // tranche -> volume cumulé de la fenêtre
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
    // POC + bornes + total (un seul parcours de la map)
    let pocB = 0, maxV = -1, total = 0, minB = Infinity, maxB = -Infinity;
    for (const [b, v] of vol) {
      total += v;
      if (v > maxV) { maxV = v; pocB = b; }
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    if (!(total > 0)) continue;
    // zone de valeur 70 % : expansion depuis le POC, côté le plus volumineux d'abord
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

function signaux(c5, p, mode, D) {
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
    } else { // varec : reclaim du bord de la zone de valeur
      const vh = p.vah[i], vl = p.val[i], vhP = p.vah[i - 1], vlP = p.val[i - 1];
      if (Number.isNaN(vh) || Number.isNaN(vhP)) continue;
      if (clP > vhP && cl <= vh && cl > pc) out.push({ i5: i, dir: -1 });
      else if (clP < vlP && cl >= vl && cl < pc) out.push({ i5: i, dir: 1 });
    }
  }
  return out;
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
  const combos = [];
  for (const D of DS) { combos.push(["pocrec", D]); combos.push(["poccnf", D]); }
  combos.push(["varec", 0]);
  for (const [mode, D] of combos) {
    const sigs = signaux(c5, p, mode, D);
    if (sigs.length < 20) continue;
    for (const [exNom, ex] of Object.entries(EXITS)) {
      const stub = { instId, exits: ex, detect: () => sigs };
      const r = evaluer(stub, c5);
      if (!r.A || !r.B) continue;
      const valide = r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15;
      const worst = Math.min(r.A.esp, r.B.esp);
      res.push({ instId: nom, mode, D, exit: exNom, espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n, wrOOS: r.B.wr, pfOOS: r.B.pf, worst, valide });
    }
  }
  fait++;
  if (fait % 25 === 0) console.error(`... ${fait} cryptos`);
}

res.sort((a, b) => b.worst - a.worst);
const outFile = process.argv[2] || path.join(__dirname, "rapports", "volprofile_scan_resultats.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(res));
const valides = res.filter(r => r.valide);
console.log(`lignes: ${res.length} · valides: ${valides.length} · cryptos scannées: ${fait}`);
console.log("TOP 40 valides par worst :");
for (const r of valides.slice(0, 40))
  console.log(`${r.instId.padEnd(10)} ${r.mode} D${r.D} ${r.exit}  worst ${r.worst.toFixed(2)}  IS ${r.espIS}/${r.nIS}  OOS ${r.espOOS}/${r.nOOS}  pfOOS ${r.pfOOS}`);
