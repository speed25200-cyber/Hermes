#!/usr/bin/env node
/* ============================================================================
   L'ÉPREUVE DU SUIVI HORS ÉCHANTILLON.

   Un suivi hors échantillon n'a qu'une valeur : celle de la promesse
   qu'il ne bougera pas. Si le jour où le chiffre déplaît quelqu'un peut
   changer 72 h en 96 h, la pré-inscription n'aura servi qu'à donner un
   air rigoureux à la même pêche aux résultats. Cette épreuve garde donc
   surtout des PROMESSES, pas des calculs :

   1. L'hypothèse est-elle gelée, et le code interdit-il de la régler
      depuis l'extérieur ?
   2. Le texte du document et les constantes du code disent-ils encore
      la même chose ? Les deux dérivent séparément, et le jour où ils
      divergent, c'est le document qu'on croira.
   3. La coupure au 2 septembre est-elle propre — rien avant ne fuit
      après, et la période qui enjambe la date n'est comptée nulle part ?
   4. Le calcul de puissance est-il juste ? C'est lui qui empêche de
      lire un verdict trop tôt ; s'il ment, il ment dans le sens
      rassurant.
   5. La chaîne complète attrape-t-elle un effet qu'on y met exprès ?
      Un suivi qui ne verrait rien même quand il y a tout à voir serait
      une machine à confirmer l'absence d'avantage.
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const RACINE = path.join(__dirname, "..");
const H = require(path.join(RACINE, "deploy", "hors_echantillon.js"));
const T = require(path.join(RACINE, "deploy", "banc_transversal.js"));

let echecs = 0;
function verifier(nom, condition, detail) {
  if (condition) { console.log(`  ok   ${nom}`); return; }
  echecs++;
  console.log(`  ECHEC ${nom}${detail ? " — " + detail : ""}`);
}

/* --- 1. L'hypothèse est-elle gelée ? ------------------------------------- */
console.log("1. L'hypothese est-elle hors d'atteinte ?");

verifier("l'objet est gele", Object.isFrozen(H.PRE));
let mute = false;
try { H.PRE.heures = 96; } catch { mute = true; }
verifier("ecrire dedans ne prend pas", H.PRE.heures === 72, "heures = " + H.PRE.heures);

const source = fs.readFileSync(path.join(RACINE, "deploy", "hors_echantillon.js"), "utf8");
const envs = [...source.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
verifier("une seule variable d'environnement, et elle ne touche pas l'hypothese",
  envs.length === 1 && envs[0] === "HORS_TIRAGES", envs.join(", ") || "aucune");

/* Le piège le plus probable n'est pas qu'on ajoute une variable : c'est
   qu'on réutilise celles du banc transversal, qui elles sont réglables.
   Le suivi doit lire SES constantes, pas TRANSVERSAL_HEURES. */
verifier("aucune variable du banc transversal n'est relue",
  !/TRANSVERSAL_|BANC_UNIVERS/.test(source));

/* --- 2. Le code et le document disent-ils la même chose ? ---------------- */
console.log("2. Le code et le document disent-ils la meme chose ?");
const doc = fs.readFileSync(path.join(RACINE, "docs", "avantage.md"), "utf8");
const bloc = doc.slice(Math.max(0, doc.indexOf("Sur un univers de trente")), doc.indexOf("Sur un univers de trente") + 400);
verifier("le document existe et porte l'enonce", bloc.includes("taux de financement"));
verifier("l'horizon du document est celui du code",
  new RegExp(`toutes les ${H.PRE.heures} heures`).test(bloc), bloc.slice(0, 0) || "72 attendu");
verifier("le nombre de positions du document est celui du code",
  H.PRE.k === 5 && /cinq plus bas/.test(bloc) && /cinq plus hauts/.test(bloc));
verifier("la taille d'univers du document est celle du code",
  H.PRE.univers.length === 30 && /trente perp/.test(bloc), String(H.PRE.univers.length));
verifier("l'univers n'a pas de doublon",
  new Set(H.PRE.univers).size === H.PRE.univers.length);
verifier("l'univers du suivi est celui du banc qui a produit l'hypothese",
  H.PRE.univers.join(",") === T.UNIVERS.join(","));

/* --- 3. La coupure ------------------------------------------------------- */
console.log("3. La coupure au 2 septembre est-elle propre ?");
const H5 = 3600e3;
const t0 = H.T_PRE - 100 * 72 * H5;             // cent periodes avant la date
const per = [];
for (let m = 0; m < 200; m++) per.push({ i: m * 72, brut: 1, net: 1, jambes: 0 });
const { avant, apres } = H.couper(per, t0);
verifier("cent periodes tombent avant", avant.length === 100, String(avant.length));
verifier("cent periodes tombent apres", apres.length === 100, String(apres.length));
verifier("aucune periode n'est comptee deux fois",
  new Set([...avant, ...apres].map((p) => p.i)).size === avant.length + apres.length);
verifier("tout l'apprentissage se termine avant la date",
  avant.every((p) => t0 + p.i * H5 + 72 * H5 <= H.T_PRE));
verifier("toute l'epreuve commence a la date ou apres",
  apres.every((p) => t0 + p.i * H5 >= H.T_PRE));

// Une grille décalée : une période enjambe la date et ne doit compter nulle part.
const decale = H.couper(per, t0 + 36 * H5);
verifier("la periode a cheval sur la date est ecartee",
  decale.avant.length + decale.apres.length === per.length - 1,
  `${decale.avant.length} + ${decale.apres.length} sur ${per.length}`);

/* --- 4. La puissance ----------------------------------------------------- */
console.log("4. Le calcul de puissance dit-il la verite ?");
const p137 = H.puissance(0.137, 0);
verifier("sharpe 0,137 demande bien (2/0,137)^2 periodes",
  p137.requis === Math.ceil((2 / 0.137) ** 2), String(p137.requis));
verifier("cela fait plus de six cents jours", p137.jours > 600, p137.jours + " j");
const p274 = H.puissance(0.274, 0);
verifier("un effet deux fois plus grand demande quatre fois moins de donnees",
  Math.abs(p274.requis * 4 - p137.requis) <= 4, `${p274.requis} contre ${p137.requis}`);
verifier("les periodes deja acquises se retranchent",
  H.puissance(0.137, 50).manque === p137.requis - 50);
verifier("jamais de manque negatif", H.puissance(0.137, 10000).manque === 0);
verifier("un sharpe nul repond « jamais » au lieu de fabriquer une date",
  H.puissance(0, 0).requis === Infinity && H.puissance(0, 0).quand === null);
verifier("un sharpe minuscule ne fabrique pas de date non plus",
  H.puissance(1e-4, 0).quand === null, String(H.puissance(1e-4, 0).quand));
verifier("un sharpe credible rend bien une date",
  /^\d{4}-\d{2}-\d{2}$/.test(String(p137.quand)), String(p137.quand));
verifier("un sharpe negatif demande autant qu'un positif",
  H.puissance(-0.137, 0).requis === p137.requis);
verifier("plus rien a attendre quand le compte y est",
  H.puissance(0.137, p137.requis).manque === 0);

/* --- 5. La chaine complete voit-elle un effet qu'on y met ? -------------- */
console.log("5. La chaine attrape-t-elle un effet plante expres ?");

/* Trente instruments, et un financement qui prédit vraiment le
   rendement des 72 heures suivantes. Si le suivi ne ressort pas un t
   largement positif là-dessus, ce n'est pas le marché qui est muet,
   c'est le câblage qui est coupé.

   Le financement doit être un processus INDÉPENDANT par instrument, et
   la première version de ce banc s'est fait prendre à ne pas l'être :
   une sinusoïde décalée d'une constante par instrument garde le même
   classement transversal à un déphasage près, si bien que le témoin —
   qui redistribue les financements — retrouvait l'avantage intact et
   ne témoignait de rien. Un contrôle qui contient encore le signal ne
   contrôle rien. D'où une marche aléatoire lente, propre à chaque
   instrument, que la permutation casse pour de bon. */
function alea(g) { let s = g >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
const rnd = alea(7);
function gauss() { return Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd()); }

const NH = 30 * 24 * 20;                        // vingt mois d'heures
const base = H.T_PRE - Math.floor(NH * 0.5) * H5;
const BETA = 12;                                // le rendement des 72 h vaut -BETA x financement
const donnees = [];
for (let k = 0; k < 30; k++) {
  const closes = new Float64Array(NH);
  const fin = new Float64Array(NH);
  let px = 100, f = 0;
  for (let i = 0; i < NH; i++) {
    f = 0.99 * f + 0.0004 * gauss();            // lente, stationnaire, independante
    fin[i] = f;
    px *= Math.exp(-BETA * f / H.PRE.heures + 0.004 * gauss());
    closes[i] = px;
  }
  donnees.push({ instId: `T${k}-USDT-SWAP`, closes, car: T.caracteristiques(closes), fin });
}
const toutes = T.evaluer(donnees, H.PRE.signal, H.PRE.heures, H.PRE.k);
const coupe = H.couper(toutes, base);
const sA = T.stats(coupe.avant), sB = T.stats(coupe.apres);
verifier("l'histoire fabriquee se coupe des deux cotes",
  sA.n > 40 && sB.n > 40, `${sA.n} / ${sB.n}`);
verifier("l'effet plante ressort en apprentissage", sA.t > 3, "t = " + sA.t.toFixed(2));
verifier("et il ressort AUSSI hors echantillon", sB.t > 3, "t = " + sB.t.toFixed(2));
verifier("le net reste positif apres frais", sB.net > 0, sB.net.toFixed(2));

/* Le témoin, sans lequel le test précédent ne prouve rien : on donne à
   chaque instrument le financement d'un autre. Les séries gardent
   toutes leurs propriétés — même loi, même lenteur, même échelle — et
   perdent la seule chose qu'on prétend mesurer : le lien avec LEUR
   rendement. Le t doit retomber dans le bruit. */
const brouille = donnees.map((d, k) => ({ ...d, fin: donnees[(k + 7) % donnees.length].fin }));
const sT = T.stats(H.couper(T.evaluer(brouille, H.PRE.signal, H.PRE.heures, H.PRE.k), base).apres);
verifier("temoin : financements redistribues, l'avantage disparait",
  Math.abs(sT.t) < 2, "t = " + sT.t.toFixed(2));
verifier("le temoin est bien plus faible que le vrai",
  Math.abs(sT.t) < sB.t / 2, `${sT.t.toFixed(2)} contre ${sB.t.toFixed(2)}`);

/* --- 6. La chaine de donnees peut-elle S'ETENDRE ? ---------------------- */
console.log("6. Le financement peut-il gagner des mois nouveaux ?");

/* Le suivi hors echantillon ne vit que de mois qui n'existaient pas
   encore. Si le telechargement ne sait pas prolonger une serie deja
   presente, le releve affichera zero periode jusqu'a la fin des temps
   en ayant parfaitement l'air de fonctionner — c'est le pire mode de
   panne possible, et c'etait l'etat du code. */
const X = require(path.join(RACINE, "deploy", "histoire_extra.js"));
const MS = 86400e3;
const pts = (deb, fin) => {           // un point par jour entre deux mois inclus
  const out = []; let d = Date.UTC(+deb.slice(0, 4), +deb.slice(5, 7) - 1, 1);
  const stop = Date.UTC(+fin.slice(0, 4), +fin.slice(5, 7), 1);
  for (; d < stop; d += MS) out.push([d, 0.0001]);
  return out;
};

const acquis = pts("2024-09", "2026-08");
verifier("les mois presents sont reconnus",
  X.manquants(["2025-01", "2026-08"], acquis, []).length === 0);

// LA REGRESSION : la serie s'arrete en aout, septembre est demande.
verifier("un mois NOUVEAU est reclame meme si la serie commence assez tot",
  X.manquants(["2024-09", "2026-08", "2026-09"], acquis, []).join(",") === "2026-09",
  X.manquants(["2024-09", "2026-08", "2026-09"], acquis, []).join(","));

verifier("un mois connu absent n'est pas redemande",
  X.manquants(["2026-09"], acquis, ["2026-09"]).length === 0);

verifier("la fusion n'oublie rien et ne double rien",
  X.fusionner(acquis, pts("2026-09", "2026-09")).length === acquis.length + 30,
  String(X.fusionner(acquis, pts("2026-09", "2026-09")).length - acquis.length));
verifier("la fusion ne raccourcit jamais l'existant",
  X.fusionner(acquis, []).length === acquis.length);
verifier("la fusion reste triee",
  X.fusionner(pts("2026-09", "2026-09"), acquis).every((r, i, a) => !i || a[i - 1][0] < r[0]));
verifier("un point deja present ne se duplique pas",
  X.fusionner(acquis, acquis).length === acquis.length);

/* Le delai avant de declarer un mois absent pour de bon. Sans lui, le
   mois qui vient de finir serait marque absent le 1er — avant meme que
   Binance l'ait publie — et plus jamais retente. */
const moisDe = (t) => new Date(t).toISOString().slice(0, 7);
verifier("le mois qui vient de finir n'est pas declare absent",
  !X.absentPourDeBon(moisDe(Date.now() - 20 * MS)), moisDe(Date.now() - 20 * MS));
verifier("un vieux mois l'est",
  X.absentPourDeBon(moisDe(Date.now() - 200 * MS)), moisDe(Date.now() - 200 * MS));

/* La meme garantie sur les BOUGIES. Le fichier par instrument etait
   reconstruit a partir des seuls mois demandes : une passe a douze mois
   sur un cache de vingt-quatre le coupait en deux sans un mot, et avec
   lui la fenetre d'apprentissage de l'hypothese. On verifie ici que la
   fusion est bien celle du code, pas celle du commentaire. */
const srcL = fs.readFileSync(path.join(RACINE, "deploy", "histoire_longue.js"), "utf8");
verifier("les bougies deja en cache sont relues avant d'ecrire",
  /let ancien = \[\];[\s\S]{0,400}\[\.\.\.ancien, \.\.\.bougies\]/.test(srcL));
verifier("plus aucun tri qui ignore l'existant",
  !/for \(const k of bougies\.sort/.test(srcL));

console.log(echecs === 0 ? "\nEPREUVE DU SUIVI HORS ECHANTILLON : verte." : `\nEPREUVE DU SUIVI HORS ECHANTILLON : ${echecs} echec(s).`);
process.exit(echecs === 0 ? 0 : 1);
