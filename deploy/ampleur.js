#!/usr/bin/env node
/* ============================================================================
   L'EPREUVE DE LA LARGEUR — et pourquoi c'est un vrai test, pas une
   recherche de plus.

   Etat des lieux. Le classement par taux de financement a 72 heures
   rend, sur trente instruments et vingt-quatre mois, un sharpe par
   periode de 0,137. Comme un t vaut sharpe x racine(n), le prouver a
   t = 2 demande 214 periodes, soit 642 jours : le milieu de 2028. Cette
   attente est la seule chose qui separe l'hypothese pre-inscrite d'un
   verdict, et aucune quantite de calcul ne la raccourcit.

   Une chose la raccourcirait : un sharpe plus grand. La duree varie
   comme l'INVERSE DU CARRE du sharpe — le doubler divise l'attente par
   quatre.

   LA PREDICTION, ecrite avant de voir un chiffre. La loi fondamentale
   de la gestion active dit que le ratio d'information vaut a peu pres
   IC x racine(N) : la qualite du signal, multipliee par la racine du
   nombre de paris. Si l'avantage du financement est REEL, alors elargir
   l'univers de trente a cent instruments doit multiplier le sharpe par
   racine(100/30) = 1,83 environ — et le sharpe divise par racine(N)
   doit rester A PEU PRES CONSTANT quand N varie.

   POURQUOI CE N'EST PAS UNE RECHERCHE DE PLUS. Tout ce depot a passe
   une journee a se defendre d'un piege : essayer beaucoup de choses,
   garder la plus belle, et confondre la chance avec un avantage. Ce
   banc-ci ne cherche rien. Il ne fait varier ni le signal, ni
   l'horizon, ni la fraction de l'univers prise de chaque cote — un
   sixieme en haut, un sixieme en bas, toujours. Il fait varier UNE
   SEULE chose, la largeur, et il teste une prediction QUANTITATIVE
   faite d'avance.

   C'est la difference decisive. Une cellule qui brille parce qu'on en a
   regarde vingt et une n'a aucune raison de grandir en racine(N) quand
   on elargit l'univers : le bruit ne connait pas cette loi. Un effet
   transversal reel, si. La prediction est donc REFUTABLE, et c'est la
   seule chose qu'on puisse encore apprendre sans attendre 2028.

   Le nul repond a la meme question a chaque largeur : chaque instrument
   melange separement, ce qui casse le lien entre son classement et son
   rendement futur en gardant toutes les distributions marginales.

   Ne lit que data/cache-1h et data/extra. N'ecrit que data/ampleur.json.
   Ne branche rien.
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");
const T = require(path.join(__dirname, "banc_transversal.js"));
const JUGE = require(path.join(RACINE, "modules", "juge.js"));
const CACHE = path.join(RACINE, "data", "cache-1h");
const EXTRA = path.join(RACINE, "data", "extra");

const H5 = 3600e3;
const HEURES = 72;                  // l'horizon pre-inscrit, jamais varie
const FRACTION = 6;                 // un sixieme en haut, un sixieme en bas
const TIRAGES = Number(process.env.AMPLEUR_TIRAGES || 24);
const SOUS = Number(process.env.AMPLEUR_SOUS || 8);      // sous-ensembles par largeur
const MOIS_MIN = Number(process.env.AMPLEUR_MOIS_MIN || 20);

function alea(g) { let s = (g >>> 0) || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

function lireBougies(instId) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(CACHE, instId + ".json"), "utf8"));
    const b = Array.isArray(v) ? v : v.bougies;
    return Array.isArray(b) && b.length > 24 * 30 ? b : null;
  } catch { return null; }
}
function lireFin(instId) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(EXTRA, instId + ".json"), "utf8"));
    return j && Array.isArray(j.financement) && j.financement.length ? j.financement : null;
  } catch { return null; }
}

/* Le melange par blocs, en pas HORAIRE. Une journee vaut 24 points et
   non 288 : passer la mauvaise taille de bloc melangerait par paquets
   de douze jours et laisserait au nul une memoire qu'il ne doit pas
   avoir. */
function repliquer(brutes, t0, n, graine) {
  return brutes.map((d, i) => {
    const px = JUGE.melangerParBlocs(d.px, graine * 1000 + i, 24);
    const closes = T.grilleHoraire(px, t0, n, 4);
    return { instId: d.instId, closes, car: T.caracteristiques(closes), fin: d.fin };
  });
}

function main() {
  console.log(`[AMPLEUR] prediction ecrite AVANT de voir un chiffre : si l'avantage est reel, sharpe ∝ racine(N).`);
  console.log(`[AMPLEUR] signal, horizon et fraction de l'univers sont FIXES : financement, ${HEURES} h, un ${FRACTION}e de chaque cote.`);
  console.log(`[AMPLEUR] seule la largeur varie. C'est une prediction quantitative refutable, pas une recherche.`);

  const W = require(path.join(__dirname, "histoire_1h.js"));
  const brutes = [];
  for (const instId of W.UNIVERS) {
    const px = lireBougies(instId);
    const fin = lireFin(instId);
    if (px && fin) brutes.push({ instId, px, finBrut: fin });
  }
  console.log(`[AMPLEUR] ${brutes.length} instruments ont a la fois des bougies horaires et un financement.`);
  if (brutes.length < 20) { console.error("[AMPLEUR] pas assez d'instruments : lancer histoire_1h.js et histoire_extra.js d'abord."); process.exit(1); }

  /* La fenetre commune. On vise la profondeur demandee et l'on ECARTE
     les instruments qui ne l'ont pas : un classement sur soixante
     instruments profonds vaut mieux qu'un classement sur cent courts,
     la statistique venant du nombre de periodes. */
  const t1 = Math.min(...brutes.map((d) => d.px[d.px.length - 1][0]));
  const vise = t1 - MOIS_MIN * 30.44 * 86400e3;
  const assez = brutes.filter((d) => d.px[0][0] <= vise);
  const retenus = assez.length >= 20 ? assez : brutes;
  if (assez.length < brutes.length) console.log(`[AMPLEUR] ${brutes.length - assez.length} instrument(s) ecarte(s) : moins de ${MOIS_MIN} mois d'histoire.`);
  const t0 = Math.max(...retenus.map((d) => d.px[0][0]));
  const n = Math.floor((t1 - t0) / H5) + 1;
  console.log(`[AMPLEUR] fenetre commune : ${new Date(t0).toISOString().slice(0, 10)} → ${new Date(t1).toISOString().slice(0, 10)} (${n} heures, ${retenus.length} instruments)`);

  const prepares = retenus.map((d) => {
    const closes = T.grilleHoraire(d.px, t0, n, 4);
    return { instId: d.instId, closes, car: T.caracteristiques(closes),
             fin: T.grilleHoraire(d.finBrut, t0, n, 1), px: d.px };
  });

  const LARGEURS = [12, 20, 30, 45, 60, 80, prepares.length].filter((N, i, a) => N <= prepares.length && a.indexOf(N) === i);
  console.log(`[AMPLEUR] largeurs essayees : ${LARGEURS.join(", ")}`);

  const lignes = [];
  for (const N of LARGEURS) {
    const k = Math.max(2, Math.round(N / FRACTION));
    /* Plusieurs sous-ensembles TIRES AU SORT plutot qu'un seul, et
       jamais choisis sur leur resultat : un tirage unique ferait
       dependre la courbe de la chance du tirage, et choisir le meilleur
       serait precisement la faute que ce banc existe pour eviter. */
    const sh = [], ts = [], nets = [];
    const shNul = [];
    for (let s = 0; s < (N >= prepares.length ? 1 : SOUS); s++) {
      const rnd = alea(1000 + N * 31 + s);
      const idx = prepares.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      const sous = idx.slice(0, N).map((i) => prepares[i]);
      const st = T.stats(T.evaluer(sous, "financement", HEURES, k));
      if (st.n < 10) continue;
      sh.push(st.sharpe); ts.push(st.t); nets.push(st.net);

      // Le nul de CE sous-ensemble, a la meme largeur.
      for (let g = 0; g < Math.max(2, Math.round(TIRAGES / SOUS)); g++) {
        const rep = repliquer(sous.map((d) => ({ instId: d.instId, px: d.px, fin: d.fin })), t0, n, g + 1 + s * 97);
        const sn = T.stats(T.evaluer(rep, "financement", HEURES, k));
        if (sn.n >= 10) shNul.push(sn.sharpe);
      }
    }
    if (!sh.length) { console.log(`  N=${N} : pas assez de periodes, ignore.`); continue; }
    const moy = (a) => a.reduce((u, v) => u + v, 0) / a.length;
    const ec = (a, m) => a.length < 2 ? 0 : Math.sqrt(a.reduce((u, v) => u + (v - m) ** 2, 0) / (a.length - 1));
    const mS = moy(sh), mT = moy(ts), mN = moy(nets);
    const mNul = shNul.length ? moy(shNul) : 0;
    lignes.push({ N, k, sharpe: mS, sharpeSd: ec(sh, mS), t: mT, net: mN,
                  sharpeNul: mNul, sharpeNulSd: shNul.length ? ec(shNul, mNul) : 0,
                  normalise: mS / Math.sqrt(N), normaliseNul: mNul / Math.sqrt(N),
                  sousEnsembles: sh.length, tiragesNul: shNul.length });
  }

  console.log(`[AMPLEUR] resultats — toutes les largeurs, y compris les mauvaises :`);
  console.log(`  ${"N".padStart(4)} ${"k".padStart(3)} ${"sharpe".padStart(8)} ${"± sd".padStart(7)} ${"t".padStart(6)} ${"net".padStart(8)} ${"sharpe/√N".padStart(10)} ${"nul".padStart(8)} ${"nul/√N".padStart(8)}`);
  for (const l of lignes) {
    console.log(`  ${String(l.N).padStart(4)} ${String(l.k).padStart(3)} ${l.sharpe.toFixed(4).padStart(8)} ${l.sharpeSd.toFixed(4).padStart(7)} ` +
      `${l.t.toFixed(2).padStart(6)} ${l.net.toFixed(2).padStart(8)} ${l.normalise.toFixed(5).padStart(10)} ` +
      `${l.sharpeNul.toFixed(4).padStart(8)} ${l.normaliseNul.toFixed(5).padStart(8)}`);
  }

  /* LE VERDICT. Deux choses doivent tenir ensemble, et l'une sans
     l'autre ne vaut rien :

     que le sharpe GRANDISSE avec la largeur, ce qui se lit sur la pente
     de sharpe contre racine(N) ;

     et que le sharpe divise par racine(N) reste STABLE, ce qui est la
     forme precise de la prediction. Un sharpe qui grandit plus vite que
     racine(N) serait aussi suspect qu'un sharpe qui ne grandit pas :
     la loi ne dit pas « plus c'est large, mieux c'est », elle dit
     combien. */
  let verdict = null;
  if (lignes.length >= 3) {
    const x = lignes.map((l) => Math.sqrt(l.N)), y = lignes.map((l) => l.sharpe);
    const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    const pente = sxx > 0 ? sxy / sxx : 0;
    const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;

    const norm = lignes.map((l) => l.normalise);
    const mn = norm.reduce((a, b) => a + b, 0) / norm.length;
    const sdn = Math.sqrt(norm.reduce((u, v) => u + (v - mn) ** 2, 0) / Math.max(1, norm.length - 1));
    const stabilite = mn !== 0 ? sdn / Math.abs(mn) : Infinity;      // coefficient de variation

    const grand = lignes[lignes.length - 1], petit = lignes[0];
    const gain = petit.sharpe !== 0 ? grand.sharpe / petit.sharpe : 0;
    const attendu = Math.sqrt(grand.N / petit.N);

    console.log(`[AMPLEUR] la prediction, confrontee :`);
    console.log(`  sharpe contre racine(N) : pente ${pente.toFixed(5)}, R² ${r2.toFixed(3)}`);
    console.log(`  de N=${petit.N} a N=${grand.N} : sharpe x${gain.toFixed(2)} · la loi en attendait x${attendu.toFixed(2)}`);
    console.log(`  sharpe/racine(N) : moyenne ${mn.toFixed(5)}, variation relative ${(100 * stabilite).toFixed(0)} %`);
    console.log(`  le nul, lui, reste plat : ${lignes.map((l) => l.normaliseNul.toFixed(4)).join(" ")}`);

    const monte = pente > 0 && r2 >= 0.5;
    const stable = stabilite <= 0.35;
    const battuNul = grand.sharpe > 0 && grand.sharpe > grand.sharpeNul + 2 * (grand.sharpeNulSd || 1e-9);
    const tenue = monte && stable && battuNul;
    console.log(`  ${tenue ? "LA PREDICTION TIENT : l'avantage grandit comme la largeur le veut, et le hasard ne le suit pas."
                          : "LA PREDICTION NE TIENT PAS. Le bruit ne connait pas la loi en racine(N) ; un avantage reel devrait la suivre."}`);
    if (!monte) console.log(`    (le sharpe ne monte pas avec la largeur)`);
    if (!stable) console.log(`    (il monte, mais pas au rythme predit : variation relative ${(100 * stabilite).toFixed(0)} % pour un seuil de 35 %)`);
    if (!battuNul) console.log(`    (a la plus grande largeur, le reel ne se detache pas de son nul)`);

    /* Ce que la largeur changerait a l'attente, si elle tient. */
    const requis = (s) => Math.ceil((2 / Math.abs(s || 1e-9)) ** 2);
    console.log(`[AMPLEUR] ce que cela change a l'attente :`);
    console.log(`  a N=${petit.N} (sharpe ${petit.sharpe.toFixed(3)}) : ${requis(petit.sharpe)} periodes, ${Math.round(requis(petit.sharpe) * HEURES / 24)} jours`);
    console.log(`  a N=${grand.N} (sharpe ${grand.sharpe.toFixed(3)}) : ${requis(grand.sharpe)} periodes, ${Math.round(requis(grand.sharpe) * HEURES / 24)} jours`);

    verdict = { pente: +pente.toFixed(5), r2: +r2.toFixed(3), gain: +gain.toFixed(2), attendu: +attendu.toFixed(2),
                normaliseMoyen: +mn.toFixed(5), stabilite: +stabilite.toFixed(3),
                monte, stable, battuNul, tenue,
                periodesRequises: { petit: requis(petit.sharpe), grand: requis(grand.sharpe) } };
  }

  try {
    const chemin = path.join(RACINE, "data", "ampleur.json");
    fs.mkdirSync(path.dirname(chemin), { recursive: true });
    fs.writeFileSync(chemin + ".tmp", JSON.stringify({
      genere: new Date().toISOString(),
      prediction: `sharpe proportionnel a racine(N) — signal financement, horizon ${HEURES} h, un ${FRACTION}e de l'univers de chaque cote`,
      periode: { du: new Date(t0).toISOString().slice(0, 10), au: new Date(t1).toISOString().slice(0, 10), heures: n },
      instruments: prepares.length,
      largeurs: lignes.map((l) => ({ N: l.N, k: l.k, sharpe: +l.sharpe.toFixed(5), sharpeSd: +l.sharpeSd.toFixed(5),
                                     t: +l.t.toFixed(2), net: +l.net.toFixed(3),
                                     normalise: +l.normalise.toFixed(6),
                                     sharpeNul: +l.sharpeNul.toFixed(5), normaliseNul: +l.normaliseNul.toFixed(6),
                                     sousEnsembles: l.sousEnsembles, tiragesNul: l.tiragesNul })),
      verdict,
    }, null, 1));
    fs.renameSync(chemin + ".tmp", chemin);
    console.log(`[AMPLEUR] verdict ecrit : ${chemin}`);
  } catch (e) { console.log(`[AMPLEUR] verdict non ecrit : ${e.message}`); }

  console.log(`[AMPLEUR] ce script ne branche rien.`);
}

if (require.main === module) main();
module.exports = { HEURES, FRACTION, repliquer };
