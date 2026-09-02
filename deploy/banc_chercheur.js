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

   Quatre bras sont comparés sur exactement les mêmes trades :
     A  le chercheur seul, tel qu'il tourne aujourd'hui
     B  le chercheur plus le filtre par état du MARCHÉ (BTC et ETH)
     C  le chercheur plus le filtre par état de L'INSTRUMENT lui-même
     T  un témoin qui retire au hasard autant de trades que B ou C

   Le bras C répond à une objection que le bras B invite : une perle sur
   KITE se moque peut-être de ce que fait BTC, et ne casse que lorsque
   KITE part en tendance. Le calcul est le même, la série d'entrée
   change. La parité vivant/banc reste garantie : le moteur tire déjà
   trois cents bougies de chaque perle à chaque tour, il a donc de quoi
   calculer l'état de l'instrument sans un seul appel de plus.

   Si A est négatif, aucune couche posée par-dessus n'a de sens, et il
   faut le dire avant d'en construire une. Si A est positif et B mieux
   que A ET mieux que le témoin, la couche régime a gagné sa place.

   Ne lit que le cache long, n'écrit rien.
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");

/* L'EXPÉRIENCE DE L'HORIZON LONG. Les frais coûtent 0,015 de marge par
   trade, quelle que soit la cible visée. Viser 0,30 de marge fait donc
   payer cinq pour cent du gain visé rien qu'en frais ; viser 2,00 en
   fait payer moins d'un. Si le petit avantage brut mesuré est réel mais
   noyé sous le coût de transaction, il doit ressortir en visant plus
   grand et plus rarement. Si rien ne ressort là non plus, l'avantage
   n'existe pas, et c'est une réponse aussi.

   Ce réglage doit être posé AVANT de charger le chercheur, qui lit sa
   grille au chargement. */
if (process.env.BANC_HORIZON_LONG === "1") {
  process.env.PERLES_SORTIES = JSON.stringify([
    { tpPctMargin: 2.5, trailActPctMargin: 1.0 },
    { tpPctMargin: 1.8, trailActPctMargin: 0.7 },
    { tpPctMargin: 1.2, trailActPctMargin: 0.5 },
  ]);
  process.env.PERLES_DUREES = "48,96,168";
}

const { serieSignaux, simuler, resumer } = require(path.join(RACINE, "modules", "backtest.js"));
const { chercherPourInstrument, SORTIES, DUREES } = require(path.join(RACINE, "deploy", "chercher_perles.js"));
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
const ALEATOIRE = process.env.BANC_ALEATOIRE === "1";

const UNIVERS = (process.env.BANC_UNIVERS ||
  "BTC,ETH,SOL,XRP,DOGE,ADA,AVAX,LINK,LTC,BCH,DOT,FIL").split(",").map((s) => s.trim() + "-USDT-SWAP");

/* LE CONTRÔLE PAR MÉLANGE DE BLOCS. C'est la question qui décide de
   tout : le chercheur trouve-t-il autre chose que du hasard ?

   Le premier essai a utilisé des marches aléatoires gaussiennes, et le
   chercheur y a trouvé des perles au même rythme que sur le vrai
   marché, avec la même performance. Mais on peut objecter qu'une
   gaussienne n'a ni queues épaisses ni grappes de volatilité, et qu'un
   marché factice trop lisse est un adversaire trop facile.

   Le mélange par blocs répond à l'objection. On prend les VRAIS
   rendements de cinq minutes, on les découpe en journées, on mélange
   l'ordre des journées, et on reconstruit le prix. La distribution des
   rendements est conservée exactement — mêmes queues, mêmes journées
   agitées, mêmes journées calmes. Seul disparaît ce qui relie une
   journée à la suivante, c'est-à-dire précisément ce dont un avantage
   aurait besoin pour exister.

   Si le chercheur gagne autant sur ce faux marché que sur le vrai, ses
   perles ne sont pas des découvertes : ce sont les meilleures de cent
   cinquante-six combinaisons tirées au sort. */
function melangerParBlocs(c5, graine) {
  const TAILLE = 288;                              // une journée
  let x = (graine * 2654435761) >>> 0;
  const suiv = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const r = [];
  for (let i = 1; i < c5.length; i++) r.push(Math.log(c5[i][4] / c5[i - 1][4]));
  const blocs = [];
  for (let i = 0; i + TAILLE <= r.length; i += TAILLE) blocs.push(r.slice(i, i + TAILLE));
  for (let i = blocs.length - 1; i > 0; i--) { const j = Math.floor(suiv() * (i + 1)); [blocs[i], blocs[j]] = [blocs[j], blocs[i]]; }
  const plat = [].concat(...blocs);
  const out = [];
  let c = c5[0][4];
  for (let i = 0; i < plat.length; i++) {
    const o = c;
    c = c * Math.exp(plat[i]);
    // Les mèches sont reconstruites au prorata de celles de la vraie
    // bougie : un corps sans mèche fausserait les signaux de mèche.
    const vrai = c5[i + 1];
    const ampl = vrai[1] > 0 ? Math.max(0, (vrai[2] - vrai[3]) / vrai[1]) : 0;
    const haut = Math.max(o, c) * (1 + ampl / 4), bas = Math.min(o, c) * (1 - ampl / 4);
    out.push([c5[i + 1][0], o, haut, bas, c, vrai[5]]);
  }
  return out;
}

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
/* L'erreur standard sur le gain moyen, et le t de Student qui va avec.
   Sans eux, « +0,0019 de marge par trade » se lit comme un avantage
   alors que c'est peut-etre zero : sur des trades dont l'ecart-type
   depasse 0,2, il faut des milliers d'observations pour distinguer un
   petit avantage du bruit. Un banc qui ne dit pas cela invite a
   construire sur du vide. */
function significativite(tr) {
  const n = tr.length;
  if (n < 2) return { n, moyenne: 0, ecartType: 0, erreur: 0, t: 0 };
  const m = tr.reduce((a, t) => a + t.pnlMarge, 0) / n;
  const v = tr.reduce((a, t) => a + (t.pnlMarge - m) * (t.pnlMarge - m), 0) / (n - 1);
  const sd = Math.sqrt(v), se = sd / Math.sqrt(n);
  return { n, moyenne: m, ecartType: sd, erreur: se, t: se > 0 ? m / se : 0 };
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
  console.log(`[BANC-CHERCHEUR] grille des signaux : ${process.env.PERLES_SIGNAUX || "les treize actuels (defaut)"}`);
  console.log(`[BANC-CHERCHEUR] grille des sorties : tp ${SORTIES.map((s) => s.tpPctMargin).join("/")} de marge · tenue ${DUREES.map((d) => d / 3600e3).join("/")} h` +
    (process.env.BANC_HORIZON_LONG === "1" ? "  (HORIZON LONG : cibles plus grandes et plus rares)" : ""));
  console.log(`[BANC-CHERCHEUR] univers fixe de ${UNIVERS.length} instruments : ${UNIVERS.map((s) => s.replace("-USDT-SWAP", "")).join(", ")}`);
  console.log(`[BANC-CHERCHEUR] deux biais assumes : l'univers est FIXE et choisi aujourd'hui (favorable au systeme),`);
  console.log(`[BANC-CHERCHEUR] et le pas de ${PAS_JOURS} j garde une perle bien plus longtemps que le vivant, qui rejuge toutes les 30 min (defavorable).`);

  if (ALEATOIRE) {
    console.log(`[BANC-CHERCHEUR] MODE CONTROLE : les journees sont melangees. Tout avantage trouve ici est du hasard,`);
    console.log(`[BANC-CHERCHEUR] et sert d'etalon : le vrai marche doit faire NETTEMENT mieux, sinon il ne fait rien.`);
  }
  const brut = (instId, g) => { const c = lire(instId); return c && ALEATOIRE ? melangerParBlocs(c, g) : c; };
  const btc = brut("BTC-USDT-SWAP", 1);
  if (!btc) { console.error("[BANC-CHERCHEUR] pas d'histoire longue pour BTC"); process.exit(1); }
  const eth = brut("ETH-USDT-SWAP", 2);
  const index = REGIME.indexEtats(btc, REGIME.serieEtats(btc, eth,
    REGIME.lireSeuils(path.join(RACINE, "config", "regime.json"))));
  const listePoints = points(btc[0][0], btc[btc.length - 1][0]);
  console.log(`[BANC-CHERCHEUR] ${listePoints.length} points, du ${new Date(listePoints[0]).toISOString().slice(0, 10)} ` +
    `au ${new Date(listePoints[listePoints.length - 1]).toISOString().slice(0, 10)}`);

  const tousA = [], tousB = [], tousC = [];
  const parPoint = listePoints.map(() => ({ perles: 0, trades: 0, net: 0 }));
  const parInstrument = [];

  for (const instId of UNIVERS) {
    const nom = instId.replace("-USDT-SWAP", "");
    const c5 = brut(instId, 3 + UNIVERS.indexOf(instId));
    if (!c5) { console.log(`  ${nom.padEnd(6)} — pas d'histoire, ignore`); continue; }
    const t0 = Date.now();
    const tsCol = c5.map((k) => k[0]);
    const bornes = (a, b) => {                          // indices [a,b) par recherche binaire
      const cherche = (v) => { let lo = 0, hi = tsCol.length; while (lo < hi) { const m = (lo + hi) >> 1; if (tsCol[m] < v) lo = m + 1; else hi = m; } return lo; };
      return [cherche(a), cherche(b)];
    };

    /* L'état de l'instrument lui-même, calculé une fois pour toute son
       histoire — même formule, même module, autre série d'entrée. */
    const indexPropre = REGIME.indexEtats(c5, REGIME.serieEtats(c5, null,
      REGIME.lireSeuils(path.join(RACINE, "config", "regime.json"))));

    let perlesIci = 0;
    const aInst = [], bInst = [], cInst = [];
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
      const perdants = (idx) => {
        const parEtat = {};
        for (const t of tradesPasse) (parEtat[REGIME.etatA(idx, t.tsIn)] = parEtat[REGIME.etatA(idx, t.tsIn)] || []).push(t);
        return Object.entries(parEtat)
          .filter(([e, l]) => e !== "inconnu" && l.length >= MIN_TRADES_ETAT && l.reduce((a, t) => a + t.pnlMarge, 0) < 0)
          .map(([e]) => e);
      };
      const ecartes = perdants(index);            // etat du marche
      const ecartesP = perdants(indexPropre);     // etat de l'instrument

      // Le futur : de T a T + PAS. La chauffe precede T pour que le
      // premier signal du bloc soit evalue comme le moteur l'evaluerait.
      const [jDeb, jFin] = bornes(T, T + PAS_JOURS * 86400e3);
      const avenir = c5.slice(Math.max(0, jDeb - CHAUFFE), jFin);
      if (avenir.length < CHAUFFE + 2) continue;
      const trAvenir = simuler({ c5: avenir, signaux: serieSignaux(p.sig, avenir), sortie, lev: LEVIER })
        .filter((t) => t.tsIn >= T)
        .map((t) => ({ ...t, instId, etat: REGIME.etatA(index, t.tsIn), etatP: REGIME.etatA(indexPropre, t.tsIn) }));

      for (const t of trAvenir) {
        aInst.push(t);
        if (!ecartes.includes(t.etat)) bInst.push(t);
        if (!ecartesP.includes(t.etatP)) cInst.push(t);
        parPoint[k].trades++; parPoint[k].net += t.pnlMarge;
      }
    }
    tousA.push(...aInst); tousB.push(...bInst); tousC.push(...cInst);
    const bA = bilan(aInst);
    parInstrument.push({ nom, perles: perlesIci, ...bA });
    console.log(`  ${nom.padEnd(6)} ${String(perlesIci).padStart(2)}/${listePoints.length} points avec perle · ` +
      `${String(bA.trades).padStart(4)} trades · wr ${(bA.trades ? bA.winrate.toFixed(1) : "—").padStart(5)} % · ` +
      `net ${bA.net.toFixed(2).padStart(8)} · par trade ${(bA.trades ? bA.moyenne.toFixed(4) : "—").padStart(8)} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }

  const A = bilan(tousA), B = bilan(tousB), C = bilan(tousC);
  const temoin = partBattue(tousA, tousB, TIRAGES);
  const temoinC = partBattue(tousA, tousC, TIRAGES);

  console.log(`[BANC-CHERCHEUR] resultat, tout hors echantillon :`);
  console.log(`  A  chercheur seul          : ${A.trades} trades · wr ${A.winrate.toFixed(1)} % · net ${A.net.toFixed(2)} · par trade ${A.moyenne.toFixed(4)} · creux ${A.creux.toFixed(2)}`);
  console.log(`  B  chercheur + regime      : ${B.trades} trades · wr ${(B.trades ? B.winrate.toFixed(1) : "—")} % · net ${B.net.toFixed(2)} · par trade ${(B.trades ? B.moyenne.toFixed(4) : "—")} · creux ${B.creux.toFixed(2)}`);
  console.log(`  C  chercheur + regime prop.: ${C.trades} trades · wr ${(C.trades ? C.winrate.toFixed(1) : "—")} % · net ${C.net.toFixed(2)} · par trade ${(C.trades ? C.moyenne.toFixed(4) : "—")} · creux ${C.creux.toFixed(2)}`);
  console.log(`  temoin : B bat ${temoin == null ? "—" : (100 * temoin).toFixed(1) + " %"} des retraits au hasard de meme taille`);
  console.log(`  temoin : C bat ${temoinC == null ? "—" : (100 * temoinC).toFixed(1) + " %"} des retraits au hasard de meme taille`);
  console.log(`  un temoin autour de 50 % veut dire que le filtre fait exactement ce que ferait le hasard :`);
  console.log(`  il retire des trades d'un ensemble qui perd, et retirer au hasard aurait fait aussi bien.`);

  // Les frais, seuls, pour situer l'ordre de grandeur du probleme.
  const fraisParTrade = 2 * 0.0005 * LEVIER;
  console.log(`  pour memoire : les frais coutent ${fraisParTrade.toFixed(4)} de marge par trade, soit ${(A.trades * fraisParTrade).toFixed(2)} sur ${A.trades} trades.`);
  console.log(`  sans frais, le bras A ferait net ${(A.net + A.trades * fraisParTrade).toFixed(2)}.`);

  /* La question qui decide de tout : cet avantage existe-t-il ? */
  const sigNet = significativite(tousA);
  const sigBrut = significativite(tousA.map((t) => ({ pnlMarge: t.pnlMarge + fraisParTrade })));
  console.log(`[BANC-CHERCHEUR] l'avantage est-il distinguable de zero ?`);
  console.log(`  net de frais  : moyenne ${sigNet.moyenne.toFixed(4)} · ecart-type ${sigNet.ecartType.toFixed(4)} · erreur standard ${sigNet.erreur.toFixed(4)} · t = ${sigNet.t.toFixed(2)}`);
  console.log(`  brut de frais : moyenne ${sigBrut.moyenne.toFixed(4)} · ecart-type ${sigBrut.ecartType.toFixed(4)} · erreur standard ${sigBrut.erreur.toFixed(4)} · t = ${sigBrut.t.toFixed(2)}`);
  console.log(`  lecture : |t| sous 2 veut dire « indistinguable de zero avec ces donnees ». Un t brut proche de zero`);
  console.log(`  signifie que le procede n'a pas d'avantage demontre AVANT meme de payer les frais, et qu'aucune`);
  console.log(`  couche posee par-dessus ne peut en creer un.`);

  console.log(`[BANC-CHERCHEUR] par point de la glissade (perles trouvees · trades · net) :`);
  for (let k = 0; k < listePoints.length; k++) {
    const p = parPoint[k];
    console.log(`  ${new Date(listePoints[k]).toISOString().slice(0, 10)} : ${String(p.perles).padStart(2)} perles · ${String(p.trades).padStart(4)} trades · net ${p.net.toFixed(2).padStart(8)}`);
  }
  console.log(`[BANC-CHERCHEUR] ce script ne branche rien.`);
}

if (require.main === module) main();
