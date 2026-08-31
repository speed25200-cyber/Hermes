// CHANTIER PERTURBATION — orchestrateur.
// 1) Classe TOUS les modules de candidates/ via test_harness.js (spawn, chiffres réels du banc 30 j)
//    → tools/rapports/robustesse_classement.json
// 2) Applique tools/perturbation.js aux 10 meilleurs (tri : valide d'abord, puis worst décroissant)
//    → tools/rapports/robustesse_<id>.json pour chacun
// 3) Synthèse (scores de robustesse + suspects <50 %) → tools/rapports/robustesse_synthese.json
// Usage : node tools/robustesse_run.js

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { perturber } = require("./perturbation.js");

const AGENTS = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "rapports");
fs.mkdirSync(OUT, { recursive: true });

// ---- 1) classement via test_harness ----
const fichiers = fs.readdirSync(path.join(AGENTS, "candidates")).filter(f => f.endsWith(".js")).sort();
const lignes = [];
for (const f of fichiers) {
  const rel = "candidates/" + f;
  try {
    const out = execFileSync(process.execPath, ["test_harness.js", rel], { cwd: AGENTS, encoding: "utf8", timeout: 180000 });
    lignes.push(Object.assign({ module: rel }, JSON.parse(out)));
  } catch (e) {
    lignes.push({ module: rel, erreur: String((e && e.message) || e).slice(0, 200) });
  }
  process.stderr.write(".");
}
process.stderr.write("\n");
lignes.sort((a, b) => {
  const va = a.valide ? 1 : 0, vb = b.valide ? 1 : 0;
  if (va !== vb) return vb - va;
  return ((b.worst != null ? b.worst : -999) - (a.worst != null ? a.worst : -999));
});
fs.writeFileSync(path.join(OUT, "robustesse_classement.json"), JSON.stringify({
  note: "Classement banc 30 j (test_harness.js) de tous les modules candidates/ ; tri = valides d'abord puis worst decroissant.",
  genere: new Date().toISOString(),
  classement: lignes,
}, null, 1));

// ---- 2) perturbation du top 10 ----
const top10 = lignes.filter(l => !l.erreur).slice(0, 10);
const synthese = [];
for (const l of top10) {
  const abs = path.join(AGENTS, l.module);
  const id = path.basename(l.module, ".js");
  process.stderr.write("perturbation " + id + " ... ");
  let rap;
  try {
    rap = perturber(abs);
  } catch (e) {
    synthese.push({ module: l.module, erreur: String((e && e.message) || e).slice(0, 300) });
    process.stderr.write("ERREUR\n");
    continue;
  }
  fs.writeFileSync(path.join(OUT, "robustesse_" + id + ".json"), JSON.stringify(rap, null, 1));
  synthese.push({
    rang: synthese.length + 1,
    module: l.module,
    instId: rap.instId,
    worst30j: l.worst,
    baselineEspAll: rap.baseline.espAll,
    nbParams: rap.parametresDetectes.length,
    nbVariantes: rap.nbVariantes,
    scoreRobustesse: rap.scoreRobustesse,
    scoreRobustesseWorst: rap.scoreRobustesseWorst,
    suspect: rap.suspect,
  });
  process.stderr.write("score " + rap.scoreRobustesse + " %\n");
}

// ---- 3) synthèse ----
const suspects = synthese.filter(s => s.suspect).map(s => s.module);
const synth = {
  note: "Robustesse aux perturbations (params numeriques ±25 %, exits ±1 cran) des 10 meilleurs modules du banc 30 j. scoreRobustesse = % de variantes a esperance globale > 0 ; <50 % = SUSPECT (artefact probable).",
  genere: new Date().toISOString(),
  top10: synthese,
  suspects,
};
fs.writeFileSync(path.join(OUT, "robustesse_synthese.json"), JSON.stringify(synth, null, 1));
console.log(JSON.stringify(synth, null, 1));
