// sorties2_run — chantier SORTIES INNOVANTES : TP partiel + break-even + trail.
// Rejoue les 8 champions du REGISTRE sur data90 (60 j vierges, coupure = 30 derniers jours exclus)
// avec 6 schémas de sortie étendus vs la sortie actuelle (S0 = contrôle au centime).
// Usage : node tools/sorties2_run.js
const fs = require("fs");
const path = require("path");
const { chargerCandles, sim2, evaluer2, metriques } = require("./harness2.js");
const lib = require("../harness_lib.js");
const h15 = require("./hermes15_modules.js");

// Les 8 champions du registre (REGISTRE_STRATEGIES.json, lignes "champions" + maj_vague2 O).
const CHAMPIONS = [
  { nom: "PIEVERSE web_structure_1", mod: require("../candidates/web_structure_1.js"), esp60Ref: 7.98 },
  { nom: "ENSO multiech_2", mod: require("../candidates/multiech_2.js"), esp60Ref: 6.74 },
  { nom: "USELESS patterns_2", mod: require("../candidates/patterns_2.js"), esp60Ref: 3.0 },
  { nom: "SOON web_vwap_1", mod: require("../candidates/web_vwap_1.js"), esp60Ref: 1.99 },
  { nom: "GRASS champions_2", mod: require("../candidates/champions_2.js"), esp60Ref: 1.31 },
  { nom: "ENSO rsi5m (live)", mod: require("../candidates/_record_enso.js"), esp60Ref: 6.1 },
  { nom: "GRASS z48_5m (live)", mod: h15.modules.GRASS, esp60Ref: 3.09 },
  { nom: "O ti_arsenal_2", mod: require("../candidates/ti_arsenal_2.js"), esp60Ref: 4.69 }
];

// Schémas étendus (grille GROSSIÈRE, % de marge) appliqués PAR-DESSUS la sortie actuelle.
const SCHEMAS = [
  { id: "S0_actuel", plus: {} },                             // contrôle : sortie actuelle telle quelle
  { id: "P20", plus: { ptp: 0.20, pfrac: 0.5 } },      // fermer 50 % à +20 % de marge
  { id: "P40", plus: { ptp: 0.40, pfrac: 0.5 } },      // fermer 50 % à +40 %
  { id: "BE15", plus: { be: 0.15 } },                   // SL -> break-even après +15 %
  { id: "BE30", plus: { be: 0.30 } },                   // SL -> break-even après +30 %
  { id: "P20+BE20", plus: { ptp: 0.20, pfrac: 0.5, be: 0.20 } }, // classique « moitié + stop BE »
  { id: "P40+BE20", plus: { ptp: 0.40, pfrac: 0.5, be: 0.20 } }
];

const rapport = { _doc: "Chantier sorties2 : TP partiel / break-even / trail sur les 8 champions du registre, data90 60 j vierges (coupure 30 j). S0 = sortie actuelle (contrôle).", date: new Date().toISOString(), controles: [], resultats: [] };

for (const ch of CHAMPIONS) {
  const c5 = chargerCandles("data90", ch.mod.instId);
  const coupureTs = c5[c5.length - 1][0] - 30 * 86400 * 1000;
  const sigs = ch.mod.detect(c5) || [];

  // ---- CONTRÔLE 1 : sim2 sans extension == harness_lib.sim, trade par trade (bit à bit)
  const t0 = evaluer2(ch.mod, c5, { coupureTs, sigs });
  let maxDelta = 0, deltaDur = 0;
  for (const t of t0) {
    const ref = lib.sim(c5, t.i5, t.dir, ch.mod.exits);
    maxDelta = Math.max(maxDelta, Math.abs(ref.pnl - t.pnl));
    deltaDur += Math.abs(ref.dur - t.dur);
  }
  // ---- CONTRÔLE 2 : agrégat identique à harness_lib.evaluer + esp60 du registre
  const rl = lib.evaluer(ch.mod, c5, { coupureTs }).all;
  const m0 = metriques(t0);
  const ctrl = {
    nom: ch.nom, instId: ch.mod.instId, n: m0.n,
    maxDeltaPnl: maxDelta, deltaDur,
    espSim2: m0.esp, espHarness: rl.esp, espRegistre: ch.esp60Ref,
    ok: maxDelta === 0 && deltaDur === 0 && m0.esp === rl.esp && m0.n === rl.n
  };
  rapport.controles.push(ctrl);
  console.log(`CTRL ${ch.nom.padEnd(26)} n=${String(m0.n).padStart(3)} sim2=${m0.esp} harness=${rl.esp} registre=${ch.esp60Ref} maxΔpnl=${maxDelta} ${ctrl.ok ? "OK" : "ÉCART !!"}`);

  // ---- Schémas étendus
  const ligne = { nom: ch.nom, instId: ch.mod.instId, exitsActuels: ch.mod.exits, schemas: {} };
  for (const s of SCHEMAS) {
    const ex = { ...ch.mod.exits, ...s.plus };
    const tr = s.id === "S0_actuel" ? t0 : evaluer2(ch.mod, c5, { coupureTs, sigs, exits: ex });
    ligne.schemas[s.id] = metriques(tr);
  }
  rapport.resultats.push(ligne);
}

// ---- Synthèse par schéma (moyenne des 8 champions, pondération égale)
const synth = {};
for (const s of SCHEMAS) {
  const ls = rapport.resultats.map(r => r.schemas[s.id]).filter(Boolean);
  synth[s.id] = {
    espMoy: +(ls.reduce((a, x) => a + x.esp, 0) / ls.length).toFixed(2),
    ddMoy: +(ls.reduce((a, x) => a + x.ddMax, 0) / ls.length).toFixed(2),
    sigmaMoy: +(ls.reduce((a, x) => a + x.sigma, 0) / ls.length).toFixed(2),
    ratioMoy: +(ls.reduce((a, x) => a + (x.ratio ?? 0), 0) / ls.length).toFixed(3),
    pireTradeMoy: +(ls.reduce((a, x) => a + x.pireTrade, 0) / ls.length).toFixed(1),
    nTot: ls.reduce((a, x) => a + x.n, 0),
    meilleurQue_S0: rapport.resultats.filter(r => r.schemas[s.id] && r.schemas.S0_actuel && r.schemas[s.id].esp > r.schemas.S0_actuel.esp).length
  };
}
rapport.synthese = synth;

fs.mkdirSync(path.join(__dirname, "rapports"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "rapports", "sorties2_resultats.json"), JSON.stringify(rapport, null, 1));

console.log("\n=== ESPÉRANCE (% marge/trade, 60 j vierges) par schéma ===");
const ids = SCHEMAS.map(s => s.id);
console.log("champion".padEnd(26) + ids.map(i => i.padStart(10)).join(""));
for (const r of rapport.resultats)
  console.log(r.nom.padEnd(26) + ids.map(i => String(r.schemas[i]?.esp ?? "-").padStart(10)).join(""));
console.log("MOYENNE".padEnd(26) + ids.map(i => String(synth[i].espMoy).padStart(10)).join(""));
console.log("\n=== DRAWDOWN MAX (% du pic, capital 100 / mise 10) ===");
for (const r of rapport.resultats)
  console.log(r.nom.padEnd(26) + ids.map(i => String(r.schemas[i]?.ddMax ?? "-").padStart(10)).join(""));
console.log("MOYENNE".padEnd(26) + ids.map(i => String(synth[i].ddMoy).padStart(10)).join(""));
console.log("\nRapport : tools/rapports/sorties2_resultats.json");
