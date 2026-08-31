// CHANTIER 4H — passe 2 : le 4h comme FILTRE DE RÉGIME sur déclencheurs 5m fréquents.
// Constat passe 1 : signaux 4h/1d purs trop rares (meilleur 4h : n=41/7/5 sur 90 j) pour
// n30>=60. Ici : déclencheur 5m (RSI extrême / mèche+vol / z-score) gardé par l'étirement
// du timeframe supérieur (z-score 4h vs SMA20-4h), même signe (marché AUSSI étiré en 4h).
// Comparaison demandée : même filtre calculé en 1h / 4h / 1d + baseline nue.
// Exits fondateurs (pas de balayage) : E1 tp80/act30/hold12 · E2 tp80/act30/hold24.
const fs = require("fs");
const path = require("path");
const { sim, agg } = require("../harness_lib.js");

const D90 = path.join(__dirname, "..", "..", "data90");
const BLOCK = new Set(["CBRS-USDT-SWAP"]);
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
};
const MS = { "1h": 3600e3, "4h": 4 * 3600e3, "1d": 24 * 3600e3 };

function aggreger(c5, ms) {
  const out = []; let cur = null;
  for (let i = 0; i < c5.length; i++) {
    const b = Math.floor(c5[i][0] / ms);
    if (!cur || b !== cur.b) { if (cur) out.push(cur); cur = { b, o: c5[i][1], h: c5[i][2], l: c5[i][3], c: c5[i][4], last: i }; }
    else { if (c5[i][2] > cur.h) cur.h = c5[i][2]; if (c5[i][3] < cur.l) cur.l = c5[i][3]; cur.c = c5[i][4]; cur.last = i; }
  }
  return out;
}
function mapCloses(c5, A, ms) {
  const m = new Array(c5.length).fill(-1); let k = 0;
  for (let i = 0; i < c5.length; i++) {
    const b = Math.floor(c5[i][0] / ms);
    while (k < A.length && A[k].b < b) k++;
    m[i] = k - 1;
  }
  return m;
}
function rsiWilder(closes, p) {
  const r = new Array(closes.length).fill(null); let g = 0, pr = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (i <= p) { if (d > 0) g += d; else pr -= d; if (i === p) r[i] = 100 - 100 / (1 + (g / p) / ((pr / p) || 1e-12)); continue; }
    g = (g * (p - 1) + Math.max(d, 0)) / p; pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
    r[i] = 100 - 100 / (1 + g / (pr || 1e-12));
  }
  return r;
}
function zScore(closes, N) {
  const z = new Array(closes.length).fill(null); let s = 0, s2 = 0;
  for (let i = 0; i < closes.length; i++) {
    s += closes[i]; s2 += closes[i] * closes[i];
    if (i >= N) { const o = closes[i - N]; s -= o; s2 -= o * o; }
    if (i >= N - 1) { const m = s / N, v = Math.max(s2 / N - m * m, 1e-18); z[i] = (closes[i] - m) / Math.sqrt(v); }
  }
  return z;
}

// déclencheurs 5m -> tableau de {i5,dir} candidats (avant filtre TF)
function trigRsi5(c5, rsi5, th) {
  const out = [];
  for (let i = 300; i < c5.length; i++) {
    if (rsi5[i] == null) continue;
    if (rsi5[i] < th) out.push({ i5: i, dir: 1 });
    else if (rsi5[i] > 100 - th) out.push({ i5: i, dir: -1 });
  }
  return out;
}
function trigMeche(c5, frac, volX) {
  const out = []; const V = 20; let sv = 0;
  const vols = c5.map(x => x[5] || 0);
  for (let i = 0; i < c5.length; i++) {
    sv += vols[i]; if (i >= V) sv -= vols[i - V];
    if (i < 300) continue;
    const smaV = sv / V; // moyenne des V dernières Y COMPRIS la bougie i ? Non : recalcule sans i
    const smaPrev = (sv - vols[i]) / (V - 1);
    const rg = c5[i][2] - c5[i][3]; if (rg <= 0) continue;
    if (!(vols[i] >= volX * smaPrev)) continue;
    const wLo = Math.min(c5[i][1], c5[i][4]) - c5[i][3], wHi = c5[i][2] - Math.max(c5[i][1], c5[i][4]);
    if (wLo / rg >= frac) out.push({ i5: i, dir: 1 });
    else if (wHi / rg >= frac) out.push({ i5: i, dir: -1 });
  }
  return out;
}
function trigZ5(c5, N, th) {
  const z = zScore(c5.map(x => x[4]), N), out = [];
  for (let i = 300; i < c5.length; i++) {
    if (z[i] == null) continue;
    if (z[i] <= -th) out.push({ i5: i, dir: 1 });
    else if (z[i] >= th) out.push({ i5: i, dir: -1 });
  }
  return out;
}

function evalTriple(c5, sigs, exits) {
  const lastTs = c5[c5.length - 1][0];
  const coup60 = lastTs - 30 * 86400e3, tOOS = lastTs - 10 * 86400e3;
  const w60 = [], is = [], oos = []; let busy = -1;
  for (const s of sigs.sort((a, b) => a.i5 - b.i5)) {
    if (s.i5 <= busy || s.i5 >= c5.length - 2 || !s.dir) continue;
    const t = sim(c5, s.i5, s.dir, exits);
    busy = s.i5 + t.dur;
    const ts = c5[s.i5][0];
    if (ts < coup60) w60.push(t); else if (ts >= tOOS) oos.push(t); else is.push(t);
  }
  return { W: agg(w60), A: agg(is), B: agg(oos) };
}

const insts = fs.readdirSync(D90).filter(f => f.endsWith(".json")).map(f => f.replace(".json", "")).filter(x => !BLOCK.has(x));
const rows = [];
for (const inst of insts) {
  const c5 = JSON.parse(fs.readFileSync(path.join(D90, inst + ".json")));
  if (c5.length < 20000) continue;
  const rsi5 = rsiWilder(c5.map(x => x[4]), 14);
  // filtres TF : z-score N20 du TF + RSI14 du TF
  const F = {};
  for (const [tf, ms] of Object.entries(MS)) {
    const A = aggreger(c5, ms);
    F[tf] = { map: mapCloses(c5, A, ms), z: zScore(A.map(x => x.c), 20), r: rsiWilder(A.map(x => x.c), 14) };
  }
  const triggers = {
    "rsi25": trigRsi5(c5, rsi5, 25),
    "rsi30": trigRsi5(c5, rsi5, 30),
    "meche60v15": trigMeche(c5, 0.6, 1.5),
    "z48t25": trigZ5(c5, 48, 2.5),
  };
  const filtres = [["nu", null, 0, "nu"]];
  for (const tf of ["1h", "4h", "1d"]) {
    for (const th of [0.5, 1, 1.5]) filtres.push([`${tf}_z${th}`, tf, th, "z"]);       // z TF aligné (étiré même sens)
    filtres.push([`${tf}_zc1`, tf, 1, "zc"]);                                          // contra (pullback) — documentation
    for (const th of [40, 35]) filtres.push([`${tf}_r${th}`, tf, th, "r"]);            // RSI TF <=40/35 pour longs
  }
  for (const [tname, sigs0] of Object.entries(triggers)) {
    for (const [fname, tf, th, kind] of filtres) {
      let sigs;
      if (kind === "nu") sigs = sigs0;
      else {
        const { map, z, r } = F[tf];
        sigs = sigs0.filter(s => {
          const k = map[s.i5]; if (k < 21) return false;
          if (kind === "z") return s.dir > 0 ? z[k] != null && z[k] <= -th : z[k] != null && z[k] >= th;
          if (kind === "zc") return s.dir > 0 ? z[k] != null && z[k] >= th : z[k] != null && z[k] <= -th;
          if (kind === "r") return s.dir > 0 ? r[k] != null && r[k] <= th : r[k] != null && r[k] >= 100 - th;
          return false;
        });
      }
      if (!sigs.length) continue;
      for (const [ex, exits] of Object.entries(EXITS)) {
        const rr = evalTriple(c5, sigs.map(s => ({ ...s })), exits);
        const esp60 = rr.W?.esp ?? null, espIS = rr.A?.esp ?? null, espOOS = rr.B?.esp ?? null;
        const worst3 = (esp60 != null && espIS != null && espOOS != null) ? Math.min(esp60, espIS, espOOS) : null;
        rows.push({ inst, trig: tname, filtre: fname, ex, n60: rr.W?.n ?? 0, esp60, nIS: rr.A?.n ?? 0, espIS, nOOS: rr.B?.n ?? 0, espOOS, pfOOS: rr.B?.pf ?? null, worst3 });
      }
    }
  }
  process.stderr.write(inst + " ");
}
process.stderr.write("\n");
const OUT = path.join(__dirname, "rapports", "tf4h_scan2.json");
fs.writeFileSync(OUT, JSON.stringify(rows));

// comparaison agrégée du MÊME filtre selon le TF (delta médian de worst3 vs nu, lignes appariées)
const cle = r => `${r.inst}|${r.trig}|${r.ex}`;
const nus = new Map(rows.filter(r => r.filtre === "nu").map(r => [cle(r), r]));
console.log("=== Delta worst3 vs nu (médiane sur lignes appariées à triple fenêtre) ===");
const groupes = {};
for (const r of rows) {
  if (r.filtre === "nu" || r.worst3 == null) continue;
  const b = nus.get(cle(r)); if (!b || b.worst3 == null) continue;
  (groupes[r.filtre] = groupes[r.filtre] || []).push(r.worst3 - b.worst3);
}
for (const [f, l] of Object.entries(groupes).sort()) {
  l.sort((a, b) => a - b);
  const med = l[Math.floor(l.length / 2)];
  const pos = l.filter(x => x > 0).length;
  console.log(`${f.padEnd(10)} n=${String(l.length).padStart(3)} · delta médian ${med.toFixed(2).padStart(6)} · % améliorés ${(100 * pos / l.length).toFixed(0)} %`);
}
console.log("\n=== Lignes valide-30j (nIS+nOOS>=60, nOOS>=15, espIS/espOOS/esp60>0) par worst3 ===");
const v = rows.filter(r => (r.nIS + r.nOOS) >= 60 && r.nOOS >= 15 && r.espIS > 0 && r.espOOS > 0 && r.esp60 > 0)
  .sort((a, b) => b.worst3 - a.worst3);
for (const r of v.slice(0, 40)) console.log(JSON.stringify(r));
console.log("total valides:", v.length);
