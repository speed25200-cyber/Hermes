#!/usr/bin/env node
/* ============================================================================
   LE BANC TRANSVERSAL — changer de question, pas de modèle.

   Ce que douze mois de mesures ont fermé :

     par instrument, sur bougies de 5 minutes, en pariant contre le
     mouvement    → avantage brut −0,0012 de marge par trade, t = −0,22
     en le suivant → −0,0028, t = −0,49
     en visant six fois plus grand et plus rare → −0,0009, t = −0,04

   Trois portes, trois zéros. La conclusion n'est pas que le marché est
   imprévisible : c'est que la QUESTION posée n'a pas de réponse. « BTC
   va-t-il monter dans l'heure ? » est arbitrée en secondes par des
   acteurs mieux placés, et il ne reste rien pour un moteur qui regarde
   la même bougie qu'eux.

   Ce banc pose une autre question, celle que la littérature soutient
   encore :

     « Parmi trente instruments, lesquels vont faire MIEUX que les
       autres cette semaine ? »

   La différence n'est pas cosmétique. Prédire un niveau absolu demande
   de battre le marché sur sa propre information. Prédire un CLASSEMENT
   ne demande que de repérer une asymétrie relative, et le mouvement
   commun à toute la crypto — qui est l'essentiel de la variance et
   l'essentiel du risque — s'annule entre le côté long et le côté court.

   Deux familles de signaux sont essayées, et seulement deux, parce que
   chacune a une raison d'exister avant d'avoir un chiffre :

     LE PRIX RELATIF. Momentum transversal (ce qui monte le plus
     continue) et son inverse (ce qui monte le plus revient). Documenté
     sur actions depuis quarante ans, sur crypto depuis 2018.

     LE POSITIONNEMENT. Le taux de financement dit qui paie qui pour
     tenir sa position. Un financement très positif dit que les longs
     sont encombrés et paient pour le rester. Ce n'est PAS dans le prix :
     deux instruments au même graphique peuvent avoir des financements
     opposés. C'est la seule donnée de ce banc que le marché n'a pas
     déjà entièrement digérée dans la série des prix.

   LA DISCIPLINE. Aucun paramètre n'est ajusté sur les résultats. La
   grille est déclarée avant de voir un chiffre, TOUS ses résultats sont
   imprimés — y compris les mauvais — et chaque cellule est comparée à
   sa propre distribution nulle. Le null mélange les journées de chaque
   instrument avec une permutation DIFFÉRENTE : cela détruit le lien
   entre le classement d'un instrument et son rendement futur, en
   gardant toutes les distributions marginales. C'est exactement
   l'hypothèse qu'on veut réfuter.

   Ne lit que data/cache-long et data/extra. N'écrit rien.
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");
const JUGE = require(path.join(RACINE, "modules", "juge.js"));
const CACHE = path.join(RACINE, "data", "cache-long");
const EXTRA = path.join(RACINE, "data", "extra");

const LEVIER = Number(process.env.HERMES_DEFAULT_LEVERAGE || 15);
const FRAIS = Number(process.env.HERMES_FRAIS || 0.0005);
const TIRAGES = Number(process.env.TRANSVERSAL_TIRAGES || 20);
const K = Number(process.env.TRANSVERSAL_K || 5);           // longs en haut, courts en bas
const HEURES = (process.env.TRANSVERSAL_HEURES || "24,72,168").split(",").map(Number);
const H5 = 3600e3, J5 = 86400e3;

const UNIVERS = (process.env.BANC_UNIVERS ||
  "BTC,ETH,SOL,XRP,DOGE,ADA,AVAX,LINK,LTC,BCH,DOT,FIL,NEAR,ATOM,UNI,APT,ARB,OP,TRX,ETC,XLM,ICP,INJ,SUI,SEI,TIA,AAVE,ALGO,SAND,MANA")
  .split(",").map((s) => s.trim() + "-USDT-SWAP");

/* ---- les données ---- */

function lireCandles(instId) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(CACHE, instId + ".json"), "utf8"));
    return Array.isArray(r) && r.length > 288 * 60 ? r : null;
  } catch { return null; }
}
function lireExtra(instId) {
  try { return JSON.parse(fs.readFileSync(path.join(EXTRA, instId + ".json"), "utf8")); }
  catch { return null; }
}

/* La dernière valeur connue à un instant donné. Jamais la suivante :
   c'est toute la différence entre une mesure et une prophétie. */
function derniereAvant(serie, quand) {
  if (!serie || !serie.length || quand < serie[0][0]) return null;
  let lo = 0, hi = serie.length - 1, t = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (serie[m][0] <= quand) { t = m; lo = m + 1; } else hi = m - 1; }
  return t < 0 ? null : serie[t][1];
}

/* ---- la grille horaire : le prix a chaque heure, une fois pour toutes ---- */

/* La première version cherchait chaque valeur par dichotomie dans les
   105 000 bougies de cinq minutes. Pour une seule cellule de la grille
   cela faisait soixante millions d'opérations, et il y a vingt et une
   cellules à multiplier par vingt et une répliques : le banc n'aurait
   jamais rendu son verdict.

   Une stratégie qui rebalance toutes les vingt-quatre heures n'a que
   faire de la résolution de cinq minutes. On projette donc chaque
   instrument sur une grille horaire commune, une fois, et tout le reste
   devient de l'indexation directe. Le report de la dernière valeur
   connue (et jamais de la suivante) préserve la causalité. */
function grilleHoraire(serie, t0, n, colonne) {
  const out = new Float64Array(n).fill(NaN);
  if (!serie || !serie.length) return out;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const T = t0 + i * H5;
    while (j + 1 < serie.length && serie[j + 1][0] <= T) j++;
    if (serie[j][0] <= T) out[i] = serie[j][colonne];
  }
  return out;
}

/* Les caractéristiques, calculées d'un bout à l'autre en une passe. La
   volatilité glisse par sommes courantes : la recalculer sur 336 points
   à chaque heure serait le seul endroit où ce banc pourrait ramer. */
function caracteristiques(closes) {
  const n = closes.length;
  const r1 = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) if (closes[i] > 0 && closes[i - 1] > 0) r1[i] = Math.log(closes[i] / closes[i - 1]);
  const r24 = new Float64Array(n).fill(NaN), r7 = new Float64Array(n).fill(NaN), vol = new Float64Array(n).fill(NaN);
  const FEN = 14 * 24;
  let s = 0, q = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (i >= 24 && closes[i] > 0 && closes[i - 24] > 0) r24[i] = Math.log(closes[i] / closes[i - 24]);
    if (i >= 168 && closes[i] > 0 && closes[i - 168] > 0) r7[i] = Math.log(closes[i] / closes[i - 168]);
    if (Number.isFinite(r1[i])) { s += r1[i]; q += r1[i] * r1[i]; cnt++; }
    if (i >= FEN && Number.isFinite(r1[i - FEN])) { s -= r1[i - FEN]; q -= r1[i - FEN] * r1[i - FEN]; cnt--; }
    if (cnt > 48) { const m = s / cnt; const v = q / cnt - m * m; if (v > 0) vol[i] = Math.sqrt(v); }
  }
  return { r1, r24, r7, vol };
}

/* ---- les signaux transversaux ---- */

/* Chacun rend un SCORE à l'indice horaire i. Le classement se fait sur
   ce score : les K plus hauts en long, les K plus bas en court. Un
   score incalculable ÉCARTE l'instrument de ce rebalancement ; le
   mettre à zéro le placerait artificiellement au milieu du classement,
   ce qui est une opinion et non une absence d'opinion. */
const SIGNAUX = {
  momentum: {
    quoi: "rendement des 7 derniers jours — ce qui monte le plus continue",
    score: (d, i) => d.car.r7[i],
  },
  retournement: {
    quoi: "rendement des 7 derniers jours, inverse — ce qui monte le plus revient",
    score: (d, i) => -d.car.r7[i],
  },
  momentum_court: {
    quoi: "rendement des 24 dernieres heures",
    score: (d, i) => d.car.r24[i],
  },
  retournement_court: {
    quoi: "rendement des 24 dernieres heures, inverse",
    score: (d, i) => -d.car.r24[i],
  },
  financement: {
    quoi: "taux de financement, inverse — on prend le cote que personne ne paie pour tenir",
    score: (d, i) => -d.fin[i],
  },
  financement_normalise: {
    quoi: "financement rapporte a la volatilite — un meme taux ne pese pas pareil sur BTC et sur un altcoin",
    score: (d, i) => -d.fin[i] / d.car.vol[i],
  },
  momentum_normalise: {
    quoi: "rendement 7 jours rapporte a la volatilite (un ratio de Sharpe court)",
    score: (d, i) => d.car.r7[i] / d.car.vol[i],
  },
};

/* ---- l'évaluation d'une combinaison ---- */

function evaluer(donnees, nomSignal, heures, k) {
  const sig = SIGNAUX[nomSignal];
  const n = donnees[0].closes.length;
  const debut = 15 * 24;                      // de quoi calculer 7 j et 14 j de volatilite
  const periodes = [];
  const tampon = [];
  let precedent = new Map();                  // instId -> sens tenu au tour d'avant

  for (let i = debut; i + heures < n; i += heures) {
    tampon.length = 0;
    for (const d of donnees) {
      const c = d.closes[i], f = d.closes[i + heures];
      if (!(c > 0) || !(f > 0)) continue;
      const s = sig.score(d, i);
      if (!Number.isFinite(s)) continue;
      tampon.push({ id: d.instId, s, r: Math.log(f / c) });
    }
    if (tampon.length < 2 * k + 2) continue;
    tampon.sort((a, b) => b.s - a.s);
    let rL = 0, rC = 0;
    const courant = new Map();
    for (let j = 0; j < k; j++) {
      rL += tampon[j].r; courant.set(tampon[j].id, 1);
      const c2 = tampon[tampon.length - 1 - j];
      rC += c2.r; courant.set(c2.id, -1);
    }
    const brut = ((rL - rC) / k) / 2;

    /* LES FRAIS, comptes sur la ROTATION reelle. La premiere version
       facturait un aller-retour complet a chaque rebalancement, comme si
       tout le livre etait solde puis rouvert. C'est le pire cas, et il
       etait volontaire tant qu'on ne savait pas si un signal existait ;
       mais c'est faux, et cette fausseté joue contre les horizons longs
       precisement la ou ils devraient briller : un instrument qui reste
       dans les cinq premiers d'une semaine sur l'autre n'est pas
       retrade, il est simplement conserve.

       Une jambe se paie quand une position s'ouvre et quand elle se
       ferme. Un changement de sens sur un meme instrument compte pour
       deux : on solde et on repart de l'autre cote. */
    let jambes = 0;
    for (const [id, sens] of courant) { const av = precedent.get(id); if (av === undefined) jambes += 1; else if (av !== sens) jambes += 2; }
    for (const [id] of precedent) if (!courant.has(id)) jambes += 1;
    const cout = FRAIS * jambes / (2 * k);
    precedent = courant;

    periodes.push({ i, brut: brut * LEVIER, net: (brut - cout) * LEVIER, n: tampon.length, jambes });
  }
  return periodes;
}

function stats(periodes) {
  const n = periodes.length;
  if (n < 3) return { n, moyenne: 0, ecartType: 0, t: 0, net: 0, brut: 0, sharpe: 0, creux: 0 };
  const x = periodes.map((p) => p.net);
  const b = periodes.map((p) => p.brut);
  const moy = (a) => a.reduce((u, v) => u + v, 0) / a.length;
  const ecart = (a, m) => Math.sqrt(a.reduce((u, v) => u + (v - m) ** 2, 0) / (a.length - 1));
  const m = moy(x), sd = ecart(x, m);
  const mb = moy(b), sdb = ecart(b, mb);
  let cum = 0, sommet = 0, creux = 0;
  for (const v of x) { cum += v; if (cum > sommet) sommet = cum; if (sommet - cum > creux) creux = sommet - cum; }
  /* Deux t plutot qu'un, parce que ce sont deux questions distinctes :
     « le signal existe-t-il ? » se lit sur le BRUT, « est-il negociable ? »
     sur le net. Un signal reel mange par les frais reste un signal reel,
     et c'est une information qu'un seul t effacerait. */
  const rot = periodes.reduce((u, p) => u + (p.jambes || 0), 0) / n;
  return { n, moyenne: m, ecartType: sd, t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0,
           net: cum, sharpe: sd > 0 ? m / sd : 0, creux, rotation: rot,
           brut: b.reduce((u, v) => u + v, 0),
           moyenneBrut: mb, tBrut: sdb > 0 ? mb / (sdb / Math.sqrt(n)) : 0 };
}

/* ---- le null : chaque instrument mélangé SÉPARÉMENT ---- */

/* Une permutation commune garderait intacte la relation entre
   instruments et ne testerait rien. Des permutations indépendantes
   cassent le lien entre le classement d'un instrument et son rendement
   futur, tout en conservant chaque distribution marginale. C'est
   exactement l'hypothèse à réfuter : « le classement ne contient aucune
   information sur la suite ».

   Le financement n'est PAS mélangé. On teste si le classement par
   financement prédit les rendements ; c'est le lien qu'il faut casser,
   pas la série elle-même. */
function repliques(brutes, t0, n, graine) {
  return brutes.map((d, idx) => {
    const px = JUGE.melangerParBlocs(d.px, graine * 1000 + idx);
    const closes = grilleHoraire(px, t0, n, 4);
    return { instId: d.instId, closes, car: caracteristiques(closes), fin: d.fin };
  });
}

/* ---- la passe ---- */

function main() {
  console.log(`[TRANSVERSAL] classement de ${UNIVERS.length} instruments · K=${K} longs et ${K} courts · levier ${LEVIER}`);
  console.log(`[TRANSVERSAL] frais comptes sur la ROTATION reelle : ${(FRAIS * LEVIER).toFixed(4)} de marge par jambe rapportee au livre ; un instrument qui reste dans le classement n'est pas retrade`);

  const brutes = [];
  for (const instId of UNIVERS) {
    const px = lireCandles(instId);
    if (!px) continue;
    const ex = lireExtra(instId);
    brutes.push({ instId, px, finBrut: ex && ex.financement && ex.financement.length ? ex.financement : null });
  }
  if (brutes.length < 2 * K + 2) { console.error("[TRANSVERSAL] pas assez d'instruments avec histoire"); process.exit(1); }

  // La grille horaire commune : du plus tardif des débuts au plus
  // précoce des fins, pour que tous les instruments soient comparables
  // à chaque instant du classement.
  const t0 = Math.max(...brutes.map((d) => d.px[0][0]));
  const t1 = Math.min(...brutes.map((d) => d.px[d.px.length - 1][0]));
  const n = Math.floor((t1 - t0) / H5) + 1;
  console.log(`[TRANSVERSAL] periode commune : ${new Date(t0).toISOString().slice(0, 10)} → ${new Date(t1).toISOString().slice(0, 10)} (${n} heures)`);

  const donnees = brutes.map((d) => {
    const closes = grilleHoraire(d.px, t0, n, 4);
    return { instId: d.instId, closes, car: caracteristiques(closes),
             fin: grilleHoraire(d.finBrut, t0, n, 1) };
  });
  const avecFin = brutes.filter((d) => d.finBrut).length;
  console.log(`[TRANSVERSAL] ${donnees.length} instruments avec bougies, ${avecFin} avec financement`);

  const noms = Object.keys(SIGNAUX).filter((x) => avecFin >= 2 * K + 2 || !/financement/.test(x));
  const cellules = noms.length * HEURES.length;
  console.log(`[TRANSVERSAL] grille declaree AVANT de voir un chiffre : ${noms.length} signaux x ${HEURES.length} horizons = ${cellules} cellules`);
  console.log(`[TRANSVERSAL] avec ${cellules} cellules, on attend ${(0.05 * cellules).toFixed(1)} cellule(s) au-dela du 95e percentile PAR HASARD.`);
  console.log(`[TRANSVERSAL] une seule cellule brillante ne prouverait donc rien ; c'est ecrit ici avant d'avoir vu le tableau.`);
  for (const x of noms) console.log(`  ${x.padEnd(22)} ${SIGNAUX[x].quoi}`);

  console.log(`[TRANSVERSAL] construction de ${TIRAGES} repliques melangees…`);
  const tR = Date.now();
  const rep = [];
  for (let g = 0; g < TIRAGES; g++) rep.push(repliques(brutes.map((d, i) => ({ ...d, fin: donnees[i].fin })), t0, n, g + 1));
  console.log(`[TRANSVERSAL] repliques pretes en ${((Date.now() - tR) / 1000).toFixed(0)} s`);

  const lignes = [];
  const matrice = [];      // [cellule][replique] : le net de chaque cellule sur chaque replique
  for (const nom of noms) {
    for (const h of HEURES) {
      const vrai = stats(evaluer(donnees, nom, h, K));
      if (vrai.n < 10) { lignes.push({ nom, h, vrai, pct: null }); continue; }
      const parReplique = rep.map((r) => stats(evaluer(r, nom, h, K)).net);
      matrice.push(parReplique);
      const tri = [...parReplique].sort((a, b) => a - b);
      lignes.push({ nom, h, vrai, pct: JUGE.percentileDe(tri, vrai.net), medianNul: tri[tri.length >> 1] });
    }
  }

  console.log(`[TRANSVERSAL] resultats — TOUTES les cellules, y compris les mauvaises :`);
  console.log(`  ${"signal".padEnd(22)} ${"h".padStart(4)} ${"periodes".padStart(8)} ${"net".padStart(8)} ${"brut".padStart(8)} ${"t net".padStart(6)} ${"t brut".padStart(7)} ${"sharpe".padStart(7)} ${"creux".padStart(7)} ${"jambes".padStart(7)} ${"nul".padStart(8)} ${"pct".padStart(5)}`);
  for (const l of [...lignes].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))) {
    const v = l.vrai;
    console.log(`  ${l.nom.padEnd(22)} ${String(l.h).padStart(4)} ${String(v.n).padStart(8)} ` +
      `${v.net.toFixed(2).padStart(8)} ${v.brut.toFixed(2).padStart(8)} ` +
      `${v.t.toFixed(2).padStart(6)} ${v.tBrut.toFixed(2).padStart(7)} ${v.sharpe.toFixed(3).padStart(7)} ${v.creux.toFixed(2).padStart(7)} ${(v.rotation || 0).toFixed(1).padStart(7)} ` +
      `${l.medianNul == null ? "      —" : l.medianNul.toFixed(2).padStart(8)} ` +
      `${l.pct == null ? "    —" : ((100 * l.pct).toFixed(0) + "e").padStart(5)}`);
  }

  /* LA CORRECTION POUR COMPARAISONS MULTIPLES, et c'est elle qui decide.

     Vingt et une cellules, c'est vingt et une chances de bien paraitre.
     Dire « une cellule est au 97e percentile de SON nul » ne veut alors
     presque rien dire : sur du bruit pur, la MEILLEURE des vingt et une
     est presque toujours haute dans son propre nul.

     La question juste porte sur la famille entiere : la meilleure
     cellule du vrai marche bat-elle la meilleure cellule des repliques ?
     Pour chaque replique, on prend le maximum sur toutes les cellules —
     ce que le hasard produit quand on le laisse chercher aussi
     librement que nous — et l'on compare le maximum reel a cette
     distribution. C'est le test de Westfall-Young, et il tient compte
     tout seul de la correlation entre cellules : momentum a 24, 72 et
     168 heures ne sont pas trois essais independants, et une correction
     de Bonferroni les punirait comme s'ils l'etaient. */
  if (matrice.length) {
    const nRep = matrice[0].length;
    const maxParReplique = [];
    for (let g = 0; g < nRep; g++) {
      let m = -Infinity;
      for (const cell of matrice) if (cell[g] > m) m = cell[g];
      maxParReplique.push(m);
    }
    maxParReplique.sort((a, b) => a - b);
    const meilleure = lignes.filter((l) => l.pct != null).reduce((a, b) => (a && a.vrai.net >= b.vrai.net ? a : b), null);
    const pFamille = meilleure ? JUGE.percentileDe(maxParReplique, meilleure.vrai.net) : null;
    console.log(`[TRANSVERSAL] epreuve de la FAMILLE ENTIERE (Westfall-Young) :`);
    console.log(`  meilleure cellule reelle : ${meilleure ? `${meilleure.nom} a ${meilleure.h} h, net ${meilleure.vrai.net.toFixed(2)}` : "aucune"}`);
    console.log(`  meilleure cellule des repliques : median ${maxParReplique[nRep >> 1].toFixed(2)}, max ${maxParReplique[nRep - 1].toFixed(2)}`);
    console.log(`  la meilleure reelle bat ${pFamille == null ? "—" : (100 * pFamille).toFixed(0) + " %"} des meilleures de repliques`);
    console.log(`  c'est LE chiffre qui decide : il tient compte des ${lignes.length} essais et de leur correlation.`);
    console.log(`  ${pFamille != null && pFamille >= 0.95 ? "AU-DELA DU SEUIL : la famille bat le hasard." : "sous le seuil de 95 % : rien de demontre au niveau de la famille."}`);
  }

  const forts = lignes.filter((l) => l.pct != null && l.pct >= 0.95 && l.vrai.t > 2 && l.vrai.net > 0);
  console.log(`[TRANSVERSAL] cellules au-dela du 95e percentile du nul ET t > 2 ET net positif : ${forts.length} (attendu par hasard : ${(0.05 * lignes.length).toFixed(1)})`);
  for (const l of forts) console.log(`  RETENUE : ${l.nom} a ${l.h} h — net ${l.vrai.net.toFixed(2)} de marge, t ${l.vrai.t.toFixed(2)}, sharpe/periode ${l.vrai.sharpe.toFixed(3)}, ${(100 * l.pct).toFixed(0)}e percentile du nul`);
  if (!forts.length) console.log(`  aucune. Le classement transversal, sur ces signaux et ces horizons, ne bat pas le hasard APRES FRAIS.`);
  // La question separee : un signal existe-t-il, meme si les frais le mangent ?
  const bruts = lignes.filter((l) => l.pct != null && l.vrai.tBrut > 2 && l.vrai.brut > 0);
  console.log(`[TRANSVERSAL] cellules dont le signal EXISTE brut de frais (t brut > 2, brut positif) : ${bruts.length}`);
  for (const l of bruts) console.log(`  ${l.nom} a ${l.h} h : brut ${l.vrai.brut.toFixed(2)} (t ${l.vrai.tBrut.toFixed(2)}), net ${l.vrai.net.toFixed(2)} — ` +
    (l.vrai.net > 0 ? "survit aux frais" : "mange par les frais : il faudrait rebalancer moins souvent ou payer moins cher"));
  console.log(`[TRANSVERSAL] ce script ne branche rien.`);
}

if (require.main === module) main();
module.exports = { SIGNAUX, evaluer, stats, derniereAvant };
