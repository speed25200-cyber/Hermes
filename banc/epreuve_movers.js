#!/usr/bin/env node
/* ============================================================================
   L'EPREUVE DU BANC DES MOVERS.

   Un banc qui trouve un avantage la ou l'on en a plante un, et qui n'en
   trouve plus une fois le lien casse, merite qu'on lise ses chiffres.
   Sinon ses verdicts — bons ou mauvais — ne valent rien. Six questions :

   1. Les indicateurs sont-ils justes, et surtout CAUSAUX ? La valeur a la
      bougie i, calculee sur un prefixe, doit etre celle calculee sur la
      serie entiere. Un indicateur qui lit le futur fabrique un avantage.
   2. Les sorties font-elles ce qu'elles disent — stop, cible, suivi,
      temps — sur des chemins 5 min construits pour les declencher ?
   3. L'univers causal du jour d ignore-t-il ce qui vient apres d ?
   4. Un effet plante (le flux predit le rendement) est-il retrouve ?
   5. Le nul le detruit-il ? C'est la question qui compte : si le melange
      laissait passer l'effet, chaque cellule battrait son nul pour rien.
   6. Le papier est-il lu sans perte (100 profils, 88 + 12, WR annonce) ?
   ============================================================================ */
"use strict";
const fs = require("fs"); const path = require("path");
const RACINE = path.join(__dirname, "..");
const M = require(path.join(RACINE, "deploy", "banc_movers.js"));
let echecs = 0;
function verifier(nom, cond, detail) { if (cond) { console.log(`  ok   ${nom}`); return; } echecs++; console.log(`  ECHEC ${nom}${detail ? " — " + detail : ""}`); }
function alea(g) { let s = g >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
const F = (a) => Float64Array.from(a);

/* --- 1. indicateurs ---------------------------------------------------- */
console.log("1. Les indicateurs sont-ils justes et causaux ?");
const rampe = F(Array.from({ length: 300 }, (_, i) => 100 + i));
const e = M.ema(rampe, 10);
verifier("EMA d'une rampe suit la rampe avec le retard theorique", Math.abs((rampe[299] - e[299]) - 4.5) < 0.3, (rampe[299] - e[299]).toFixed(2));
verifier("RSI d'une serie qui ne fait que monter vaut 100", M.rsi(rampe, 14)[100] === 100);
const plat = F(new Array(100).fill(50)); const hp = F(new Array(100).fill(51)), lp = F(new Array(100).fill(49));
verifier("ATR d'une bougie constante de 2 vaut 2", Math.abs(M.trAtr(hp, lp, plat, 14)[60] - 2) < 1e-9);
const x = F([1, 5, 3, 9, 2, 8]); const rm = M.rollMax(x, 2);
verifier("rollMax lit les N bougies PRECEDENTES, pas la courante", rm[3] === 5 && rm[4] === 9, `${rm[3]} ${rm[4]}`);
// causalite : prefixe contre serie entiere
const rnd = alea(11); const n = 2000; const c = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n); let p = 100;
for (let i = 0; i < n; i++) { p *= Math.exp(0.003 * (rnd() - 0.5)); c[i] = p; h[i] = p * (1 + 0.002 * rnd()); l[i] = p * (1 - 0.002 * rnd()); }
const coupe = 1200; const pre = (a) => a.slice(0, coupe);
const pairs = [["ema", M.ema(c, 21), M.ema(pre(c), 21)], ["rsi", M.rsi(c, 14), M.rsi(pre(c), 14)], ["atr", M.trAtr(h, l, c, 14), M.trAtr(pre(h), pre(l), pre(c), 14)],
  ["adx", M.dmi(h, l, c, 14).adx, M.dmi(pre(h), pre(l), pre(c), 14).adx], ["supertrend", M.supertrend(h, l, c, 10, 2).ligne, M.supertrend(pre(h), pre(l), pre(c), 10, 2).ligne],
  ["rollMax", M.rollMax(h, 48), M.rollMax(pre(h), 48)], ["zscore", M.zscore(c, 96), M.zscore(pre(c), 96)]];
for (const [nom, a, b] of pairs) { let ok = true; for (let i = 0; i < coupe; i++) { const u = a[i], v = b[i]; if (Number.isNaN(u) && Number.isNaN(v)) continue; if (Math.abs(u - v) > 1e-9) { ok = false; break; } } verifier(`${nom} : identique sur un prefixe (causal)`, ok); }

/* --- 2. sorties -------------------------------------------------------- */
console.log("2. Les sorties font-elles ce qu'elles disent ?");
const pr = { sl_prix_pct: 1.25, tp_prix_pct: 4, act_prix_pct: 0.5, dist_prix_pct: 0.15, duree_max_h: 6 };
const chemin = (pts) => M.chemin5(pts.map((v, i) => [i * M.B5, v.o ?? v, v.h ?? v, v.l ?? v, v.c ?? v, 1]), 0, pts.length + 80);
// stop : la bougie 3 descend a -1,3 %
let c5 = chemin([100, 100, 100, { o: 100, h: 100, l: 98.7, c: 99 }, 99]);
let ex = M.sortir(c5, 0, 1, 100, pr); verifier("stop touche : sortie au prix du stop", ex && ex.raison === "sl" && Math.abs(ex.prix - 98.75) < 1e-9, JSON.stringify(ex));
c5 = chemin([100, 100, { o: 100, h: 104.5, l: 100, c: 104 }, 104]);
ex = M.sortir(c5, 0, 1, 100, pr); verifier("cible touchee : sortie a la cible", ex && ex.raison === "tp" && Math.abs(ex.prix - 104) < 1e-9, JSON.stringify(ex));
c5 = chemin([100, 100, { o: 100, h: 101, l: 100, c: 100.9 }, { o: 100.9, h: 101, l: 100.7, c: 100.8 }, 100.8]);
ex = M.sortir(c5, 0, 1, 100, pr); verifier("suivi : active a +0,5 %, sort a 0,15 % sous le meilleur", ex && ex.raison === "trail" && Math.abs(ex.prix - 101 * (1 - 0.0015)) < 1e-9, JSON.stringify(ex));
c5 = chemin(new Array(80).fill(100.2)); ex = M.sortir(c5, 0, 1, 100, pr); verifier("temps : sortie a la cloture apres 6 h (72 bougies)", ex && ex.raison === "temps" && ex.bars === 72, JSON.stringify(ex));
c5 = chemin([100, 100, { o: 100, h: 101.3, l: 100, c: 101 }, 101]); ex = M.sortir(c5, 0, -1, 100, pr); verifier("court : le stop est au-dessus", ex && ex.raison === "sl" && Math.abs(ex.prix - 101.25) < 1e-9, JSON.stringify(ex));
c5 = chemin([100, { o: 100, h: 104.2, l: 98.6, c: 100 }]); ex = M.sortir(c5, 0, 1, 100, pr); verifier("stop ET cible dans la meme bougie : le stop l'emporte (prudent)", ex && ex.raison === "sl");

/* --- 3 a 5. un instrument fabrique, un effet plante ------------------------- */
console.log("3. L'univers causal ignore-t-il le futur ?");
const JOURS = 150, N5 = JOURS * 288; const t0 = Date.UTC(2026, 0, 1);
function fabriquer(graine, planter) {
  /* Le flux est un processus LENT (AR(1), constante de temps ~ 5 h) et,
     quand on plante, la derive du prix suit le flux moyen des 24 h — a
     l'echelle exacte que le signal ofi_momentum mesure. Une rafale d'une
     bougie, comme dans la premiere version de ce banc, se noyait dans la
     moyenne de 48 bougies et ne testait pas ce que le signal lit. */
  const r = alea(graine); const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const rows = []; let px = 100 + 50 * r(); let flux = 0; const hist = [];
  for (let i = 0; i < N5; i++) {
    flux = 0.985 * flux + 0.12 * gauss(); const f = Math.max(-0.9, Math.min(0.9, flux));
    hist.push(f); if (hist.length > 288) hist.shift(); const f24 = hist.reduce((u, v) => u + v, 0) / hist.length;
    const v = 1000 * (0.5 + r()); const tb = v * (0.5 + 0.5 * f);
    const ret = (planter ? 0.0012 * f24 : 0) + 0.0015 * gauss(); const o = px; px = px * Math.exp(ret);
    rows.push([t0 + i * M.B5, o, Math.max(o, px) * (1 + 0.0005 * r()), Math.min(o, px) * (1 - 0.0005 * r()), px, v, v * px, 10, tb]);
  }
  return rows;
}
const nBar = Math.floor((N5 * M.B5) / M.B30);
const instruments = Array.from({ length: 14 }, (_, k) => { const c5 = fabriquer(100 + k, k < 7); const B = M.barres30(c5, t0, nBar); const P5 = M.chemin5(c5, t0, N5); return { instId: `T${k}`, P5, B, M: { fund: new Float64Array(nBar).fill(0), prime: null, oi: null, top: null, taker: null } }; });
const U1 = M.universCausaux(instruments, t0, JOURS, nBar);
// on altere tout ce qui suit le jour 100 et l'on verifie que les jours <= 100 ne bougent pas
const alt = instruments.map((x) => { const B = { ...x.B, c: Float64Array.from(x.B.c), qv: Float64Array.from(x.B.qv) }; for (let i = 100 * 48; i < nBar; i++) { B.c[i] *= 3; B.qv[i] *= 100; } return { ...x, B }; });
const U2 = M.universCausaux(alt, t0, JOURS, nBar);
let memes = true; for (let k = 0; k < instruments.length; k++) for (let d = 0; d <= 100; d++) if (U1.topVol[k * JOURS + d] !== U2.topVol[k * JOURS + d] || U1.topMov[k * JOURS + d] !== U2.topMov[k * JOURS + d]) memes = false;
verifier("l'appartenance des jours <= 100 ne change pas quand on altere l'apres", memes);
verifier("aucun instrument n'entre avant 30 jours d'histoire", (() => { for (let k = 0; k < instruments.length; k++) for (let d = 0; d < 30; d++) if (U1.topVol[k * JOURS + d]) return false; return true; })());

console.log("4. Un effet plante est-il retrouve ?");
const tous = (list, fn) => { const out = {}; for (const x of list) { const { S } = M.famillesFlux(x.B, x.M); const r = M.evaluerFlux(x.B, x.M.fund, S, null); for (const c of Object.keys(r)) (out[c] = out[c] || []).push(...r[c]); } return out; };
const avec = tous(instruments.slice(0, 7)), sans = tous(instruments.slice(7));
const sA = M.stats(avec["ofi_momentum@4h"]), sS = M.stats(sans["ofi_momentum@4h"]);
/* On lit le t BRUT : le t net d'une cellule sans effet vaut deja ~ -4
   par le seul cout des executions, et ce n'est pas un biais du banc. */
verifier("ofi_momentum@4h ressort fort la ou le flux predit le prix (t brut)", sA.n > 200 && sA.tBrut > 4, `n ${sA.n} t brut ${sA.tBrut.toFixed(2)}`);
verifier("et ne ressort pas la ou rien n'est plante (t brut)", Math.abs(sS.tBrut) < 2.5, `t brut ${sS.tBrut.toFixed(2)}`);
verifier("le net d'une cellule sans effet est negatif du seul fait des couts", sS.t < -2 && sS.moyBrut > -0.0005, `t net ${sS.t.toFixed(2)} brut/trade ${(100 * sS.moyBrut).toFixed(3)} %`);
verifier("le contrarien du meme signal est negatif", M.stats(avec["ofi_contrarien@4h"]).tBrut < -4, M.stats(avec["ofi_contrarien@4h"]).tBrut.toFixed(2));

console.log("5. Le nul detruit-il l'effet plante ?");
const tsNul = []; for (let g = 1; g <= 6; g++) { const rep = instruments.slice(0, 7).map((x, k) => ({ ...x, B: M.melanger(x.B, g * 31 + k) })); tsNul.push(M.stats(tous(rep)["ofi_momentum@4h"]).tBrut); }
verifier("sur six repliques melangees, le t brut de la cellule retombe dans le bruit", tsNul.every((v) => Math.abs(v) < 2.5), tsNul.map((v) => v.toFixed(2)).join(" "));
verifier("le reel est loin au-dessus du maximum des repliques", sA.tBrut > Math.max(...tsNul) + 2, `${sA.tBrut.toFixed(2)} contre ${Math.max(...tsNul).toFixed(2)}`);
const B0 = instruments[0].B, Bm = M.melanger(B0, 5); const rets = (B) => { const r = []; for (let i = 1; i < B.c.length; i++) if (Number.isFinite(B.c[i]) && Number.isFinite(B.c[i - 1])) r.push(Math.log(B.c[i] / B.c[i - 1])); return r; };
const r0 = rets(B0), r1 = rets(Bm); const sd = (a) => { const m = a.reduce((u, v) => u + v, 0) / a.length; return Math.sqrt(a.reduce((u, v) => u + (v - m) ** 2, 0) / a.length); };
verifier("le melange conserve l'ecart-type des rendements a 5 % pres", Math.abs(sd(r0) / sd(r1) - 1) < 0.05, `${sd(r0).toExponential(3)} vs ${sd(r1).toExponential(3)}`);
verifier("le melange conserve le nombre de bougies", r0.length === r1.length);
verifier("les hauts restent au-dessus des clotures apres melange", (() => { for (let i = 0; i < Bm.c.length; i++) if (Number.isFinite(Bm.c[i]) && (Bm.h[i] < Math.max(Bm.o[i], Bm.c[i]) - 1e-9 || Bm.l[i] > Math.min(Bm.o[i], Bm.c[i]) + 1e-9)) return false; return true; })());

/* --- 6. le papier --------------------------------------------------------- */
console.log("6. Le papier est-il lu sans perte ?");
const P = JSON.parse(fs.readFileSync(path.join(RACINE, "config", "movers", "papier_profils.json"), "utf8"));
verifier("100 profils, 88 individuels, 12 globaux", P.profils.length === 100 && P.meta.n_individuels === 88 && P.meta.n_globaux === 12);
verifier("un seul profil global, pullback 21/55", P.meta.profil_global_unique && P.meta.profil_global.famille === "pullback" && P.meta.profil_global.fast === 21);
verifier("le WR OOS recalcule depuis les annexes est celui annonce (69,25 %)", Math.abs(P.meta.oos_wr_pct_recalcule - 69.25) < 0.01);
verifier("1 665 trades OOS, 685 longs, 980 courts, comme annonce", P.meta.oos_total_trades === 1665 && P.meta.oos_longs === 685 && P.meta.oos_shorts === 980);
verifier("aucune incoherence ROE -> prix a x20", P.meta.incoherences_roe_prix.length === 0);
// un profil se rejoue sans erreur sur l'instrument fabrique
const prof = P.profils.find((q) => q.type === "individuel" && q.famille === "pullback");
const tr = M.rejouerProfil(instruments[0].B, instruments[0].P5, t0, instruments[0].M.fund, prof, null);
verifier("un profil du papier se rejoue de bout en bout", Array.isArray(tr), String(tr && tr.length));
verifier("chaque trade porte une raison de sortie connue", tr.every((q) => ["sl", "tp", "trail", "temps"].includes(q.raison)));

console.log(echecs === 0 ? "\nEPREUVE DES MOVERS : verte." : `\nEPREUVE DES MOVERS : ${echecs} echec(s).`);
process.exit(echecs === 0 ? 0 : 1);
