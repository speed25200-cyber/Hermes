// TEST ACIDE 365j — VERSION UNITAIRE : rejoue UN module candidat TEL QUEL sur la fenêtre
// J-365 -> J-180 de ../data365/<instId>.json (100 % vierge, jamais utilisée en recherche).
// coupureTs = dernier ts du fichier - 180 j : harness_lib.evaluer ignore tout signal entré
// APRÈS coupureTs (mêmes règles que verif90_harness.js : levier x15, coûts 0,12 % A/R,
// SL cap -30 % marge, pire cas dans la bougie, IS/OOS 20/10 j -- sans effet ici puisque
// coupureTs relègue tous les trades gardés dans le bucket IS ; on lit r.all).
// Pas de collecte réseau : le fichier data365/<instId>.json doit déjà exister (collecte
// séparée, cf. tools/collecte180.js pour la logique équivalente).
// HISTORIQUE_INSUFFISANT si le fichier manque OU si la fenêtre J-365->J-180 (avant coupureTs)
// contient moins de 15000 bougies. SURVIT si esp > 0 et n >= 25 sur cette fenêtre.
// Usage : node tools/verif365_un.js candidates/mon_module.js
const fs = require("fs");
const path = require("path");
const { evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));

const DATA365 = path.join(__dirname, "..", "..", "data365");
const MIN_BOUGIES = 15000;
const FENETRE_EXCLUSION_J = 180;

(async () => {
  const modPath = process.argv[2];
  if (!modPath) { console.error("usage: node tools/verif365_un.js <candidates/module.js>"); process.exit(1); }
  const mod = require(path.resolve(__dirname, "..", modPath));

  const f = path.join(DATA365, mod.instId + ".json");
  if (!fs.existsSync(f)) {
    console.log(JSON.stringify({ instId: mod.instId, verdict: "HISTORIQUE_INSUFFISANT", raison: "fichier data365 absent" }, null, 1));
    return;
  }
  const c5 = JSON.parse(fs.readFileSync(f));
  if (!c5.length) {
    console.log(JSON.stringify({ instId: mod.instId, verdict: "HISTORIQUE_INSUFFISANT", bougies: 0 }, null, 1));
    return;
  }

  const coupure = c5[c5.length - 1][0] - FENETRE_EXCLUSION_J * 86400 * 1000;
  const bougiesFenetre = c5.filter(c => c[0] < coupure).length;
  if (bougiesFenetre < MIN_BOUGIES) {
    console.log(JSON.stringify({
      instId: mod.instId, bougies: c5.length, bougies_fenetre: bougiesFenetre,
      verdict: "HISTORIQUE_INSUFFISANT"
    }, null, 1));
    return;
  }

  const r = evaluer(mod, c5, { coupureTs: coupure });
  const T = r.all;   // fenêtre "vierge" -> IS/OOS n'a pas de sens, tout agrégé
  const out = {
    instId: mod.instId, bougies: c5.length, bougies_fenetre: bougiesFenetre,
    fenetre: { de: new Date(c5[0][0]).toISOString(), a: new Date(coupure).toISOString() },
    esp365: T?.esp ?? null, wr365: T?.wr ?? null, n365: T?.n ?? 0, pf365: T?.pf ?? null,
    verdict: (T && T.esp > 0 && T.n >= 25) ? "SURVIT" : "RECALE"
  };
  console.log(JSON.stringify(out, null, 1));
})();
