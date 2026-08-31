// LEVIER CONFIRMATION : ajoute UNE confirmation à chaque signal du roster LIVE (13 modules)
// et compare TOUJOURS au signal nu. Filtres testés : bougie de reprise (même bougie, close du
// bon côté) · volume >= mult x médiane 24h (288 barres, rolling causal) · mèche de rejet
// (fraction du range) · confirmation décalée (2e bougie qui confirme, entrée décalée d'1 bougie).
// Usage : node tools/wr_confirm_scan.js
const path = require("path");
const fs = require("fs");
const { chargerCandles, evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));
const { modules: run5mods } = require(path.join(__dirname, "hermes15_modules.js"));

const CAND = path.join(__dirname, "..", "candidates");

// ---- les 13 modules LIVE du roster ----
const ROSTER = [
  { nom: "PIEVERSE", file: "web_structure_1.js" },
  { nom: "ENSO", file: "multiech_2.js" },
  { nom: "GPS", file: "gen_regime_3.js" },
  { nom: "SOON", file: "gen_keltner_2.js" },
  { nom: "O", file: "ti_arsenal_2.js" },
  { nom: "ACT", file: "x4_reliquat_1.js" },
  { nom: "POPCAT", file: "mixA_2.js" },
  { nom: "LIT", file: "mixB_3.js" },
  { nom: "GRASS", file: "champions_2.js" },
];
const RUN5 = ["AXS", "MANA", "LUNA", "MEGA"];

function loadMod(entry) {
  if (entry.file) return require(path.join(CAND, entry.file));
  return run5mods[entry.nom];
}

// ---- médiane roulante causale (fenêtre 288 = 24h), incluant la bougie courante ----
function rollingMedian(vals, win) {
  const n = vals.length, out = new Array(n).fill(null);
  const w = [];
  function insert(v) { let lo = 0, hi = w.length; while (lo < hi) { const m = (lo + hi) >> 1; if (w[m] < v) lo = m + 1; else hi = m; } w.splice(lo, 0, v); }
  function remove(v) { let lo = 0, hi = w.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (w[m] === v) { w.splice(m, 1); return; } if (w[m] < v) lo = m + 1; else hi = m - 1; } }
  for (let i = 0; i < n; i++) {
    insert(vals[i]);
    if (w.length > win) remove(vals[i - win]);
    if (i >= win - 1) { const m = w.length >> 1; out[i] = w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2; }
  }
  return out;
}

// ---- 4 familles de confirmation, chacune retourne une liste filtrée (i5 peut être décalé) ----
function confClose(c5, sigs) {
  return sigs.filter(s => { const o = c5[s.i5][1], c = c5[s.i5][4]; return s.dir === 1 ? c > o : c < o; });
}
function confVolume(c5, sigs, mult) {
  const vol = c5.map(x => x[5]);
  const med = rollingMedian(vol, 288);
  return sigs.filter(s => med[s.i5] != null && med[s.i5] > 0 && vol[s.i5] >= mult * med[s.i5]);
}
function confWick(c5, sigs, frac) {
  return sigs.filter(s => {
    const o = c5[s.i5][1], h = c5[s.i5][2], l = c5[s.i5][3], c = c5[s.i5][4], range = h - l;
    if (!(range > 0)) return false;
    if (s.dir === 1) return (Math.min(o, c) - l) / range >= frac;
    return (h - Math.max(o, c)) / range >= frac;
  });
}
function confDelay(c5, sigs) {
  const out = [];
  for (const s of sigs) {
    const j = s.i5 + 1;
    if (j >= c5.length - 2) continue;
    const o = c5[j][1], c = c5[j][4];
    if (s.dir === 1 ? c > o : c < o) out.push({ i5: j, dir: s.dir });
  }
  return out;
}

function evalSigs(mod, c5, sigs) {
  const fake = { instId: mod.instId, exits: mod.exits, detect: () => sigs };
  const r = evaluer(fake, c5);
  if (!r.A || !r.B) return null;
  return {
    espIS: r.A.esp, espOOS: r.B.esp, wrIS: r.A.wr, wrOOS: r.B.wr,
    nIS: r.A.n, nOOS: r.B.n, pfOOS: r.B.pf,
    worst: Math.min(r.A.esp, r.B.esp),
  };
}

const results = [];
for (const entry of ROSTER.concat(RUN5.map(n => ({ nom: n })))) {
  const mod = loadMod(entry);
  const c5 = chargerCandles("data", mod.instId);
  const raw = (mod.detect(c5) || []).sort((a, b) => a.i5 - b.i5);
  const base = evalSigs(mod, c5, raw);
  if (!base) { console.log(entry.nom, "BASE INVALIDE"); continue; }

  const variants = [];
  variants.push({ tag: "nu", sigs: raw });
  variants.push({ tag: "close", sigs: confClose(c5, raw) });
  for (const mult of [2, 2.5, 3]) variants.push({ tag: "vol" + mult, sigs: confVolume(c5, raw, mult) });
  for (const frac of [0.3, 0.4, 0.5]) variants.push({ tag: "wick" + frac, sigs: confWick(c5, raw, frac) });
  variants.push({ tag: "delay", sigs: confDelay(c5, raw) });
  // combos utiles
  variants.push({ tag: "close+vol2", sigs: confVolume(c5, confClose(c5, raw), 2) });
  variants.push({ tag: "delay+vol2", sigs: confVolume(c5, confDelay(c5, raw), 2) });
  variants.push({ tag: "close+wick0.3", sigs: confWick(c5, confClose(c5, raw), 0.3) });

  for (const v of variants) {
    if (v.tag === "nu") { results.push({ nom: entry.nom, tag: v.tag, ...base, nRaw: raw.length }); continue; }
    const r = evalSigs(mod, c5, v.sigs);
    if (!r) { results.push({ nom: entry.nom, tag: v.tag, invalide: true, nRaw: v.sigs.length }); continue; }
    results.push({ nom: entry.nom, tag: v.tag, ...r, nRaw: v.sigs.length, baseEspIS: base.espIS, baseEspOOS: base.espOOS, baseWrIS: base.wrIS, baseWrOOS: base.wrOOS });
  }
}

fs.writeFileSync(path.join(__dirname, "rapports", "wr_confirm_scan.json"), JSON.stringify(results, null, 1));

// affichage : pour chaque nom, la baseline puis les variantes triées par wrOOS+wrIS décroissant
console.log("nom".padEnd(9), "tag".padEnd(14), "wrIS".padStart(6), "wrOOS".padStart(6), "espIS".padStart(7), "espOOS".padStart(7), "nIS".padStart(5), "nOOS".padStart(5));
let curNom = null;
for (const r of results) {
  if (r.nom !== curNom) { console.log("---"); curNom = r.nom; }
  if (r.invalide) { console.log(r.nom.padEnd(9), r.tag.padEnd(14), "INVALIDE n=" + r.nRaw); continue; }
  console.log(
    r.nom.padEnd(9), r.tag.padEnd(14),
    String(r.wrIS).padStart(6), String(r.wrOOS).padStart(6),
    String(r.espIS).padStart(7), String(r.espOOS).padStart(7),
    String(r.nIS).padStart(5), String(r.nOOS).padStart(5)
  );
}
