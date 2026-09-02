/* ============================================================================
   L'ÉTAT DU MARCHÉ — la couche qui manquait.

   Le constat qui a motivé ce fichier : les perles retenues par le
   chercheur sont presque toutes des stratégies de RETOUR À LA MOYENNE
   (vwap_reclaim, meche15m, meche_regime, keltner3, donchian_fade,
   bb_range, double_extreme). Elles gagnent tant que le marché oscille
   autour d'une valeur, et elles perdent EN SÉRIE dès qu'il part en
   tendance ou qu'il se retourne violemment. Aucun prédicteur qui
   regarde la même bougie de 5 minutes ne corrige cela : le problème
   n'est pas le signal, c'est le contexte dans lequel on le joue.

   Ce module dit dans quel contexte on est. Quatre états :

     fourchette           le marché oscille — le terrain des perles
     tendance_haussiere   il monte avec persistance
     tendance_baissiere   il descend avec persistance
     choc                 la volatilité explose — plus rien ne tient

   TROIS DÉCISIONS DE CONCEPTION, et leurs raisons :

   1. RÈGLES, PAS MODÈLE APPRIS. Un régime est une quantité lente et de
      faible dimension. Une règle calibrée est causale, lisible, et
      surtout IDENTIQUE partout : le carnet Colab, le banc d'essai, le
      chercheur et le moteur vivant calculent le même nombre. Un modèle
      exporté aurait ajouté une dépendance (onnxruntime), un fichier à
      poser sur le serveur, et un risque d'écart entre l'entraînement et
      l'exécution. Le moteur ne doit jamais pouvoir s'arrêter faute d'un
      fichier de modèle. Les seuils, eux, se calibrent hors ligne et
      arrivent par config/regime.json ; absent, les défauts jouent.

   2. BTC ET ETH SEULS. La largeur du marché (part des instruments
      au-dessus de leur moyenne) serait un bon indice, mais le moteur
      vivant ne tire les bougies que des perles du roster — dix à douze
      instruments qui changent toutes les demi-heures — tandis que le
      banc en a cinquante. La même formule rendrait deux nombres
      différents, et l'on sélectionnerait sur un état pour en trader un
      autre. C'est exactement le défaut que modules/signaux.js a été
      écrit pour rendre impossible. Deux instruments toujours présents,
      toujours les mêmes : la parité est garantie par construction.

   3. TOUT EST CAUSAL. Chaque nombre à l'instant i n'utilise que les
      bougies closes jusqu'à i. Un état calculé sur l'histoire complète
      puis appliqué au passé serait de la triche rétrospective, et le
      banc d'essai mesurerait une stratégie que le moteur ne peut pas
      jouer.

   Une bougie est [ts, open, high, low, close, volume], la série est
   ascendante et ne contient QUE des bougies closes.
   ============================================================================ */
"use strict";

const ETATS = ["fourchette", "tendance_haussiere", "tendance_baissiere", "choc"];

/* Les fenêtres, en bougies de 5 minutes. 288 = 24 h, 12 = 1 h.
   Le moteur voit 299 bougies closes (limite REST 300 moins la bougie en
   cours) : tout ce qui suit doit tenir dans cette fenêtre, sinon l'état
   serait calculable au banc et pas en vivant. 288 + une marge : cela
   tient, tout juste, et c'est voulu. */
const N_JOUR = 288;
const N_HEURE = 12;

/* Les seuils. Ce sont les SEULS nombres réglables, et ils sont réglés
   hors ligne (carnet Colab) puis posés dans config/regime.json. Les
   défauts ci-dessous sont ceux d'un marché crypto ordinaire :

   choc      : la volatilité de la dernière heure vaut plus de 2,2 fois
               celle du jour. Une heure ordinaire est autour de 1.
   tendance  : le déplacement de 24 h vaut plus de 1,3 fois ce qu'une
               marche aléatoire de même volatilité produirait. Sous ce
               seuil, « ça monte » est une illusion d'optique.
   Ces deux nombres seront calibrés ; ils ne sont pas sacrés. */
const SEUILS_DEFAUT = {
  choc: 2.2,        // vol 1 h / vol 24 h au-delà duquel plus rien ne tient
  tendance: 1.3,    // |déplacement 24 h| / déplacement attendu d'une marche aléatoire
  version: "regles-v1",
};

/* L'écart-type des log-rendements 5 m sur les n dernières bougies.
   Retour null si l'histoire est trop courte : un état ne s'invente pas. */
function volatilite(closes, n) {
  if (closes.length < n + 1) return null;
  let somme = 0, somme2 = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    somme += r; somme2 += r * r;
  }
  const m = somme / n;
  return Math.sqrt(Math.max(0, somme2 / n - m * m));
}

/* Les caractéristiques d'UNE série, à sa dernière bougie close.

   force : le cœur du module. Une marche aléatoire de volatilité v sur n
   pas se déplace typiquement de v×√n. Si le déplacement réel des 24 h
   vaut deux fois cela, le mouvement n'est pas du bruit : c'est une
   tendance, et une stratégie de retour à la moyenne va se faire
   écraser. Normaliser par la volatilité est ce qui rend le nombre
   comparable entre BTC calme et un altcoin nerveux. */
function caracteristiques(c5) {
  if (!Array.isArray(c5) || c5.length < N_JOUR + 2) return null;
  const closes = c5.map((k) => k[4]);
  const vol24 = volatilite(closes, N_JOUR);
  const vol1h = volatilite(closes, N_HEURE);
  if (!vol24 || vol24 <= 0 || vol1h == null) return null;

  const r24 = Math.log(closes[closes.length - 1] / closes[closes.length - 1 - N_JOUR]);
  const attendu = vol24 * Math.sqrt(N_JOUR);         // déplacement d'une marche aléatoire de même volatilité
  return {
    ts: c5[c5.length - 1][0],
    r24,
    vol24,
    vol1h,
    ratioVol: vol1h / vol24,                          // > 1 : l'heure est plus agitée que le jour
    force: Math.abs(r24) / (attendu || 1e-12),        // > 1 : le déplacement dépasse le hasard
    sens: Math.sign(r24),
  };
}

/* La classification, à partir des caractéristiques de BTC et (si elle
   existe) d'ETH. L'ordre des tests EST la règle :

   le choc d'abord, parce qu'une volatilité qui explose invalide tout le
   reste — y compris une belle tendance ; la tendance ensuite ; la
   fourchette est ce qui reste, et c'est le cas ordinaire.

   ETH ne vote pas à égalité avec BTC : il CONFIRME. Le choc se déclare
   si l'un des deux explose (la contagion est réelle et rapide), la
   tendance se mesure sur la moyenne des deux forces mais garde le sens
   de BTC — deux marchés qui partent en sens contraire ne sont pas une
   tendance de marché, c'est une rotation, et la moyenne des forces la
   dégrade correctement vers la fourchette. */
function classer(btc, eth, seuils) {
  const s = { ...SEUILS_DEFAUT, ...(seuils || {}) };
  if (!btc) return { etat: "inconnu", force: null, ratioVol: null, seuils: s };

  const ratioVol = eth ? Math.max(btc.ratioVol, eth.ratioVol) : btc.ratioVol;
  if (ratioVol >= s.choc) {
    return { etat: "choc", force: btc.force, ratioVol, sens: btc.sens, seuils: s };
  }
  // La force des deux marchés, signée par le sens de chacun : deux sens
  // opposés s'annulent, deux sens d'accord s'additionnent.
  const forceSignee = eth
    ? (btc.sens * btc.force + eth.sens * eth.force) / 2
    : btc.sens * btc.force;
  const force = Math.abs(forceSignee);
  if (force >= s.tendance) {
    return { etat: forceSignee > 0 ? "tendance_haussiere" : "tendance_baissiere",
             force, ratioVol, sens: Math.sign(forceSignee), seuils: s };
  }
  return { etat: "fourchette", force, ratioVol, sens: Math.sign(forceSignee), seuils: s };
}

/* L'état à la dernière bougie close de deux séries. C'est ce qu'appelle
   le moteur vivant, toutes les cinq minutes. */
function etatMaintenant(c5btc, c5eth, seuils) {
  const btc = caracteristiques(c5btc);
  const eth = c5eth ? caracteristiques(c5eth) : null;
  const r = classer(btc, eth, seuils);
  return { ...r, ts: btc ? btc.ts : null };
}

/* LA SÉRIE des états, bougie par bougie, alignée sur c5btc. C'est ce
   qu'appellent le banc d'essai et le chercheur : pour juger une perle
   « par état », il faut savoir dans quel état chaque trade a été OUVERT.

   ETH est aligné par horodatage, pas par indice : les deux séries
   peuvent avoir des trous différents, et un décalage d'un cran ferait
   juger l'état d'hier sur le trade d'aujourd'hui.

   Le calcul est incrémental — recalculer deux écarts-types sur 288
   points à chaque bougie ferait 8 700 × 600 opérations par instrument,
   et la passe du chercheur doit tenir sous la minute. */
function serieEtats(c5btc, c5eth, seuils) {
  const n = c5btc.length;
  const out = new Array(n).fill(null);
  if (n < N_JOUR + 2) return out;

  const carBtc = serieCaracteristiques(c5btc);
  const carEthParTs = new Map();
  if (c5eth && c5eth.length >= N_JOUR + 2) {
    const carEth = serieCaracteristiques(c5eth);
    for (let i = 0; i < c5eth.length; i++) if (carEth[i]) carEthParTs.set(c5eth[i][0], carEth[i]);
  }
  for (let i = 0; i < n; i++) {
    if (!carBtc[i]) continue;
    out[i] = classer(carBtc[i], carEthParTs.get(c5btc[i][0]) || null, seuils);
  }
  return out;
}

/* Les caractéristiques à CHAQUE bougie, en une passe. Les sommes
   glissantes rendent le coût linéaire ; la version naïve était le seul
   endroit où ce module pouvait ralentir la passe du chercheur. */
function serieCaracteristiques(c5) {
  const n = c5.length;
  const out = new Array(n).fill(null);
  if (n < N_JOUR + 2) return out;
  const closes = c5.map((k) => k[4]);
  const r = new Array(n).fill(0);
  for (let i = 1; i < n; i++) r[i] = Math.log(closes[i] / closes[i - 1]);

  let s24 = 0, q24 = 0, s1h = 0, q1h = 0;
  for (let i = 1; i < n; i++) {
    s24 += r[i]; q24 += r[i] * r[i];
    s1h += r[i]; q1h += r[i] * r[i];
    if (i > N_JOUR) { const v = r[i - N_JOUR]; s24 -= v; q24 -= v * v; }
    if (i > N_HEURE) { const v = r[i - N_HEURE]; s1h -= v; q1h -= v * v; }
    if (i < N_JOUR + 1) continue;

    const m24 = s24 / N_JOUR;
    const vol24 = Math.sqrt(Math.max(0, q24 / N_JOUR - m24 * m24));
    const m1h = s1h / N_HEURE;
    const vol1h = Math.sqrt(Math.max(0, q1h / N_HEURE - m1h * m1h));
    if (!(vol24 > 0)) continue;

    const r24 = Math.log(closes[i] / closes[i - N_JOUR]);
    const attendu = vol24 * Math.sqrt(N_JOUR);
    out[i] = { ts: c5[i][0], r24, vol24, vol1h,
               ratioVol: vol1h / vol24, force: Math.abs(r24) / (attendu || 1e-12), sens: Math.sign(r24) };
  }
  return out;
}

/* L'INDEX des états, et la recherche par horodatage. Sans lui, chaque
   consommateur réinventerait la même boucle, et le premier essai a
   montré pourquoi c'est dangereux : chercher l'état à l'horodatage
   EXACT d'une entrée rend « inconnu » dès qu'une bougie manque dans la
   série de référence — un trou d'une minute chez BTC, et le filtre
   s'éteint en silence sur tous les instruments à la fois.

   La règle juste est celle du moteur vivant : on prend le DERNIER état
   connu à cet instant. C'est causal (jamais un état futur), robuste aux
   trous, et identique à ce que le moteur a réellement en main quand il
   décide. Un état trop vieux (plus d'une heure par défaut) redevient
   « inconnu » : mieux vaut ne pas savoir que croire savoir. */
function indexEtats(c5, etats) {
  const ts = [], etat = [];
  for (let i = 0; i < c5.length; i++) {
    if (!etats[i]) continue;
    ts.push(c5[i][0]); etat.push(etats[i].etat);
  }
  return { ts, etat };
}

function etatA(index, quand, toleranceMs) {
  const tol = toleranceMs == null ? 3600e3 : toleranceMs;
  const { ts, etat } = index;
  if (!ts.length || quand < ts[0]) return "inconnu";
  let lo = 0, hi = ts.length - 1, trouve = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ts[m] <= quand) { trouve = m; lo = m + 1; } else hi = m - 1;
  }
  if (trouve < 0) return "inconnu";
  if (quand - ts[trouve] > tol) return "inconnu";
  return etat[trouve];
}

/* Les seuils du disque, s'ils existent. Le carnet Colab les calibre et
   les écrit ; leur absence n'est pas une erreur, c'est le cas normal
   tant que la calibration n'a pas tourné. */
function lireSeuils(chemin) {
  try {
    const j = JSON.parse(require("fs").readFileSync(chemin, "utf8"));
    const s = { ...SEUILS_DEFAUT };
    if (Number.isFinite(j.choc)) s.choc = j.choc;
    if (Number.isFinite(j.tendance)) s.tendance = j.tendance;
    if (typeof j.version === "string") s.version = j.version;
    return s;
  } catch { return { ...SEUILS_DEFAUT }; }
}

module.exports = { ETATS, SEUILS_DEFAUT, N_JOUR, N_HEURE,
                   volatilite, caracteristiques, serieCaracteristiques,
                   classer, etatMaintenant, serieEtats,
                   indexEtats, etatA, lireSeuils };
