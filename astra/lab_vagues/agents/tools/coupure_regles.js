// CHANTIER RÈGLES DE COUPURE — agent indépendant (31/08).
// Pour CHAQUE stratégie EN_LIVE dans HERMES 15 (les 9 modules de hermes15_modules.js
// + PIEVERSE web_structure_1.js, ajoutée au bot le 30/08), rejoue les trades TELS QUELS
// sur data90 (fenêtre "jamais vue" 60 j : coupureTs = harness_lib.evaluer avec les mêmes
// règles que verif90_harness -> reproduit esp60/n60 publiés au centime, cf. contrôle),
// puis fait un bootstrap (10 000 tirages avec remise) de séquences de 30 trades sur cette
// distribution empirique pour trouver le seuil (somme des 30 trades) en-dessous duquel une
// vraie série live serait statistiquement incompatible avec le backtest (p<5%, i.e. un tel
// résultat n'arrive que <5% du temps si la stratégie se comporte réellement comme son
// backtest 60 j). Courbe supplémentaire N=5..30 pour un monitoring progressif (pas besoin
// d'attendre 30 trades pour un premier signal).
//
// Spécial PIEVERSE (verif180_2e_test_acide du REGISTRE : esp180 -0,56 sur le régime
// mars-mai 2026, edge DÉPENDANT DU RÉGIME) : le bootstrap "backtest pur" (régime récent
// seul, esp60 +7,98) est trop optimiste comme référence -> règle renforcée = bootstrap de
// MÉLANGE 50/50 (régime récent data90 unseen-60j / régime ancien data180 J-180->J-90) +
// seuil de significativité relevé à p<10 % (on coupe sur une preuve plus faible, exprès).
//
// Usage : node tools/coupure_regles.js  -> tools/rapports/regles_coupure.json (+ détail)
const fs = require("fs");
const path = require("path");
const { chargerCandles, sim, evaluer, LEV } = require("../harness_lib.js");
const { modules: H15, REFERENCE } = require("./hermes15_modules.js");

const RAPPORTS = path.join(__dirname, "rapports");
fs.mkdirSync(RAPPORTS, { recursive: true });
const DATA180 = path.join(__dirname, "..", "..", "data180");
const OOS_JOURS_COUPURE = 30 * 86400 * 1000; // même fenêtre que verif90_harness

const ITER = 10000;
const NS = [5, 10, 15, 20, 25, 30];
const P_STANDARD = 0.05;   // p<5% : seuil normal
const P_PIEVERSE = 0.10;   // p<10% : seuil renforcé, edge dépendant du régime

// ---- RNG déterministe (mulberry32) : résultats reproductibles d'un run à l'autre ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// ---- rejoue un module TEL QUEL, avec la même logique que harness_lib.evaluer (tri i5,
// blocage busy, coupureTs), mais retourne la LISTE des trades (pnl en % de marge) ----
function collecterTrades(mod, c5, coupureTs) {
  const sigs = (mod.detect(c5) || []).slice().sort((a, b) => a.i5 - b.i5);
  const out = [];
  let busy = -1;
  for (const s of sigs) {
    if (s.i5 <= busy || s.i5 >= c5.length - 2 || !s.dir) continue;
    if (coupureTs && c5[s.i5][0] >= coupureTs) continue;
    const t = sim(c5, s.i5, s.dir, mod.exits);
    busy = s.i5 + t.dur;
    out.push({ pnlPct: 100 * t.pnl * LEV, entryTs: c5[s.i5][0], exitTs: c5[s.i5 + t.dur][0] });
  }
  return out;
}

function agrege(trades) {
  const n = trades.length;
  if (!n) return null;
  const sum = trades.reduce((s, t) => s + t.pnlPct, 0);
  const w = trades.filter(t => t.pnlPct > 0).length;
  const gp = trades.filter(t => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
  const gn = -trades.filter(t => t.pnlPct <= 0).reduce((s, t) => s + t.pnlPct, 0);
  return { n, esp: +(sum / n).toFixed(2), wr: +(100 * w / n).toFixed(1), pf: gn > 0 ? +(gp / gn).toFixed(2) : 99 };
}

// ---- bootstrap : population = liste de valeurs pnlPct (une ou plusieurs poches mélangées
// à parts égales si `pools` a plusieurs entrées) ; renvoie pour chaque N de `ns` la somme
// triée des ITER tirages de N trades ----
function bootstrap(pools, ns, iter, seed) {
  const rng = mulberry32(seed);
  const maxN = Math.max(...ns);
  const nPools = pools.length;
  // pour chaque itération on tire maxN trades (poche choisie uniformément si mélange),
  // et on lit les sommes cumulées aux paliers N demandés -> une seule passe de tirage.
  const sommesParN = Object.fromEntries(ns.map(n => [n, new Array(iter)]));
  for (let it = 0; it < iter; it++) {
    let cum = 0;
    let iN = 0;
    for (let k = 1; k <= maxN; k++) {
      const pool = nPools === 1 ? pools[0] : pools[Math.floor(rng() * nPools)];
      const v = pool[Math.floor(rng() * pool.length)];
      cum += v;
      if (ns[iN] === k) { sommesParN[k][it] = cum; iN++; }
    }
  }
  const out = {};
  for (const n of ns) out[n] = sommesParN[n].slice().sort((a, b) => a - b);
  return out;
}

function quantile(sortedArr, p) {
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.round(p * (sortedArr.length - 1))));
  return sortedArr[idx];
}
function moyenne(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }

// ---- liste des stratégies EN_LIVE dans HERMES 15 (REGISTRE_STRATEGIES.json) ----
const LIVE = [
  { id: "PIEVERSE", instId: "PIEVERSE-USDT-SWAP", moduleSrc: "candidates/web_structure_1.js", refEsp60: 7.98, special: "regime_dependant" },
  { id: "ENSO", instId: "ENSO-USDT-SWAP", moduleSrc: "hermes15:ENSO", refEsp60: 6.1 },
  { id: "GRASS", instId: "GRASS-USDT-SWAP", moduleSrc: "hermes15:GRASS", refEsp60: 3.09 },
  { id: "SOON", instId: "SOON-USDT-SWAP", moduleSrc: "hermes15:SOON", refEsp60: null },
  { id: "LUNA", instId: "LUNA-USDT-SWAP", moduleSrc: "hermes15:LUNA", refEsp60: null },
  { id: "NES", instId: "NES-USDT-SWAP", moduleSrc: "hermes15:NES", refEsp60: null },
  { id: "MEGA", instId: "MEGA-USDT-SWAP", moduleSrc: "hermes15:MEGA", refEsp60: null },
  { id: "MANA", instId: "MANA-USDT-SWAP", moduleSrc: "hermes15:MANA", refEsp60: null },
  { id: "GPS", instId: "GPS-USDT-SWAP", moduleSrc: "hermes15:GPS", refEsp60: null },
  { id: "AXS", instId: "AXS-USDT-SWAP", moduleSrc: "hermes15:AXS", refEsp60: null }
];

function chargerModule(moduleSrc) {
  if (moduleSrc.startsWith("hermes15:")) return H15[moduleSrc.split(":")[1]];
  return require(path.resolve(__dirname, "..", moduleSrc));
}

const detail = [];
const regles = [];

for (const st of LIVE) {
  const mod = chargerModule(st.moduleSrc);
  const c5 = chargerCandles("data90", st.instId);
  const coupureTs = c5[c5.length - 1][0] - OOS_JOURS_COUPURE;
  const tradesRecents = collecterTrades(mod, c5, coupureTs); // fenêtre "jamais vue" 60 j (= esp60 publié)
  const aggRecent = agrege(tradesRecents);
  const controle = st.refEsp60 != null ? { refEsp60: st.refEsp60, obtenu: aggRecent?.esp ?? null, match: aggRecent && Math.abs(aggRecent.esp - st.refEsp60) < 0.011 } : null;

  const poolRecent = tradesRecents.map(t => t.pnlPct);
  const ligne = {
    id: st.id, instId: st.instId, moduleSrc: st.moduleSrc,
    fenetre: { de: new Date(c5[0][0]).toISOString().slice(0, 10), coupure: new Date(coupureTs).toISOString().slice(0, 10) },
    backtest_60j_jamais_vu: aggRecent,
    controle_reproduction_registre: controle
  };

  if (poolRecent.length < 10) {
    ligne.erreur = `population insuffisante pour bootstrap (n=${poolRecent.length} < 10)`;
    detail.push(ligne);
    continue;
  }

  // ---- bootstrap standard (régime récent seul, p<5%) ----
  const bootStd = bootstrap([poolRecent], NS, ITER, hashSeed(st.id + ":std"));
  const courbeStd = NS.map(n => ({
    N: n,
    seuil_somme_p5: +quantile(bootStd[n], P_STANDARD).toFixed(2),
    seuil_moyenne_p5: +(quantile(bootStd[n], P_STANDARD) / n).toFixed(2),
    somme_moyenne_attendue: +moyenne(bootStd[n]).toFixed(2),
    proba_somme_negative: +(bootStd[n].filter(x => x < 0).length / ITER * 100).toFixed(1)
  }));
  ligne.bootstrap_standard = { iterations: ITER, p: P_STANDARD, population_n: poolRecent.length, courbe: courbeStd };

  let regleRetenue;
  if (st.special === "regime_dependant") {
    // ---- PIEVERSE : mélange 50/50 régime récent (data90 unseen-60j) / régime ancien
    // (data180 J-180->J-90, 100% vierge, evaluer().all sans coupure -> même calcul que
    // verif180.js) + seuil relevé p<10% ----
    const f180 = path.join(DATA180, st.instId + ".json");
    if (!fs.existsSync(f180)) { ligne.erreur_special = "data180 absent, règle stricte non calculable"; detail.push(ligne); continue; }
    const c180 = JSON.parse(fs.readFileSync(f180));
    const rAncien = evaluer(mod, c180).all; // agrégat, pour contrôle vs verif180_resultats.json
    const tradesAnciens = collecterTrades(mod, c180, null); // aucune coupure : fenêtre déjà 100% vierge
    const aggAncien = agrege(tradesAnciens);
    ligne.regime_ancien_data180 = { fenetre: "J-180 -> J-90 (2e test acide)", ...aggAncien, controle_vs_verif180: rAncien ? { refEsp: -0.56, obtenu: rAncien.esp, match: Math.abs(rAncien.esp - (-0.56)) < 0.011 } : null };

    const poolAncien = tradesAnciens.map(t => t.pnlPct);
    const bootMix = bootstrap([poolRecent, poolAncien], NS, ITER, hashSeed(st.id + ":mix"));
    const courbeMix = NS.map(n => ({
      N: n,
      seuil_somme_p10: +quantile(bootMix[n], P_PIEVERSE).toFixed(2),
      seuil_moyenne_p10: +(quantile(bootMix[n], P_PIEVERSE) / n).toFixed(2),
      somme_moyenne_attendue: +moyenne(bootMix[n]).toFixed(2),
      proba_somme_negative: +(bootMix[n].filter(x => x < 0).length / ITER * 100).toFixed(1)
    }));
    ligne.bootstrap_renforce_melange_regimes = {
      iterations: ITER, p: P_PIEVERSE,
      population: "50% pool régime récent (esp60 +7,98) / 50% pool régime ancien mars-mai 2026 (esp180 -0,56)",
      courbe: courbeMix
    };

    const c30 = courbeMix.find(x => x.N === 30);
    regleRetenue = {
      regle: `couper PIEVERSE si la somme des 30 derniers trades < ${c30.seuil_somme_p10} % de marge`,
      N: 30, seuil_somme: c30.seuil_somme_p10, seuil_moyenne_par_trade: c30.seuil_moyenne_p10,
      base: "bootstrap renforcé (mélange 50/50 régime récent/ancien, p<10%)",
      alerte_precoce: `surveillance rapprochée dès N=15 (somme < ${courbeMix.find(x => x.N === 15).seuil_somme_p10})`,
      justification: "edge dépendant du régime (verif180 : esp180 -0,56 sur mars-mai 2026, pf 0,96) — le bootstrap sur le seul régime récent (esp60 +7,98) sous-estime le risque réel ; seuil relevé à p<10% pour couper sur une preuve plus faible."
    };
  } else {
    const c30 = courbeStd.find(x => x.N === 30);
    regleRetenue = {
      regle: `couper ${st.id} si la somme des 30 derniers trades < ${c30.seuil_somme_p5} % de marge`,
      N: 30, seuil_somme: c30.seuil_somme_p5, seuil_moyenne_par_trade: c30.seuil_moyenne_p5,
      base: "bootstrap standard (régime récent 60j jamais vu, p<5%)",
      alerte_precoce: `surveillance rapprochée dès N=15 (somme < ${courbeStd.find(x => x.N === 15).seuil_somme_p5})`
    };
  }
  ligne.regle_coupure = regleRetenue;
  detail.push(ligne);
  regles.push({
    strategie: st.id, instId: st.instId,
    ...regleRetenue,
    esp60_backtest: aggRecent.esp, n60_backtest: aggRecent.n
  });
}

// ---- écriture des rapports ----
const meta = {
  _doc: "Règles de coupure par stratégie EN_LIVE (HERMES 15 + PIEVERSE). Méthode : rejeu TEL QUEL sur data90 (harness_lib.sim/evaluer, coûts+pire-cas+blocage symbole identiques au banc) restreint à la fenêtre 60j jamais vue (coupureTs = -30j, même calcul que verif90_harness -> reproduit esp60 du REGISTRE) = distribution empirique de trades = 'le backtest'. Bootstrap 10 000 tirages avec remise de séquences de N trades depuis cette distribution -> seuil = Xe percentile (p<5% standard, p<10% pour PIEVERSE) de la somme des N trades : une vraie série live sous ce seuil n'a que <5%/<10% de chances de provenir de la même distribution que le backtest -> statistiquement incompatible -> couper. Courbe N=5..30 fournie pour un monitoring progressif ; la règle officielle porte sur N=30 (demande du chantier). PIEVERSE : règle renforcée (population = mélange 50/50 avec le régime ancien data180 où l'edge s'est inversé, verif180_2e_test_acide du REGISTRE, + seuil p<10%).",
  genere: new Date().toISOString(),
  iterations_bootstrap: ITER,
  seuils_significativite: { standard: P_STANDARD, pieverse: P_PIEVERSE },
  seed_rng: "mulberry32, seed = FNV-1a hash de l'id de stratégie (déterministe, reproductible)"
};

fs.writeFileSync(path.join(RAPPORTS, "coupure_detail_bootstrap.json"), JSON.stringify({ ...meta, strategies: detail }, null, 1));
fs.writeFileSync(path.join(RAPPORTS, "regles_coupure.json"), JSON.stringify({ ...meta, regles }, null, 1));

console.log("STRATEGIE".padEnd(10), "esp60".padStart(7), "n60".padStart(5), " REGLE (N=30)");
for (const r of regles) console.log(r.strategie.padEnd(10), String(r.esp60_backtest).padStart(7), String(r.n60_backtest).padStart(5), " " + r.regle);
console.log("\nRapports : tools/rapports/regles_coupure.json + coupure_detail_bootstrap.json");
