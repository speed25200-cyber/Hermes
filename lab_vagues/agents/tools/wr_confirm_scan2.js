// Balayage fin (grille un peu plus large mais toujours GROSSIÈRE) sur les modules qui n'ont
// pas encore franchi wr>=65% des DEUX côtés au 1er passage (wr_confirm_scan.js).
const path = require("path");
const fs = require("fs");
const { chargerCandles, evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));
const { modules: run5mods } = require(path.join(__dirname, "hermes15_modules.js"));

const CAND = path.join(__dirname, "..", "candidates");
const ROSTER = [
  { nom: "ENSO", file: "multiech_2.js" },
  { nom: "GPS", file: "gen_regime_3.js" },
  { nom: "SOON", file: "gen_keltner_2.js" },
  { nom: "O", file: "ti_arsenal_2.js" },
  { nom: "GRASS", file: "champions_2.js" },
];
const RUN5 = ["MANA", "LUNA", "MEGA"];

function loadMod(entry) { return entry.file ? require(path.join(CAND, entry.file)) : run5mods[entry.nom]; }

function rollingMedian(vals, win) {
  const n = vals.length, out = new Array(n).fill(null);
  const w = [];
  function insert(v) { let lo = 0, hi = w.length; while (lo < hi) { const m = (lo + hi) >> 1; if (w[m] < v) lo = m + 1; else hi = m; } w.splice(lo, 0, v); }
  function remove(v) { let lo = 0, hi = w.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (w[m] === v) { w.splice(m, 1); return; } if (w[m] < v) lo = m + 1; else hi = m - 1; } }
  for (let i = 0; i < n; i++) { insert(vals[i]); if (w.length > win) remove(vals[i - win]); if (i >= win - 1) { const m = w.length >> 1; out[i] = w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2; } }
  return out;
}
function confClose(c5, sigs) { return sigs.filter(s => { const o = c5[s.i5][1], c = c5[s.i5][4]; return s.dir === 1 ? c > o : c < o; }); }
function confVolume(c5, sigs, mult) {
  const vol = c5.map(x => x[5]); const med = rollingMedian(vol, 288);
  return sigs.filter(s => med[s.i5] != null && med[s.i5] > 0 && vol[s.i5] >= mult * med[s.i5]);
}
function confWick(c5, sigs, frac) {
  return sigs.filter(s => {
    const o = c5[s.i5][1], h = c5[s.i5][2], l = c5[s.i5][3], c = c5[s.i5][4], range = h - l;
    if (!(range > 0)) return false;
    return s.dir === 1 ? (Math.min(o, c) - l) / range >= frac : (h - Math.max(o, c)) / range >= frac;
  });
}
function confDelay(c5, sigs) {
  const out = [];
  for (const s of sigs) { const j = s.i5 + 1; if (j >= c5.length - 2) continue; const o = c5[j][1], c = c5[j][4]; if (s.dir === 1 ? c > o : c < o) out.push({ i5: j, dir: s.dir }); }
  return out;
}
function evalSigs(mod, c5, sigs) {
  const fake = { instId: mod.instId, exits: mod.exits, detect: () => sigs };
  const r = evaluer(fake, c5);
  if (!r.A || !r.B) return null;
  return { espIS: r.A.esp, espOOS: r.B.esp, wrIS: r.A.wr, wrOOS: r.B.wr, nIS: r.A.n, nOOS: r.B.n, pfOOS: r.B.pf };
}

const out = [];
for (const entry of ROSTER.concat(RUN5.map(n => ({ nom: n })))) {
  const mod = loadMod(entry);
  const c5 = chargerCandles("data", mod.instId);
  const raw = (mod.detect(c5) || []).sort((a, b) => a.i5 - b.i5);
  const base = evalSigs(mod, c5, raw);
  if (!base) continue;

  const variants = [];
  for (const mult of [1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4])
    variants.push({ tag: "vol" + mult, sigs: confVolume(c5, raw, mult) });
  for (const frac of [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55])
    variants.push({ tag: "wick" + frac, sigs: confWick(c5, raw, frac) });
  const delaySigs = confDelay(c5, raw);
  variants.push({ tag: "delay", sigs: delaySigs });
  const closeSigs = confClose(c5, raw);
  variants.push({ tag: "close", sigs: closeSigs });
  for (const mult of [1.5, 2, 2.5, 3]) {
    variants.push({ tag: "delay+vol" + mult, sigs: confVolume(c5, delaySigs, mult) });
    variants.push({ tag: "close+vol" + mult, sigs: confVolume(c5, closeSigs, mult) });
  }
  for (const frac of [0.3, 0.4]) {
    variants.push({ tag: "delay+wick" + frac, sigs: confWick(c5, delaySigs, frac) });
    variants.push({ tag: "vol2+wick" + frac, sigs: confWick(c5, confVolume(c5, raw, 2), frac) });
  }

  for (const v of variants) {
    const r = evalSigs(mod, c5, v.sigs);
    if (!r) continue;
    const okWr = r.wrIS >= 65 && r.wrOOS >= 65;
    const okEsp = r.espIS > 0 && r.espOOS > 0 && r.espIS >= 0.6 * base.espIS && r.espOOS >= 0.6 * base.espOOS;
    if (okWr && okEsp) {
      out.push({ nom: entry.nom, tag: v.tag, ...r, baseEspIS: base.espIS, baseEspOOS: base.espOOS, baseWrIS: base.wrIS, baseWrOOS: base.wrOOS, nTotal: r.nIS + r.nOOS });
    }
  }
}

out.sort((a, b) => (a.nom > b.nom ? 1 : -1) || b.nTotal - a.nTotal);
fs.writeFileSync(path.join(__dirname, "rapports", "wr_confirm_scan2_hits.json"), JSON.stringify(out, null, 1));
console.log("HITS (wr>=65 les deux côtés + esp>0 + esp>=60% baseline) :", out.length);
for (const r of out) {
  console.log(r.nom.padEnd(8), r.tag.padEnd(16),
    "wr", r.wrIS + "/" + r.wrOOS, " esp", r.espIS + "/" + r.espOOS,
    " base", r.baseWrIS + "/" + r.baseWrOOS, "esp", r.baseEspIS + "/" + r.baseEspOOS,
    " n", r.nIS + "+" + r.nOOS);
}
