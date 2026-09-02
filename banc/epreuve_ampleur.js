#!/usr/bin/env node
/* ============================================================================
   L'EPREUVE DE LA LARGEUR.

   Ce banc ne verifie pas une conclusion, il verifie un INSTRUMENT DE
   MESURE — et il le fait avant que cet instrument ne serve, parce que
   l'ordre inverse est la meilleure facon de croire un chiffre faux.

   La question est simple : si l'on FABRIQUE un monde ou l'effet
   transversal existe pour de bon, la mesure retrouve-t-elle la loi en
   racine(N) qu'on pretend tester ? Si elle ne la retrouve pas sur des
   donnees dont on connait la reponse, alors sa reponse sur le vrai
   marche ne vaut rien, quelle qu'elle soit.

   Et le pendant, sans lequel le premier ne prouve rien : sur un monde
   ou l'on a casse le lien, la loi ne doit PAS apparaitre. Une mesure
   qui voit une croissance en racine(N) dans du bruit serait pire
   qu'inutile, elle serait convaincante.
   ============================================================================ */
"use strict";
const path = require("path");
const RACINE = path.join(__dirname, "..");
const T = require(path.join(RACINE, "deploy", "banc_transversal.js"));
const A = require(path.join(RACINE, "deploy", "ampleur.js"));

let echecs = 0;
function verifier(nom, condition, detail) {
  if (condition) { console.log(`  ok   ${nom}`); return; }
  echecs++;
  console.log(`  ECHEC ${nom}${detail ? " — " + detail : ""}`);
}

function alea(g) { let s = (g >>> 0) || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

/* Cent instruments, chacun avec son propre financement lent et
   independant, et un rendement a 72 heures qui vaut -BETA x financement
   plus du bruit. L'independance est la condition de tout : c'est elle
   qui fait que chaque instrument ajoute est un PARI DE PLUS, et donc
   elle qui produit la racine(N). */
function monde(graine, lien) {
  const rnd = alea(graine);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const NH = 24 * 30 * 14, BETA = 10, M = 100;
  const fins = [];
  for (let k = 0; k < M; k++) {
    const f = new Float64Array(NH);
    let v = 0;
    for (let i = 0; i < NH; i++) { v = 0.99 * v + 0.0004 * gauss(); f[i] = v; }
    fins.push(f);
  }
  const out = [];
  for (let k = 0; k < M; k++) {
    const closes = new Float64Array(NH);
    let px = 100;
    for (let i = 0; i < NH; i++) {
      px *= Math.exp(-BETA * fins[k][i] / A.HEURES + 0.006 * gauss());
      closes[i] = px;
    }
    // « lien » faux : l'instrument porte le financement d'un autre.
    out.push({ instId: `S${k}`, closes, car: T.caracteristiques(closes),
               fin: lien ? fins[k] : fins[(k + 37) % M] });
  }
  return out;
}

function courbe(univers, largeurs) {
  const pts = [];
  for (const N of largeurs) {
    const k = Math.max(2, Math.round(N / A.FRACTION));
    const st = T.stats(T.evaluer(univers.slice(0, N), "financement", A.HEURES, k));
    pts.push({ N, k, sharpe: st.sharpe, t: st.t, n: st.n });
  }
  return pts;
}

const LARG = [12, 25, 50, 100];

/* --- 1. Sur un monde ou l'effet existe ----------------------------------- */
console.log("1. Un monde ou l'effet transversal existe pour de bon");
const vrai = courbe(monde(11, true), LARG);
for (const p of vrai) console.log(`   N=${String(p.N).padStart(3)} k=${String(p.k).padStart(2)} · ${p.n} periodes · sharpe ${p.sharpe.toFixed(4)} · t ${p.t.toFixed(2)}`);

verifier("chaque largeur donne assez de periodes", vrai.every((p) => p.n > 100));
verifier("l'effet est visible des la plus petite largeur", vrai[0].sharpe > 0, vrai[0].sharpe.toFixed(4));
verifier("le sharpe grandit avec la largeur",
  vrai.every((p, i) => !i || p.sharpe > vrai[i - 1].sharpe),
  vrai.map((p) => p.sharpe.toFixed(3)).join(" < "));

const gain = vrai[vrai.length - 1].sharpe / vrai[0].sharpe;
const attendu = Math.sqrt(LARG[LARG.length - 1] / LARG[0]);
verifier(`le gain de ${LARG[0]} a ${LARG[LARG.length - 1]} suit a peu pres racine(N)`,
  gain > attendu / 2 && gain < attendu * 2,
  `obtenu x${gain.toFixed(2)}, attendu x${attendu.toFixed(2)}`);

const norm = vrai.map((p) => p.sharpe / Math.sqrt(p.N));
const mn = norm.reduce((a, b) => a + b, 0) / norm.length;
const cv = Math.sqrt(norm.reduce((u, v) => u + (v - mn) ** 2, 0) / (norm.length - 1)) / Math.abs(mn);
verifier("sharpe/racine(N) reste stable", cv < 0.35, `variation relative ${(100 * cv).toFixed(0)} %`);

/* --- 2. Le temoin : le lien casse ---------------------------------------- */
console.log("2. Le meme monde, mais le lien casse");
const faux = courbe(monde(11, false), LARG);
for (const p of faux) console.log(`   N=${String(p.N).padStart(3)} · sharpe ${p.sharpe.toFixed(4)} · t ${p.t.toFixed(2)}`);

verifier("aucune largeur ne sort du bruit",
  faux.every((p) => Math.abs(p.t) < 2.5), faux.map((p) => p.t.toFixed(2)).join(" "));
verifier("la loi en racine(N) n'apparait PAS dans le bruit",
  !(faux.every((p, i) => !i || p.sharpe > faux[i - 1].sharpe) && faux[3].sharpe > 2 * faux[0].sharpe),
  faux.map((p) => p.sharpe.toFixed(4)).join(" "));
verifier("le vrai monde se detache nettement du temoin",
  vrai[3].t > 3 * Math.abs(faux[3].t) || (vrai[3].t > 4 && Math.abs(faux[3].t) < 2),
  `vrai t ${vrai[3].t.toFixed(2)} contre temoin t ${faux[3].t.toFixed(2)}`);

/* --- 3. La taille de bloc du melange ------------------------------------- */
console.log("3. Le melange horaire utilise-t-il la bonne journee ?");
const src = require("fs").readFileSync(path.join(RACINE, "deploy", "ampleur.js"), "utf8");
verifier("une journee vaut 24 points, pas 288",
  /melangerParBlocs\(d\.px, graine \* 1000 \+ i, 24\)/.test(src));
verifier("le signal, l'horizon et la fraction ne sont pas reglables",
  !/process\.env\.[A-Z_]*(?:HEURES|SIGNAL|FRACTION)/.test(src));

console.log(echecs === 0 ? "\nEPREUVE DE LA LARGEUR : verte." : `\nEPREUVE DE LA LARGEUR : ${echecs} echec(s).`);
process.exit(echecs === 0 ? 0 : 1);
