// Évalue un module candidat sur les 30 jours de data/ (IS 20 j / OOS 10 j).
// Usage : node test_harness.js candidates/mon_idee.js
const path = require("path");
const { chargerCandles, evaluer } = require("./harness_lib.js");

const modPath = process.argv[2];
if (!modPath) { console.error("usage: node test_harness.js <module.js>"); process.exit(1); }
const mod = require(path.resolve(__dirname, modPath));
const c5 = chargerCandles("data", mod.instId);
const r = evaluer(mod, c5);
const out = {
  instId: mod.instId,
  espIS: r.A?.esp ?? null, espOOS: r.B?.esp ?? null,
  wrIS: r.A?.wr ?? null, wrOOS: r.B?.wr ?? null,
  nIS: r.A?.n ?? 0, nOOS: r.B?.n ?? 0,
  pfOOS: r.B?.pf ?? null,
  worst: (r.A && r.B) ? Math.min(r.A.esp, r.B.esp) : null,
  valide: !!(r.A && r.B && r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15)
};
console.log(JSON.stringify(out, null, 1));
