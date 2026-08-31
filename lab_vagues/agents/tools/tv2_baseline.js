// Baseline : pour chaque instId déjà présent dans candidates/, calcule le "worst" (comme test_harness.js)
// afin de respecter la règle 1 STRAT/CRYPTO (ne proposer que si on bat l'existant).
const fs = require("fs");
const path = require("path");
const AG = "C:/Users/Administrator/Desktop/HERMES_V4_LIVE/lab_vagues/agents";
const { chargerCandles, evaluer } = require(path.join(AG, "harness_lib.js"));

const CAND_DIR = path.join(AG, "candidates");
const files = fs.readdirSync(CAND_DIR).filter(f => f.endsWith(".js"));
const map = {}; // instId -> {worst, module}
for (const f of files) {
  let mod;
  try { mod = require(path.join(CAND_DIR, f)); } catch (e) { console.error("SKIP (require fail)", f, e.message); continue; }
  if (!mod || !mod.instId || typeof mod.detect !== "function") continue;
  let c5;
  try { c5 = chargerCandles("data", mod.instId); } catch (e) { continue; }
  let r;
  try { r = evaluer(mod, c5); } catch (e) { console.error("SKIP (eval fail)", f, e.message); continue; }
  if (!r.A || !r.B) continue;
  const worst = Math.min(r.A.esp, r.B.esp);
  if (!map[mod.instId] || worst > map[mod.instId].worst) {
    map[mod.instId] = { worst: +worst.toFixed(2), module: f };
  }
}
fs.writeFileSync(path.join(__dirname, "tv2_baseline_resultats.json"), JSON.stringify(map, null, 1));
console.log(JSON.stringify({ cryptos_avec_champion: Object.keys(map).length }, null, 1));
