// CHANTIER PRÉCISION 1 MINUTE — étape 2 : rejoue les trades des meilleurs candidats
// avec les exits simulés sur bougies 1 m (data1m/) et compare à la simulation
// officielle 5 m (harness_lib.sim) SUR LES MÊMES TRADES, même période.
//
// Méthode :
//  - signaux détectés sur les bougies 5 m (data/) exactement comme evaluer() du banc
//    (tri, blocage par symbole via la durée 5 m, i5 < len-2) → même liste de trades ;
//  - pour chaque trade dont la fenêtre de hold complète est couverte par les 1 m :
//      pnl5 = sim() officielle sur 5 m (vérifiée au centime par une ré-implémentation locale)
//      pnl1 = même logique d'exit (SL pire-cas d'abord, puis TP, trail sur CLOSE) sur les 1 m,
//             même prix d'entrée (close 5 m du signal), même coûts, même hold (×5 bougies).
//  - agrégats par module + global : espérance (% marge/trade, levier x15), winrate,
//    transitions de motif de sortie, écart par trade.
//
// Usage : node tools/sim1m.js          (depuis lab_vagues/agents)
// Sortie : tools/rapports/minute_comparaison.json (+ détail par trade minute_trades_detail.json)
const fs = require("fs");
const path = require("path");
const { chargerCandles, sim, LEV, COUT_PX } = require("../harness_lib.js");
const { CIBLES } = require("./collecte1m.js");

const EPS = 1e-9;

/* Marche un chemin de bougies (déjà sélectionnées, ascendantes) avec la logique d'exit
   EXACTE du harness : SL d'abord (pire cas), puis TP, puis trail activé sur close.
   Retourne aussi le motif de sortie. Sur les bougies 5 m du trade, doit reproduire
   harness_lib.sim au centime (c'est vérifié plus bas). */
function marcher(entry, dir, ex, candles) {
  const tpPx = ex.tp / LEV, slPx0 = Math.min(ex.sl, 0.30) / LEV;
  const actPx = (ex.act ?? 99) / LEV, cbPx = (ex.cb ?? 0.05) / LEV;
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  let sl = dir > 0 ? entry * (1 - slPx0) : entry * (1 + slPx0);
  let best = entry, traine = false;
  for (let k = 0; k < candles.length; k++) {
    const hi = candles[k][2], lo = candles[k][3];
    if (dir > 0 ? lo <= sl : hi >= sl)
      return { pnl: (dir > 0 ? sl / entry - 1 : 1 - sl / entry) - COUT_PX, exit: traine ? "trail" : "sl", nb: k + 1 };
    if (dir > 0 ? hi >= tp : lo <= tp)
      return { pnl: tpPx - COUT_PX, exit: "tp", nb: k + 1 };
    const close = candles[k][4];
    if (dir > 0 ? close > best : close < best) best = close;
    if ((dir > 0 ? best / entry - 1 : 1 - best / entry) >= actPx) {
      const t = dir > 0 ? best * (1 - cbPx) : best * (1 + cbPx);
      if (dir > 0 ? t > sl : t < sl) { sl = t; traine = true; }
    }
  }
  const dernier = candles[candles.length - 1][4];
  return { pnl: (dir > 0 ? dernier / entry - 1 : 1 - dernier / entry) - COUT_PX, exit: "timeout", nb: candles.length };
}

function agreger(pnls) {
  const n = pnls.length;
  if (!n) return null;
  const sum = pnls.reduce((s, p) => s + p, 0);
  const w = pnls.filter(p => p > 0).length;
  return { n, esp: +(100 * sum / n * LEV).toFixed(2), wr: +(100 * w / n).toFixed(1) };
}

function traiterModule(cible) {
  const mod = require(path.resolve(__dirname, "..", cible.mod));
  const c5 = chargerCandles("data", mod.instId);
  let c1;
  try { c1 = chargerCandles("data1m", mod.instId); }
  catch { return { instId: mod.instId, mod: cible.mod, erreur: "DATA1M_ABSENT" }; }
  if (!c1.length) return { instId: mod.instId, mod: cible.mod, erreur: "DATA1M_VIDE" };

  // index ts -> position dans c1
  const idx1 = new Map();
  for (let i = 0; i < c1.length; i++) idx1.set(c1[i][0], i);
  const debut1 = c1[0][0], fin1 = c1[c1.length - 1][0];

  // Rejoue la sélection de trades EXACTEMENT comme evaluer() (blocage 5 m officiel)
  const sigs = (mod.detect(c5) || []).sort((a, b) => a.i5 - b.i5);
  const hold5 = Math.round((mod.exits.holdH ?? 12) * 12);
  let busy = -1;
  const trades = [];
  let horsFenetre = 0, couvertureInsuf = 0;
  for (const s of sigs) {
    if (s.i5 <= busy || s.i5 >= c5.length - 2 || !s.dir) continue;
    const t5 = sim(c5, s.i5, s.dir, mod.exits);
    busy = s.i5 + t5.dur;

    const sigTs = c5[s.i5][0];
    // fenêtre théorique complète du trade : bougies 5 m i5+1 .. i5+hold5
    if (s.i5 + hold5 > c5.length - 1) { horsFenetre++; continue; }        // hold tronqué par la fin des 5 m
    const premiereTs = sigTs + 300e3;                                      // 1re bougie 1 m après la clôture du signal
    const derniereTs = sigTs + hold5 * 300e3 + 4 * 60e3;                   // dernière 1 m de la dernière bougie 5 m
    if (premiereTs < debut1 || derniereTs > fin1) { horsFenetre++; continue; } // hors couverture 1 m

    // chemin 1 m : toutes les bougies 1 m dans [premiereTs, derniereTs]
    let k0 = idx1.get(premiereTs);
    if (k0 === undefined) { // gap au départ : première bougie >= premiereTs
      k0 = c1.findIndex(c => c[0] >= premiereTs);
      if (k0 < 0) { couvertureInsuf++; continue; }
    }
    const chemin1 = [];
    for (let k = k0; k < c1.length && c1[k][0] <= derniereTs; k++) chemin1.push(c1[k]);
    const attendu = hold5 * 5;
    if (chemin1.length < attendu * 0.95) { couvertureInsuf++; continue; }  // gaps > 5 % : trade écarté

    // vérification : ma marche 5 m reproduit sim() officielle au centime
    const chemin5 = c5.slice(s.i5 + 1, s.i5 + hold5 + 1);
    const v5 = marcher(c5[s.i5][4], s.dir, mod.exits, chemin5);
    if (Math.abs(v5.pnl - t5.pnl) > 1e-12)
      throw new Error(`divergence réimplémentation 5m sur ${mod.instId} i5=${s.i5} : ${v5.pnl} vs ${t5.pnl}`);

    const v1 = marcher(c5[s.i5][4], s.dir, mod.exits, chemin1);
    trades.push({
      ts: sigTs, date: new Date(sigTs).toISOString(), dir: s.dir,
      pnl5: +(100 * t5.pnl * LEV).toFixed(3), pnl1: +(100 * v1.pnl * LEV).toFixed(3),
      delta: +(100 * (v1.pnl - t5.pnl) * LEV).toFixed(3),
      exit5: v5.exit, exit1: v1.exit,
      durMin5: v5.nb * 5, durMin1: v1.nb,
    });
  }

  const a5 = agreger(trades.map(t => t.pnl5 / 100 / LEV));
  const a1 = agreger(trades.map(t => t.pnl1 / 100 / LEV));
  const transitions = {};
  let pires = 0, meilleures = 0, egales = 0;
  for (const t of trades) {
    const cle = `${t.exit5}->${t.exit1}`;
    transitions[cle] = (transitions[cle] || 0) + 1;
    if (t.pnl1 < t.pnl5 - 1e-6) pires++;
    else if (t.pnl1 > t.pnl5 + 1e-6) meilleures++;
    else egales++;
  }
  const deltas = trades.map(t => t.delta).sort((a, b) => a - b);
  return {
    instId: mod.instId, mod: cible.mod, worst30_docu: cible.worst30,
    fenetre1m: { de: new Date(debut1).toISOString(), a: new Date(fin1).toISOString() },
    nCompares: trades.length, horsFenetre, couvertureInsuf,
    esp5m: a5 ? a5.esp : null, esp1m: a1 ? a1.esp : null,
    deltaEsp: (a5 && a1) ? +(a1.esp - a5.esp).toFixed(2) : null,
    wr5m: a5 ? a5.wr : null, wr1m: a1 ? a1.wr : null,
    tradesPires1m: pires, tradesMeilleurs1m: meilleures, tradesEgaux: egales,
    deltaMedian: deltas.length ? deltas[Math.floor(deltas.length / 2)] : null,
    transitions,
    trades,
  };
}

function main() {
  const resultats = [];
  for (const cible of CIBLES) {
    const r = traiterModule(cible);
    resultats.push(r);
    if (r.erreur) { console.log(`${r.instId} : ${r.erreur}`); continue; }
    console.log(`${r.instId.padEnd(20)} n=${String(r.nCompares).padStart(3)}  esp5m=${String(r.esp5m).padStart(7)}  esp1m=${String(r.esp1m).padStart(7)}  delta=${String(r.deltaEsp).padStart(7)}  (pires:${r.tradesPires1m} meilleurs:${r.tradesMeilleurs1m} egaux:${r.tradesEgaux})`);
  }

  // agrégat global (tous trades comparés confondus)
  const tous = resultats.filter(r => !r.erreur).flatMap(r => r.trades);
  const g5 = agreger(tous.map(t => t.pnl5 / 100 / LEV));
  const g1 = agreger(tous.map(t => t.pnl1 / 100 / LEV));
  const transG = {};
  for (const t of tous) { const c = `${t.exit5}->${t.exit1}`; transG[c] = (transG[c] || 0) + 1; }
  const global = {
    nTrades: tous.length,
    esp5m: g5 ? g5.esp : null, esp1m: g1 ? g1.esp : null,
    deltaEsp: (g5 && g1) ? +(g1.esp - g5.esp).toFixed(2) : null,
    wr5m: g5 ? g5.wr : null, wr1m: g1 ? g1.wr : null,
    transitions: transG,
  };
  console.log(`\nGLOBAL ${global.nTrades} trades : esp5m=${global.esp5m} esp1m=${global.esp1m} delta=${global.deltaEsp} (% de marge/trade, x${LEV})`);

  const rapDir = path.join(__dirname, "rapports");
  fs.mkdirSync(rapDir, { recursive: true });
  const parModule = resultats.map(({ trades, ...reste }) => reste);
  fs.writeFileSync(path.join(rapDir, "minute_comparaison.json"), JSON.stringify({
    genere: new Date().toISOString(),
    methode: "memes trades (selection 5m officielle), exits rejoues sur 1m ; SL pire-cas d'abord, trail sur close ; entree = close 5m du signal ; couts et levier identiques",
    global, parModule,
  }, null, 1));
  fs.writeFileSync(path.join(rapDir, "minute_trades_detail.json"), JSON.stringify({
    genere: new Date().toISOString(),
    trades: resultats.filter(r => !r.erreur).map(r => ({ instId: r.instId, trades: r.trades })),
  }, null, 1));
  console.log("Rapports : tools/rapports/minute_comparaison.json + minute_trades_detail.json");
}

if (require.main === module) main();
