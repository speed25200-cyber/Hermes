#!/usr/bin/env node
/* ============================================================================
   LE SUIVI HORS ÉCHANTILLON — la seule mesure qui n'a pas été choisie
   après coup.

   Tout le reste de ce dépôt souffre du même défaut, et il vaut mieux
   l'écrire que le taire : chaque chiffre y a été obtenu en regardant des
   données déjà connues. Le chercheur de perles choisit ses seuils sur
   l'histoire qu'il vient de lire ; le banc transversal déclare sa grille
   d'avance, mais lit les vingt et une cellules d'un coup et doit ensuite
   se corriger lourdement de les avoir toutes vues. Il n'existe qu'un
   seul remède connu à cela, et il ne s'achète pas avec du calcul : il
   faut écrire l'hypothèse AVANT que les données n'existent, puis
   attendre.

   C'est ce qui a été fait le 2 septembre 2026, dans docs/avantage.md, et
   qui est recopié ici mot pour mot :

     « Sur un univers de trente perpétuels majeurs, classer chaque
       instrument par son taux de financement, être long les cinq plus
       bas et court les cinq plus hauts, rebalancer toutes les 72 heures.
       Aucun autre signal, aucun autre horizon, aucun autre nombre de
       positions. »

   Ce script mesure CELA et rien d'autre. Les constantes ci-dessous ne
   sont pas configurables, et ce n'est pas un oubli : une variable
   d'environnement qui permettrait d'essayer 96 heures « pour voir »
   transformerait la pré-inscription en une grille de plus, et rendrait
   au hasard exactement ce qu'on avait passé un mois à lui retirer.

   Il calcule aussi, et c'est peut-être le plus utile, DANS COMBIEN DE
   TEMPS la question pourra être tranchée. La réponse est longue. Elle
   est écrite ici pour que personne — moi compris — ne lise un verdict
   dans trois mois de données.

   Ne lit que data/cache-long, data/extra et data/transversal.json.
   N'écrit que data/hors_echantillon.json. Ne branche rien.
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");
const T = require(path.join(RACINE, "deploy", "banc_transversal.js"));
const JUGE = require(path.join(RACINE, "modules", "juge.js"));

/* ---- L'HYPOTHÈSE, telle qu'elle a été consignée. Ne pas modifier. ---- */

const PRE = Object.freeze({
  signal: "financement",
  heures: 72,
  k: 5,
  univers: ("BTC,ETH,SOL,XRP,DOGE,ADA,AVAX,LINK,LTC,BCH,DOT,FIL,NEAR,ATOM,UNI," +
            "APT,ARB,OP,TRX,ETC,XLM,ICP,INJ,SUI,SEI,TIA,AAVE,ALGO,SAND,MANA")
             .split(",").map((s) => s + "-USDT-SWAP"),
  date: "2026-09-02",
  /* Ce que l'échantillon d'apprentissage avait donné. Sert de point de
     comparaison et de base au calcul de puissance — jamais de seuil. */
  sharpeAttendu: 0.137,
});

const T_PRE = Date.parse(PRE.date + "T00:00:00Z");
const H5 = T.H5;

/* Seule la résolution du null se règle de l'extérieur : elle ne touche
   pas à l'hypothèse, seulement à la finesse avec laquelle on la juge. */
const TIRAGES = Number(process.env.HORS_TIRAGES || 40);

/* ---- lecture ---- */

function charger() {
  const brutes = [];
  for (const instId of PRE.univers) {
    const px = T.lireCandles(instId);
    if (!px) continue;
    const ex = T.lireExtra(instId);
    brutes.push({ instId, px, finBrut: ex && ex.financement && ex.financement.length ? ex.financement : null });
  }
  return brutes;
}

/* ---- la coupure ----

   La fenêtre d'apprentissage et la fenêtre d'épreuve partagent une
   SEULE passe de calcul, et c'est délibéré. Les caractéristiques ont
   besoin de quinze jours de chauffe ; les frais dépendent de la
   position tenue au tour précédent. Découper les bougies au 2 septembre
   et repartir de zéro donnerait à l'épreuve deux semaines de chauffe
   perdues et un livre vide à ouvrir — deux artefacts qui n'existent pas
   dans la vraie vie, où la stratégie tournait déjà la veille.

   On évalue donc l'histoire entière d'un trait, puis on répartit les
   périodes obtenues de part et d'autre de la date. La période qui
   ENJAMBE la date n'appartient à aucune des deux : elle a commencé
   avant que l'hypothèse ne soit écrite et s'est finie après. */
function couper(periodes, t0) {
  const avant = [], apres = [];
  for (const p of periodes) {
    const debut = t0 + p.i * H5;
    const fin = debut + PRE.heures * H5;
    if (fin <= T_PRE) avant.push(p);
    else if (debut >= T_PRE) apres.push(p);
  }
  return { avant, apres };
}

/* ---- combien de temps faut-il ? ----

   Un t de Student vaut sharpe x racine(n). Pour atteindre un t de 2 sur
   un effet de la taille observée en apprentissage, il faut donc
   (2 / sharpe)^2 périodes. Avec le sharpe par période de l'échantillon
   d'apprentissage — 0,137 — cela fait 213 périodes de 72 heures, soit
   près de deux ans.

   Ce chiffre est le vrai résultat de ce script tant qu'il n'y a pas de
   données. Il dit qu'une stratégie dont l'avantage par période est
   petit devant son bruit ne peut PAS être validée vite, quelle que soit
   la quantité de calcul qu'on y met, et que lire un verdict sur trois
   mois reviendrait à relire du bruit. */
/* Le plafond n'est pas une precaution de programmeur : c'est la reponse
   elle-meme. Un avantage par periode negligeable devant son bruit
   demande un nombre de periodes qui n'a pas de sens humain, et la
   formule le dit en produisant une date au-dela de l'an dix mille. On
   la refuse alors, et le suivi repond « jamais » — ce qui est
   l'information utile, pas une erreur a rattraper. */
const HORIZON_MAX = 40 * 365 * 24 / 72;         // quarante ans de periodes

function puissance(sharpe, nDeja) {
  const s = Math.abs(sharpe);
  if (!(s > 1e-6)) return { requis: Infinity, manque: Infinity, jours: Infinity, quand: null };
  const requis = Math.ceil((2 / s) ** 2);
  const manque = Math.max(0, requis - nDeja);
  if (manque > HORIZON_MAX) return { requis, manque, jours: Math.round(manque * PRE.heures / 24), quand: null };
  return { requis, manque, jours: Math.round(manque * PRE.heures / 24),
           quand: new Date(Date.now() + manque * PRE.heures * 3600e3).toISOString().slice(0, 10) };
}

/* ---- l'historique sur disque ---- */

function lireHistorique(chemin) {
  try {
    const v = JSON.parse(fs.readFileSync(chemin, "utf8"));
    return Array.isArray(v.historique) ? v.historique : [];
  } catch { return []; }
}

function main() {
  console.log(`[HORS] hypothese consignee le ${PRE.date} : ${PRE.signal} a ${PRE.heures} h, ${PRE.k} longs et ${PRE.k} courts sur ${PRE.univers.length} instruments.`);
  console.log(`[HORS] aucun parametre de cette ligne n'est reglable. C'est le seul interet de la manoeuvre.`);
  console.log(`[HORS] conditions de jeu, consignees mais non figees : frais ${T.FRAIS}, levier ${T.LEVIER}.`);

  const brutes = charger();
  if (brutes.length < 2 * PRE.k + 2) {
    console.error(`[HORS] seulement ${brutes.length} instruments avec histoire : pas assez pour classer.`);
    process.exit(1);
  }

  const t0 = Math.max(...brutes.map((d) => d.px[0][0]));
  const t1 = Math.min(...brutes.map((d) => d.px[d.px.length - 1][0]));
  const n = Math.floor((t1 - t0) / H5) + 1;
  console.log(`[HORS] fenetre commune : ${new Date(t0).toISOString().slice(0, 10)} → ${new Date(t1).toISOString().slice(0, 10)} (${brutes.length} instruments)`);

  const donnees = brutes.map((d) => {
    const closes = T.grilleHoraire(d.px, t0, n, 4);
    return { instId: d.instId, closes, car: T.caracteristiques(closes),
             fin: T.grilleHoraire(d.finBrut, t0, n, 1) };
  });
  const avecFin = brutes.filter((d) => d.finBrut).length;
  if (avecFin < 2 * PRE.k + 2) {
    console.error(`[HORS] ${avecFin} instruments seulement ont un taux de financement : l'hypothese porte sur le financement, elle ne peut pas etre mesuree.`);
    process.exit(1);
  }

  const toutes = T.evaluer(donnees, PRE.signal, PRE.heures, PRE.k);
  const { avant, apres } = couper(toutes, t0);
  const sAvant = T.stats(avant);
  const sApres = T.stats(apres);

  console.log(`[HORS] apprentissage (avant le ${PRE.date}) : ${sAvant.n} periodes, net ${sAvant.net.toFixed(2)}, t ${sAvant.t.toFixed(2)}, sharpe/periode ${sAvant.sharpe.toFixed(3)}`);
  console.log(`[HORS] EPREUVE (a partir du ${PRE.date}) : ${sApres.n} periodes${sApres.n >= 3 ? `, net ${sApres.net.toFixed(2)}, t ${sApres.t.toFixed(2)}, sharpe/periode ${sApres.sharpe.toFixed(3)}` : ""}`);

  /* Le null, sur la SEULE fenêtre d'épreuve. Il ne remplace pas
     l'attente : avec dix périodes, la distribution nulle est large et
     ne tranchera rien non plus. Il est là parce qu'il ne suppose
     aucune loi normale, là où le t en suppose une. */
  let pct = null, medianNul = null;
  if (sApres.n >= 10) {
    console.log(`[HORS] ${TIRAGES} repliques melangees pour la fenetre d'epreuve…`);
    const pour = brutes.map((d, i) => ({ ...d, fin: donnees[i].fin }));
    const nets = [];
    for (let g = 0; g < TIRAGES; g++) {
      const r = T.repliques(pour, t0, n, g + 1);
      nets.push(T.stats(couper(T.evaluer(r, PRE.signal, PRE.heures, PRE.k), t0).apres).net);
    }
    nets.sort((a, b) => a - b);
    medianNul = nets[nets.length >> 1];
    pct = JUGE.percentileDe(nets, sApres.net);
    console.log(`[HORS] nul de la fenetre d'epreuve : median ${medianNul.toFixed(2)}, le reel bat ${pct == null ? "—" : (100 * pct).toFixed(0) + " %"} des repliques`);
  } else if (sApres.n > 0) {
    console.log(`[HORS] moins de dix periodes : le null ne serait pas lisible, on ne le tire pas.`);
  }

  /* La puissance se calcule sur l'effet ATTENDU, celui de
     l'apprentissage — pas sur celui qu'on vient de mesurer. Utiliser
     l'effet observé pour décider combien de données il faut serait
     refermer la boucle qu'on essaie précisément d'ouvrir. */
  const sharpeRef = Number.isFinite(sAvant.sharpe) && sAvant.n >= 30 ? sAvant.sharpe : PRE.sharpeAttendu;
  const p = puissance(sharpeRef, sApres.n);
  console.log(`[HORS] pour trancher a t = 2 sur un effet de taille ${sharpeRef.toFixed(3)} par periode, il faut ${Number.isFinite(p.requis) ? p.requis + " periodes" : "un nombre de periodes sans limite"} de ${PRE.heures} h.`);
  if (p.manque > 0 && !p.quand) {
    console.log(`[HORS] l'avantage par periode est trop petit devant son bruit : aucune duree raisonnable ne le trancherait.`);
    console.log(`[HORS] ce n'est pas un defaut de mesure, c'est la reponse : une strategie pareille n'est pas verifiable, donc pas jouable.`);
  } else if (p.manque > 0) {
    console.log(`[HORS] il en manque ${p.manque}, soit ${p.jours} jours : pas de verdict lisible avant le ${p.quand} environ.`);
    console.log(`[HORS] tout chiffre lu avant cette date est du bruit, y compris s'il est beau.`);
  } else {
    console.log(`[HORS] la fenetre d'epreuve a la taille requise. Le verdict ci-dessus se lit.`);
    const tenu = sApres.t >= 2 && sApres.net > 0 && (pct == null || pct >= 0.95);
    console.log(`[HORS] ${tenu ? "L'HYPOTHESE TIENT hors echantillon." : "L'hypothese NE tient PAS hors echantillon. Elle est refutee, et c'est un resultat."}`);
  }

  /* Le journal. Chaque passe ajoute une ligne : ce qui compte n'est pas
     la valeur d'un jour mais la façon dont elle se déplace à mesure que
     les périodes s'accumulent. Un t qui monte régulièrement vers 2 et un
     t qui oscille autour de zéro ne se distinguent que sur la durée. */
  const chemin = path.join(RACINE, "data", "hors_echantillon.json");
  try {
    const historique = lireHistorique(chemin);
    const ligne = { quand: new Date().toISOString().slice(0, 10), periodes: sApres.n,
                    net: +sApres.net.toFixed(3), brut: +sApres.brut.toFixed(3),
                    t: +sApres.t.toFixed(2), sharpe: +sApres.sharpe.toFixed(3),
                    percentileNul: pct == null ? null : +pct.toFixed(2) };
    if (!historique.length || historique[historique.length - 1].quand !== ligne.quand) historique.push(ligne);
    else historique[historique.length - 1] = ligne;
    while (historique.length > 400) historique.shift();

    const contenu = {
      genere: new Date().toISOString(),
      hypothese: { signal: PRE.signal, heures: PRE.heures, k: PRE.k,
                   instruments: PRE.univers.length, consignee: PRE.date,
                   enonce: `Classer ${PRE.univers.length} perpetuels par taux de financement, long les ${PRE.k} plus bas, court les ${PRE.k} plus hauts, rebalancement toutes les ${PRE.heures} h.` },
      fenetre: { du: new Date(t0).toISOString().slice(0, 10), au: new Date(t1).toISOString().slice(0, 10),
                 instruments: donnees.length, avecFinancement: avecFin },
      /* Les frais et le levier ne sont pas des reglages de l'hypothese —
         c'est l'environnement dans lequel on la joue — mais ils changent
         le net, et un reglage qui change un resultat sans laisser de
         trace est exactement ce que cette manoeuvre existe pour empecher.
         Ils sont donc consignes a chaque passe : si le net bouge un jour
         sans que le marche ait bouge, la raison sera lisible ici. */
      conditions: { frais: T.FRAIS, levier: T.LEVIER },
      apprentissage: { periodes: sAvant.n, net: +sAvant.net.toFixed(3), brut: +sAvant.brut.toFixed(3),
                       t: +sAvant.t.toFixed(2), sharpe: +sAvant.sharpe.toFixed(3) },
      epreuve: { periodes: sApres.n, net: +sApres.net.toFixed(3), brut: +sApres.brut.toFixed(3),
                 t: +sApres.t.toFixed(2), sharpe: +sApres.sharpe.toFixed(3),
                 creux: +sApres.creux.toFixed(2), rotation: +(sApres.rotation || 0).toFixed(1),
                 percentileNul: pct == null ? null : +pct.toFixed(2),
                 medianNul: medianNul == null ? null : +medianNul.toFixed(3), tirages: pct == null ? 0 : TIRAGES },
      puissance: { sharpeReference: +sharpeRef.toFixed(3),
                   periodesRequises: Number.isFinite(p.requis) ? p.requis : null,
                   periodesManquantes: Number.isFinite(p.manque) ? p.manque : null,
                   joursRestants: Number.isFinite(p.jours) ? p.jours : null,
                   lisibleLe: p.manque > 0 ? p.quand : null },
      historique,
    };
    fs.mkdirSync(path.dirname(chemin), { recursive: true });
    fs.writeFileSync(chemin + ".tmp", JSON.stringify(contenu, null, 1));
    fs.renameSync(chemin + ".tmp", chemin);
    console.log(`[HORS] journal ecrit : ${chemin} (${historique.length} releve(s))`);
  } catch (e) { console.log(`[HORS] journal non ecrit : ${e.message}`); }

  console.log(`[HORS] ce script ne branche rien et ne change aucun parametre du moteur.`);
}

if (require.main === module) main();
module.exports = { PRE, couper, puissance, T_PRE };
