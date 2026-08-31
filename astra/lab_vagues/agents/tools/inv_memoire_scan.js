// SCAN inv_memoire — MÉMOIRE DES NIVEAUX (MNIV). INVENTION, zéro indicateur classique.
// Carte causale des niveaux de prix : tranches LOG de 0,25 %. Chaque pivot fractal CONFIRMÉ
// (aile L bougies de chaque côté, confirmation L bougies après l'extrême) dépose dans la tranche
// de son extrême une mémoire w = min(vol_pivot / moyVol96, 4) ; la mémoire décroît en
// exponentielle (demi-vie HALF heures) → poids du niveau = pivots × récence × volume.
// Déclencheur : le prix REVIENT au contact d'un niveau à haute mémoire (score >= M, distance <= D,
// il en était éloigné il y a 30 min) pendant que la vitesse 5 m s'éteint : |c[i]-c[i-3]| <= DEC x |c[i-3]-c[i-6]|
// avec une approche réelle (|c[i-3]-c[i-6]| >= 3 x bruit moyen). Sens : FADE de l'approche
// (long sur support en chute décélérée, short sous résistance en montée décélérée).
// Grille GROSSIÈRE, exits FONDATEURS E1/E2 uniquement (pas de balayage de sorties).
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));

const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY GOOGL " +
  "INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK SNXX SOXL SOXS " +
  "SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD").split(" "));

const LNB = Math.log(1.0025);   // tranche log 0,25 %
const WREF = 96;                // moyennes volume + |d close| sur les 96 bougies PRÉCÉDENTES
const VCAP = 4;                 // cap du poids volume d'un pivot
const S = 3;                    // vitesse mesurée sur 3 bougies (15 min)
const F = 6;                    // fraîcheur du retour : loin du niveau il y a 6 bougies
const MINK = 3;                 // approche réelle : |v_prev| >= MINK x bruit moyen par bougie
const WARM = 600;

const LS = [6, 12];             // aile du pivot fractal (30 min / 1 h)
const HALFS = [24, 48];         // demi-vie de la mémoire (heures)
const MS = [1.5, 3];            // seuil de mémoire (en "pivots efficaces")
const DS = [0.003, 0.006];      // distance de contact au niveau (log)
const DECS = [0.5, 999];        // 0.5 = décélération exigée ; 999 = porte OFF (contrôle)
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};

function precalc(c5) {
  const n = c5.length;
  const avgV = new Float64Array(n).fill(NaN), avgA = new Float64Array(n).fill(NaN);
  let sv = 0, sa = 0; const qv = [], qa = [];
  for (let i = 0; i < n; i++) {
    if (qv.length >= WREF) { avgV[i] = sv / qv.length; avgA[i] = sa / qa.length; }
    const v = +c5[i][5] || 0;
    qv.push(v); sv += v; if (qv.length > WREF) sv -= qv.shift();
    if (i > 0) { const d = Math.abs(c5[i][4] - c5[i - 1][4]); qa.push(d); sa += d; if (qa.length > WREF) sa -= qa.shift(); }
  }
  return { avgV, avgA };
}

// pivots fractals d'aile L : extrême strict à gauche, >= (resp <=) à droite ; confirmé à j+L
function pivots(c5, L) {
  const out = []; // {conf, j, price, isHigh}
  const n = c5.length;
  for (let j = L; j < n - L; j++) {
    const h = c5[j][2], l = c5[j][3];
    let ph = true, pl = true;
    for (let k = 1; k <= L && (ph || pl); k++) {
      if (c5[j - k][2] >= h || c5[j + k][2] > h) ph = false;
      if (c5[j - k][3] <= l || c5[j + k][3] < l) pl = false;
    }
    if (ph) out.push({ conf: j + L, j, price: h, isHigh: true });
    if (pl) out.push({ conf: j + L, j, price: l, isHigh: false });
  }
  out.sort((a, b) => a.conf - b.conf);
  return out;
}

// une passe sur les bougies pour un couple (L, HALF) : retourne les signaux par clé "M|D|DEC"
function passe(c5, pre, pvs, HALF) {
  const n = c5.length;
  const decay = Math.pow(0.5, 1 / (HALF * 12));
  const bins = new Map(); // bin -> [score, lastIdx]
  const sigs = {};
  for (const M of MS) for (const D of DS) for (const DEC of DECS) sigs[M + "|" + D + "|" + DEC] = [];
  let pi = 0;
  const lnC = new Float64Array(n);
  for (let i = 0; i < n; i++) lnC[i] = Math.log(c5[i][4]);
  const read = (b, i) => {
    const e = bins.get(b);
    if (!e) return 0;
    return e[0] * Math.pow(decay, i - e[1]);
  };
  for (let i = 0; i < n; i++) {
    // dépôt des pivots confirmés à i (âge compté depuis la bougie de l'extrême j)
    while (pi < pvs.length && pvs[pi].conf === i) {
      const p = pvs[pi++];
      const va = pre.avgV[p.j];
      const w = (va > 0 && !Number.isNaN(va)) ? Math.min((+c5[p.j][5] || 0) / va, VCAP) : 1;
      const b = Math.floor(Math.log(p.price) / LNB);
      const e = bins.get(b);
      if (e) { e[0] = e[0] * Math.pow(decay, p.j - e[1]) + w; e[1] = p.j; }
      else bins.set(b, [w, p.j]);
    }
    if (i < WARM || i >= n - 2) continue;
    const noise = pre.avgA[i];
    if (!(noise > 0)) continue;
    const vPrev = c5[i - S][4] - c5[i - 2 * S][4];
    const vNow = c5[i][4] - c5[i - S][4];
    if (Math.abs(vPrev) < MINK * noise) continue;      // pas de vraie approche
    const dirApp = vPrev > 0 ? 1 : -1;                 // sens du mouvement qui meurt
    const lnc = lnC[i], b0 = Math.floor(lnc / LNB);
    // meilleure tranche mémoire du côté visé par l'approche
    for (const D of DS) {
      let bestB = -1, bestS = 0;
      for (let b = b0 - 3; b <= b0 + 3; b++) {
        const ctr = (b + 0.5) * LNB, dd = ctr - lnc;
        if (Math.abs(dd) > D) continue;
        if (dirApp < 0 && dd > 0.5 * LNB) continue;    // chute → support à/sous le prix
        if (dirApp > 0 && dd < -0.5 * LNB) continue;   // montée → résistance à/sur le prix
        const s = read(b, i);
        if (s > bestS) { bestS = s; bestB = b; }
      }
      if (bestB < 0) continue;
      const ctr = (bestB + 0.5) * LNB;
      if (Math.abs(lnC[i - F] - ctr) <= D) continue;   // pas un RETOUR : il y était déjà
      for (const M of MS) {
        if (bestS < M) continue;
        for (const DEC of DECS) {
          if (Math.abs(vNow) > DEC * Math.abs(vPrev)) continue;
          sigs[M + "|" + D + "|" + DEC].push({ i5: i, dir: -dirApp });
        }
      }
    }
  }
  return sigs;
}

const dataDir = path.join(__dirname, "..", "..", "data");
const files = fs.readdirSync(dataDir).filter(f => f.endsWith("-USDT-SWAP.json"))
  .filter(f => !BLOCK.has(f.split("-")[0]));
const res = [];
let done = 0;
for (const f of files) {
  const instId = f.replace(".json", "");
  let c5; try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
  if (!Array.isArray(c5) || c5.length < 3000) continue;
  const pre = precalc(c5);
  for (const L of LS) {
    const pvs = pivots(c5, L);
    for (const HALF of HALFS) {
      const sigs = passe(c5, pre, pvs, HALF);
      for (const key of Object.keys(sigs)) {
        const list = sigs[key];
        if (list.length < 25) continue;
        for (const ex of Object.keys(EXITS)) {
          const r = evaluer({ exits: EXITS[ex], detect: () => list }, c5);
          if (!r.A || !r.B) continue;
          const worst = Math.min(r.A.esp, r.B.esp);
          const valide = r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15;
          res.push({ instId, L, HALF, key, ex, espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n, pfOOS: r.B.pf, wrOOS: r.B.wr, worst: +worst.toFixed(2), valide });
        }
      }
    }
  }
  done++;
  if (done % 25 === 0) console.error("... " + done + "/" + files.length);
}
res.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "rapports", "inv_memoire_scan_resultats.json"), JSON.stringify(res, null, 1));
console.log("lignes: " + res.length + " · valides: " + res.filter(r => r.valide).length);
for (const r of res.filter(r => r.valide).slice(0, 40)) console.log(JSON.stringify(r));
