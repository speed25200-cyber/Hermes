// 3e passe, plus dense, ciblée sur GRASS/O/SOON/ENSO/GPS (proches du seuil en passe 1-2).
const path = require("path");
const fs = require("fs");
const { chargerCandles, evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));
const CAND = path.join(__dirname, "..", "candidates");
const ROSTER = [
  { nom: "GRASS", file: "champions_2.js" },
  { nom: "O", file: "ti_arsenal_2.js" },
  { nom: "SOON", file: "gen_keltner_2.js" },
];

function loadMod(entry) { return require(path.join(CAND, entry.file)); }
function rollingMedian(vals, win) {
  const n = vals.length, out = new Array(n).fill(null);
  const w = [];
  function insert(v) { let lo = 0, hi = w.length; while (lo < hi) { const m = (lo + hi) >> 1; if (w[m] < v) lo = m + 1; else hi = m; } w.splice(lo, 0, v); }
  function remove(v) { let lo = 0, hi = w.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (w[m] === v) { w.splice(m, 1); return; } if (w[m] < v) lo = m + 1; else hi = m - 1; } }
  for (let i = 0; i < n; i++) { insert(vals[i]); if (w.length > win) remove(vals[i - win]); if (i >= win - 1) { const m = w.length >> 1; out[i] = w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2; } }
  return out;
}
function confClose(c5, sigs) { return sigs.filter(s => { const o = c5[s.i5][1], c = c5[s.i5][4]; return s.dir === 1 ? c > o : c < o; }); }
function confVolume(c5, sigs, mult) { const vol = c5.map(x => x[5]); const med = rollingMedian(vol, 288); return sigs.filter(s => med[s.i5] != null && med[s.i5] > 0 && vol[s.i5] >= mult * med[s.i5]); }
function confWick(c5, sigs, frac) {
  return sigs.filter(s => { const o = c5[s.i5][1], h = c5[s.i5][2], l = c5[s.i5][3], c = c5[s.i5][4], range = h - l; if (!(range > 0)) return false; return s.dir === 1 ? (Math.min(o, c) - l) / range >= frac : (h - Math.max(o, c)) / range >= frac; });
}
function evalSigs(mod, c5, sigs) { const fake = { instId: mod.instId, exits: mod.exits, detect: () => sigs }; const r = evaluer(fake, c5); if (!r.A || !r.B) return null; return { espIS: r.A.esp, espOOS: r.B.esp, wrIS: r.A.wr, wrOOS: r.B.wr, nIS: r.A.n, nOOS: r.B.n }; }

const out = [];
for (const entry of ROSTER) {
  const mod = loadMod(entry);
  const c5 = chargerCandles("data", mod.instId);
  const raw = (mod.detect(c5) || []).sort((a, b) => a.i5 - b.i5);
  const base = evalSigs(mod, c5, raw);
  const closeSigs = confClose(c5, raw);
  const variants = [];
  for (let mult = 1.5; mult <= 4; mult += 0.25) variants.push({ tag: "close+vol" + mult, sigs: confVolume(c5, closeSigs, mult) });
  for (let frac = 0.15; frac <= 0.5; frac += 0.05) variants.push({ tag: "close+wick" + frac.toFixed(2), sigs: confWick(c5, closeSigs, frac) });
  for (let mult = 1.5; mult <= 4; mult += 0.25) for (let frac = 0.15; frac <= 0.4; frac += 0.1)
    variants.push({ tag: "vol" + mult + "+wick" + frac.toFixed(2), sigs: confWick(c5, confVolume(c5, raw, mult), frac) });

  for (const v of variants) {
    const r = evalSigs(mod, c5, v.sigs);
    if (!r) continue;
    const okWr = r.wrIS >= 65 && r.wrOOS >= 65;
    const okEsp = r.espIS > 0 && r.espOOS > 0 && r.espIS >= 0.6 * base.espIS && r.espOOS >= 0.6 * base.espOOS;
    if (okWr && okEsp) out.push({ nom: entry.nom, tag: v.tag, ...r, nTotal: r.nIS + r.nOOS, baseEspIS: base.espIS, baseEspOOS: base.espOOS, baseWrIS: base.wrIS, baseWrOOS: base.wrOOS });
  }
}
out.sort((a, b) => (a.nom > b.nom ? 1 : -1) || b.nTotal - a.nTotal);
console.log("HITS:", out.length);
for (const r of out) console.log(r.nom.padEnd(7), r.tag.padEnd(20), "wr", r.wrIS + "/" + r.wrOOS, "esp", r.espIS + "/" + r.espOOS, "base", r.baseWrIS + "/" + r.baseWrOOS, r.baseEspIS + "/" + r.baseEspOOS, "n", r.nIS + "+" + r.nOOS);
