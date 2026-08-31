// TÉLÉMÉTRIE LIVE vs BACKTEST — HERMES
// Lit les fills réels OKX (trade/fills-history, fallback trade/fills), reconstruit les
// trades réels (entrée -> sortie) par instId, calcule le PnL %marge réel par trade et par
// crypto, la part d'entrées maker, et compare aux espérances attendues du REGISTRE_STRATEGIES.json.
//
// LECTURE SEULE : uniquement des GET (trade/fills, trade/fills-history, account/positions,
// account/positions-history, public/time). Aucun ordre, aucun POST de trading.
//
// Sortie : tools/rapports/telemetrie_<date>.json
//
// Méthode de calcul du "% marge net" par trade :
//   OKX ne renvoie pas directement le "PnL % de marge NET (après frais/funding)" dans
//   positions-history — seulement pnlRatio = pnl_BRUT / marge (avant frais/funding).
//   On retrouve la marge implicite   marge_est = pnl_brut / pnlRatio   (cohérent, cf.
//   contrôle croisé avec le champ `margin` des positions encore ouvertes : même ordre de
//   grandeur), puis on calcule   pctMargeNet = realizedPnl(net frais+funding) / marge_est.
//   C'est ce dernier chiffre qui est comparable à l'"esp60" du registre (qui est net de coûts).

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..", "..", "..");          // HERMES_V4_LIVE
const AGENTS_DIR = path.join(__dirname, "..");                 // lab_vagues/agents
const RAPPORTS_DIR = path.join(__dirname, "rapports");
fs.mkdirSync(RAPPORTS_DIR, { recursive: true });

// ---------- .env (lecture seule) ----------
function loadEnv(p) {
  const env = {};
  const txt = fs.readFileSync(p, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return env;
}
const ENV = loadEnv(path.join(ROOT, ".env"));
const KEY = ENV.OKX_API_KEY, SECRET = ENV.OKX_API_SECRET, PASS = ENV.OKX_API_PASSPHRASE;
if (!KEY || !SECRET || !PASS) throw new Error("Clés OKX manquantes dans .env (OKX_API_KEY/SECRET/PASSPHRASE)");

// ---------- client OKX signé (GET uniquement) ----------
function sign(ts, method, reqPath, body, secret) {
  return crypto.createHmac("sha256", secret).update(ts + method + reqPath + (body || "")).digest("base64");
}
function httpGet(reqPath) {
  return new Promise((resolve, reject) => {
    const ts = new Date().toISOString();
    const sig = sign(ts, "GET", reqPath, "", SECRET);
    const headers = {
      "OK-ACCESS-KEY": KEY, "OK-ACCESS-PASSPHRASE": PASS,
      "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-SIGN": sig, "Content-Type": "application/json",
    };
    const r = https.request({ hostname: "www.okx.com", path: reqPath, method: "GET", headers }, res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d) }); }
        catch (e) { reject(new Error("JSON invalide OKX: " + e.message)); }
      });
    });
    r.on("error", reject);
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getGET(pathBase, qs, tries = 6) {
  const q = "?" + new URLSearchParams(qs).toString();
  const reqPath = pathBase + q;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const { json } = await httpGet(reqPath);
      if (json && json.code === "0") return json;
      // erreurs transitoires connues côté OKX -> retry
      if (json && ["50026", "50011", "50013"].includes(json.code)) { lastErr = json; await sleep(600 * (i + 1)); continue; }
      return json; // erreur définitive (permission, param invalide...) -> remontée telle quelle
    } catch (e) { lastErr = e; await sleep(600 * (i + 1)); }
  }
  return { code: "ERR", msg: "échec après retries: " + JSON.stringify(lastErr && lastErr.msg || lastErr), data: [] };
}

// Pagination par curseur `after`. IMPORTANT (découvert empiriquement, non documenté
// clairement) : sur trade/fills(-history) `after` attend le billId de la dernière ligne ;
// sur account/positions-history `after` attend en fait un TIMESTAMP (le uTime de la
// dernière ligne), PAS le posId — un posId peut être réutilisé par plusieurs événements de
// clôture distincts (scale-in/out), donc paginer par posId saute des lignes et dédoublonner
// dessus en SUPPRIME à tort. Et surtout : dès qu'un curseur `after` est fourni, OKX semble
// IGNORER silencieusement `begin`/`end` sur account/positions-history (constaté : la
// pagination continue sur l'historique COMPLET du compte, ~5600 lignes remontant bien avant
// la fenêtre demandée, au lieu de s'arrêter à J-3) -> on renforce donc le filtrage `begin`
// côté client (sur tsField) et on arrête dès qu'une page contient une ligne antérieure à la
// fenêtre, quoi que renvoie le serveur.
async function paginerParAfter(pathBase, qsBase, cursorField, tsField, dedupKeyFn, begin, warnings, label) {
  let out = [];
  let after;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const qs = { ...qsBase, begin: String(begin), limit: "100" };
    if (after) qs.after = String(after);
    const r = await getGET(pathBase, qs);
    if (r.code !== "0") { warnings.push(`${label}: page ${page} échouée (${r.code} ${r.msg || ""}), arrêt pagination`); break; }
    const d = r.data || [];
    if (!d.length) break;
    let added = 0, hitBoundary = false;
    for (const row of d) {
      if (+row[tsField] < begin) { hitBoundary = true; continue; } // filtrage client, begin pas fiable côté serveur avec `after`
      const k = dedupKeyFn(row);
      if (!seen.has(k)) { seen.add(k); out.push(row); added++; }
    }
    if (hitBoundary) break; // page suivante forcément encore plus ancienne -> inutile de continuer
    if (d.length < 100) break;
    after = d[d.length - 1][cursorField];
    if (added === 0) break; // garde-fou anti boucle infinie si le curseur ne progresse plus
    await sleep(220);
  }
  return out;
}

function fmt(n, dec = 2) { return +(+n).toFixed(dec); }

(async () => {
  const warnings = [];
  const now = Date.now();
  const FENETRE_JOURS = 3;
  const begin = now - FENETRE_JOURS * 86400 * 1000;

  // Ancre "lancement" fournie par le contexte client (mémoire) : 30/08/2026 ~14h30 UTC+2 = 12h30 UTC.
  const ancreLancementMemoire = Date.parse("2026-08-30T12:30:00.000Z");

  console.log(`[telemetrie] fenêtre ${new Date(begin).toISOString()} -> ${new Date(now).toISOString()}`);

  // ---------- 1) FILLS (trade/fills-history, fallback trade/fills) ----------
  let fills = await paginerParAfter("/api/v5/trade/fills-history", { instType: "SWAP" }, "billId", "fillTime", row => row.billId, begin, warnings, "fills-history");
  let sourceFills = "trade/fills-history";
  if (!fills.length) {
    warnings.push("trade/fills-history vide ou inaccessible -> repli sur trade/fills (3 derniers jours, sans permission spéciale)");
    fills = await paginerParAfter("/api/v5/trade/fills", { instType: "SWAP" }, "billId", "fillTime", row => row.billId, begin, warnings, "fills");
    sourceFills = "trade/fills";
  }
  fills.sort((a, b) => +a.fillTime - +b.fillTime);
  console.log(`[telemetrie] ${fills.length} fills récupérés via ${sourceFills}`);

  // ---------- 2) POSITIONS FERMÉES (account/positions-history) ----------
  // curseur = uTime (timestamp), dédoublonnage = posId+uTime (un posId peut porter
  // plusieurs événements de clôture distincts en scale-in/out).
  const posHist = await paginerParAfter("/api/v5/account/positions-history", { instType: "SWAP" }, "uTime", "uTime", row => row.posId + "|" + row.uTime, begin, warnings, "positions-history");
  posHist.sort((a, b) => +a.uTime - +b.uTime);
  console.log(`[telemetrie] ${posHist.length} positions fermées (account/positions-history)`);

  // ---------- 3) POSITIONS OUVERTES (account/positions, snapshot courant) ----------
  const posOpenR = await getGET("/api/v5/account/positions", { instType: "SWAP" });
  if (posOpenR.code !== "0") warnings.push("account/positions a échoué: " + JSON.stringify(posOpenR));
  const posOpen = posOpenR.code === "0" ? posOpenR.data || [] : [];
  console.log(`[telemetrie] ${posOpen.length} positions ouvertes actuellement`);

  // ---------- Index des fills par instId ----------
  const fillsParInst = {};
  for (const f of fills) {
    (fillsParInst[f.instId] = fillsParInst[f.instId] || []).push(f);
  }
  for (const k in fillsParInst) fillsParInst[k].sort((a, b) => +a.fillTime - +b.fillTime);

  // ---------- Reconstruction des trades réels (entrée -> sortie) par instId ----------
  // Ground truth du round-trip (ouverture/fermeture, PnL brut, lever) = account/positions-history.
  // Les fills du même instId dans la fenêtre [cTime, uTime] sont regroupés par ordId pour
  // identifier l'ordre d'ENTRÉE (premier groupe) et de SORTIE (dernier groupe), et calculer
  // la part d'entrées exécutées maker (execType "M").
  const trades = [];
  let fillsNonRattaches = 0;
  for (const p of posHist) {
    const inst = p.instId;
    const cTime = +p.cTime, uTime = +p.uTime;
    const candidats = (fillsParInst[inst] || []).filter(f => +f.fillTime >= cTime && +f.fillTime <= uTime);
    const groupes = {};
    for (const f of candidats) (groupes[f.ordId] = groupes[f.ordId] || []).push(f);
    const ordIds = Object.keys(groupes).sort((a, b) => +groupes[a][0].fillTime - +groupes[b][0].fillTime);

    const entryFills = ordIds.length ? groupes[ordIds[0]] : [];
    const exitFills = ordIds.length ? groupes[ordIds[ordIds.length - 1]] : [];
    if (!candidats.length) fillsNonRattaches++;

    const szEntry = entryFills.reduce((s, f) => s + +f.fillSz, 0);
    const szEntryMaker = entryFills.filter(f => f.execType === "M").reduce((s, f) => s + +f.fillSz, 0);
    const nFillsEntree = entryFills.length, nFillsSortie = exitFills.length;
    const sumFillPnlFenetre = candidats.reduce((s, f) => s + (+f.fillPnl || 0), 0);

    const pnlBrut = +p.pnl;              // avant frais/funding
    const pnlRatio = +p.pnlRatio;        // pnlBrut / marge (marge estimée ci-dessous)
    const fee = +p.fee, fundingFee = +p.fundingFee || 0;
    const pnlNet = p.realizedPnl !== "" && p.realizedPnl != null ? +p.realizedPnl : (pnlBrut + fee + fundingFee);

    let margeEstimee = null, pctMargeGross = null, pctMargeNet = null;
    if (Math.abs(pnlRatio) > 1e-9) {
      margeEstimee = pnlBrut / pnlRatio;                    // marge implicite (isolé, à la lever indiquée)
      pctMargeGross = pnlRatio * 100;
      pctMargeNet = margeEstimee !== 0 ? (pnlNet / margeEstimee) * 100 : null;
    }

    trades.push({
      instId: inst,
      posId: p.posId,
      direction: p.direction,               // "long" | "short"
      lever: +p.lever,
      mgnMode: p.mgnMode,
      cTime, uTime,
      cISO: new Date(cTime).toISOString(), uISO: new Date(uTime).toISOString(),
      dureeMin: fmt((uTime - cTime) / 60000, 1),
      openAvgPx: +p.openAvgPx, closeAvgPx: +p.closeAvgPx,
      taille: +p.closeTotalPos,
      pnlBrutUSDT: fmt(pnlBrut, 4),
      feeUSDT: fmt(fee, 4), fundingFeeUSDT: fmt(fundingFee, 4),
      pnlNetUSDT: fmt(pnlNet, 4),
      margeEstimeeUSDT: margeEstimee !== null ? fmt(margeEstimee, 3) : null,
      pctMargeGross: pctMargeGross !== null ? fmt(pctMargeGross, 2) : null,
      pctMargeNet: pctMargeNet !== null ? fmt(pctMargeNet, 2) : null,
      nOrdresDansFenetre: ordIds.length,
      nFillsEntree, nFillsSortie,
      tailleEntreeContrats: fmt(szEntry, 4),
      makerShareEntreePct: szEntry > 0 ? fmt(100 * szEntryMaker / szEntry, 1) : null,
      controleFillPnl: fmt(sumFillPnlFenetre, 4),           // doit ~= pnlBrutUSDT si le rattachement fills<->position est correct
      controleEcartFillPnl: fmt(sumFillPnlFenetre - pnlBrut, 4),
    });
  }
  trades.sort((a, b) => a.cTime - b.cTime);

  // ---------- Positions ouvertes actuelles (contexte, hors stats de trades clos) ----------
  const ouvertes = posOpen.map(p => ({
    instId: p.instId, direction: p.pos > 0 ? "long" : (p.pos < 0 ? "short" : "flat"),
    lever: +p.lever, mgnMode: p.mgnMode,
    cTime: +p.cTime, cISO: new Date(+p.cTime).toISOString(),
    dureeMinDepuisOuverture: fmt((now - +p.cTime) / 60000, 1),
    avgPx: +p.avgPx, markPx: +p.markPx,
    margeUSDT: fmt(+p.margin, 3), notionalUsd: fmt(+p.notionalUsd, 2),
    uplUSDT: fmt(+p.upl, 4), uplRatioPct: fmt(+p.uplRatio * 100, 2),
  }));

  // ---------- Maker share global (toutes entrées confondues) ----------
  const nEntreesAvecTaille = trades.filter(t => t.makerShareEntreePct !== null);
  const totalSzEntree = trades.reduce((s, t) => s + t.tailleEntreeContrats, 0);
  const totalSzEntreeMaker = trades.reduce((s, t) => s + (t.makerShareEntreePct !== null ? t.tailleEntreeContrats * t.makerShareEntreePct / 100 : 0), 0);
  const makerShareEntreesGlobalPct = totalSzEntree > 0 ? fmt(100 * totalSzEntreeMaker / totalSzEntree, 2) : null;
  const nOrdresEntreeMaker = trades.filter(t => t.makerShareEntreePct !== null && t.makerShareEntreePct >= 50).length; // ordre "majoritairement maker"

  const execTypeCounts = { M: 0, T: 0, autre: 0 };
  for (const f of fills) {
    if (f.execType === "M") execTypeCounts.M++;
    else if (f.execType === "T") execTypeCounts.T++;
    else execTypeCounts.autre++;
  }

  // ---------- Registre : espérances attendues (EN_LIVE) ----------
  let registre = null;
  try { registre = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, "REGISTRE_STRATEGIES.json"), "utf8")); } catch (e) { warnings.push("REGISTRE_STRATEGIES.json illisible: " + e.message); }
  const attenduParInst = {}; // instId -> { esp60, module, statut }
  if (registre && Array.isArray(registre.champions)) {
    for (const c of registre.champions) {
      if (!/EN_LIVE/.test(c.statut || "")) continue;
      const ids = String(c.instId).split("/").map(s => s.trim());
      for (const idBase of ids) {
        const instId = /-USDT-SWAP$/.test(idBase) ? idBase : `${idBase}-USDT-SWAP`;
        attenduParInst[instId] = { esp60_attendu: c.esp60, module: c.module, statut: c.statut };
      }
    }
  }

  // ---------- Agrégats par crypto ----------
  const parCrypto = {};
  for (const t of trades) {
    const g = (parCrypto[t.instId] = parCrypto[t.instId] || { instId: t.instId, n: 0, gagnants: 0, sommePctNet: 0, pnlNetUSDTTotal: 0, best: -Infinity, worst: Infinity, sommeMakerPondere: 0, sommeTaille: 0, dureeMoyMin: 0 });
    g.n++;
    if (t.pctMargeNet !== null) {
      g.sommePctNet += t.pctMargeNet;
      g.best = Math.max(g.best, t.pctMargeNet);
      g.worst = Math.min(g.worst, t.pctMargeNet);
      if (t.pctMargeNet > 0) g.gagnants++;
    }
    g.pnlNetUSDTTotal += t.pnlNetUSDT;
    g.dureeMoyMin += t.dureeMin;
    if (t.makerShareEntreePct !== null) { g.sommeMakerPondere += t.makerShareEntreePct * t.tailleEntreeContrats; g.sommeTaille += t.tailleEntreeContrats; }
  }
  const comparaisonRegistre = Object.values(parCrypto).map(g => {
    const attendu = attenduParInst[g.instId] || null;
    const moyPctNet = g.n ? fmt(g.sommePctNet / g.n, 2) : null;
    return {
      instId: g.instId,
      n: g.n,
      winrate: g.n ? fmt(100 * g.gagnants / g.n, 1) : null,
      pctMargeNetMoyen: moyPctNet,
      pnlNetUSDTTotal: fmt(g.pnlNetUSDTTotal, 3),
      best: isFinite(g.best) ? fmt(g.best, 2) : null,
      worst: isFinite(g.worst) ? fmt(g.worst, 2) : null,
      dureeMoyMin: g.n ? fmt(g.dureeMoyMin / g.n, 1) : null,
      makerShareEntreePct: g.sommeTaille > 0 ? fmt(g.sommeMakerPondere / g.sommeTaille, 1) : null,
      statut_registre: attendu ? attendu.statut : "HORS REGISTRE (non validé EN_LIVE)",
      module_registre: attendu ? attendu.module : null,
      esp60_attendu: attendu ? attendu.esp60_attendu : null,
      delta_vs_attendu: (attendu && typeof attendu.esp60_attendu === "number" && moyPctNet !== null) ? fmt(moyPctNet - attendu.esp60_attendu, 2) : null,
    };
  }).sort((a, b) => (b.n - a.n));

  const instIdsEnRegistre = Object.keys(attenduParInst);
  const instIdsObserves = Object.keys(parCrypto);
  const instIdsHorsRegistre = instIdsObserves.filter(id => !instIdsEnRegistre.includes(id));
  const instIdsRegistreJamaisVus = instIdsEnRegistre.filter(id => !instIdsObserves.includes(id));

  // ---------- Agrégat global (trades clos, tous instId) ----------
  const tradesAvecPct = trades.filter(t => t.pctMargeNet !== null);
  const nGlobal = tradesAvecPct.length;
  const gGagnants = tradesAvecPct.filter(t => t.pctMargeNet > 0).length;
  const sommePct = tradesAvecPct.reduce((s, t) => s + t.pctMargeNet, 0);
  const pnlNetTotalUSDT = trades.reduce((s, t) => s + t.pnlNetUSDT, 0);
  const gainsUSDT = trades.filter(t => t.pnlNetUSDT > 0).reduce((s, t) => s + t.pnlNetUSDT, 0);
  const pertesUSDT = -trades.filter(t => t.pnlNetUSDT <= 0).reduce((s, t) => s + t.pnlNetUSDT, 0);

  // ---------- Sous-fenêtre "depuis le lancement" (ancre mémoire 30/08 ~14h30 CEST) ----------
  const tradesDepuisLancement = trades.filter(t => t.cTime >= ancreLancementMemoire);
  const avecPctDepuis = tradesDepuisLancement.filter(t => t.pctMargeNet !== null);
  const bilanDepuisLancement = {
    ancre_utilisee: new Date(ancreLancementMemoire).toISOString() + " (30/08/2026 ~14h30 UTC+2, mémoire client)",
    n_trades_clos: tradesDepuisLancement.length,
    n_avec_pct: avecPctDepuis.length,
    winrate: avecPctDepuis.length ? fmt(100 * avecPctDepuis.filter(t => t.pctMargeNet > 0).length / avecPctDepuis.length, 1) : null,
    pctMargeNetMoyen: avecPctDepuis.length ? fmt(avecPctDepuis.reduce((s, t) => s + t.pctMargeNet, 0) / avecPctDepuis.length, 2) : null,
    pnlNetUSDTTotal: fmt(tradesDepuisLancement.reduce((s, t) => s + t.pnlNetUSDT, 0), 3),
  };

  // Premier fill observé dans les 3 j (peut être ANTÉRIEUR à l'ancre mémoire -> écart à signaler)
  const premierFillTs = fills.length ? +fills[0].fillTime : null;
  if (premierFillTs !== null && premierFillTs < ancreLancementMemoire - 3600 * 1000) {
    warnings.push(
      `Écart lancement: le premier fill observé dans la fenêtre 3 j date de ${new Date(premierFillTs).toISOString()}, ` +
      `soit avant l'ancre mémoire du lancement (${new Date(ancreLancementMemoire).toISOString()}). ` +
      `Trading réel déjà actif ~${fmt((ancreLancementMemoire - premierFillTs) / 3600000, 1)} h avant l'heure de lancement retenue.`
    );
  }

  if (fillsNonRattaches > 0) warnings.push(`${fillsNonRattaches} position(s) fermée(s) sans fill correspondant trouvé dans la fenêtre (hors période des 3 j, ou fills partiellement paginés).`);

  const grosEcartsControle = trades.filter(t => Math.abs(t.controleEcartFillPnl) > 0.01);
  if (grosEcartsControle.length) warnings.push(`${grosEcartsControle.length} trade(s) avec écart fillPnl(fills) vs pnl(positions-history) > 0.01 USDT — rattachement fills<->position à vérifier pour ces cas.`);

  // ---------- Levier réellement utilisé (le banc de recherche suppose LEV=15 fixe) ----------
  const leverDistribution = {};
  for (const t of trades) leverDistribution[t.lever] = (leverDistribution[t.lever] || 0) + 1;
  const leverTimeline = [];
  { let prev = null; for (const t of trades) { if (t.lever !== prev) { leverTimeline.push({ lever: t.lever, depuis: t.cISO, instId: t.instId }); prev = t.lever; } } }
  if (Object.keys(leverDistribution).length > 1) warnings.push(`Levier VARIABLE sur la fenêtre (${JSON.stringify(leverDistribution)}) — le banc de recherche (harness_lib.js) suppose LEV=15 fixe pour tout calcul d'esp60 ; les trades à levier 10 ou 20 ne sont donc pas directement comparables au registre sur cet axe.`);

  // ---------- Trades qui dépassent le pire cas théorique du banc (-30% marge, sl<=0.30 + coûts 0,12%) ----------
  const PIRE_CAS_THEORIQUE = -30.12;
  const depassementsFloor = trades.filter(t => t.pctMargeNet !== null && t.pctMargeNet < PIRE_CAS_THEORIQUE)
    .map(t => ({ instId: t.instId, pctMargeNet: t.pctMargeNet, lever: t.lever, cISO: t.cISO, uISO: t.uISO, dureeMin: t.dureeMin }));
  if (depassementsFloor.length) warnings.push(`${depassementsFloor.length}/${nGlobal} trades clos dépassent le pire cas théorique du banc (SL cap -30% marge + coûts ≈ ${PIRE_CAS_THEORIQUE}%) — voir risques.trades_depassant_floor_theorique. La protection SL réelle ne borne pas la perte au niveau supposé par le backtest.`);

  const rapport = {
    _doc: "Télémétrie LIVE OKX (lecture seule) vs backtest — HERMES. Reconstruit les trades réels depuis trade/fills(-history) et account/positions-history, calcule le PnL %marge NET réel par trade/crypto, la part d'entrées maker, et compare à REGISTRE_STRATEGIES.json (EN_LIVE).",
    genere_le: new Date(now).toISOString(),
    fenetre: { debut: new Date(begin).toISOString(), fin: new Date(now).toISOString(), jours: FENETRE_JOURS },
    sources: { fills: sourceFills, nFills: fills.length, nOrdresUniques: new Set(fills.map(f => f.ordId)).size, positionsHistory: "account/positions-history", nPositionsFermees: posHist.length, positionsOuvertes: "account/positions", nPositionsOuvertes: posOpen.length },
    avertissements: warnings,

    execution: {
      _doc: "Exécution des fills (tous, entrées+sorties confondues) — maker M vs taker T.",
      execType: execTypeCounts,
      makerPctTousFills: fmt(100 * execTypeCounts.M / (execTypeCounts.M + execTypeCounts.T + execTypeCounts.autre || 1), 2),
      makerShareEntreesPct: makerShareEntreesGlobalPct,
      _note_maker: "makerShareEntreesPct = part (pondérée en taille) des ordres d'ENTRÉE exécutés maker, sur les trades reconstruits. makerPctTousFills = même ratio sur l'ensemble des fills (entrées+sorties).",
    },

    bilan_global_3j: {
      n_trades_clos: trades.length,
      n_avec_pct_marge: nGlobal,
      winrate: nGlobal ? fmt(100 * gGagnants / nGlobal, 1) : null,
      pctMargeNetMoyen: nGlobal ? fmt(sommePct / nGlobal, 2) : null,
      pctMargeNetMedian: nGlobal ? fmt([...tradesAvecPct].map(t => t.pctMargeNet).sort((a, b) => a - b)[Math.floor(nGlobal / 2)], 2) : null,
      pnlNetUSDTTotal: fmt(pnlNetTotalUSDT, 3),
      profitFactor: pertesUSDT > 0 ? fmt(gainsUSDT / pertesUSDT, 2) : null,
      nInstIdsDistincts: instIdsObserves.length,
    },

    bilan_depuis_lancement: bilanDepuisLancement,

    risques: {
      _doc: `Levier réellement observé (le banc de recherche 60j/30j suppose LEV=15 fixe) et trades ayant dépassé le pire cas théorique du banc (SL cap -30% marge + coûts ~0,12% = ${PIRE_CAS_THEORIQUE}%).`,
      leverDistributionNTrades: leverDistribution,
      leverTimeline,
      floor_theorique_pct: PIRE_CAS_THEORIQUE,
      n_trades_depassant_floor_theorique: depassementsFloor.length,
      trades_depassant_floor_theorique: depassementsFloor,
    },

    par_crypto: comparaisonRegistre,

    perimetre_registre: {
      _doc: "Comparaison du périmètre réellement tradé en live vs le périmètre validé EN_LIVE du registre.",
      instIds_EN_LIVE_registre: instIdsEnRegistre,
      instIds_EN_LIVE_jamais_vus_sur_3j: instIdsRegistreJamaisVus,
      instIds_tradés_hors_registre: instIdsHorsRegistre,
      n_instIds_tradés_hors_registre: instIdsHorsRegistre.length,
      n_instIds_tradés_total: instIdsObserves.length,
    },

    positions_ouvertes_actuellement: ouvertes,

    trades: trades,
  };

  const dateTag = new Date(now).toISOString().slice(0, 10);
  const outPath = path.join(RAPPORTS_DIR, `telemetrie_${dateTag}.json`);
  fs.writeFileSync(outPath, JSON.stringify(rapport, null, 2));
  console.log(`[telemetrie] rapport écrit: ${outPath}`);
  console.log(`[telemetrie] bilan 3j: n=${rapport.bilan_global_3j.n_trades_clos} wr=${rapport.bilan_global_3j.winrate} pctMargeNetMoyen=${rapport.bilan_global_3j.pctMargeNetMoyen} pnlNetTotal=${rapport.bilan_global_3j.pnlNetUSDTTotal} USDT`);
  console.log(`[telemetrie] hors registre: ${instIdsHorsRegistre.length}/${instIdsObserves.length} instId tradés ne sont pas EN_LIVE au registre`);
  console.log(`[telemetrie] maker: tous fills ${rapport.execution.makerPctTousFills}% · entrées ${rapport.execution.makerShareEntreesPct}%`);
  for (const w of warnings) console.log("[telemetrie][warn]", w);
})().catch(e => { console.error("[telemetrie] ERREUR FATALE", e); process.exit(1); });
