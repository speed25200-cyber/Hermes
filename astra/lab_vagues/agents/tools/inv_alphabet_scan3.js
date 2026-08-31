// SCAN ALPHABET passe 3 — l'axe qui compte : la TAILLE et la NATURE de l'alphabet.
// A (10 lettres) = formes fines (passe 1/2) : X Y U D u d h l o z
// B (6 lettres)  = formes grossières : U D (corps>=50 % ou géante) · h l o (petit corps, tiers du range) · z
//                  -> espace k4 = 1296 mots : « jamais vu » redevient une VRAIE anomalie
// V (8 lettres)  = rythme de VOLATILITÉ : classe de range (G>=2× · g 1,3-2× · n 0,6-1,3× · q<0,6× la moy 48)
//                  × sens (maj=up/min=down) — la syntaxe du rythme, indépendante de la forme
// k {3,4,5} × rare {0,1} × P {0.2,0.3} × mode {any,conf} × exits E1/E2.
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require("../harness_lib.js");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};
const KS = [3, 4, 5], RARES = [0, 1], PS = [0.20, 0.30], MODES = ["any", "conf"];
const MINH = 1440, WPOS = 288, WR = 48;
const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY GOOGL " +
  "INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK SNXX SOXL SOXS " +
  "SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD").split(" "));

function encoderA(c5) {
  const n = c5.length, L = new Array(n).fill("z");
  let sumR = 0; const rq = [];
  for (let i = 0; i < n; i++) {
    const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4];
    const r = h - l;
    const avgR = rq.length >= WR ? sumR / rq.length : NaN;
    let let_;
    if (r <= 0) let_ = "z";
    else if (!Number.isNaN(avgR) && r >= 2 * avgR) let_ = c >= o ? "X" : "Y";
    else {
      const b = Math.abs(c - o) / r;
      if (b >= 0.55) let_ = c >= o ? "U" : "D";
      else if (b >= 0.25) let_ = c >= o ? "u" : "d";
      else {
        const p = (c - l) / r;
        let_ = p >= 0.67 ? "h" : p <= 0.33 ? "l" : "o";
      }
    }
    L[i] = let_;
    rq.push(r); sumR += r;
    if (rq.length > WR) sumR -= rq.shift();
  }
  return L;
}

function encoderB(c5) {
  const n = c5.length, L = new Array(n).fill("z");
  for (let i = 0; i < n; i++) {
    const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4];
    const r = h - l;
    if (r <= 0) { L[i] = "z"; continue; }
    const b = Math.abs(c - o) / r;
    if (b >= 0.5) L[i] = c >= o ? "U" : "D";
    else {
      const p = (c - l) / r;
      L[i] = p >= 0.67 ? "h" : p <= 0.33 ? "l" : "o";
    }
  }
  return L;
}

function encoderV(c5) {
  const n = c5.length, L = new Array(n).fill("n");
  let sumR = 0; const rq = [];
  for (let i = 0; i < n; i++) {
    const c = c5[i][4], o = c5[i][1], r = c5[i][2] - c5[i][3];
    const avgR = rq.length >= WR ? sumR / rq.length : NaN;
    let cl;
    if (Number.isNaN(avgR) || avgR <= 0) cl = "n";
    else if (r >= 2 * avgR) cl = "g2";
    else if (r >= 1.3 * avgR) cl = "g1";
    else if (r >= 0.6 * avgR) cl = "n";
    else cl = "q";
    const up = c >= o;
    L[i] = cl === "g2" ? (up ? "G" : "Ğ") : cl === "g1" ? (up ? "g" : "ğ") : cl === "n" ? (up ? "N" : "ñ") : (up ? "Q" : "q");
    rq.push(r); sumR += r;
    if (rq.length > WR) sumR -= rq.shift();
  }
  return L;
}

function positions(c5) {
  const n = c5.length, pos = new Float64Array(n).fill(NaN);
  const qMin = [], qMax = [];
  for (let i = 0; i < n; i++) {
    while (qMin.length && c5[qMin[qMin.length - 1]][3] >= c5[i][3]) qMin.pop();
    qMin.push(i);
    while (qMax.length && c5[qMax[qMax.length - 1]][2] <= c5[i][2]) qMax.pop();
    qMax.push(i);
    const lo = i - WPOS + 1;
    while (qMin[0] < lo) qMin.shift();
    while (qMax[0] < lo) qMax.shift();
    if (i >= WPOS - 1) {
      const mn = c5[qMin[0]][3], mx = c5[qMax[0]][2];
      if (mx > mn) pos[i] = (c5[i][4] - mn) / (mx - mn);
    }
  }
  return pos;
}

function evenements(L, pos, k) {
  const n = L.length, cnt = new Map(), ev = [];
  for (let i = k - 1; i < n; i++) {
    const g = L.slice(i - k + 1, i + 1).join("|");
    const c = cnt.get(g) || 0;
    if (i >= MINH && c <= 1 && !Number.isNaN(pos[i])) ev.push({ i5: i, cnt: c, pos: pos[i] });
    cnt.set(g, c + 1);
  }
  return ev;
}

const ALPHAS = { A: encoderA, B: encoderB, V: encoderV };
const fichiers = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
const lignes = [];
for (const f of fichiers) {
  const instId = f.replace(".json", "");
  if (BLOCK.has(instId.split("-")[0])) continue;
  let c5; try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
  if (!Array.isArray(c5) || c5.length < 5000) continue;
  const pos = positions(c5);
  for (const al of Object.keys(ALPHAS)) {
    const L = ALPHAS[al](c5);
    for (const k of KS) {
      const ev = evenements(L, pos, k);
      for (const rare of RARES) for (const P of PS) for (const mode of MODES) {
        const sigs = [];
        for (const e of ev) {
          if (e.cnt > rare) continue;
          let dir = 0;
          if (e.pos <= P) dir = 1; else if (e.pos >= 1 - P) dir = -1;
          if (!dir) continue;
          const o = c5[e.i5][1], c = c5[e.i5][4];
          if (mode === "conf" && (dir > 0 ? c < o : c > o)) continue;
          sigs.push({ i5: e.i5, dir });
        }
        if (sigs.length < 30) continue;
        for (const ex of Object.keys(EXITS)) {
          const r = evaluer({ instId, exits: EXITS[ex], detect: () => sigs }, c5);
          if (!r.A || !r.B) continue;
          const valide = r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15;
          lignes.push({
            instId, al, k, rare, P, mode, ex,
            espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
            wrOOS: r.B.wr, pfOOS: r.B.pf,
            worst: Math.min(r.A.esp, r.B.esp), valide
          });
        }
      }
    }
  }
}
lignes.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "rapports", "inv_alphabet_scan3_resultats.json"), JSON.stringify(lignes, null, 1));
const valides = lignes.filter(l => l.valide);
console.log("lignes:", lignes.length, "valides:", valides.length);
for (const l of valides.slice(0, 50))
  console.log(`${l.instId} ${l.al} k${l.k} rare${l.rare} P${l.P} ${l.mode} ${l.ex} worst ${l.worst} (IS ${l.espIS}/${l.nIS} OOS ${l.espOOS}/${l.nOOS} pf ${l.pfOOS})`);
