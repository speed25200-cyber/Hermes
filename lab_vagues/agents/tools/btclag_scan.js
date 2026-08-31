// SCAN BTC LEAD-LAG (agent btclag_, 30/08) — signal RELATIF jamais testé :
// excès de l'alt PAR RAPPORT au BTC = (rendement log alt sur H bougies) − β×(rendement log BTC sur H bougies),
// β = pente de régression des rendements 5 m alt/BTC sur B bougies glissantes (24 h ou 48 h).
// z-score de l'excès sur 288 bougies glissantes (fenêtre W passée, bougie courante exclue) ;
// |z| au-delà du seuil → FADE de l'excès (alt sur-étendue vs BTC → short, sous-étendue → long).
// Grille GROSSIÈRE : B {288,576} × H {12,24,48} × T {2,3} × mode {zx=franchissement, zr=reclaim} × 2 exits FONDATEURS.
// Zéro look-ahead : β, moyenne et σ n'utilisent que des bougies <= i (fenêtre z exclut i).
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require("../harness_lib.js");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const W = 288; // fenêtre du z-score (24 h)
const BS = [288, 576], HS = [12, 24, 48], TS = [2, 3], MODES = ["zx", "zr"];
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};
const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY GOOGL " +
  "INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK SNXX SOXL SOXS " +
  "SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD").split(" "));

const btc = chargerCandles("data", "BTC-USDT-SWAP");
const btcMap = new Map(btc.map(c => [c[0], c[4]]));

function serieSignaux(c5) {
  const n = c5.length;
  const La = new Float64Array(n), Lb = new Float64Array(n);
  let manquants = 0;
  for (let i = 0; i < n; i++) {
    La[i] = Math.log(c5[i][4]);
    const b = btcMap.get(c5[i][0]);
    if (b === undefined) { manquants++; Lb[i] = NaN; } else Lb[i] = Math.log(b);
  }
  if (manquants > n * 0.01) return null; // alignement BTC insuffisant
  const ra = new Float64Array(n), rb = new Float64Array(n);
  for (let i = 1; i < n; i++) { ra[i] = La[i] - La[i - 1]; rb[i] = Lb[i] - Lb[i - 1]; }
  const out = {}; // out[`${B}_${H}`] = z (Float64Array)
  for (const B of BS) {
    // beta glissante sur [i-B+1 .. i]
    const beta = new Float64Array(n).fill(NaN);
    let Sa = 0, Sb = 0, Sab = 0, Sbb = 0, bad = 0;
    for (let i = 1; i < n; i++) {
      const va = ra[i], vb = rb[i];
      if (Number.isNaN(va) || Number.isNaN(vb)) bad++; else { Sa += va; Sb += vb; Sab += va * vb; Sbb += vb * vb; }
      const j = i - B; // sort de fenêtre
      if (j >= 1) {
        const wa = ra[j], wb = rb[j];
        if (Number.isNaN(wa) || Number.isNaN(wb)) bad--; else { Sa -= wa; Sb -= wb; Sab -= wa * wb; Sbb -= wb * wb; }
      }
      if (i >= B && bad === 0) {
        const cov = Sab / B - (Sa / B) * (Sb / B), vr = Sbb / B - (Sb / B) * (Sb / B);
        if (vr > 1e-12) beta[i] = cov / vr;
      }
    }
    for (const H of HS) {
      const exc = new Float64Array(n).fill(NaN);
      for (let i = B; i < n; i++) {
        if (i < H || Number.isNaN(beta[i]) || Number.isNaN(Lb[i]) || Number.isNaN(Lb[i - H])) continue;
        exc[i] = (La[i] - La[i - H]) - beta[i] * (Lb[i] - Lb[i - H]);
      }
      // z-score glissant sur les W bougies PASSÉES (i exclu)
      const z = new Float64Array(n).fill(NaN);
      let S = 0, S2 = 0, cnt = 0;
      for (let i = 0; i < n; i++) {
        const j = i - 1; // la bougie j entre dans la fenêtre servant à z[i]... fenêtre = [i-W, i-1]
        if (j >= 0 && !Number.isNaN(exc[j])) { S += exc[j]; S2 += exc[j] * exc[j]; cnt++; }
        const k = i - W - 1;
        if (k >= 0 && !Number.isNaN(exc[k])) { S -= exc[k]; S2 -= exc[k] * exc[k]; cnt--; }
        if (cnt >= W * 0.9 && !Number.isNaN(exc[i])) {
          const m = S / cnt, v = S2 / cnt - m * m;
          if (v > 1e-18) z[i] = (exc[i] - m) / Math.sqrt(v);
        }
      }
      out[`${B}_${H}`] = z;
    }
  }
  return out;
}

function signaux(z, B, H, T, mode) {
  const out = [], i0 = B + W + H + 2;
  for (let i = Math.max(i0, 1); i < z.length; i++) {
    const zi = z[i], zp = z[i - 1];
    if (Number.isNaN(zi) || Number.isNaN(zp)) continue;
    if (mode === "zx") {
      if (zi >= T && zp < T) out.push({ i5: i, dir: -1 });
      else if (zi <= -T && zp > -T) out.push({ i5: i, dir: 1 });
    } else { // zr : était au-delà du seuil, referme en dessous mais l'excès est encore du même côté
      if (zp > T && zi <= T && zi > 0) out.push({ i5: i, dir: -1 });
      else if (zp < -T && zi >= -T && zi < 0) out.push({ i5: i, dir: 1 });
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
  if (BLOCK.has(nom) || nom === "BTC") continue;
  let c5;
  try { c5 = chargerCandles("data", instId); } catch { continue; }
  if (!c5 || c5.length < 5000) continue;
  const zs = serieSignaux(c5);
  if (!zs) continue;
  for (const B of BS) for (const H of HS) {
    const z = zs[`${B}_${H}`];
    for (const T of TS) for (const mode of MODES) {
      const sigs = signaux(z, B, H, T, mode);
      if (sigs.length < 20) continue;
      for (const [exNom, ex] of Object.entries(EXITS)) {
        const stub = { instId, exits: ex, detect: () => sigs };
        const r = evaluer(stub, c5);
        if (!r.A || !r.B) continue;
        const valide = r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15;
        const worst = Math.min(r.A.esp, r.B.esp);
        res.push({ instId: nom, B, H, T, mode, exit: exNom, espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n, wrOOS: r.B.wr, pfOOS: r.B.pf, worst, valide });
      }
    }
  }
  fait++;
  if (fait % 25 === 0) console.error(`... ${fait} cryptos`);
}

res.sort((a, b) => b.worst - a.worst);
const outFile = process.argv[2] || path.join(__dirname, "rapports", "btclag_scan_resultats.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(res));
const valides = res.filter(r => r.valide);
console.log(`lignes: ${res.length} · valides: ${valides.length} · cryptos scannées: ${fait}`);
console.log("TOP 30 valides par worst :");
for (const r of valides.slice(0, 30))
  console.log(`${r.instId.padEnd(10)} B${r.B} H${r.H} T${r.T} ${r.mode} ${r.exit}  worst ${r.worst.toFixed(2)}  IS ${r.espIS}/${r.nIS}  OOS ${r.espOOS}/${r.nOOS}  pfOOS ${r.pfOOS}`);
