// fable1_scan2 — ACT avec confirmation DÉCALÉE (detect de wr_confirm_4) × sorties courtes retenues.
// Question : la confirmation engraisse-t-elle l'esp 60 j (point mince du candidat ACT) sans casser le wr ?
const fs = require("fs");
const path = require("path");
const { evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));

const EXITS = [
  { tp: 0.15, sl: 0.30, holdH: 24, id: "tp15_noTrail_h24" },
  { tp: 0.20, sl: 0.30, holdH: 24, id: "tp20_noTrail_h24" },
  { tp: 0.20, sl: 0.30, act: 0.10, cb: 0.05, holdH: 12, id: "tp20_act10_h12" },
  { tp: 0.20, sl: 0.30, act: 0.10, cb: 0.05, holdH: 24, id: "tp20_act10_h24" },
  { tp: 0.30, sl: 0.30, act: 0.15, cb: 0.05, holdH: 12, id: "tp30_act15_h12" },
  { tp: 0.30, sl: 0.30, act: 0.15, cb: 0.05, holdH: 24, id: "tp30_act15_h24" },
];

function lire(dossier, instId) {
  const f = path.join(__dirname, "..", "..", dossier, instId + ".json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null;
}

const base = require(path.join(__dirname, "..", "candidates", "wr_confirm_4.js"));
const inst = base.instId;
const dBench = lire("data", inst), d90 = lire("data90", inst), d180 = lire("data180", inst);
const sigsBench = base.detect(dBench), sigs90 = base.detect(d90), sigs180 = base.detect(d180);
const coupure90 = d90[d90.length - 1][0] - 30 * 86400 * 1000;
for (const ex of EXITS) {
  const rB = evaluer({ instId: inst, exits: ex, detect: () => sigsBench }, dBench);
  const r90 = evaluer({ instId: inst, exits: ex, detect: () => sigs90 }, d90, { coupureTs: coupure90 }).all;
  const r180 = evaluer({ instId: inst, exits: ex, detect: () => sigs180 }, d180).all;
  const b = rB.A && rB.B ? `banc ${rB.A.wr}/${rB.B.wr} e${rB.A.esp}/${rB.B.esp} n${rB.A.n}+${rB.B.n}` : "banc -";
  console.log(`ACTconf ${ex.id.padEnd(18)} ${b} | 60j wr${r90?.wr} e${r90?.esp} n${r90?.n} | 180j wr${r180?.wr} e${r180?.esp} n${r180?.n}`);
}
