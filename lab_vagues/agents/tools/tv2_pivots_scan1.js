// SCAN "Pivot Points journaliers classiques" (agent tv2_pivots_, Pack PIVOTS, 31/08) — TradingView communautaire.
// Formule EXACTE (méthode "Floor Trader" standard, TradingView "Pivot Points Standard") calculée sur le
// JOUR CALENDAIRE UTC PRÉCÉDENT (H/L/C de la veille, 00:00->24:00 UTC), 100% causale :
//   PP = (Hveille + Lveille + Cveille) / 3
//   R1 = 2*PP - Lveille        S1 = 2*PP - Hveille
// PP est utilisée dans SON RÔLE LOCAL (support si le prix vient d'au-dessus, résistance si le prix
// vient d'en-dessous -> le générateur générique teste les deux issues, elles sont mutuellement
// exclusives sur une même bougie) ; S1 = support pur (fade LONG uniquement) ; R1 = résistance pure
// (fade SHORT uniquement).
// mode X = rejet même bougie (mèche qui perce le niveau, clôture qui referme du bon côté)
// mode R = reclaim (clôture qui était de l'autre côté au i-1, revient du bon côté au i ; le niveau
//          ne doit pas avoir sauté entre i-1 et i, sinon on ignore -> évite l'artefact de bascule
//          de jour UTC). Cf. leçon "reclaim > touch" reconfirmée 7x dans le journal, jamais testée
//          sur les pivots journaliers.
// Aucun repaint : le niveau du jour d est calculé à partir du jour d-1 ENTIER (fini avant que le
// jour d ne commence) ; warm-up 320 barres (>1 jour) pour ignorer le 1er jour partiel du dataset.
const fs = require("fs");
const path = require("path");
const AG = "C:/Users/Administrator/Desktop/HERMES_V4_LIVE/lab_vagues/agents";
const { chargerCandles, evaluer } = require(path.join(AG, "harness_lib.js"));
const { dailyPivotLevels, genLevelSignals } = require("./tv2_pivots_lib.js");

const DATA_DIR = path.join(AG, "..", "data");
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};
const MODES = ["X", "R"];
const LEVELS = ["PP", "S1", "R1"];
const WARM = 320;
const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY GOOGL " +
  "INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK SNXX SOXL SOXS " +
  "SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD " +
  // règle "1 strat/crypto" : cryptos déjà championnes au registre, à éviter (assignation de l'orchestrateur)
  "PIEVERSE ENSO GRASS GPS SOON O USELESS AXS MANA LUNA MEGA NES").split(" "));

const ROLE = { PP: "piv", S1: "sup", R1: "res" };

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith("-USDT-SWAP.json"));
const res = [];
let done = 0;
for (const f of files) {
  const inst = f.replace(".json", "");
  const base = inst.replace("-USDT-SWAP", "");
  if (BLOCK.has(base)) continue;
  let c5; try { c5 = chargerCandles("data", inst); } catch (e) { continue; }
  if (!c5 || c5.length < 4000) continue;
  const high = c5.map(x => x[2]), low = c5.map(x => x[3]), close = c5.map(x => x[4]);
  const lvl = dailyPivotLevels(c5); // { PP, S1, R1, H3, L3 } arrays

  for (const name of LEVELS) {
    const arr = lvl[name], role = ROLE[name];
    for (const mode of MODES) {
      const sigs = genLevelSignals(arr, close, high, low, role, mode, WARM);
      if (sigs.length < 25) continue;
      for (const ex of Object.keys(EXITS)) {
        const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
        if (!r.A || !r.B) continue;
        res.push({
          inst, level: name, mode, ex,
          espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
          nSig: sigs.length,
          wrOOS: r.B.wr, pfOOS: r.B.pf,
          worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
          valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15
        });
      }
    }
  }
  done++;
  if (done % 40 === 0) console.error(`... ${done} cryptos`);
}
res.sort((a, b) => b.worst - a.worst);
const out = path.join(__dirname, "tv2_pivots_scan1_resultats.json");
fs.writeFileSync(out, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ cryptos: done, lignes: res.length, valides: res.filter(r => r.valide).length, top: res.filter(r => r.valide).slice(0, 25) }, null, 1));
