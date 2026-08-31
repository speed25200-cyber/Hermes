// Roster des 13 stratégies LIVE demandées par le client, pour le chantier "winrate / retracement d'entrée".
// 9 modules réutilisés TELS QUELS depuis candidates/ (aucune réécriture de la logique de détection).
// 4 modules (AXS/MANA/LUNA/MEGA) recréés depuis le pattern documenté "5 bougies 5m consécutives (fade)"
// de profond2.js (run>=5 dans le même sens -> fade), exits = la ligne "retenue" du scan profond2_resultats.json.
const path = require("path");
function req(f) { return require(path.join(__dirname, "..", "candidates", f)); }

const RUN_N = 5;
function detectRun5(c5) {
  const out = [];
  let run = 0, sgn = 0;
  for (let i = 1; i < c5.length; i++) {
    const d = Math.sign(c5[i][4] - c5[i - 1][4]);
    if (d !== 0 && d === sgn) run++; else { run = 1; sgn = d; }
    if (run >= RUN_N && sgn !== 0) out.push({ i5: i, dir: -sgn }); // fade du run
  }
  return out;
}

const run5AXS  = { instId: "AXS-USDT-SWAP",  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 }, detect: detectRun5 };
const run5MANA = { instId: "MANA-USDT-SWAP", exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 12 }, detect: detectRun5 };
const run5LUNA = { instId: "LUNA-USDT-SWAP", exits: { tp: 0.40, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 }, detect: detectRun5 };
const run5MEGA = { instId: "MEGA-USDT-SWAP", exits: { tp: 0.40, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 }, detect: detectRun5 };

const ROSTER = [
  { tag: "PIEVERSE", src: "web_structure_1.js", mod: req("web_structure_1.js") },
  { tag: "ENSO",     src: "multiech_2.js",       mod: req("multiech_2.js") },
  { tag: "GPS",      src: "gen_regime_3.js",     mod: req("gen_regime_3.js") },
  { tag: "SOON",     src: "gen_keltner_2.js",    mod: req("gen_keltner_2.js") },
  { tag: "O",        src: "ti_arsenal_2.js",     mod: req("ti_arsenal_2.js") },
  { tag: "ACT",      src: "x4_reliquat_1.js",    mod: req("x4_reliquat_1.js") },
  { tag: "POPCAT",   src: "mixA_2.js",           mod: req("mixA_2.js") },
  { tag: "LIT",      src: "mixB_3.js",           mod: req("mixB_3.js") },
  { tag: "GRASS",    src: "champions_2.js",      mod: req("champions_2.js") },
  { tag: "AXS",      src: "run5 (recréé)",       mod: run5AXS },
  { tag: "MANA",     src: "run5 (recréé)",       mod: run5MANA },
  { tag: "LUNA",     src: "run5 (recréé)",       mod: run5LUNA },
  { tag: "MEGA",     src: "run5 (recréé)",       mod: run5MEGA },
];

module.exports = { ROSTER, detectRun5 };
