// CHANTIER MÉTRIQUES DE RISQUE — l'espérance ne suffit pas.
// Pour un module candidat, rejoue les trades du banc 30 j (mêmes règles que harness_lib.evaluer :
// tri i5, blocage busy, i5 >= len-2 exclu, sim() officiel) puis calcule les métriques de risque
// sur la courbe de capital SÉQUENTIELLE : capital de départ 100, mise 10 par trade
// (PnL capital d'un trade = 10 × pnl_prix × levier 15 = 10 × rendement de la marge).
//
// Métriques : drawdown max de la courbe de capital (absolu + % du pic), plus longue série de
// pertes consécutives, pire journée (PnL agrégé par jour UTC de SORTIE), écart-type des trades
// (en % de marge, échantillon n-1), ratio espérance/écart-type (Sharpe par trade).
//
// Usage :
//   node tools/risque.js                      -> batch top 10 banc + 9 HERMES 15, rapports drawdown_*.json
//   node tools/risque.js candidates/x.js      -> un module candidat, JSON sur stdout
//   node tools/risque.js hermes15:ENSO        -> une survivante HERMES 15, JSON sur stdout
const fs = require("fs");
const path = require("path");
const { chargerCandles, sim, LEV } = require("../harness_lib.js");
const { modules: H15, REFERENCE, aggreger, sigZscore } = require("./hermes15_modules.js");

/* candidates/_opt_O.js dépend de champions_5.js, supprimé du dossier par un autre chantier
   pendant la session. Reconstruction à l'identique : champions_5 = recréation du champion O
   de profond2 (« zScore-SMA48-15m |z|>2.5 »), et _opt_O = mêmes signaux avec les sorties
   tp 0.60 / act 0.20 / 24 h (commentaire de _opt_O.js + O retenue de profond2_resultats.json :
   A 9.30 n40 / B 9.35 n24 = exactement les chiffres publiés de _opt_O au classement).
   La reconstruction n'est utilisée QUE si le require échoue, et le drapeau reproduitReference
   valide qu'elle rejoue les chiffres publiés au centime. */
const RECONSTRUCTIONS = {
  "candidates/_opt_O.js": {
    instId: "O-USDT-SWAP",
    exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 24 },
    detect: c5 => sigZscore(aggreger(c5, 3), 48, 2.5),
    _sig: "zScore-SMA48-15m |z|>2.5 (reconstruction, champions_5.js disparu)"
  }
};

function chargerCandidat(modPath) {
  try { return { mod: require(path.resolve(__dirname, "..", modPath)), reconstruit: false }; }
  catch (e) {
    if (RECONSTRUCTIONS[modPath]) return { mod: RECONSTRUCTIONS[modPath], reconstruit: true };
    throw e;
  }
}

const CAPITAL0 = 100, MISE = 10, OOS_JOURS = 10;
const RAPPORTS = path.join(__dirname, "rapports");

/* Rejoue exactement la sélection de harness_lib.evaluer, mais en gardant chaque trade
   avec ses timestamps (nécessaire pour la courbe de capital et le PnL par jour). */
function collecterTrades(mod, c5) {
  const tOOS = c5[c5.length - 1][0] - OOS_JOURS * 86400 * 1000;
  const sigs = (mod.detect(c5) || []).slice().sort((a, b) => a.i5 - b.i5);
  const out = [];
  let busy = -1;
  for (const s of sigs) {
    if (s.i5 <= busy || s.i5 >= c5.length - 2 || !s.dir) continue;
    const t = sim(c5, s.i5, s.dir, mod.exits);
    busy = s.i5 + t.dur;
    out.push({ pnl: t.pnl, dur: t.dur, dir: s.dir, entryTs: c5[s.i5][0], exitTs: c5[s.i5 + t.dur][0], oos: c5[s.i5][0] >= tOOS });
  }
  return out;
}

function esp(l) { return l.length ? +(100 * l.reduce((s, t) => s + t.pnl, 0) / l.length * LEV).toFixed(2) : null; }

function metriques(trades) {
  const n = trades.length;
  const margins = trades.map(t => 100 * t.pnl * LEV); // % de marge par trade (unité de l'espérance)
  const moy = margins.reduce((s, x) => s + x, 0) / n;
  const ecart = n > 1 ? Math.sqrt(margins.reduce((s, x) => s + (x - moy) * (x - moy), 0) / (n - 1)) : null;

  // Courbe de capital séquentielle (capital 100, mise 10/trade -> PnL = MISE * rendement marge)
  let cap = CAPITAL0, peak = CAPITAL0, ddMaxAbs = 0, ddMaxPct = 0;
  let streak = 0, streakMax = 0;
  const parJour = new Map();
  const courbe = [+CAPITAL0.toFixed(2)];
  let capMin = CAPITAL0;
  for (const t of trades) {
    const gain = MISE * t.pnl * LEV;
    cap += gain;
    courbe.push(+cap.toFixed(2));
    if (cap < capMin) capMin = cap;
    if (cap > peak) peak = cap;
    const dd = peak - cap;
    if (dd > ddMaxAbs) ddMaxAbs = dd;
    const ddPct = peak > 0 ? 100 * dd / peak : 0;
    if (ddPct > ddMaxPct) ddMaxPct = ddPct;
    if (t.pnl <= 0) { streak++; if (streak > streakMax) streakMax = streak; } else streak = 0;
    const jour = new Date(t.exitTs).toISOString().slice(0, 10);
    parJour.set(jour, +((parJour.get(jour) || 0) + gain).toFixed(4));
  }
  let pireJour = null;
  for (const [jour, pnl] of parJour) if (!pireJour || pnl < pireJour.pnlCapital) pireJour = { date: jour, pnlCapital: +pnl.toFixed(2) };
  const joursNegatifs = [...parJour.values()].filter(v => v < 0).length;

  const isL = trades.filter(t => !t.oos), oosL = trades.filter(t => t.oos);
  return {
    nTrades: n, nIS: isL.length, nOOS: oosL.length,
    wr: +(100 * trades.filter(t => t.pnl > 0).length / n).toFixed(1),
    espIS: esp(isL), espOOS: esp(oosL), esp: +moy.toFixed(2),
    ecartType: ecart == null ? null : +ecart.toFixed(2),
    ratioEspEcart: ecart ? +(moy / ecart).toFixed(3) : null,
    capitalFinal: +cap.toFixed(2), capitalMin: +capMin.toFixed(2),
    ddMaxAbs: +ddMaxAbs.toFixed(2), ddMaxPct: +ddMaxPct.toFixed(2),
    plusLongueSeriePertes: streakMax,
    pireJournee: pireJour, joursNegatifs, nJours: parJour.size,
    pireTrade: +Math.min(...margins).toFixed(2), meilleurTrade: +Math.max(...margins).toFixed(2),
    _courbe: courbe, _parJour: Object.fromEntries([...parJour.entries()].sort())
  };
}

function evaluerModule(id, mod, refEsp) {
  const c5 = chargerCandles("data", mod.instId);
  const trades = collecterTrades(mod, c5);
  if (!trades.length) return { id, instId: mod.instId, erreur: "aucun trade" };
  const m = metriques(trades);
  const r = { id, instId: mod.instId, signal: mod._sig || null, exits: mod.exits, ...m };
  if (refEsp) {
    r.refEspIS = refEsp.espIS; r.refEspOOS = refEsp.espOOS;
    r.reproduitReference = (m.espIS === refEsp.espIS && m.espOOS === refEsp.espOOS);
  }
  return r;
}

// ---- CLI ----
const arg = process.argv[2];
if (arg) {
  let id, mod;
  if (arg.startsWith("hermes15:")) {
    id = arg; mod = H15[arg.split(":")[1]];
    if (!mod) { console.error("survivantes connues : " + Object.keys(H15).join(", ")); process.exit(1); }
  } else {
    id = arg; mod = chargerCandidat(arg).mod;
  }
  const ref = arg.startsWith("hermes15:") ? REFERENCE[arg.split(":")[1]] : null;
  const r = evaluerModule(id, mod, ref);
  delete r._courbe; delete r._parJour;
  console.log(JSON.stringify(r, null, 1));
  process.exit(0);
}

// Batch : top 10 du banc 30 j (robustesse_classement.json) + 9 survivantes HERMES 15.
const classement30 = JSON.parse(fs.readFileSync(path.join(RAPPORTS, "robustesse_classement.json"))).classement;
const TOP10 = classement30.slice(0, 10).map(x => x.module);

const detail = [], lignes = [];
for (const modPath of TOP10) {
  const { mod, reconstruit } = chargerCandidat(modPath);
  const r = evaluerModule(modPath, mod, null);
  r.groupe = "top10_banc";
  if (reconstruit) r.reconstruit = true;
  const ref = classement30.find(x => x.module === modPath);
  r.refEspIS = ref.espIS; r.refEspOOS = ref.espOOS;
  r.reproduitReference = (r.espIS === ref.espIS && r.espOOS === ref.espOOS);
  detail.push(r);
}
for (const [nom, mod] of Object.entries(H15)) {
  const r = evaluerModule("hermes15:" + nom, mod, REFERENCE[nom]);
  r.groupe = "hermes15";
  detail.push(r);
}

for (const r of detail) {
  lignes.push({
    id: r.id, groupe: r.groupe, instId: r.instId,
    nTrades: r.nTrades, esp: r.esp, ecartType: r.ecartType, ratioEspEcart: r.ratioEspEcart,
    ddMaxPct: r.ddMaxPct, ddMaxAbs: r.ddMaxAbs, plusLongueSeriePertes: r.plusLongueSeriePertes,
    pireJournee: r.pireJournee, capitalFinal: r.capitalFinal, wr: r.wr,
    espIS: r.espIS, espOOS: r.espOOS, reproduitReference: r.reproduitReference
  });
}
lignes.sort((a, b) => (b.ratioEspEcart ?? -99) - (a.ratioEspEcart ?? -99));
lignes.forEach((x, i) => x.rang = i + 1);

fs.mkdirSync(RAPPORTS, { recursive: true });
const meta = {
  note: "Banc 30 j (data/), rejeu exact de harness_lib.evaluer. Capital 100, mise 10/trade, PnL capital = 10 x rendement marge (levier 15). ddMaxPct = drawdown max en % du pic de la courbe de capital. pireJournee = PnL capital agrégé par jour UTC de sortie. ecartType = écart-type échantillon des trades en % de marge. Classement risque-ajusté = ratio espérance/écart-type décroissant. reproduitReference = espIS/espOOS identiques à la source (robustesse_classement.json pour le top 10, profond2_resultats.json retenue pour HERMES 15).",
  genere: new Date().toISOString(),
  capitalDepart: CAPITAL0, miseParTrade: MISE, levier: LEV
};
fs.writeFileSync(path.join(RAPPORTS, "drawdown_classement.json"), JSON.stringify({ ...meta, classement: lignes }, null, 1));
const detailOut = detail.map(r => { const { _courbe, _parJour, ...rest } = r; return { ...rest, courbeCapital: _courbe, pnlParJour: _parJour }; });
fs.writeFileSync(path.join(RAPPORTS, "drawdown_risque_detail.json"), JSON.stringify({ ...meta, modules: detailOut }, null, 1));

console.log("rang | id | esp | std | esp/std | ddMax% | seriePertes | pireJour | repro");
for (const x of lignes)
  console.log([x.rang, x.id, x.esp, x.ecartType, x.ratioEspEcart, x.ddMaxPct, x.plusLongueSeriePertes,
    x.pireJournee.pnlCapital + " (" + x.pireJournee.date + ")", x.reproduitReference].join(" | "));
console.log("\nRapports écrits : tools/rapports/drawdown_classement.json + drawdown_risque_detail.json");
