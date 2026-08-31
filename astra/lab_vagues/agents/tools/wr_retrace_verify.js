// Vérificateur pour les candidats wr_retrace_*.js (levier retracement d'entrée).
// ⚠️ N'utilise PAS test_harness.js : le harness standard entre TOUJOURS au close de la bougie de
// signal (harness_lib.sim), il ne peut pas exprimer un ordre limite à un prix différent. Ce script
// réutilise le même detect() que le candidat mais simule l'entrée via wr_retrace_lib.evaluerRetrace
// (limite -retrace.pct du close, annulé si non touché en retrace.window bougies) — mêmes coûts/pire
// cas/IS20-OOS10/blocage symbole que le banc officiel, seule l'entrée diffère.
// Usage : node tools/wr_retrace_verify.js candidates/wr_retrace_1.js
const path = require("path");
const { chargerCandles } = require("../harness_lib.js");
const { evaluerRetrace } = require("./wr_retrace_lib.js");

const modPath = process.argv[2];
if (!modPath) { console.error("usage: node tools/wr_retrace_verify.js <candidates/xxx.js>"); process.exit(1); }
const mod = require(path.resolve(__dirname, "..", modPath));
if (!mod.retrace) { console.error("module sans champ `retrace: {pct, window}`"); process.exit(1); }

const c5 = chargerCandles("data", mod.instId);
const r = evaluerRetrace(mod, c5, mod.retrace.pct, mod.retrace.window);
const out = {
  instId: mod.instId, retrace: mod.retrace,
  espIS: r.A?.esp ?? null, espOOS: r.B?.esp ?? null,
  wrIS: r.A?.wr ?? null, wrOOS: r.B?.wr ?? null,
  nIS: r.A?.n ?? 0, nOOS: r.B?.n ?? 0,
  pfOOS: r.B?.pf ?? null,
  nSig: r.nSig, nFill: r.nFill, tauxRemplissage: r.nSig ? +(100 * r.nFill / r.nSig).toFixed(1) : null,
  worst: (r.A && r.B) ? Math.min(r.A.esp, r.B.esp) : null,
  valide: !!(r.A && r.B && r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 40 && r.B.n >= 10),
  wr_ok: !!(r.A && r.B && r.A.wr >= 65 && r.B.wr >= 65)
};
console.log(JSON.stringify(out, null, 1));
