/* ============================================================================
   LE JUGE HONNÊTE — la correction qui conditionne tout le reste.

   Ce que la mesure du 2 septembre 2026 a établi, et qui a rendu ce
   fichier nécessaire :

     Le chercheur de perles a été rejoué sur douze mois d'archives, en
     glissade, puis sur LES MÊMES douze mois après avoir mélangé l'ordre
     des journées. Mélanger conserve tout — distribution des rendements,
     queues épaisses, grappes de volatilité — et ne détruit qu'une seule
     chose : ce qui relie une journée à la suivante. Autrement dit, il
     ne reste RIEN à trouver.

     Le chercheur y a trouvé autant de perles que sur le vrai marché,
     et elles y rapportaient DAVANTAGE : +0,0128 de marge par trade
     brut de frais (t = +2,39) contre −0,0012 sur le vrai marché
     (t = −0,22).

   La conclusion est sans échappatoire : les trois seuils fixes du juge
   — positif dans deux sous-fenêtres, winrate ≥ 55 %, gain moyen ≥ 0,02
   — ne mesurent pas un avantage. Ils mesurent la capacité du meilleur
   de cent cinquante-six tirages à bien paraître sur les données qui
   l'ont désigné, et cette capacité est la même dans du bruit.

   LA CORRECTION. Un seuil fixe ne peut pas savoir ce que vaut « 0,02 de
   gain moyen » : cela dépend de la volatilité de l'instrument, du
   nombre de combinaisons essayées, de la longueur de la fenêtre. Un
   seuil qui ne sait pas cela est un seuil qui se trompe. La seule
   référence qui sache tout cela est la MÊME procédure appliquée aux
   MÊMES données privées de leur structure temporelle.

   Le juge honnête ne demande donc plus « ce nombre dépasse-t-il 0,02 ? »
   mais « ce nombre dépasse-t-il ce que la même recherche produit sur ce
   même instrument quand il n'y a rien à trouver ? ». C'est la seule
   question dont la réponse ne dépend pas d'une constante devinée.

   Ce module ne remplace pas le juge existant : il l'enveloppe. La
   procédure de sélection reste mot pour mot celle de
   deploy/chercher_perles.js — on la lui passe en argument et on la
   rejoue sur des répliques mélangées. Un juge qu'on réécrirait pour le
   tester ne serait plus le juge qu'on teste.
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");
const DOSSIER_NUL = path.join(RACINE, "data", "nul");

/* Un générateur reproductible. Deux passes sur les mêmes données
   doivent rendre la même distribution nulle, sinon une perle passe ou
   ne passe pas selon l'humeur du tirage. */
function alea(graine) {
  let x = (graine * 2654435761) >>> 0 || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

/* LE MÉLANGE PAR BLOCS. On prend les vrais log-rendements de cinq
   minutes, on les découpe en journées, on mélange l'ordre des journées,
   on reconstruit le prix.

   Le choix de la journée comme bloc n'est pas cosmétique : il conserve
   la structure INTRA-journalière — l'heure de la session américaine,
   les grappes de volatilité, l'alternance calme/agité — et ne détruit
   que la mémoire d'un jour sur l'autre. Un bloc plus court détruirait
   aussi la structure intra-journalière et rendrait le faux marché trop
   facile à battre ; un bloc plus long garderait trop de mémoire et
   rendrait le null trop sévère.

   Les mèches sont reconstruites au prorata de l'amplitude de la vraie
   bougie : sans elles, cinq des treize signaux — tous ceux qui lisent
   une mèche — ne se déclencheraient jamais sur la réplique, et le null
   serait trop indulgent envers eux. */
function melangerParBlocs(c5, graine, taille) {
  const T = taille || 288;
  const suiv = alea(graine);
  const r = [];
  for (let i = 1; i < c5.length; i++) r.push(Math.log(c5[i][4] / c5[i - 1][4]));
  const blocs = [];
  for (let i = 0; i < r.length; i += T) blocs.push([i, r.slice(i, Math.min(i + T, r.length))]);
  // Le reste de journée entre dans le mélange comme les autres : sinon
  // la réplique serait plus courte que l'original, et le juge, qui
  // vérifie la longueur de son histoire, ne jugerait pas tout à fait la
  // même chose sur les deux.
  for (let i = blocs.length - 1; i > 0; i--) { const j = Math.floor(suiv() * (i + 1)); [blocs[i], blocs[j]] = [blocs[j], blocs[i]]; }

  const out = [];
  let c = c5[0][4];
  let k = 0;
  for (const [origine, bloc] of blocs) {
    for (let b = 0; b < bloc.length; b++, k++) {
      const o = c;
      c = c * Math.exp(bloc[b]);
      /* Les mèches de la bougie d'origine, en FRACTION DE PRIX, posées
         telles quelles sur la bougie d'arrivée. La première version les
         reconstruisait au prorata de l'amplitude totale et les
         rétrécissait d'un tiers en moyenne — assez pour que les cinq
         signaux qui lisent une mèche se déclenchent moins souvent sur
         la réplique que sur le vrai marché, et donc pour que leur
         distribution nulle soit trop indulgente. Ce sont précisément
         les signaux qu'il faut le plus sévèrement tester. */
      const vraie = c5[origine + b + 1] || c5[c5.length - 1];
      const ref = vraie[4] || 1;
      const hautFrac = Math.max(0, (vraie[2] - Math.max(vraie[1], vraie[4])) / ref);
      const basFrac = Math.max(0, (Math.min(vraie[1], vraie[4]) - vraie[3]) / ref);
      out.push([c5[k + 1][0], o,
                Math.max(o, c) * (1 + hautFrac),
                Math.min(o, c) * (1 - basFrac),
                c, vraie[5]]);
    }
  }
  return out;
}

/* LA DISTRIBUTION NULLE. On rejoue la procédure complète — celle qu'on
   veut juger, passée en argument — sur des répliques mélangées, et l'on
   note ce qu'elle y trouve.

   Deux nombres en sortent, et les deux comptent :

     taux    la part des répliques où la procédure trouve quand même une
             perle. Un taux élevé dit que les portes laissent passer le
             hasard ; c'est un diagnostic de la procédure, pas d'un
             instrument.
     scores  la qualité des perles ainsi trouvées, triée. C'est contre
             elle que la vraie perle devra se mesurer. */
function distributionNulle(c5, juger, options) {
  const o = options || {};
  const tirages = o.tirages || 12;
  const extraire = o.extraire || ((r) => (r && r.perle && r.perle.val) ? r.perle.val.moyenneMarge : null);
  const scores = [];
  let trouvees = 0;
  for (let t = 0; t < tirages; t++) {
    let r = null;
    try { r = juger(melangerParBlocs(c5, 1 + t)); } catch { r = null; }
    const s = extraire(r);
    if (s == null || !Number.isFinite(s)) continue;
    trouvees++;
    scores.push(s);
  }
  scores.sort((a, b) => a - b);
  return { tirages, trouvees, taux: tirages ? trouvees / tirages : 0, scores };
}

/* La part de la distribution nulle que la vraie valeur dépasse. Une
   perle au 95e percentile fait mieux que dix-neuf répliques sur vingt ;
   une perle au 50e fait exactement ce que le hasard fait. */
function percentileDe(scores, valeur) {
  if (!scores || !scores.length) return null;
  let n = 0;
  for (const s of scores) if (valeur > s) n++;
  return n / scores.length;
}

/* Le cache. Une distribution nulle coûte autant que douze recherches
   complètes : impensable toutes les trente minutes, banal une fois par
   jour. Ce qu'elle mesure — combien d'avantage apparent cette procédure
   fabrique sur un instrument de cette volatilité — ne change pas d'une
   demi-heure à l'autre. */
function cheminCache(instId) { return path.join(DOSSIER_NUL, instId.replace(/[^\w.-]/g, "_") + ".json"); }

function lireCache(instId, ageMaxMs) {
  try {
    const j = JSON.parse(fs.readFileSync(cheminCache(instId), "utf8"));
    if (!j || !Array.isArray(j.scores)) return null;
    if (Date.now() - (j.ts || 0) > ageMaxMs) return null;
    return j;
  } catch { return null; }
}

function ecrireCache(instId, d) {
  try {
    fs.mkdirSync(DOSSIER_NUL, { recursive: true });
    const tmp = cheminCache(instId) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ ts: Date.now(), ...d }));
    fs.renameSync(tmp, cheminCache(instId));
  } catch {}
}

/* L'appel que fait le chercheur : rend la distribution nulle de cet
   instrument, du cache si elle est fraîche, calculée sinon. */
function nulPourInstrument(instId, c5, juger, options) {
  const o = options || {};
  const ageMax = o.ageMaxMs || 20 * 3600e3;
  const cache = lireCache(instId, ageMax);
  if (cache && cache.tirages >= (o.tirages || 12)) return { ...cache, duCache: true };
  const d = distributionNulle(c5, juger, o);
  ecrireCache(instId, d);
  return { ...d, duCache: false };
}

/* Le verdict, en une phrase lisible dans un journal. */
function verdictTexte(v) {
  if (!v || v.percentile == null) return "nul indisponible";
  return `nul ${(100 * v.taux).toFixed(0)} % de repliques avec perle, ` +
         `score reel au ${(100 * v.percentile).toFixed(0)}e percentile ` +
         `(median nul ${v.median == null ? "?" : v.median.toFixed(4)})`;
}

module.exports = { alea, melangerParBlocs, distributionNulle, percentileDe,
                   nulPourInstrument, verdictTexte, DOSSIER_NUL };
