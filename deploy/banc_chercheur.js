#!/usr/bin/env node
/* ============================================================================
   LE BANC DU CHERCHEUR — la question qu'il fallait poser en premier.

   Le banc du régime a rendu, sur douze mois d'archives, un chiffre qui
   déplace le problème : en rejouant le roster actuel sur un an, les
   perles perdent de l'argent DANS LES QUATRE ÉTATS. Winrate 62 %, gain
   net négatif partout. Un filtre par état ne répare pas cela — il ne
   fait que trader moins d'une chose qui perd, et le témoin l'a dit
   sans détour : retirer les mêmes trades au hasard faisait mieux neuf
   fois sur dix.

   Mais ce chiffre-là ne juge pas Hermes. Il juge un roster FIGÉ rejoué
   sur une période pour laquelle il n'a jamais été choisi. Or Hermes ne
   fige rien : le chercheur reprend la main toutes les trente minutes,
   sur les trente derniers jours. La vraie question est donc :

     LE PROCÉDÉ DE SÉLECTION produit-il une espérance positive sur des
     données qu'il n'a pas vues ?

   Ce script y répond par une glissade du PROCÉDÉ, pas d'un résultat :

     à chaque point T, on relance le juge du chercheur — le vrai,
     chercherPourInstrument, importé et non recopié — sur les trente
     jours qui précèdent T ; on trade les perles obtenues sur les
     semaines qui suivent T ; on recommence. Aucun choix ne voit
     jamais ce qu'il sera jugé sur.

   Trois bras sont comparés sur exactement les mêmes trades :
     A  le chercheur seul, tel qu'il tourne aujourd'hui
     B  le chercheur plus le filtre par état de marché
     T  un témoin qui retire au hasard autant de trades que B

   Si A est négatif, aucune couche posée par-dessus n'a de sens, et il
   faut le dire avant d'en construire une. Si A est positif et B mieux
   que A ET mieux que le témoin, la couche régime a gagné sa place.

   Ne lit que le cache long, n'écrit rien.
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");
const { serieSignaux, simuler, resumer } = require(path.join(RACINE, "modules", "backtest.js"));
const { chercherPourInstrument } = require(path.join(RACINE, "deploy", "chercher_perles.js"));
const REGIME = require(path.join(RACINE, "modules", "regime.js"));

const CACHE_LONG = path.join(RACINE, "data", "cache-long");
const JOURS = Number(process.env.PERLES_JOURS || 30);
const LEVIER = Number(process.env.HERMES_DEFAULT_LEVERAGE || 15);
const SL = 0.30, CB = 0.05;
/* Le pas de la glissade. Il porte une approximation qu'il faut dire :
   le vrai chercheur reprend la main toutes les TRENTE MINUTES, et une
   perle qui se degrade sort du roster dans l'heure. Rejouer le procede
   au pas de trois semaines fait donc trader une perle bien plus
   longtemps que le vivant ne le ferait — ce banc est PESSIMISTE, et il
   l'est d'autant plus que le pas est grand. Sept jours coute trois fois
   plus de calcul et serre la realite de bien plus pres. */
const PAS_JOURS = Number(process.env.BANC_PAS_JOURS || 21);
const MIN_TRADES_ETAT = Number(process.env.REGIME_MIN_TRADES_ETAT || 5);
const TIRAGES = Number(process.env.REGIME_TIRAGES || 400);
const CHAUFFE = 299;                                  // ce que le moteur voit avant de pouvoir signaler

const UNIVERS = (process.env.BANC_UNIVERS ||
  "BTC,ETH,SOL,XRP,DOGE,ADA,AVAX,LINK,LTC,BCH,DOT,FIL").split(",").map((s) => s.trim() + "-USDT-SWAP");

function lire(instId) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(CACHE_LONG, instId + ".json"), "utf8"));
    return Array.isArray(r) && r.length > JOURS * 288 * 2 ? r : null;
  } catch { return null; }
}

function creuxMax(trades) {
  const o = [...trades].sort((a, b) => a.tsOut - b.tsOut);
  let c = 0, s = 0, p = 0;
  for (const t of o) { c += t.pnlMarge; if (c > s) s = c; if (s - c > p) p = s - c; }
  return p;
}
function bilan(tr) {
  const r = resumer(tr);
  return { trades: r.trades, winrate: r.winrate, net: r.netMarge, moyenne: r.moyenneMarge, creux: creuxMax(tr) };
}
function partBattue(tous, gardes, tirages) {
  if (!gardes.length || gardes.length >= tous.length) return null;
  const cible = gardes.reduce((a, t) => a + t.pnlMarge, 0);
  let x = 123456789;
  const suiv = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  let battus = 0;
  for (let k = 0; k < tirages; k++) {
    const c = [...tous];
    for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(suiv() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
    if (cible > c.slice(0, gardes.length).reduce((a, t) => a + t.pnlMarge, 0)) battus++;
  }
  return battus / tirages;
}

/* Les points de la glissade : régulièrement espacés, le premier assez
   loin dans l'histoire pour que le juge ait ses trente jours. */
function points(debutTs, finTs) {
  const out = [];
  const premier = debutTs + JOURS * 86400e3;
  for (let T = premier; T + PAS_JOURS * 86400e3 <= finTs; T += PAS_JOURS * 86400e3) out.push(T);
  return out;
}

function main() {
  console.log(`[BANC-CHERCHEUR] glissade du PROCEDE : juge sur ${JOURS} j, trade ${PAS_JOURS} j, levier ${LEVIER}`);
  console.log(`[BANC-CHERCHEUR] univers fixe de ${UNIVERS.length} instruments : ${UNIVERS.map((s) => s.replace("-USDT-SWAP", "")).join(", ")}`);
  console.log(`[BANC-CHERCHEUR] deux biais assumes : l'univers est FIXE et choisi aujourd'hui (favorable au systeme),`);
  console.log(`[BANC-CHERCHEUR] et le pas de ${PAS_JOURS} j garde une perle bien plus longtemps que le vivant, qui rejuge toutes les 30 min (defavorable).`);

  const btc = lire("BTC-USDT-SWAP");
  if (!btc) { console.error("[BANC-CHERCHEUR] pas d'histoire longue pour BTC"); process.exit(1); }
  const eth = lire("ETH-USDT-SWAP");
  const index = REGIME.indexEtats(btc, REGIME.serieEtats(btc, eth,
    REGIME.lireSeuils(path.join(RACINE, "config", "regime.json"))));
  const listePoints = points(btc[0][0], btc[btc.length - 1][0]);
  console.log(`[BANC-CHERCHEUR] ${listePoints.length} points, du ${new Date(listePoints[0]).toISOString().slice(0, 10)} ` +
    `au ${new Date(listePoints[listePoints.length - 1]).toISOString().slice(0, 10)}`);

  const tousA = [], tousB = [];
  const parPoint = listePoints.map(() => ({ perles: 0, trades: 0, net: 0 }));
  const parInstrument = [];

  for (const instId of UNIVERS) {
    const nom = instId.replace("-USDT-SWAP", "");
    const c5 = lire(instId);
    if (!c5) { console.log(`  ${nom.padEnd(6)} — pas d'histoire, ignore`); continue; }
    const t0 = Date.now();
    const tsCol = c5.map((k) => k[0]);
    const bornes = (a, b) => {                          // indices [a,b) par recherche binaire
      const cherche = (v) => { let lo = 0, hi = tsCol.length; while (lo < hi) { const m = (lo + hi) >> 1; if (tsCol[m] < v) lo = m + 1; else hi = m; } return lo; };
      return [cherche(a), cherche(b)];
    };

    let perlesIci = 0;
    const aInst = [], bInst = [];
    for (let k = 0; k < listePoints.length; k++) {
      const T = listePoints[k];
      const [iDeb, iFin] = bornes(T - JOURS * 86400e3, T);
      const passe = c5.slice(iDeb, iFin);
      if (passe.length < CHAUFFE + 288 * 3) continue;

      let choix;
      try { choix = chercherPourInstrument(passe); } catch { continue; }
      if (!choix || !choix.perle) continue;
      perlesIci++;
      parPoint[k].perles++;

      const p = choix.perle;
      const sortie = { tpPctMargin: p.sortie.tpPctMargin, trailActPctMargin: p.sortie.trailActPctMargin,
                       slPctMargin: SL, trailCbPctMargin: CB, holdMs: p.sortie.holdMs };

      // Le filtre : les etats ou CETTE perle a perdu sur SA fenetre de
      // choix. Les trades de la fenetre sont recalcules — un seul signal,
      // une seule sortie, c'est bon marche.
      const tradesPasse = simuler({ c5: passe, signaux: serieSignaux(p.sig, passe), sortie, lev: LEVIER });
      const parEtat = {};
      for (const t of tradesPasse) {
        const e = REGIME.etatA(index, t.tsIn);
        (parEtat[e] = parEtat[e] || []).push(t);
      }
      const ecartes = Object.entries(parEtat)
        .filter(([e, l]) => e !== "inconnu" && l.length >= MIN_TRADES_ETAT && l.reduce((a, t) => a + t.pnlMarge, 0) < 0)
        .map(([e]) => e);

      // Le futur : de T a T + PAS. La chauffe precede T pour que le
      // premier signal du bloc soit evalue comme le moteur l'evaluerait.
      const [jDeb, jFin] = bornes(T, T + PAS_JOURS * 86400e3);
      const avenir = c5.slice(Math.max(0, jDeb - CHAUFFE), jFin);
      if (avenir.length < CHAUFFE + 2) continue;
      const trAvenir = simuler({ c5: avenir, signaux: serieSignaux(p.sig, avenir), sortie, lev: LEVIER })
        .filter((t) => t.tsIn >= T)
        .map((t) => ({ ...t, instId, etat: REGIME.etatA(index, t.tsIn) }));

      for (const t of trAvenir) {
        aInst.push(t);
        if (!ecartes.includes(t.etat)) bInst.push(t);
        parPoint[k].trades++; parPoint[k].net += t.pnlMarge;
      }
    }
    tousA.push(...aInst); tousB.push(...bInst);
    const bA = bilan(aInst);
    parInstrument.push({ nom, perles: perlesIci, ...bA });
    console.log(`  ${nom.padEnd(6)} ${String(perlesIci).padStart(2)}/${listePoints.length} points avec perle · ` +
      `${String(bA.trades).padStart(4)} trades · wr ${(bA.trades ? bA.winrate.toFixed(1) : "—").padStart(5)} % · ` +
      `net ${bA.net.toFixed(2).padStart(8)} · par trade ${(bA.trades ? bA.moyenne.toFixed(4) : "—").padStart(8)} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }

  const A = bilan(tousA), B = bilan(tousB);
  const temoin = partBattue(tousA, tousB, TIRAGES);

  console.log(`[BANC-CHERCHEUR] resultat, tout hors echantillon :`);
  console.log(`  A  chercheur seul          : ${A.trades} trades · wr ${A.winrate.toFixed(1)} % · net ${A.net.toFixed(2)} · par trade ${A.moyenne.toFixed(4)} · creux ${A.creux.toFixed(2)}`);
  console.log(`  B  chercheur + regime      : ${B.trades} trades · wr ${(B.trades ? B.winrate.toFixed(1) : "—")} % · net ${B.net.toFixed(2)} · par trade ${(B.trades ? B.moyenne.toFixed(4) : "—")} · creux ${B.creux.toFixed(2)}`);
  console.log(`  temoin : B bat ${temoin == null ? "—" : (100 * temoin).toFixed(1) + " %"} des retraits au hasard de meme taille`);

  // Les frais, seuls, pour situer l'ordre de grandeur du probleme.
  const fraisParTrade = 2 * 0.0005 * LEVIER;
  console.log(`  pour memoire : les frais coutent ${fraisParTrade.toFixed(4)} de marge par trade, soit ${(A.trades * fraisParTrade).toFixed(2)} sur ${A.trades} trades.`);
  console.log(`  sans frais, le bras A ferait net ${(A.net + A.trades * fraisParTrade).toFixed(2)}.`);

  console.log(`[BANC-CHERCHEUR] par point de la glissade (perles trouvees · trades · net) :`);
  for (let k = 0; k < listePoints.length; k++) {
    const p = parPoint[k];
    console.log(`  ${new Date(listePoints[k]).toISOString().slice(0, 10)} : ${String(p.perles).padStart(2)} perles · ${String(p.trades).padStart(4)} trades · net ${p.net.toFixed(2).padStart(8)}`);
  }
  console.log(`[BANC-CHERCHEUR] ce script ne branche rien.`);
}

if (require.main === module) main();
