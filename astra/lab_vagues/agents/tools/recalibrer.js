// RECALIBRAGE AUTO — une seule commande :
//   1) télécharge les N derniers jours de bougies 5 m OKX (fraîches, publiques, aucune clé
//      requise) pour toutes les cryptos du bot LIVE (app/main.js, bloc HERMES15) et du
//      REGISTRE (REGISTRE_STRATEGIES.json + candidats PROPOSE suivis par tools/verif180.js) ;
//   2) rejoue CHAQUE stratégie TELLE QUELLE (harness_lib.sim, même blocage par symbole que
//      harness_lib.evaluer) sur ces bougies, découpée en deux fenêtres glissantes : 7 et 30
//      derniers jours ;
//   3) écrit tools/rapports/recalibrage_<date>.json avec esp/wr/n par stratégie + statut :
//        SAIN        : esp30 >= 0
//        DEGRADE     : esp30 <  0
//        MORT        : esp30 < -2  ET  n30 >= 20   (perte confirmée, pas du bruit d'échantillon)
//        SANS_SIGNAL : 0 trade entré dans les 30 j (hors barème demandé, cas informatif)
//
// Ne modifie JAMAIS harness_lib.js, test_harness.js, verif90_harness.js, ni aucun fichier de
// candidates/, ni app/main.js — tout est require() en LECTURE SEULE, comme le fait déjà
// tools/actualiser.js pour les candidats.
//
// Usage (depuis lab_vagues/agents) :
//   node tools/recalibrer.js [joursEval] [joursMarge]
//     joursEval  : fenêtre d'évaluation la plus longue à couvrir (def 30 ; doit être >= 7)
//     joursMarge : jours de bougies supplémentaires téléchargées EN AMONT pour le warm-up des
//                  detect() (def 4 -> 1152 barres, largement au-dessus du besoin max observé
//                  dans candidates/ : ~400 barres = 33 h pour les canaux de Keltner)
// Relançable à volonté (aucun cache : re-télécharge tout à chaque exécution, "fraîcheur" garantie).
const fs = require("fs");
const path = require("path");
const https = require("https");
const { sim, agg } = require("../harness_lib.js");
const { modules: LIVE9 } = require("./hermes15_modules.js");

const AGENTS = path.join(__dirname, "..");
const CANDIDATES = path.join(AGENTS, "candidates");
const DATA_DIR = path.join(AGENTS, "..", "data_recalibrage");
const RAPPORTS = path.join(__dirname, "rapports");
const BAR_MS = 5 * 60 * 1000;
const PAUSE_MS = 300; // respect du rate-limit public OKX (même valeur que les autres outils)

const JOURS_EVAL = Math.max(7, +process.argv[2] || 30);   // fenêtre longue (couvre aussi les 7 j)
const JOURS_MARGE = +process.argv[3] || 4;                 // warm-up detect() (max observé ~1,4 j)
const JOURS_COURT = 7;

/* ============================================================================
   1) PÉRIMÈTRE — LIVE (app/main.js, bloc HERMES15) + REGISTRE (candidats PROPOSE)
   ============================================================================ */

// LIVE : les 9 stratégies génériques du bot sont reproduites au centime par
// tools/hermes15_modules.js (contrôlé par tools/risque.js) ; la 10e (PIEVERSE, ajoutée en
// direct le 30/08, cf. app/main.js lignes ~2322-2325) est candidates/web_structure_1.js —
// mêmes exits (tp0.80/act0.30/hold12) que le bloc STRATS de main.js pour "double_extreme".
const LIVE = Object.entries(LIVE9).map(([nom, mod]) => ({
  nom, categorie: "LIVE", instId: mod.instId, module: `hermes15_modules.js (${nom})`, mod
}));
LIVE.push({
  nom: "PIEVERSE", categorie: "LIVE", instId: "PIEVERSE-USDT-SWAP",
  module: "candidates/web_structure_1.js",
  mod: require(path.join(CANDIDATES, "web_structure_1.js"))
});

// REGISTRE (PROPOSE) : candidats validés au banc 30 j, pas encore en live, suivis dans
// REGISTRE_STRATEGIES.json (champions[].statut === "PROPOSE"/"écarté") et dans la liste
// CHAMPIONS de tools/verif180.js. PIEVERSE (déjà EN_LIVE ci-dessus) est exclue d'ici.
const REGISTRE_FICHIERS = [
  { nom: "ENSO-alt (multiech_2)", fichier: "multiech_2.js" },
  { nom: "O (ti_arsenal_2)", fichier: "ti_arsenal_2.js" },
  { nom: "GRASS-alt1 (champions_2)", fichier: "champions_2.js" },
  { nom: "GRASS-alt2 (tf4h_1)", fichier: "tf4h_1.js" },
  { nom: "USELESS (patterns_2)", fichier: "patterns_2.js" },
  { nom: "GPS-alt (gen_regime_3)", fichier: "gen_regime_3.js" },
  { nom: "SOON-alt1 (web_vwap_1)", fichier: "web_vwap_1.js" },
  { nom: "SOON-alt2 (gen_keltner_2)", fichier: "gen_keltner_2.js" },
  { nom: "ESP (tv_ehlers_2)", fichier: "tv_ehlers_2.js" }
];
const REGISTRE = REGISTRE_FICHIERS.map(({ nom, fichier }) => {
  const mod = require(path.join(CANDIDATES, fichier));
  return { nom, categorie: "REGISTRE_PROPOSE", instId: mod.instId, module: "candidates/" + fichier, mod };
});

const STRATEGIES = [...LIVE, ...REGISTRE];
const INST_IDS = [...new Set(STRATEGIES.map(s => s.instId))].sort();

/* ============================================================================
   2) TÉLÉCHARGEMENT OKX public (même primitives que tools/actualiser.js / collecte180.js)
   ============================================================================ */
function httpGet(p) {
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
      const r = await httpGet(p);
      if (r.code === "0") return r;
      if (r.code === "50011") { await sleep(1500 * (i + 1)); continue; } // rate-limit
      return r;
    } catch { await sleep(900 * (i + 1)); }
  }
  return { code: "ERR", data: [] };
}

async function collecter(instId, depuisTs, maintenant) {
  const seen = new Map();
  let after = "", pages = 0;
  const maxPages = Math.ceil(((maintenant - depuisTs) / BAR_MS) / 100) + 20;
  for (; pages < maxPages; pages++) {
    const q = `/api/v5/market/history-candles?instId=${instId}&bar=5m&limit=100` + (after ? `&after=${after}` : "");
    const r = await getRetry(q);
    const d = r.data || [];
    if (!d.length) break;
    for (const c of d) seen.set(+c[0], [+c[0], +c[1], +c[2], +c[3], +c[4], +c[5]]);
    const old = +d[d.length - 1][0];
    if (old < depuisTs) break;
    after = String(old);
    await sleep(PAUSE_MS);
  }
  // bougies CLOSES uniquement (exclut la bougie 5 m en cours), fenêtre, tri, dédoublonnage
  const rows = [...seen.values()]
    .filter(c => c[0] >= depuisTs && c[0] + BAR_MS <= maintenant)
    .sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(path.join(DATA_DIR, instId + ".json"), JSON.stringify(rows));
  let gaps = 0;
  for (let i = 1; i < rows.length; i++) gaps += Math.round((rows[i][0] - rows[i - 1][0]) / BAR_MS) - 1;
  return { rows, gaps, pages };
}

/* ============================================================================
   3) REJEU séquentiel (blocage par symbole comme harness_lib.evaluer), découpe 7 j / 30 j
   ============================================================================ */
function rejouer(mod, c5, ts7, ts30) {
  const sigs = (mod.detect(c5) || []).sort((a, b) => a.i5 - b.i5);
  let busy = -1;
  const t30 = [], t7 = [];
  for (const s of sigs) {
    if (s.i5 <= busy || s.i5 >= c5.length - 2 || !s.dir) continue;
    const t = sim(c5, s.i5, s.dir, mod.exits);
    busy = s.i5 + t.dur;
    const entryTs = c5[s.i5][0];
    if (entryTs >= ts30) {
      t30.push(t);
      if (entryTs >= ts7) t7.push(t);
    }
  }
  return { t30, t7 };
}

function statut(esp30, n30) {
  if (esp30 == null) return "SANS_SIGNAL";
  if (esp30 < -2 && n30 >= 20) return "MORT";
  if (esp30 < 0) return "DEGRADE";
  return "SAIN";
}

/* ============================================================================ */
async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(RAPPORTS, { recursive: true });

  const maintenant = Date.now();
  const ts30 = maintenant - JOURS_EVAL * 86400 * 1000;
  const ts7 = maintenant - JOURS_COURT * 86400 * 1000;
  const depuisTs = ts30 - JOURS_MARGE * 86400 * 1000;

  console.log(`Périmètre : ${LIVE.length} stratégies LIVE + ${REGISTRE.length} stratégies REGISTRE (PROPOSE) sur ${INST_IDS.length} cryptos.`);
  console.log(`1/2 Téléchargement OKX 5 m — ${JOURS_EVAL} j éval + ${JOURS_MARGE} j warm-up (${JOURS_EVAL + JOURS_MARGE} j au total)…`);

  const collecte = {};
  for (const instId of INST_IDS) {
    const { rows, gaps, pages } = await collecter(instId, depuisTs, maintenant);
    collecte[instId] = rows;
    const attendu = Math.round((JOURS_EVAL + JOURS_MARGE) * 288);
    const span = rows.length ? `${new Date(rows[0][0]).toISOString().slice(0, 10)} -> ${new Date(rows[rows.length - 1][0]).toISOString().slice(0, 10)}` : "VIDE";
    console.log(`   ${instId.padEnd(20)} ${String(rows.length).padStart(5)}/${attendu} bougies  gaps:${gaps}  pages:${pages}  ${span}`);
  }

  console.log("2/2 Rejeu de chaque stratégie (7 j / 30 j)…");
  const lignes = [];
  for (const s of STRATEGIES) {
    const c5 = collecte[s.instId] || [];
    const attenduMin = Math.round(JOURS_EVAL * 288 * 0.6); // tolère quelques trous/retards de listing
    if (c5.length < attenduMin) {
      lignes.push({
        nom: s.nom, categorie: s.categorie, instId: s.instId, module: s.module,
        donnees: { statut: "INSUFFISANTES", bougies: c5.length, attendues: Math.round(JOURS_EVAL * 288) },
        esp7: null, wr7: null, n7: 0, pf7: null,
        esp30: null, wr30: null, n30: 0, pf30: null,
        statut: "DONNEES_INSUFFISANTES"
      });
      console.log(`   ${s.categorie.padEnd(16)} ${s.nom.padEnd(24)} (${s.instId}) : DONNEES_INSUFFISANTES (${c5.length} bougies)`);
      continue;
    }
    let r30 = null, r7 = null, err = null;
    try {
      const { t30, t7 } = rejouer(s.mod, c5, ts7, ts30);
      r30 = agg(t30); r7 = agg(t7);
    } catch (e) { err = e.message.split("\n")[0]; }
    if (err) {
      lignes.push({
        nom: s.nom, categorie: s.categorie, instId: s.instId, module: s.module,
        erreur: err,
        esp7: null, wr7: null, n7: 0, pf7: null,
        esp30: null, wr30: null, n30: 0, pf30: null,
        statut: "ERREUR"
      });
      console.log(`   ${s.categorie.padEnd(16)} ${s.nom.padEnd(24)} (${s.instId}) : ERREUR ${err}`);
      continue;
    }
    const st = statut(r30 ? r30.esp : null, r30 ? r30.n : 0);
    lignes.push({
      nom: s.nom, categorie: s.categorie, instId: s.instId, module: s.module,
      esp7: r7 ? r7.esp : null, wr7: r7 ? r7.wr : null, n7: r7 ? r7.n : 0, pf7: r7 ? r7.pf : null,
      esp30: r30 ? r30.esp : null, wr30: r30 ? r30.wr : null, n30: r30 ? r30.n : 0, pf30: r30 ? r30.pf : null,
      statut: st
    });
    console.log(`   ${s.categorie.padEnd(16)} ${s.nom.padEnd(24)} (${s.instId}) : esp7=${r7 ? r7.esp : "—"} (n${r7 ? r7.n : 0})  esp30=${r30 ? r30.esp : "—"} (n${r30 ? r30.n : 0})  -> ${st}`);
  }

  const synthese = cat => {
    const sub = lignes.filter(l => l.categorie === cat);
    const c = { SAIN: 0, DEGRADE: 0, MORT: 0, SANS_SIGNAL: 0, DONNEES_INSUFFISANTES: 0, ERREUR: 0 };
    for (const l of sub) c[l.statut] = (c[l.statut] || 0) + 1;
    return { total: sub.length, ...c };
  };

  const date = new Date(maintenant).toISOString().slice(0, 10);
  const rapport = {
    _doc: "Recalibrage automatique : stratégies LIVE (app/main.js HERMES15) et REGISTRE (candidats PROPOSE) rejouées TELLES QUELLES sur bougies 5 m OKX fraîchement téléchargées. esp = % de marge/trade net (levier x15, coûts inclus), même unité que le banc. SAIN = esp30>=0 ; DEGRADE = esp30<0 ; MORT = esp30<-2 ET n30>=20 ; SANS_SIGNAL = 0 trade sur 30 j.",
    genere: new Date(maintenant).toISOString(),
    parametres: { joursEval: JOURS_EVAL, joursCourt: JOURS_COURT, joursMarge: JOURS_MARGE },
    fenetre7: { de: new Date(ts7).toISOString(), a: new Date(maintenant).toISOString() },
    fenetre30: { de: new Date(ts30).toISOString(), a: new Date(maintenant).toISOString() },
    dossierDonnees: "lab_vagues/data_recalibrage",
    collecte: INST_IDS.map(id => ({ instId: id, bougies: collecte[id]?.length || 0 })),
    synthese: { live: synthese("LIVE"), registre_propose: synthese("REGISTRE_PROPOSE") },
    strategies: lignes
  };
  const fichier = path.join(RAPPORTS, `recalibrage_${date}.json`);
  fs.writeFileSync(fichier, JSON.stringify(rapport, null, 1));

  console.log(`\n=== ÉTAT ACTUEL — LIVE (${JOURS_EVAL} j) ===`);
  console.log("CRYPTO".padEnd(10), "esp7".padStart(7), "n7".padStart(5), "esp30".padStart(7), "n30".padStart(5), "wr30".padStart(6), " STATUT");
  for (const l of lignes.filter(l => l.categorie === "LIVE")) {
    console.log(l.instId.replace("-USDT-SWAP", "").padEnd(10),
      String(l.esp7 ?? "—").padStart(7), String(l.n7 ?? 0).padStart(5),
      String(l.esp30 ?? "—").padStart(7), String(l.n30 ?? 0).padStart(5), String(l.wr30 ?? "—").padStart(6),
      " " + l.statut);
  }
  console.log(`\nLIVE : ${JSON.stringify(rapport.synthese.live)}`);
  console.log(`REGISTRE (PROPOSE) : ${JSON.stringify(rapport.synthese.registre_propose)}`);
  console.log(`\nRapport : ${path.relative(AGENTS, fichier)}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { statut, rejouer };
