// CHANTIER FRAÎCHEUR — nos données data/ s'arrêtent au moment de la collecte.
// Cet outil mesure la tenue des champions en CONDITIONS ACTUELLES :
//   1) reclasse tous les candidates/ sur le banc 30 j officiel (data/, test_harness inchangé)
//      -> top 15 des modules valides par worst décroissant ;
//   2) télécharge les bougies 5 m OKX les plus fraîches (96 h : 48 h de marge de warm-up
//      pour les detect() à fenêtre <= 288 barres + 48 h d'évaluation) dans ../../data_frais/
//      (même niveau que data/ et data90/, format identique, pause 300 ms entre pages) ;
//   3) rejoue chaque module TEL QUEL sur ces données (signaux mod.detect + exits harness_lib.sim,
//      même blocage par symbole que harness_lib.evaluer) en ne comptant que les trades
//      ENTRÉS dans les dernières 48 h.
// ⚠️ 48 h = très peu de trades par module : le n est rapporté partout, seul l'agrégat
//    toutes-stratégies a un début de sens. Premier indice, pas un verdict.
// Usage : node tools/actualiser.js            (depuis lab_vagues/agents)
// Rapports : tools/rapports/fraicheur_collecte.json / fraicheur_resultats.json / fraicheur_synthese.json
const fs = require("fs");
const path = require("path");
const https = require("https");
const { chargerCandles, sim, agg, evaluer, LEV, COUT_PX } = require("../harness_lib.js");

const AGENTS = path.join(__dirname, "..");
const DATA_FRAIS = path.join(AGENTS, "..", "data_frais");
const RAPPORTS = path.join(__dirname, "rapports");
const TOP_N = 15;
const HEURES_EVAL = 48;          // fenêtre d'évaluation demandée
const HEURES_MARGE = 48;         // warm-up pour les detect() (max observé : 288 barres = 24 h)
const BAR_MS = 5 * 60 * 1000;
const PAUSE_MS = 300;            // respect du rate-limit OKX public

/* ---------- OKX public (mêmes primitives que verif90_harness/collecte1m) ---------- */
function get(p) {
  return new Promise((res, rej) => {
    https.get({ hostname: "www.okx.com", path: p, headers: { "User-Agent": "hermes-lab" } }, r => {
      let d = ""; r.on("data", c => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getRetry(p) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await get(p);
      if (r.code === "0") return r;
      if (r.code === "50011") { await sleep(1500 * (i + 1)); continue; } // rate-limit
      return r;
    } catch { await sleep(900 * (i + 1)); }
  }
  return { code: "ERR", data: [] };
}

/* ---------- étape 1 : top 15 du banc 30 j ---------- */
function classerCandidats() {
  const fichiers = fs.readdirSync(path.join(AGENTS, "candidates")).filter(f => f.endsWith(".js")).sort();
  const lignes = [], casses = [];
  for (const f of fichiers) {
    const rel = "candidates/" + f;
    let mod;
    try { mod = require(path.join(AGENTS, rel)); }
    catch (e) { casses.push({ module: rel, erreur: e.message.split("\n")[0] }); continue; }
    let c5;
    try { c5 = chargerCandles("data", mod.instId); }
    catch (e) { casses.push({ module: rel, instId: mod.instId, erreur: "data/ manquant : " + e.message.split("\n")[0] }); continue; }
    const r = evaluer(mod, c5);
    lignes.push({
      module: rel, instId: mod.instId,
      espIS: r.A?.esp ?? null, espOOS: r.B?.esp ?? null,
      nIS: r.A?.n ?? 0, nOOS: r.B?.n ?? 0,
      worst: (r.A && r.B) ? Math.min(r.A.esp, r.B.esp) : null,
      valide: !!(r.A && r.B && r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15)
    });
  }
  lignes.sort((a, b) => (b.valide - a.valide) || ((b.worst ?? -999) - (a.worst ?? -999)));
  return { top: lignes.filter(l => l.valide).slice(0, TOP_N), casses, total: fichiers.length };
}

/* ---------- étape 2 : collecte 96 h de 5 m frais ---------- */
async function collecterFrais(instId, depuisTs, maintenant) {
  let rows = [], after = "";
  for (let page = 0; page < 40; page++) {   // 96 h = 1152 bougies ≈ 12 pages de 100
    const q = `/api/v5/market/history-candles?instId=${instId}&bar=5m&limit=100` + (after ? `&after=${after}` : "");
    const r = await getRetry(q);
    const d = r.data || [];
    if (!d.length) break;
    for (const c of d) rows.push([+c[0], +c[1], +c[2], +c[3], +c[4], +c[5]]);
    const old = +d[d.length - 1][0];
    if (old < depuisTs) break;
    after = String(old);
    await sleep(PAUSE_MS);
  }
  // bougies closes uniquement (la bougie 5 m en cours est exclue), fenêtre, tri, dédoublonnage
  rows = rows.filter(c => c[0] >= depuisTs && c[0] + BAR_MS <= maintenant).sort((a, b) => a[0] - b[0]);
  const dedup = []; let prev = -1;
  for (const c of rows) { if (c[0] !== prev) dedup.push(c); prev = c[0]; }
  fs.writeFileSync(path.join(DATA_FRAIS, instId + ".json"), JSON.stringify(dedup));
  let trous = 0;
  for (let i = 1; i < dedup.length; i++) trous += Math.round((dedup[i][0] - dedup[i - 1][0]) / BAR_MS) - 1;
  return { rows: dedup, trous };
}

/* ---------- étape 3 : rejouer un module sur le frais (fenêtre 48 h) ---------- */
// Même logique de blocage par symbole que harness_lib.evaluer, mais on ne garde que
// les trades entrés dans [tsDebutEval, fin] ; exits = harness_lib.sim, inchangé.
// tsFinData = dernier ts de data/<instId> : les trades entrés APRÈS sont "inedit"
// (bougies postérieures à la collecte du banc — jamais vues par aucune optimisation).
function rejouer(mod, c5, tsDebutEval, tsFinData) {
  const sigs = (mod.detect(c5) || []).sort((a, b) => a.i5 - b.i5);
  const hold = Math.round((mod.exits.holdH ?? 12) * 12);
  const pnlTp = mod.exits.tp / LEV - COUT_PX;
  const pnlSl = -Math.min(mod.exits.sl, 0.30) / LEV - COUT_PX;
  const trades = [];
  let busy = -1, sigsFenetre = 0;
  for (const s of sigs) {
    if (s.i5 <= busy || s.i5 >= c5.length - 2 || !s.dir) continue;
    if (c5[s.i5][0] < tsDebutEval) { // avant la fenêtre : on bloque quand même le symbole (réalisme)
      const t = sim(c5, s.i5, s.dir, mod.exits);
      busy = s.i5 + t.dur;
      continue;
    }
    sigsFenetre++;
    const t = sim(c5, s.i5, s.dir, mod.exits);
    busy = s.i5 + t.dur;
    const finDonnees = (s.i5 + t.dur === c5.length - 1) && t.dur < hold;
    let sortie;
    if (Math.abs(t.pnl - pnlTp) < 1e-9) sortie = "tp";
    else if (Math.abs(t.pnl - pnlSl) < 1e-9) sortie = "sl";
    else if (finDonnees) sortie = "fin_donnees";           // trade tronqué par la fin des données
    else if (t.dur >= hold) sortie = "timeout";
    else sortie = "trail";
    trades.push({
      entree: new Date(c5[s.i5][0]).toISOString(), dir: s.dir,
      pnlMarge: +(t.pnl * LEV * 100).toFixed(2), durBarres: t.dur, sortie,
      inedit: tsFinData != null ? c5[s.i5][0] > tsFinData : null
    });
  }
  return { trades, sigsFenetre };
}

async function main() {
  fs.mkdirSync(DATA_FRAIS, { recursive: true });
  fs.mkdirSync(RAPPORTS, { recursive: true });
  const maintenant = Date.now();
  const tsDebutEval = maintenant - HEURES_EVAL * 3600 * 1000;
  const depuisTs = tsDebutEval - HEURES_MARGE * 3600 * 1000;

  console.log("1/3 Classement banc 30 j de tous les candidats…");
  const { top, casses, total } = classerCandidats();
  console.log(`   ${total} modules, ${casses.length} inutilisables, top ${top.length} retenu (worst ${top[top.length - 1]?.worst} à ${top[0]?.worst})`);
  for (const c of casses) console.log(`   ⚠️ ignoré : ${c.module} (${c.erreur})`);

  const instIds = [...new Set(top.map(t => t.instId))];
  console.log(`2/3 Collecte OKX 5 m — ${HEURES_MARGE + HEURES_EVAL} h (${HEURES_MARGE} h warm-up + ${HEURES_EVAL} h éval) — ${instIds.length} instruments…`);
  const collecte = {}, bilanCollecte = [];
  for (const id of instIds) {
    const { rows, trous } = await collecterFrais(id, depuisTs, maintenant);
    collecte[id] = rows;
    const span = rows.length ? `${new Date(rows[0][0]).toISOString()} -> ${new Date(rows[rows.length - 1][0]).toISOString()}` : "VIDE";
    bilanCollecte.push({ instId: id, bougies: rows.length, trous, de: rows[0]?.[0] ?? null, a: rows[rows.length - 1]?.[0] ?? null });
    console.log(`   ${id} : ${rows.length} bougies (${trous} trou(s)) ${span}`);
  }
  fs.writeFileSync(path.join(RAPPORTS, "fraicheur_collecte.json"), JSON.stringify({
    genere: new Date().toISOString(), heuresTotal: HEURES_MARGE + HEURES_EVAL, heuresEval: HEURES_EVAL,
    depuisTs, tsDebutEval, dossier: "lab_vagues/data_frais", bilan: bilanCollecte
  }, null, 1));

  console.log("3/3 Rejeu des modules sur les 48 h fraîches…");
  const resultats = [], tousTrades = [];
  for (const t of top) {
    const mod = require(path.join(AGENTS, t.module));
    const c5 = collecte[t.instId] || [];
    const attendu = Math.round((HEURES_MARGE + HEURES_EVAL) * 12);
    if (c5.length < attendu * 0.8) {
      resultats.push({ ...t, fraicheur: { statut: "DONNEES_INSUFFISANTES", bougies: c5.length } });
      console.log(`   ${t.module} (${t.instId}) : données insuffisantes (${c5.length}/${attendu})`);
      continue;
    }
    let tsFinData = null;
    try { const d30 = chargerCandles("data", t.instId); tsFinData = d30[d30.length - 1][0]; } catch { }
    const { trades, sigsFenetre } = rejouer(mod, c5, tsDebutEval, tsFinData);
    const a = agg(trades.map(x => ({ pnl: x.pnlMarge / 100 / LEV })));
    const aNet = agg(trades.filter(x => x.sortie !== "fin_donnees").map(x => ({ pnl: x.pnlMarge / 100 / LEV })));
    const aIned = agg(trades.filter(x => x.inedit).map(x => ({ pnl: x.pnlMarge / 100 / LEV })));
    resultats.push({
      ...t,
      fraicheur: {
        statut: "OK", n: trades.length, signaux: sigsFenetre,
        esp: a?.esp ?? null, wr: a?.wr ?? null, pf: a?.pf ?? null,
        nHorsTronques: aNet?.n ?? 0, espHorsTronques: aNet?.esp ?? null,
        nInedit: aIned?.n ?? 0, espInedit: aIned?.esp ?? null,
        finData: tsFinData != null ? new Date(tsFinData).toISOString() : null,
        trades
      }
    });
    tousTrades.push(...trades.map(x => ({ ...x, module: t.module, instId: t.instId })));
    console.log(`   ${t.module} (${t.instId}) : n=${trades.length} esp=${a?.esp ?? "—"} (worst30 ${t.worst})`);
  }
  fs.writeFileSync(path.join(RAPPORTS, "fraicheur_resultats.json"), JSON.stringify({
    genere: new Date().toISOString(),
    fenetreEval: { de: new Date(tsDebutEval).toISOString(), a: new Date(maintenant).toISOString(), heures: HEURES_EVAL },
    note: "esp en % de marge/trade (levier x15, coûts inclus), même unité que le banc 30 j. n minuscule sur 48 h : NE PAS sur-interpréter par module ; l'agrégat toutes-stratégies est le seul chiffre à peu près utilisable. 'fin_donnees' = trade tronqué par la fin des données (position encore ouverte).",
    modulesCasses: casses, resultats
  }, null, 1));

  const g = agg(tousTrades.map(x => ({ pnl: x.pnlMarge / 100 / LEV })));
  const gNet = agg(tousTrades.filter(x => x.sortie !== "fin_donnees").map(x => ({ pnl: x.pnlMarge / 100 / LEV })));
  const gIned = agg(tousTrades.filter(x => x.inedit).map(x => ({ pnl: x.pnlMarge / 100 / LEV })));
  const parSortie = {};
  for (const x of tousTrades) parSortie[x.sortie] = (parSortie[x.sortie] || 0) + 1;
  const synthese = {
    genere: new Date().toISOString(),
    fenetreEval: { de: new Date(tsDebutEval).toISOString(), a: new Date(maintenant).toISOString(), heures: HEURES_EVAL },
    modulesTestes: resultats.filter(r => r.fraicheur.statut === "OK").length,
    agregat: g ? { n: g.n, espParTrade: g.esp, wr: g.wr, pf: g.pf } : null,
    agregatHorsTronques: gNet ? { n: gNet.n, espParTrade: gNet.esp, wr: gNet.wr, pf: gNet.pf } : null,
    agregatInedit: gIned ? { n: gIned.n, espParTrade: gIned.esp, wr: gIned.wr, pf: gIned.pf, note: "trades entrés APRÈS la fin de data/ : bougies jamais vues par aucune optimisation" } : null,
    parSortie,
    parModule: resultats.map(r => ({
      module: r.module, instId: r.instId, worst30: r.worst,
      n48h: r.fraicheur.n ?? 0, esp48h: r.fraicheur.esp ?? null,
      nInedit: r.fraicheur.nInedit ?? 0, espInedit: r.fraicheur.espInedit ?? null,
      statut: r.fraicheur.statut
    })),
    caveats: [
      `${HEURES_EVAL} h seulement : n minuscule, bruit énorme — premier indice de tenue, pas une validation.`,
      "Le banc 5 m est optimiste de ~15 % (chantier précision 1 m) : le même haircut s'applique ici.",
      "Les trades 'fin_donnees' sont tronqués (position théoriquement encore ouverte) — agrégat fourni avec et sans.",
      "La fenêtre 48 h peut chevaucher la fin de data/ (OOS du banc) : ce n'est pas 48 h entièrement inédites si la collecte data/ est récente."
    ]
  };
  fs.writeFileSync(path.join(RAPPORTS, "fraicheur_synthese.json"), JSON.stringify(synthese, null, 1));
  console.log(`\nAGRÉGAT ${HEURES_EVAL} h : n=${g?.n ?? 0} esp=${g?.esp ?? "—"} %/trade (hors tronqués : n=${gNet?.n ?? 0} esp=${gNet?.esp ?? "—"} | inédit post-data/ : n=${gIned?.n ?? 0} esp=${gIned?.esp ?? "—"})`);
  console.log("Rapports : tools/rapports/fraicheur_collecte.json, fraicheur_resultats.json, fraicheur_synthese.json");
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
