// AGENT "ingénieur winrate" — balayage de sorties haut-winrate sur le roster des 13 LIVE.
// Garde le detect() (le signal) de chaque stratégie EN PLACE, ne touche qu'aux sorties :
// TP {10,20,30}% de marge (au lieu de 40-80), SL -30% inchangé (cap dur), AVEC et SANS trail,
// holds {4,8,12} h. Objectif : wr >= 70% visé (mini validable 65%), esp > 0 des deux côtés
// (IS 20j / OOS 10j sur la fenêtre 30j de data/), esp_new >= 60% de l'esp de la version live.
const path = require("path");
const { chargerCandles, evaluer } = require("../harness_lib.js");

function run5Detect(c5) {
  const out = [];
  let run = 0, sgn = 0;
  for (let i = 1; i < c5.length; i++) {
    const d = Math.sign(c5[i][4] - c5[i - 1][4]);
    if (d !== 0 && d === sgn) run++; else { run = 1; sgn = d; }
    if (run >= 5 && sgn !== 0) out.push({ i5: i, dir: -sgn }); // fade de la série (== run5_5m de app/main.js)
  }
  return out;
}

// Roster LIVE (app/main.js STRATS, relevé le 31/08) : instId, module source du detect(), exits ACTUELS en prod.
const ROSTER = [
  { nom: "ENSO",     instId: "ENSO-USDT-SWAP",    mod: "multiech_2.js",   avant: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 } },
  { nom: "GRASS",    instId: "GRASS-USDT-SWAP",   mod: "champions_2.js",  avant: { tp: 0.60, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 } }, // live = cb 0.05 (pas 0.20 du fichier PROPOSE)
  { nom: "GPS",      instId: "GPS-USDT-SWAP",     mod: "gen_regime_3.js", avant: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 } },
  { nom: "AXS",      instId: "AXS-USDT-SWAP",     mod: "run5",            avant: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 } },
  { nom: "SOON",     instId: "SOON-USDT-SWAP",    mod: "gen_keltner_2.js",avant: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 8 } },
  { nom: "MANA",     instId: "MANA-USDT-SWAP",    mod: "run5",            avant: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 12 } },
  { nom: "LUNA",     instId: "LUNA-USDT-SWAP",    mod: "run5",            avant: { tp: 0.40, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 } },
  { nom: "MEGA",     instId: "MEGA-USDT-SWAP",    mod: "run5",            avant: { tp: 0.40, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 } },
  { nom: "PIEVERSE", instId: "PIEVERSE-USDT-SWAP",mod: "web_structure_1.js", avant: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 } },
  { nom: "O",        instId: "O-USDT-SWAP",       mod: "ti_arsenal_2.js", avant: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 8 } },
  { nom: "ACT",      instId: "ACT-USDT-SWAP",     mod: "x4_reliquat_1.js",avant: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 } },
  { nom: "POPCAT",   instId: "POPCAT-USDT-SWAP",  mod: "mixA_2.js",       avant: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 } },
  { nom: "LIT",      instId: "LIT-USDT-SWAP",     mod: "mixB_3.js",       avant: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 } },
];

function getDetect(entry) {
  if (entry.mod === "run5") return run5Detect;
  const m = require(path.resolve(__dirname, "..", "candidates", entry.mod));
  return m.detect.bind(m);
}

const TP_GRID = [0.10, 0.20, 0.30];
const HOLD_GRID = [4, 8, 12];
const TRAIL_MODES = ["off", "on"];

function evalOne(detect, c5, exits) {
  const r = evaluer({ instId: "x", exits, detect }, c5);
  return r;
}

const results = [];
for (const entry of ROSTER) {
  const c5 = chargerCandles("data", entry.instId);
  const detect = getDetect(entry);
  const avantR = evalOne(detect, c5, entry.avant);
  const avant = {
    espIS: avantR.A?.esp ?? null, espOOS: avantR.B?.esp ?? null,
    wrIS: avantR.A?.wr ?? null, wrOOS: avantR.B?.wr ?? null,
    nIS: avantR.A?.n ?? 0, nOOS: avantR.B?.n ?? 0
  };
  const worstAvant = (avant.espIS != null && avant.espOOS != null) ? Math.min(avant.espIS, avant.espOOS) : null;

  const grid = [];
  for (const tp of TP_GRID) {
    for (const trail of TRAIL_MODES) {
      for (const holdH of HOLD_GRID) {
        const act = trail === "on" ? +(tp * 0.5).toFixed(2) : 99;
        const exits = { tp, sl: 0.30, act, cb: 0.05, holdH };
        const r = evalOne(detect, c5, exits);
        const A = r.A, B = r.B;
        const cell = {
          tp, trail, holdH,
          espIS: A?.esp ?? null, espOOS: B?.esp ?? null,
          wrIS: A?.wr ?? null, wrOOS: B?.wr ?? null,
          nIS: A?.n ?? 0, nOOS: B?.n ?? 0,
          pfOOS: B?.pf ?? null,
        };
        cell.valide = !!(A && B && A.esp > 0 && B.esp > 0 && A.wr >= 65 && B.wr >= 65 && (A.n + B.n) >= 60 && B.n >= 15);
        cell.worst = (A && B) ? Math.min(A.esp, B.esp) : null;
        cell.minwr = (A && B) ? Math.min(A.wr, B.wr) : null;
        cell.retentionOk = (worstAvant != null && worstAvant > 0) ? (cell.worst != null && cell.worst >= 0.6 * worstAvant) : (cell.worst != null && cell.worst > 0);
        grid.push(cell);
      }
    }
  }

  const success = grid.filter(c => c.valide && c.retentionOk);
  success.sort((a, b) => (b.minwr - a.minwr) || (b.worst - a.worst));
  const best = success[0] || null;

  // plateau : parmi les voisins (même trail, holdH voisin OU tp voisin), combien sont eux aussi valide+retentionOk ?
  let plateau = 0;
  if (best) {
    for (const c of grid) {
      if (c === best) continue;
      const voisinHold = c.trail === best.trail && c.tp === best.tp && Math.abs(HOLD_GRID.indexOf(c.holdH) - HOLD_GRID.indexOf(best.holdH)) === 1;
      const voisinTp = c.trail === best.trail && c.holdH === best.holdH && Math.abs(TP_GRID.indexOf(c.tp) - TP_GRID.indexOf(best.tp)) === 1;
      if ((voisinHold || voisinTp) && c.valide && c.retentionOk) plateau++;
    }
  }

  results.push({ nom: entry.nom, instId: entry.instId, avant, worstAvant, best, plateau, nCellsValides: grid.filter(c => c.valide).length, nCellsRetention: success.length, grid });
}

const fs = require("fs");
fs.writeFileSync(path.resolve(__dirname, "rapports", "wr_exits_scan_resultats.json"), JSON.stringify(results, null, 1));

for (const r of results) {
  const b = r.best;
  console.log(`${r.nom.padEnd(9)} avant wr ${String(r.avant.wrIS).padStart(5)}/${String(r.avant.wrOOS).padStart(5)} esp ${String(r.avant.espIS).padStart(6)}/${String(r.avant.espOOS).padStart(6)} (worst ${r.worstAvant})  |  ` +
    (b ? `MEILLEUR tp${b.tp} ${b.trail === "on" ? "trail" : "notrail"} h${b.holdH}  wr ${b.wrIS}/${b.wrOOS} esp ${b.espIS}/${b.espOOS} n${b.nIS}+${b.nOOS} plateau=${r.plateau}` : "AUCUN combo ne passe (valide+rétention esp>=60%)"));
}
