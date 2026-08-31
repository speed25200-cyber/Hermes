// Chantier WINRATE — levier prix d'entrée (retracement). Grille grossière sur les 13 stratégies LIVE.
// Pour chaque stratégie : baseline (entrée au close, harness_lib officiel) vs grille retr x window
// (simulateur honnête wr_retrace_lib.js — ordre limite, annulé si non touché).
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));
const { evaluerRetrace } = require("./wr_retrace_lib.js");
const { ROSTER } = require("./wr_retrace_bases.js");

const RETRS = [0.002, 0.003, 0.005]; // -0,2 / -0,3 / -0,5 % du close
const WINDOWS = [3, 4, 5, 6];        // bougies 5m pour que le limite soit touché

function valide(A, B) {
  return !!(A && B && A.esp > 0 && B.esp > 0 && (A.n + B.n) >= 60 && B.n >= 15);
}

const report = [];
for (const entry of ROSTER) {
  const { tag, src, mod } = entry;
  let c5;
  try { c5 = chargerCandles("data", mod.instId); }
  catch (e) { report.push({ tag, instId: mod.instId, erreur: "data manquante: " + e.message }); continue; }

  const base = evaluer(mod, c5);
  const baseRow = {
    tag, instId: mod.instId, src,
    baseline: {
      wrIS: base.A?.wr ?? null, wrOOS: base.B?.wr ?? null,
      espIS: base.A?.esp ?? null, espOOS: base.B?.esp ?? null,
      nIS: base.A?.n ?? 0, nOOS: base.B?.n ?? 0,
      worst: (base.A && base.B) ? Math.min(base.A.esp, base.B.esp) : null,
      valide: valide(base.A, base.B)
    },
    grille: []
  };

  const baseEspIS = base.A?.esp ?? null, baseEspOOS = base.B?.esp ?? null;

  for (const retr of RETRS) {
    for (const w of WINDOWS) {
      const r = evaluerRetrace(mod, c5, retr, w);
      const A = r.A, B = r.B;
      const ok = !!(A && B && A.esp > 0 && B.esp > 0 && (A.n + B.n) >= 40 && B.n >= 10 &&
                    A.wr >= 65 && B.wr >= 65 &&
                    baseEspIS != null && baseEspOOS != null && baseEspIS > 0 && baseEspOOS > 0 &&
                    A.esp >= 0.6 * baseEspIS && B.esp >= 0.6 * baseEspOOS);
      baseRow.grille.push({
        retr, w,
        wrIS: A?.wr ?? null, wrOOS: B?.wr ?? null,
        espIS: A?.esp ?? null, espOOS: B?.esp ?? null,
        nIS: A?.n ?? 0, nOOS: B?.n ?? 0,
        nSig: r.nSig, nFill: r.nFill,
        tauxRemplissage: r.nSig ? +(100 * r.nFill / r.nSig).toFixed(1) : null,
        succes: ok
      });
    }
  }
  report.push(baseRow);
}

fs.writeFileSync(path.join(__dirname, "rapports", "wr_retrace_scan_resultats.json"), JSON.stringify(report, null, 1));

// Résumé lisible
for (const row of report) {
  if (row.erreur) { console.log(`${row.tag} (${row.instId}) : ${row.erreur}`); continue; }
  const b = row.baseline;
  console.log(`\n=== ${row.tag} (${row.instId}) — ${row.src} ===`);
  console.log(`  baseline: wrIS=${b.wrIS} wrOOS=${b.wrOOS} espIS=${b.espIS} espOOS=${b.espOOS} n=${b.nIS}+${b.nOOS} valide=${b.valide}`);
  const succes = row.grille.filter(g => g.succes);
  const cand = row.grille.filter(g => g.wrIS >= 65 && g.wrOOS >= 65 && g.espIS > 0 && g.espOOS > 0);
  console.log(`  grille: ${row.grille.length} cases, ${cand.length} avec wr>=65/65 & esp>0/0, ${succes.length} SUCCES complet (+ esp>=60% baseline)`);
  for (const g of row.grille) {
    const tag = g.succes ? " <== SUCCES" : (g.wrIS >= 65 && g.wrOOS >= 65 && g.espIS > 0 && g.espOOS > 0 ? " (wr ok, esp trop bas)" : "");
    console.log(`    retr=${(g.retr*100).toFixed(1)}% w=${g.w}: wrIS=${g.wrIS} wrOOS=${g.wrOOS} espIS=${g.espIS} espOOS=${g.espOOS} n=${g.nIS}+${g.nOOS} remplissage=${g.tauxRemplissage}%${tag}`);
  }
}
