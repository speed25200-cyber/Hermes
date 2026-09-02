#!/usr/bin/env node
/* ============================================================================
   L'ÉPREUVE DU JUGE HONNÊTE.

   Le juge repose entièrement sur une idée : la réplique mélangée est le
   même marché privé de sa mémoire. Si le mélange abîme autre chose que
   la mémoire, la comparaison ne vaut rien et le juge devient une
   superstition de plus.

   Cette épreuve vérifie donc ce que le mélange CONSERVE autant que ce
   qu'il détruit, et elle insiste sur un point que la première version
   avait raté : les mèches. Cinq des treize signaux ne lisent que des
   mèches. Une réplique aux bougies plates ne les déclencherait jamais,
   leur distribution nulle serait vide, et ils passeraient la porte sans
   avoir été testés — exactement les signaux qu'il faut le plus tester.
   ============================================================================ */
"use strict";
const path = require("path");
const J = require(path.join(__dirname, "..", "modules", "juge.js"));
const { evalSignal, SIGNAUX } = require(path.join(__dirname, "..", "modules", "signaux.js"));

let echecs = 0;
const verifier = (nom, ok, detail) => {
  if (ok) { console.log(`  ok   ${nom}`); return; }
  echecs++; console.log(`  ECHEC ${nom}${detail ? " — " + detail : ""}`);
};

function gauss(r) { const u = Math.max(1e-12, r()); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

/* Une série réaliste : volatilité qui change par journée, mèches
   proportionnelles, volumes irréguliers. */
function serie(graine, n) {
  const r = J.alea(graine);
  const out = []; let c = 100;
  const ts0 = Math.floor((Date.now() - n * 300000) / 300000) * 300000;
  for (let i = 0; i < n; i++) {
    const jour = Math.floor(i / 288);
    const sd = 0.0015 + 0.004 * ((jour * 7919) % 11) / 11;      // chaque journée a sa volatilité
    const o = c;
    c = c * Math.exp(sd * gauss(r));
    const ampl = Math.abs(c - o) * (1 + 3 * r());
    out.push([ts0 + i * 300000, o, Math.max(o, c) + ampl, Math.min(o, c) - ampl, c, 500 + 4000 * r() * r()]);
  }
  return out;
}

const src = serie(11, 288 * 40);

/* --- 1. Ce que le mélange conserve -------------------------------------- */
console.log("1. Le mélange conserve-t-il le marché, sa mémoire exceptée ?");

const mel = J.melangerParBlocs(src, 1);
const rendements = (c5) => { const r = []; for (let i = 1; i < c5.length; i++) r.push(Math.log(c5[i][4] / c5[i - 1][4])); return r; };
const et = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
const rSrc = rendements(src), rMel = rendements(mel);

verifier("l'écart-type des rendements est conservé",
  Math.abs(et(rSrc) - et(rMel)) / et(rSrc) < 0.02,
  `${et(rSrc).toFixed(6)} contre ${et(rMel).toFixed(6)}`);

// Le kurtosis : les queues épaisses doivent survivre, sinon le faux
// marché est plus doux que le vrai et le null trop indulgent.
const kurt = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; const s = et(a);
  return a.reduce((x, y) => x + ((y - m) / s) ** 4, 0) / a.length; };
verifier("les queues épaisses survivent au mélange",
  Math.abs(kurt(rSrc) - kurt(rMel)) / kurt(rSrc) < 0.25,
  `${kurt(rSrc).toFixed(2)} contre ${kurt(rMel).toFixed(2)}`);

verifier("les horodatages restent strictement croissants",
  mel.every((k, i) => i === 0 || k[0] > mel[i - 1][0]));

verifier("les bougies restent cohérentes (haut ≥ corps ≥ bas, prix > 0)",
  mel.every((k) => k[2] >= Math.max(k[1], k[4]) && k[3] <= Math.min(k[1], k[4]) && k[3] > 0));

// LE point que la première version ratait.
const partMeche = (c5) => c5.filter((k) => {
  const corps = Math.abs(k[4] - k[1]);
  const haut = k[2] - Math.max(k[1], k[4]), bas = Math.min(k[1], k[4]) - k[3];
  return corps > 0 && (haut > 2 * corps || bas > 2 * corps);
}).length / c5.length;
verifier("les mèches survivent, en proportion comparable",
  Math.abs(partMeche(src) - partMeche(mel)) < 0.10,
  `${(100 * partMeche(src)).toFixed(1)} % contre ${(100 * partMeche(mel)).toFixed(1)} %`);

/* --- 2. Ce que le mélange détruit --------------------------------------- */
console.log("2. Le mélange détruit-il bien la mémoire d'un jour sur l'autre ?");

// L'autocorrélation de la volatilité journalière : forte dans une série
// où les journées agitées se suivent, nulle après mélange... sauf que
// notre générateur ne groupe pas les journées agitées. On teste donc
// sur une série qui, elle, les groupe.
const groupee = (() => {
  const r = J.alea(77); const out = []; let c = 100; const n = 288 * 40;
  const ts0 = Math.floor((Date.now() - n * 300000) / 300000) * 300000;
  for (let i = 0; i < n; i++) {
    const jour = Math.floor(i / 288);
    const sd = jour < 20 ? 0.0012 : 0.0060;              // vingt jours calmes, puis vingt agités
    const o = c; c = c * Math.exp(sd * gauss(r));
    out.push([ts0 + i * 300000, o, Math.max(o, c) * 1.0008, Math.min(o, c) * 0.9992, c, 1000]);
  }
  return out;
})();
const volJour = (c5) => { const v = []; for (let j = 0; j * 288 + 288 < c5.length; j++) v.push(et(rendements(c5.slice(j * 288, j * 288 + 288)))); return v; };
const autocorr = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length;
  let num = 0, den = 0;
  for (let i = 1; i < a.length; i++) num += (a[i] - m) * (a[i - 1] - m);
  for (let i = 0; i < a.length; i++) den += (a[i] - m) ** 2;
  return den > 0 ? num / den : 0; };
const acVraie = autocorr(volJour(groupee));
const acMel = autocorr(volJour(J.melangerParBlocs(groupee, 5)));
verifier("l'enchaînement des journées est bien cassé",
  acVraie > 0.5 && acMel < acVraie - 0.3,
  `autocorrélation ${acVraie.toFixed(2)} -> ${acMel.toFixed(2)}`);

/* --- 3. Les signaux se déclenchent-ils encore ? -------------------------- */
console.log("3. Les treize signaux se déclenchent-ils sur une réplique ?");

const compter = (c5) => {
  const n = {};
  for (const s of SIGNAUX) {
    let k = 0; const etat = {};
    for (let i = 900; i < c5.length; i += 7) if (evalSignal(s, c5.slice(i - 299, i + 1), etat) !== 0) k++;
    n[s] = k;
  }
  return n;
};
const nSrc = compter(src), nMel = compter(mel);
const muets = SIGNAUX.filter((s) => nSrc[s] > 3 && nMel[s] === 0);
verifier("aucun signal actif sur le vrai ne devient muet sur la réplique",
  muets.length === 0, muets.join(", "));
console.log(`       vrai : ${SIGNAUX.map((s) => s + " " + nSrc[s]).join(" · ")}`);
console.log(`       mélangé : ${SIGNAUX.map((s) => s + " " + nMel[s]).join(" · ")}`);

/* --- 4. Déterminisme ----------------------------------------------------- */
console.log("4. La distribution nulle est-elle reproductible ?");
verifier("même graine, même réplique",
  JSON.stringify(J.melangerParBlocs(src, 3)) === JSON.stringify(J.melangerParBlocs(src, 3)));
verifier("graines différentes, répliques différentes",
  JSON.stringify(J.melangerParBlocs(src, 3)) !== JSON.stringify(J.melangerParBlocs(src, 4)));

/* --- 5. Le percentile ---------------------------------------------------- */
console.log("5. Le percentile dit-il ce qu'il prétend dire ?");
const d = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
verifier("une valeur au-dessus de tout est au 100e", J.percentileDe(d, 10) === 1);
verifier("une valeur au-dessous de tout est au 0e", J.percentileDe(d, -1) === 0);
verifier("une valeur médiane est au 50e", Math.abs(J.percentileDe(d, 4.5) - 0.5) < 1e-9);
verifier("une distribution vide ne prétend rien", J.percentileDe([], 1) === null);

/* --- 6. La distribution nulle de bout en bout --------------------------- */
console.log("6. La distribution nulle se construit-elle correctement ?");
/* Le juge d'épreuve doit dépendre de l'ORDRE des bougies. Le premier
   essai rendait l'écart-type des rendements — invariant par
   permutation : les huit répliques donnaient le même nombre au bit
   près, et le percentile n'avait plus de sens. Ici, un vrai backtest
   d'un signal réel : le gain moyen par trade dépend entièrement de
   l'ordre, ce qui est tout le sujet. */
const { serieSignaux, simuler, resumer } = require(path.join(__dirname, "..", "modules", "backtest.js"));
const fauxJuge = (c5) => {
  const tr = simuler({ c5, signaux: serieSignaux("z48_5m", c5),
                       sortie: { tpPctMargin: 0.3, trailActPctMargin: 0.15, slPctMargin: 0.3, trailCbPctMargin: 0.05, holdMs: 12 * 3600e3 },
                       lev: 15 });
  const r = resumer(tr);
  return r.trades >= 5 ? { perle: { val: { moyenneMarge: r.moyenneMarge } } } : { perle: null };
};
const dist = J.distributionNulle(src, fauxJuge, { tirages: 12 });
verifier("les répliques produisent des scores", dist.trouvees >= 10, dist.trouvees + "/12");
verifier("les scores sont triés", dist.scores.every((s, i) => i === 0 || s >= dist.scores[i - 1]));
verifier("les scores ne sont pas tous identiques (le juge dépend de l'ordre)",
  new Set(dist.scores.map((x) => x.toFixed(6))).size > 1);
/* LE test d'auto-cohérence, et il est plus exigeant qu'il n'en a l'air.
   On prend une série qui EST elle-même une réplique mélangée : par
   construction, elle n'a aucune mémoire d'un jour sur l'autre. Elle
   doit donc paraître parfaitement ordinaire au milieu de ses propres
   répliques. Si elle en sortait systématiquement gagnante ou perdante,
   c'est que le mélange lui-même introduit un biais — et toute la
   méthode s'effondrerait, car chaque perle serait jugée contre un
   étalon faussé.

   Vingt tirages plutôt que douze : un percentile lu sur douze points ne
   distingue pas 0,92 de 1,00. */
const sansMemoire = J.melangerParBlocs(src, 99);
const distAuto = J.distributionNulle(sansMemoire, fauxJuge, { tirages: 20 });
const reel = fauxJuge(sansMemoire);
const pReel = J.percentileDe(distAuto.scores, reel.perle.val.moyenneMarge);
verifier("une série déjà mélangée paraît ordinaire au milieu de ses répliques",
  pReel != null && pReel > 0.05 && pReel < 0.95,
  "percentile " + (pReel == null ? "?" : pReel.toFixed(2)) +
  " · scores de " + (distAuto.scores[0] || 0).toFixed(4) + " a " + (distAuto.scores[distAuto.scores.length - 1] || 0).toFixed(4) +
  " · reel " + reel.perle.val.moyenneMarge.toFixed(4));

// Un juge qui ne trouve jamais rien : taux nul, pas de plantage.
const jugeSterile = () => ({ perle: null });
const vide = J.distributionNulle(src, jugeSterile, { tirages: 5 });
verifier("un juge stérile donne un taux de zéro sans planter", vide.taux === 0 && vide.scores.length === 0);

console.log(echecs === 0 ? "\nÉPREUVE DU JUGE : verte." : `\nÉPREUVE DU JUGE : ${echecs} échec(s).`);
process.exit(echecs === 0 ? 0 : 1);
