// fable1_scan — PISTE : convertir les entrées à espérance PROUVÉE bi-époque en haut winrate
// via TP court (géométrie tp<<sl), en cherchant une recette de sortie COMMUNE (anti-cherry-picking).
// Bases (toutes déjà validées bi-époque en espérance avec leurs sorties d'origine) :
//   GPS gen_regime_3 (+4,81/+3,25) · SOON web_vwap_1 (+1,99/+3,07) · ACT x4_reliquat_1 (+0,45/+3,94)
//   LIT mixB_3 (+0,34/+2,34) · POPCAT mixA_2 (+2,64/+0,28)
// Grille GROSSIÈRE de sorties (choisie AVANT le scan) : tp {15,20,30} × trail {off, act=tp/2 cb5} × hold {8,12,24}.
// detect() jamais modifié — zéro look-ahead hérité des bases. sl=0,30 fixe (cap README).
// 3 fenêtres : banc data/ (IS/OOS) · 60 j vierges data90 (coupure = fin-30 j) · 90-180 j data180.
const fs = require("fs");
const path = require("path");
const { evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));

const BASES = [
  { nom: "GPS/gen_regime_3", fichier: "gen_regime_3.js" },
  { nom: "SOON/web_vwap_1", fichier: "web_vwap_1.js" },
  { nom: "ACT/x4_reliquat_1", fichier: "x4_reliquat_1.js" },
  { nom: "LIT/mixB_3", fichier: "mixB_3.js" },
  { nom: "POPCAT/mixA_2", fichier: "mixA_2.js" },
];

const EXITS = [];
for (const tp of [0.15, 0.20, 0.30])
  for (const trail of [false, true])
    for (const holdH of [8, 12, 24])
      EXITS.push(trail
        ? { tp, sl: 0.30, act: +(tp / 2).toFixed(3), cb: 0.05, holdH, id: `tp${tp * 100}_act${tp * 50}_h${holdH}` }
        : { tp, sl: 0.30, holdH, id: `tp${tp * 100}_noTrail_h${holdH}` });

function lire(dossier, instId) {
  const f = path.join(__dirname, "..", "..", dossier, instId + ".json");
  if (!fs.existsSync(f)) return null;
  const rows = JSON.parse(fs.readFileSync(f));
  return rows.length ? rows : null;
}

const resultats = [];
for (const b of BASES) {
  const base = require(path.join(__dirname, "..", "candidates", b.fichier));
  const inst = base.instId;
  const dBench = lire("data", inst), d90 = lire("data90", inst), d180 = lire("data180", inst);
  if (!dBench || !d90 || !d180) { console.error(`${b.nom}: données manquantes`); continue; }
  // signaux détectés UNE fois par fenêtre (detect ne dépend pas des exits)
  const sigsBench = base.detect(dBench), sigs90 = base.detect(d90), sigs180 = base.detect(d180);
  const coupure90 = d90[d90.length - 1][0] - 30 * 86400 * 1000; // exclut la fenêtre d'étude (= banc)
  for (const ex of EXITS.concat([{ ...base.exits, id: "ORIGINE" }])) {
    const shimB = { instId: inst, exits: ex, detect: () => sigsBench };
    const shim90 = { instId: inst, exits: ex, detect: () => sigs90 };
    const shim180 = { instId: inst, exits: ex, detect: () => sigs180 };
    const rB = evaluer(shimB, dBench);
    const r90 = evaluer(shim90, d90, { coupureTs: coupure90 }).all;
    const r180 = evaluer(shim180, d180).all;
    const row = {
      base: b.nom, exit: ex.id,
      bench: rB.A && rB.B ? { wrIS: rB.A.wr, wrOOS: rB.B.wr, espIS: rB.A.esp, espOOS: rB.B.esp, nIS: rB.A.n, nOOS: rB.B.n } : null,
      v60: r90 ? { wr: r90.wr, esp: r90.esp, n: r90.n, pf: r90.pf } : null,
      v180: r180 ? { wr: r180.wr, esp: r180.esp, n: r180.n, pf: r180.pf } : null,
    };
    const okB = row.bench && row.bench.wrIS >= 65 && row.bench.wrOOS >= 65 && row.bench.espIS > 0 && row.bench.espOOS > 0 && (row.bench.nIS + row.bench.nOOS) >= 60 && row.bench.nOOS >= 15;
    const ok60 = row.v60 && row.v60.wr >= 65 && row.v60.esp > 0 && row.v60.n >= 15;
    const ok180 = row.v180 && row.v180.wr >= 65 && row.v180.esp > 0 && row.v180.n >= 15;
    row.passBench = !!okB; row.passBi = !!(ok60 && ok180); row.passTout = !!(okB && ok60 && ok180);
    resultats.push(row);
  }
}
fs.writeFileSync(path.join(__dirname, "rapports", "fable1_scan_resultats.json"), JSON.stringify(resultats, null, 1));
// synthèse lisible
for (const r of resultats) {
  const b = r.bench ? `banc ${r.bench.wrIS}/${r.bench.wrOOS} e${r.bench.espIS}/${r.bench.espOOS} n${r.bench.nIS}+${r.bench.nOOS}` : "banc -";
  const v = r.v60 ? `60j wr${r.v60.wr} e${r.v60.esp} n${r.v60.n}` : "60j -";
  const w = r.v180 ? `180j wr${r.v180.wr} e${r.v180.esp} n${r.v180.n}` : "180j -";
  console.log(`${r.passTout ? "***" : r.passBi ? " bi" : "   "} ${r.base.padEnd(20)} ${r.exit.padEnd(18)} ${b} | ${v} | ${w}`);
}
