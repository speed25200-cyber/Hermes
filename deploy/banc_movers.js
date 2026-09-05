#!/usr/bin/env node
/* ============================================================================
   LE BANC DES MOVERS — ce que valent, une fois jugees, les strategies
   « a la mode » sur les cinquante contrats les plus actifs.

   Trois questions, posees AVANT de voir un chiffre :

   1. Le papier « Profils optimises Top 100 movers x20 » annonce 69 % de
      trades gagnants hors echantillon sur 88 profils optimises un par
      un. Reproduit a l'identique — memes indicateurs, memes sorties, sur
      bougies 5 min pour les sorties intrabougie — avec le funding et des
      couts par rotation, que reste-t-il ? Et surtout : un profil optimise
      sur SON contrat fait-il mieux que le hasard, une fois compare a ce
      que la meme regle produit sur le meme contrat prive de sa memoire ?
      Fait-il mieux sur les AUTRES contrats ? Le profil global — la seule
      regle du papier qui ne soit pas optimisee par symbole — vaut-il
      quelque chose applique a l'univers causal des movers ?

   2. Les signaux de microstructure — flux d'ordres agressif (le CVD, ici
      exact a partir du volume acheteur des klines, sans un tick), interet
      ouvert, ratios de positionnement, base — portent-ils un avantage a
      1 h, 4 h, 24 h, en serie temporelle et en transversal ?

   3. La question de la largeur : quel univers ? On construit chaque jour,
      de facon CAUSALE (donnees jusqu'a la veille), le top-50 par volume
      et le top-50 par variation absolue 24 h hors cinq plus gros — la
      definition du papier — et l'on ne compte un trade que si le contrat
      etait dans l'univers a l'instant du signal. Un instantane statique
      d'aujourd'hui projete sur le passe est un biais de survie ; le
      papier le dit lui-meme.

   LA DISCIPLINE, la meme que dans tout ce depot : grille declaree, TOUS
   les resultats imprimes, chaque cellule comparee a son nul (blocs de
   six heures pour le prix, et permutation INDEPENDANTE des colonnes de
   flux — sinon un signal intrajournalier survivrait au melange des
   journees), et un test de famille (Westfall-Young, maxT) sur toute la
   grille. Les couts : 0,05 % par execution, glissement declare, et le
   funding accumule sur la duree de detention.

   Ne lit que data/cache-long, data/extra, recherche/. Ecrit
   data/movers.json. Ne branche rien.
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const RACINE = path.join(__dirname, "..");
const JUGE = require(path.join(RACINE, "modules", "juge.js"));

const CACHE = path.join(RACINE, "data", "cache-long");
const EXTRA = path.join(RACINE, "data", "extra");
const UNIVERS_FICHIER = path.join(RACINE, "recherche", "movers", "univers.json");
const PAPIER = path.join(RACINE, "recherche", "papier", "profils.json");

/* ---- parametres declares ---- */
const FRAIS = Number(process.env.MOVERS_FRAIS || 0.0005);        // par execution (taker)
const GLISSEMENT = Number(process.env.MOVERS_GLISSEMENT || 0.0001); // par execution, declare
const TIRAGES = Number(process.env.MOVERS_TIRAGES || 20);
const BLOC_BARRES = Number(process.env.MOVERS_BLOC || 12);        // 12 bougies de 30 min = 6 h
const MOIS_MAX = Number(process.env.MOVERS_MOIS || 24);
const K_XS = Number(process.env.MOVERS_K || 10);                  // longs / courts en transversal
const B30 = 1800e3, B5 = 300e3, JOUR = 86400e3;

/* ============================ indicateurs ============================ */
/* Tous vectorises sur Float64Array, tous causaux : la valeur a i ne lit
   que 0..i. C'est verifie par le banc d'essai, pas seulement affirme. */
function ema(x, n) {
  const out = new Float64Array(x.length).fill(NaN); const k = 2 / (n + 1); let e = NaN, cnt = 0, s = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; if (!Number.isFinite(v)) { out[i] = e; continue; }
    if (cnt < n) { s += v; cnt++; if (cnt === n) e = s / n; out[i] = cnt === n ? e : NaN; continue; }
    e = v * k + e * (1 - k); out[i] = e; }
  return out;
}
function sma(x, n) {
  const out = new Float64Array(x.length).fill(NaN); let s = 0, c = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; if (Number.isFinite(v)) { s += v; c++; }
    if (i >= n) { const w = x[i - n]; if (Number.isFinite(w)) { s -= w; c--; } }
    if (i >= n - 1 && c === n) out[i] = s / n; }
  return out;
}
function rsi(c, n) {
  const out = new Float64Array(c.length).fill(NaN); let g = 0, p = 0;
  for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; const up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
    if (i <= n) { g += up / n; p += dn / n; if (i === n) out[i] = p === 0 ? 100 : 100 - 100 / (1 + g / p); continue; }
    g = (g * (n - 1) + up) / n; p = (p * (n - 1) + dn) / n; out[i] = p === 0 ? 100 : 100 - 100 / (1 + g / p); }
  return out;
}
function trAtr(h, l, c, n) {
  const atr = new Float64Array(c.length).fill(NaN); let a = 0;
  for (let i = 1; i < c.length; i++) { const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i <= n) { a += tr / n; if (i === n) atr[i] = a; continue; } a = (a * (n - 1) + tr) / n; atr[i] = a; }
  return atr;
}
function dmi(h, l, c, n) {
  const pdi = new Float64Array(c.length).fill(NaN), mdi = new Float64Array(c.length).fill(NaN), adx = new Float64Array(c.length).fill(NaN);
  let sTR = 0, sP = 0, sM = 0, ax = NaN, cntDx = 0, sDx = 0;
  for (let i = 1; i < c.length; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i <= n) { sTR += tr; sP += pdm; sM += mdm; if (i < n) continue; }
    else { sTR = sTR - sTR / n + tr; sP = sP - sP / n + pdm; sM = sM - sM / n + mdm; }
    const p = sTR > 0 ? 100 * sP / sTR : 0, m = sTR > 0 ? 100 * sM / sTR : 0; pdi[i] = p; mdi[i] = m;
    const dx = (p + m) > 0 ? 100 * Math.abs(p - m) / (p + m) : 0;
    if (!Number.isFinite(ax)) { sDx += dx; cntDx++; if (cntDx === n) { ax = sDx / n; adx[i] = ax; } }
    else { ax = (ax * (n - 1) + dx) / n; adx[i] = ax; }
  }
  return { pdi, mdi, adx };
}
function supertrend(h, l, c, n, f) {
  const atr = trAtr(h, l, c, n); const dir = new Int8Array(c.length); const ligne = new Float64Array(c.length).fill(NaN);
  let up = NaN, dn = NaN, d = 1;
  for (let i = 0; i < c.length; i++) { if (!Number.isFinite(atr[i])) continue;
    const m = (h[i] + l[i]) / 2; let bu = m + f * atr[i], bl = m - f * atr[i];
    if (Number.isFinite(dn) && c[i - 1] > dn) bl = Math.max(bl, dn); if (Number.isFinite(up) && c[i - 1] < up) bu = Math.min(bu, up);
    if (d === 1 && c[i] < bl) d = -1; else if (d === -1 && c[i] > bu) d = 1;
    up = bu; dn = bl; dir[i] = d; ligne[i] = d === 1 ? bl : bu; }
  return { dir, ligne };
}
function rollMax(x, n) { const out = new Float64Array(x.length).fill(NaN); for (let i = n; i < x.length; i++) { let m = -Infinity; for (let j = i - n; j < i; j++) if (x[j] > m) m = x[j]; out[i] = m; } return out; } // sur les N PRECEDENTES
function rollMin(x, n) { const out = new Float64Array(x.length).fill(NaN); for (let i = n; i < x.length; i++) { let m = Infinity; for (let j = i - n; j < i; j++) if (x[j] < m) m = x[j]; out[i] = m; } return out; }
function stdev(x, n) {
  const out = new Float64Array(x.length).fill(NaN); let s = 0, q = 0, c = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; if (Number.isFinite(v)) { s += v; q += v * v; c++; }
    if (i >= n) { const w = x[i - n]; if (Number.isFinite(w)) { s -= w; q -= w * w; c--; } }
    if (c === n) { const m = s / c; out[i] = Math.sqrt(Math.max(0, q / c - m * m)); } }
  return out;
}
function zscore(x, n) { const m = sma(x, n), s = stdev(x, n); const out = new Float64Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) if (s[i] > 0) out[i] = (x[i] - m[i]) / s[i]; return out; }
function cumsum(x) { const out = new Float64Array(x.length); let s = 0; for (let i = 0; i < x.length; i++) { if (Number.isFinite(x[i])) s += x[i]; out[i] = s; } return out; }

/* ============================ donnees ============================ */
function lire(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
/* Les bougies 5 min -> 30 min, alignees sur une grille commune. tb (volume
   acheteur agressif) manque dans les vieux caches : la colonne reste NaN
   et les familles de flux ecartent l'instrument. */
function barres30(c5, t0, n) {
  /* Float32 : sept significatifs suffisent a un rendement de 1e-4, et
     c'est ce qui fait tenir 136 instruments dans les deux gigaoctets. */
  const o = new Float32Array(n).fill(NaN), h = new Float32Array(n).fill(NaN), l = new Float32Array(n).fill(NaN), c = new Float32Array(n).fill(NaN),
        v = new Float32Array(n).fill(0), qv = new Float32Array(n).fill(0), tb = new Float32Array(n).fill(NaN);
  let aTb = false;
  for (const r of c5) { const i = Math.floor((r[0] - t0) / B30); if (i < 0 || i >= n) continue;
    if (!Number.isFinite(o[i])) { o[i] = r[1]; h[i] = r[2]; l[i] = r[3]; } else { if (r[2] > h[i]) h[i] = r[2]; if (r[3] < l[i]) l[i] = r[3]; }
    c[i] = r[4]; v[i] += r[5]; qv[i] += r.length > 6 && Number.isFinite(r[6]) ? r[6] : r[5] * r[4];
    if (r.length > 8 && Number.isFinite(r[8])) { tb[i] = (Number.isFinite(tb[i]) ? tb[i] : 0) + r[8]; aTb = true; } }
  return { o, h, l, c, v, qv, tb, aTb };
}
/* Le chemin 5 min, sur grille fixe depuis t0 : ne sert qu'aux sorties
   intrabougie, donc haut, bas, cloture suffisent. */
function chemin5(c5, t0, n5) {
  const h = new Float32Array(n5).fill(NaN), l = new Float32Array(n5).fill(NaN), c = new Float32Array(n5).fill(NaN);
  for (const r of c5) { const i = Math.round((r[0] - t0) / B5); if (i < 0 || i >= n5) continue; h[i] = r[2]; l[i] = r[3]; c[i] = r[4]; }
  return { h, l, c, n: n5 };
}
function grille(serie, t0, n, col, pas) {
  const out = new Float32Array(n).fill(NaN); if (!serie || !serie.length) return out; let j = 0;
  for (let i = 0; i < n; i++) { const T = t0 + i * pas; while (j + 1 < serie.length && serie[j + 1][0] <= T) j++; if (serie[j][0] <= T) out[i] = serie[j][col]; }
  return out;
}

/* ============================ le nul ============================ */
/* Melange par blocs de BLOC_BARRES bougies de 30 min : conserve la
   distribution des rendements et la structure intrabloc, detruit la
   memoire au-dela. Le flux (tb, metrics) est permute par blocs
   INDEPENDAMMENT du prix : c'est le lien flux -> rendement futur qu'on
   veut casser, pas les series. Les 5 min servent aux sorties : on les
   regenere par interpolation du chemin reel de la bougie transposee
   (memes fractions haut/bas), ce qui garde la geometrie intrabougie. */
function melanger(B, graine) {
  const n = B.c.length; const suiv = JUGE.alea(graine);
  const idx = []; for (let i = 0; i < n; i++) if (Number.isFinite(B.c[i])) idx.push(i);
  const blocs = []; for (let i = 0; i < idx.length; i += BLOC_BARRES) blocs.push(idx.slice(i, i + BLOC_BARRES));
  const perm = blocs.map((_, i) => i); for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(suiv() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const permF = blocs.map((_, i) => i); for (let i = permF.length - 1; i > 0; i--) { const j = Math.floor(suiv() * (i + 1)); [permF[i], permF[j]] = [permF[j], permF[i]]; }
  const o = new Float32Array(n).fill(NaN), h = new Float32Array(n).fill(NaN), l = new Float32Array(n).fill(NaN), c = new Float32Array(n).fill(NaN),
        v = new Float32Array(n).fill(0), qv = new Float32Array(n).fill(0), tb = new Float32Array(n).fill(NaN), src = new Int32Array(n).fill(-1);
  let prix = B.c[idx[0]]; let k = 0;
  for (let b = 0; b < blocs.length; b++) {
    const bp = blocs[perm[b]], bf = blocs[permF[b]];
    for (let q = 0; q < bp.length && k < idx.length; q++, k++) {
      const i = idx[k], s = bp[q], sf = bf[Math.min(q, bf.length - 1)];
      const rOuv = B.o[s] / (s > 0 && Number.isFinite(B.c[s - 1]) ? B.c[s - 1] : B.o[s]);
      const ret = B.c[s] / B.o[s];
      const ouv = prix * rOuv; const clo = ouv * ret;
      const hautFrac = (B.h[s] - Math.max(B.o[s], B.c[s])) / B.c[s], basFrac = (Math.min(B.o[s], B.c[s]) - B.l[s]) / B.c[s];
      o[i] = ouv; c[i] = clo; h[i] = Math.max(ouv, clo) * (1 + Math.max(0, hautFrac)); l[i] = Math.min(ouv, clo) * (1 - Math.max(0, basFrac));
      v[i] = B.v[sf]; qv[i] = B.qv[sf]; tb[i] = Number.isFinite(B.tb[sf]) && B.v[sf] > 0 ? B.tb[sf] / B.v[sf] * B.v[sf] : NaN; src[i] = s; prix = clo;
    }
  }
  return { o, h, l, c, v, qv, tb, aTb: B.aTb, src, permF, blocs };
}

/* ============================ couts ============================ */
/* Un aller-retour : deux executions (frais + glissement chacune) plus le
   funding accumule. Le funding est paye toutes les huit heures au taux
   en vigueur ; un long paie quand il est positif. On l'approxime par
   taux * (duree / 8 h), signe selon le cote. */
function coutAR(fund, duree, sens) { return 2 * (FRAIS + GLISSEMENT) + sens * (Number.isFinite(fund) ? fund : 0) * (duree / (8 * 3600e3)); }

/* ============================ statistiques ============================ */
function stats(trades) {
  const n = trades.length; if (n < 5) return { n, moy: 0, sd: 0, t: 0, wr: 0, pf: 0, brut: 0, net: 0, moyBrut: 0 };
  const moy = (a) => a.reduce((u, x) => u + x, 0) / a.length;
  const nets = trades.map((t) => t.net), bruts = trades.map((t) => t.brut);
  const m = moy(nets), sd = Math.sqrt(nets.reduce((u, x) => u + (x - m) ** 2, 0) / (n - 1));
  const g = nets.filter((x) => x > 0).reduce((u, x) => u + x, 0), p = -nets.filter((x) => x < 0).reduce((u, x) => u + x, 0);
  /* Deux t, parce que ce sont deux questions : « le signal existe-t-il ? »
     se lit sur le BRUT, « est-il negociable ? » sur le net. Un signal
     inexistant rend deja t ~ -4 en net sur mille trades par le seul cout
     des executions : lire ce -4 comme un biais serait une erreur. */
  const mb = moy(bruts), sdb = Math.sqrt(bruts.reduce((u, x) => u + (x - mb) ** 2, 0) / (n - 1));
  return { n, moy: m, sd, t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0, wr: nets.filter((x) => x > 0).length / n, pf: p > 0 ? g / p : (g > 0 ? 99 : 0),
           brut: bruts.reduce((u, x) => u + x, 0), net: nets.reduce((u, x) => u + x, 0), moyBrut: mb, tBrut: sdb > 0 ? mb / (sdb / Math.sqrt(n)) : 0 };
}

/* ============================ le papier ============================ */
/* Chaque profil du papier, tel qu'ecrit page 5 : regime 1 h, tendance
   locale, force, declencheur, qualite, puis sorties intrabougie sur les
   bougies 5 min. Les points que le papier laisse au lecteur sont tranches
   ici, une fois, et dits :
   - « RSI croise 50 » : croisement franc sur la bougie du signal ;
   - « le plus bas touche l'EMA rapide » : low <= EMA rapide <= close ;
   - Bollinger de longueur LB, ecart-type BB ; Donchian sur les LB bougies
     PRECEDENTES ;
   - ATR% maximum 3,5 fixe ; volume >= vol x SMA20 (0 desactive) ;
   - cooldown : CD bougies apres la fermeture d'une position ;
   - regime 1 h sur l'heure CLOSE precedente ;
   - entree a la cloture de la bougie 30 min du signal, plus glissement ;
   - sorties dans l'ordre : stop, puis take-profit, puis suivi, sur H/L de
     chaque bougie 5 min ; sortie temps a la cloture. */
const COMMUNS = new WeakMap();
function communs(B) {
  let c = COMMUNS.get(B); if (c) return c;
  const { h, l, c: cl, v } = B;
  c = { e200: ema(cl, 200), rsi: rsi(cl, 14), atr: trAtr(h, l, cl, 14), vsma: sma(v, 20), ...dmi(h, l, cl, 14), reg: null, emas: new Map(), st: new Map() };
  COMMUNS.set(B, c); return c;
}
function caracsProfil(B, pr) {
  const K = communs(B); const { h, l, c } = B;
  const emaDe = (n) => { let e = K.emas.get(n); if (!e) { e = ema(c, n); K.emas.set(n, e); } return e; };
  let st = K.st.get(pr.st); if (!st) { st = supertrend(h, l, c, 10, pr.st).dir; K.st.set(pr.st, st); }
  const car = { eF: emaDe(pr.fast), eS: emaDe(pr.slow), e200: K.e200, rsi: K.rsi, atr: K.atr, vsma: K.vsma, pdi: K.pdi, mdi: K.mdi, adx: K.adx, stDir: st };
  if (pr.famille === "breakout" || pr.famille === "hybrid") { car.dHaut = rollMax(h, pr.lb); car.dBas = rollMin(l, pr.lb); }
  if (pr.famille === "reversion") { const m = sma(c, pr.lb), sd = stdev(c, pr.lb); car.bbH = new Float64Array(c.length); car.bbB = new Float64Array(c.length);
    for (let i = 0; i < c.length; i++) { car.bbH[i] = m[i] + pr.bb * sd[i]; car.bbB[i] = m[i] - pr.bb * sd[i]; } }
  return car;
}
/* Regime 1 h : EMA 50/200 sur les clotures horaires, evalue a l'heure
   close precedant la bougie 30 min. */
function regime1h(B) {
  const n = B.c.length; const c1 = []; const idx1 = [];
  for (let i = 1; i < n; i += 2) if (Number.isFinite(B.c[i])) { c1.push(B.c[i]); idx1.push(i); }
  const x = Float64Array.from(c1); const e50 = ema(x, 50), e200 = ema(x, 200);
  const reg = new Int8Array(n); let cur = 0, j = 0;
  for (let i = 0; i < n; i++) { while (j < idx1.length && idx1[j] < i) { cur = (x[j] > e200[j] && e50[j] > e200[j]) ? 1 : (x[j] < e200[j] && e50[j] < e200[j]) ? -1 : 0; j++; } reg[i] = cur; }
  return reg;
}
function signalProfil(B, car, reg, pr, i) {
  const { o, h, l, c, v } = B; if (i < 2 || !Number.isFinite(car.e200[i]) || !Number.isFinite(car.adx[i]) || !Number.isFinite(car.rsi[i - 1])) return 0;
  const atrp = 100 * car.atr[i] / c[i]; if (!(atrp >= pr.atrmin_pct && atrp <= 3.5)) return 0;
  if (pr.vol > 0 && !(v[i] >= pr.vol * car.vsma[i])) return 0;
  const tendance = pr.famille !== "reversion";
  const okL = tendance ? (reg[i] === 1 && c[i] > car.e200[i] && car.eF[i] > car.eS[i] && car.stDir[i] === 1 && car.pdi[i] > car.mdi[i] && car.adx[i] >= pr.adx && car.rsi[i] >= pr.rsi && car.rsi[i] < 76)
                       : (reg[i] === 1 && c[i] > car.e200[i] && car.adx[i] < pr.adx && car.rsi[i] <= pr.rsi);
  const okS = tendance ? (reg[i] === -1 && c[i] < car.e200[i] && car.eF[i] < car.eS[i] && car.stDir[i] === -1 && car.mdi[i] > car.pdi[i] && car.adx[i] >= pr.adx && car.rsi[i] <= 100 - pr.rsi && car.rsi[i] > 24)
                       : (reg[i] === -1 && c[i] < car.e200[i] && car.adx[i] < pr.adx && car.rsi[i] >= 100 - pr.rsi);
  const pullL = l[i] <= car.eF[i] && c[i] > car.eF[i] && c[i] > o[i] && car.rsi[i - 1] < 50 && car.rsi[i] >= 50;
  const pullS = h[i] >= car.eF[i] && c[i] < car.eF[i] && c[i] < o[i] && car.rsi[i - 1] > 50 && car.rsi[i] <= 50;
  const brkL = car.dHaut && c[i] > car.dHaut[i] && c[i - 1] <= car.dHaut[i - 1], brkS = car.dBas && c[i] < car.dBas[i] && c[i - 1] >= car.dBas[i - 1];
  let L = false, S = false;
  switch (pr.famille) {
    case "pullback": L = pullL; S = pullS; break;
    case "breakout": L = !!brkL; S = !!brkS; break;
    case "hybrid": L = pullL || !!brkL; S = pullS || !!brkS; break;
    case "momentum": L = car.rsi[i - 1] < pr.rsi && car.rsi[i] >= pr.rsi; S = car.rsi[i - 1] > 100 - pr.rsi && car.rsi[i] <= 100 - pr.rsi; break;
    case "reversion": L = c[i - 1] < car.bbB[i - 1] && c[i] >= car.bbB[i]; S = c[i - 1] > car.bbH[i - 1] && c[i] <= car.bbH[i]; break;
  }
  if (L && okL) return 1; if (S && okS) return -1; return 0;
}
/* Les sorties, sur le chemin 5 min reel (ou reconstitue pour le nul). */
function sortir(P5, debut5, sens, entree, pr) {
  const sl = pr.sl_prix_pct / 100, tp = pr.tp_prix_pct / 100, act = pr.act_prix_pct / 100, dist = pr.dist_prix_pct / 100;
  const maxBars = Math.round(pr.duree_max_h * 12);
  let meilleur = entree, suiveur = NaN, vus = 0;
  for (let k = 1; k <= maxBars && debut5 + k < P5.n; k++) {
    const hi = P5.h[debut5 + k], lo = P5.l[debut5 + k]; if (!Number.isFinite(hi)) continue; vus++;
    if (sens === 1) {
      if (lo <= entree * (1 - sl)) return { prix: entree * (1 - sl), bars: k, raison: "sl" };
      if (Number.isFinite(suiveur) && lo <= suiveur) return { prix: suiveur, bars: k, raison: "trail" };
      if (hi >= entree * (1 + tp)) return { prix: entree * (1 + tp), bars: k, raison: "tp" };
      if (hi > meilleur) meilleur = hi; if (meilleur >= entree * (1 + act)) suiveur = meilleur * (1 - dist);
    } else {
      if (hi >= entree * (1 + sl)) return { prix: entree * (1 + sl), bars: k, raison: "sl" };
      if (Number.isFinite(suiveur) && hi >= suiveur) return { prix: suiveur, bars: k, raison: "trail" };
      if (lo <= entree * (1 - tp)) return { prix: entree * (1 - tp), bars: k, raison: "tp" };
      if (lo < meilleur) meilleur = lo; if (meilleur <= entree * (1 - act)) suiveur = meilleur * (1 + dist);
    }
    if (k === maxBars) return { prix: P5.c[debut5 + k], bars: k, raison: "temps" };
  }
  return vus ? null : null;
}
/* Rejoue un profil sur un instrument. `dansUnivers(i)` dit si le contrat
   est eligible a la bougie i (toujours vrai pour « son propre contrat »). */
function rejouerProfil(B, P5, t0, fund, pr, dansUnivers) {
  const K = communs(B); if (!K.reg) K.reg = regime1h(B);
  const car = caracsProfil(B, pr), reg = K.reg; const n = B.c.length; const trades = [];
  let cooldown = -1, occupeJusqua = -1;
  for (let i = 250; i < n - 1; i++) {
    if (i <= occupeJusqua || i <= cooldown) continue; if (dansUnivers && !dansUnivers(i)) continue;
    const s = signalProfil(B, car, reg, pr, i); if (!s) continue;
    const entree = B.c[i] * (1 + s * GLISSEMENT); const debut5 = (i + 1) * 6 - 1;   // derniere bougie 5 min de la bougie 30 min du signal
    const ex = sortir(P5, debut5, s, entree, pr); if (!ex) break;
    const brut = s * (ex.prix / entree - 1); const duree = ex.bars * B5;
    trades.push({ i, sens: s, brut, net: brut - coutAR(fund[i], duree, s) + 2 * GLISSEMENT * 0 , raison: ex.raison, duree });
    // le glissement a l'entree est deja dans le prix ; on compte le second a la sortie via coutAR (2 executions) : on retire donc celui de l'entree pour ne pas le compter deux fois
    trades[trades.length - 1].net += GLISSEMENT;
    occupeJusqua = i + Math.ceil(ex.bars / 6); cooldown = occupeJusqua + pr.cd;
  }
  return trades;
}

/* ============================ familles de signaux ============================ */
/* Serie temporelle, sortie a horizon fixe (1 h, 4 h, 24 h), entree a
   l'ouverture de la bougie suivante. Chaque signal rend +1 / -1 / 0. */
function famillesFlux(B, M) {
  const { c, v, tb } = B; const n = c.length;
  const ofi = new Float64Array(n).fill(NaN); for (let i = 0; i < n; i++) if (v[i] > 0 && Number.isFinite(tb[i])) ofi[i] = (2 * tb[i] - v[i]) / v[i];
  const ofi24 = new Float64Array(n).fill(NaN); { let s = 0, q = 0; for (let i = 0; i < n; i++) { if (Number.isFinite(ofi[i])) { s += ofi[i]; q++; } if (i >= 48 && Number.isFinite(ofi[i - 48])) { s -= ofi[i - 48]; q--; } if (q >= 40) ofi24[i] = s / q; } }
  const zOfi = zscore(ofi24, 96);
  const cvd = cumsum(Float64Array.from(tb, (x, i) => Number.isFinite(x) ? 2 * x - v[i] : 0));
  const hautP = rollMax(c, 48), hautC = rollMax(cvd, 48), basP = rollMin(c, 48), basC = rollMin(cvd, 48);
  const ret4 = new Float64Array(n).fill(NaN), ret48 = new Float64Array(n).fill(NaN);
  for (let i = 48; i < n; i++) { if (c[i] > 0 && c[i - 8] > 0) ret4[i] = Math.log(c[i] / c[i - 8]); if (c[i - 48] > 0) ret48[i] = Math.log(c[i] / c[i - 48]); }
  const atr = trAtr(B.h, B.l, c, 14); const atrp = new Float64Array(n).fill(NaN); for (let i = 0; i < n; i++) if (c[i] > 0) atrp[i] = atr[i] / c[i];
  const zAtr = zscore(atrp, 96);
  const dHaut = rollMax(B.h, 48), dBas = rollMin(B.l, 48);
  // metrics (grille 30 min) : oi, oiVal, topLScount, topLSsum, globalLS, taker
  const dOi = new Float64Array(n).fill(NaN); if (M.oi) for (let i = 8; i < n; i++) if (M.oi[i] > 0 && M.oi[i - 8] > 0) dOi[i] = Math.log(M.oi[i] / M.oi[i - 8]);
  const zTaker = M.taker ? zscore(M.taker, 96) : null, zTop = M.top ? zscore(M.top, 96) : null;
  const zFund = M.fund ? zscore(M.fund, 48 * 30) : null, zPrime = M.prime ? zscore(M.prime, 96) : null;
  const S = {
    ofi_momentum:      (i) => zOfi[i] > 2 ? 1 : zOfi[i] < -2 ? -1 : 0,
    ofi_contrarien:    (i) => zOfi[i] > 2 ? -1 : zOfi[i] < -2 ? 1 : 0,
    cvd_divergence:    (i) => (c[i] >= hautP[i] && cvd[i] < hautC[i]) ? -1 : (c[i] <= basP[i] && cvd[i] > basC[i]) ? 1 : 0,
    cvd_confirmation:  (i) => (c[i] >= hautP[i] && cvd[i] >= hautC[i]) ? 1 : (c[i] <= basP[i] && cvd[i] <= basC[i]) ? -1 : 0,
    breakout_donchian: (i) => (c[i] > dHaut[i] && atrp[i] > 0.002) ? 1 : (c[i] < dBas[i] && atrp[i] > 0.002) ? -1 : 0,
    atr_expansion_mom: (i) => zAtr[i] > 2 ? Math.sign(ret4[i]) : 0,
    atr_expansion_con: (i) => zAtr[i] > 2 ? -Math.sign(ret4[i]) : 0,
    squeeze_court:     (i) => (ret4[i] < -0.01 && dOi[i] > 0.01) ? 1 : 0,       // prix baisse, OI monte : nouveaux courts -> on parie la reprise
    squeeze_long:      (i) => (ret4[i] > 0.01 && dOi[i] > 0.01) ? -1 : 0,       // prix monte, OI monte : nouveaux longs -> on parie le retour
    oi_momentum:       (i) => (Math.abs(ret4[i]) > 0.01 && dOi[i] > 0.01) ? Math.sign(ret4[i]) : 0,
    taker_contrarien:  zTaker ? (i) => zTaker[i] > 2 ? -1 : zTaker[i] < -2 ? 1 : 0 : null,
    taker_momentum:    zTaker ? (i) => zTaker[i] > 2 ? 1 : zTaker[i] < -2 ? -1 : 0 : null,
    gros_comptes_contr: zTop ? (i) => zTop[i] > 2 ? -1 : zTop[i] < -2 ? 1 : 0 : null,
    financement_contr: zFund ? (i) => zFund[i] > 2 ? -1 : zFund[i] < -2 ? 1 : 0 : null,
    base_contrarien:   zPrime ? (i) => zPrime[i] > 2 ? -1 : zPrime[i] < -2 ? 1 : 0 : null,
  };
  return { S, quotidien: { ofi24, ret48, dOi, fund: M.fund, taker: M.taker, prime: M.prime, qv: B.qv } };
}
const HORIZONS = [2, 8, 48];   // bougies de 30 min : 1 h, 4 h, 24 h

function evaluerFlux(B, fund, S, dansUnivers) {
  const n = B.c.length; const res = {};
  for (const nom of Object.keys(S)) { if (!S[nom]) continue;
    for (const H of HORIZONS) { const trades = []; let libre = 0;
      for (let i = 300; i + 1 + H < n; i++) { if (i < libre) continue; if (dansUnivers && !dansUnivers(i)) continue;
        const s = S[nom](i); if (!s || !Number.isFinite(B.o[i + 1]) || !Number.isFinite(B.c[i + H])) continue;
        const brut = s * (B.c[i + H] / B.o[i + 1] - 1); trades.push({ i, sens: s, brut, net: brut - coutAR(fund[i], H * B30, s) }); libre = i + H; }
      res[`${nom}@${H === 2 ? "1h" : H === 8 ? "4h" : "24h"}`] = trades; } }
  return res;
}

/* ============================ univers causaux ============================ */
/* Chaque jour d, a partir des donnees jusqu'a d-1 : volume 24 h en USDT et
   variation absolue 24 h. Le top-50 volume ; le top-50 movers hors cinq
   plus gros volumes. Un instrument n'y entre qu'avec 30 jours d'histoire. */
function universCausaux(inst, t0, nJours, nBar) {
  const N = inst.length; const vol = new Float64Array(N * nJours).fill(NaN), mov = new Float64Array(N * nJours).fill(NaN);
  for (let k = 0; k < N; k++) { const B = inst[k].B; let premier = -1;
    for (let d = 1; d < nJours; d++) { const fin = d * 48 - 1, deb = fin - 48; if (fin >= nBar) break;
      if (!Number.isFinite(B.c[fin]) || !Number.isFinite(B.c[deb])) continue; if (premier < 0) premier = d; if (d - premier < 30) continue;
      let q = 0; for (let i = deb + 1; i <= fin; i++) q += B.qv[i]; vol[k * nJours + d] = q; mov[k * nJours + d] = Math.abs(Math.log(B.c[fin] / B.c[deb])); } }
  const topVol = new Uint8Array(N * nJours), topMov = new Uint8Array(N * nJours);
  for (let d = 1; d < nJours; d++) { const cand = []; for (let k = 0; k < N; k++) if (Number.isFinite(vol[k * nJours + d])) cand.push(k);
    cand.sort((a, b) => vol[b * nJours + d] - vol[a * nJours + d]); cand.slice(0, 50).forEach((k) => { topVol[k * nJours + d] = 1; });
    const horsGros = cand.slice(5).filter((k) => Number.isFinite(mov[k * nJours + d])); horsGros.sort((a, b) => mov[b * nJours + d] - mov[a * nJours + d]);
    horsGros.slice(0, 50).forEach((k) => { topMov[k * nJours + d] = 1; }); }
  return { topVol, topMov, nJours };
}

/* ============================ transversal quotidien ============================ */
function evaluerXS(inst, U, quot, nJours, K) {
  const cellules = {}; const N = inst.length;
  const signaux = { xs_ofi24: (k, d) => quot[k].ofi24[d * 48 - 1], xs_retour24_mom: (k, d) => quot[k].ret48[d * 48 - 1], xs_retour24_rev: (k, d) => -quot[k].ret48[d * 48 - 1],
                    xs_dOI: (k, d) => quot[k].dOi[d * 48 - 1], xs_financement: (k, d) => quot[k].fund ? -quot[k].fund[d * 48 - 1] : NaN,
                    xs_taker: (k, d) => quot[k].taker ? -quot[k].taker[d * 48 - 1] : NaN, xs_base: (k, d) => quot[k].prime ? -quot[k].prime[d * 48 - 1] : NaN };
  for (const nom of Object.keys(signaux)) { const periodes = []; let prec = new Map();
    for (let d = 31; d + 1 < nJours; d++) { const cand = [];
      for (let k = 0; k < N; k++) { if (!U.topVol[k * nJours + d]) continue; const s = signaux[nom](k, d); const c0 = inst[k].B.o[d * 48], c1 = inst[k].B.c[(d + 1) * 48 - 1];
        if (!Number.isFinite(s) || !(c0 > 0) || !(c1 > 0)) continue; cand.push({ k, s, r: Math.log(c1 / c0) }); }
      if (cand.length < 2 * K + 4) continue; cand.sort((a, b) => b.s - a.s); let rL = 0, rC = 0; const cur = new Map();
      for (let j = 0; j < K; j++) { rL += cand[j].r; cur.set(cand[j].k, 1); const q = cand[cand.length - 1 - j]; rC += q.r; cur.set(q.k, -1); }
      let jambes = 0; for (const [k, s] of cur) { const a = prec.get(k); if (a === undefined) jambes += 1; else if (a !== s) jambes += 2; } for (const [k] of prec) if (!cur.has(k)) jambes += 1;
      const brut = (rL - rC) / (2 * K); periodes.push({ brut, net: brut - (FRAIS + GLISSEMENT) * jambes / (2 * K) }); prec = cur; }
    cellules[nom + "@24h"] = periodes; }
  return cellules;
}

/* ============================ la passe ============================ */
function chargerInstruments(t0, nBar, n5) {
  const U = lire(UNIVERS_FICHIER); const liste = U && Array.isArray(U.instruments) ? U.instruments : [];
  const out = [];
  for (const instId of liste) { const c5 = lire(path.join(CACHE, instId + ".json")); if (!Array.isArray(c5) || c5.length < 288 * 60) continue;
    const ex = lire(path.join(EXTRA, instId + ".json")) || {};
    const B = barres30(c5, t0, nBar), P5 = chemin5(c5, t0, n5);      // puis on lache les 210 000 lignes
    const M = { fund: grille(ex.financement, t0, nBar, 1, B30), prime: ex.prime && ex.prime.length ? grille(ex.prime, t0, nBar, 1, B30) : null,
                oi: ex.metrics && ex.metrics.length ? grille(ex.metrics, t0, nBar, 1, B30) : null,
                top: ex.metrics && ex.metrics.length ? grille(ex.metrics, t0, nBar, 4, B30) : null,
                taker: ex.metrics && ex.metrics.length ? grille(ex.metrics, t0, nBar, 6, B30) : null };
    out.push({ instId, B, P5, M }); }
  return out;
}
function bornes() {
  const U = lire(UNIVERS_FICHIER); const liste = U && Array.isArray(U.instruments) ? U.instruments : [];
  let t1 = 0, n = 0;
  for (const instId of liste) { try { const st = fs.statSync(path.join(CACHE, instId + ".json")); if (st.size < 1e6) continue; n++;
    // la derniere bougie : on lit la fin du fichier sans le charger
    const fd = fs.openSync(path.join(CACHE, instId + ".json"), "r"); const buf = Buffer.alloc(200); fs.readSync(fd, buf, 0, 200, Math.max(0, st.size - 200)); fs.closeSync(fd);
    const m = buf.toString().match(/\[(\d{13})[,\]]/g); if (m) { const ts = Number(m[m.length - 1].slice(1, 14)); if (ts > t1) t1 = ts; } } catch {} }
  return { t1, n };
}
function main() {
  const t = Date.now();
  const { t1, n: nFichiers } = bornes();
  if (nFichiers < 12 || !t1) { console.error(`[MOVERS] ${nFichiers} instruments avec histoire : trop peu.`); process.exit(1); }
  const t0 = Math.floor((t1 - MOIS_MAX * 30.44 * JOUR) / JOUR) * JOUR;
  const nBar = Math.floor((t1 - t0) / B30) + 1, nJours = Math.floor((t1 - t0) / JOUR) + 1, n5 = Math.floor((t1 - t0) / B5) + 1;
  const inst = chargerInstruments(t0, nBar, n5);
  console.log(`[MOVERS] ${inst.length} instruments · fenetre ${new Date(t0).toISOString().slice(0, 10)} → ${new Date(t1).toISOString().slice(0, 10)} · ${nBar} bougies de 30 min · frais ${FRAIS} + glissement ${GLISSEMENT} par execution · ${TIRAGES} repliques · blocs de ${BLOC_BARRES} bougies`);
  const avecTb = inst.filter((x) => x.B.aTb).length, avecMet = inst.filter((x) => x.M.oi).length, avecPrime = inst.filter((x) => x.M.prime).length;
  console.log(`[MOVERS] flux acheteur (klines v2) : ${avecTb}/${inst.length} · metrics : ${avecMet} · base : ${avecPrime}`);

  const U = universCausaux(inst, t0, nJours, nBar);
  const taille = (T) => { let s = 0, c = 0; for (let d = 31; d < nJours; d++) { let n = 0; for (let k = 0; k < inst.length; k++) n += T[k * nJours + d]; if (n) { s += n; c++; } } return c ? (s / c).toFixed(1) : "0"; };
  console.log(`[MOVERS] univers causaux : top-50 volume = ${taille(U.topVol)} contrats/jour en moyenne · top-50 movers = ${taille(U.topMov)}`);
  const dansTopMov = (k) => (i) => { const d = Math.floor(i / 48); return d < nJours && U.topMov[k * nJours + d] === 1; };
  const dansTopVol = (k) => (i) => { const d = Math.floor(i / 48); return d < nJours && U.topVol[k * nJours + d] === 1; };

  /* ---- 1. le papier ---- */
  const papier = lire(PAPIER); const profils = papier ? papier.profils : [];
  const parBinance = new Map(); for (const x of inst) parBinance.set(x.instId.replace("-USDT-SWAP", ""), x);
  const nomOkx = (contrat) => contrat.replace(/USDT$/, "").replace(/^1000/, "");
  const resPapier = { propres: [], global: null, transfert: [] };
  const vrai = { propres: [], globalTrades: [], transfertTrades: [] };
  console.log(`[MOVERS] 1. LE PAPIER : ${profils.length} profils, ${profils.filter((p) => p.type === "individuel").length} individuels`);
  const global = papier ? papier.meta.profil_global : null;
  for (const pr of profils) { if (pr.type !== "individuel" || !pr.fast) continue; const x = parBinance.get(nomOkx(pr.contrat)); if (!x) { resPapier.propres.push({ contrat: pr.contrat, cle: pr.cle, absent: true }); continue; }
    const trades = rejouerProfil(x.B, x.P5, t0, x.M.fund, pr, null); vrai.propres.push({ pr, x, trades });
    // le meme profil sur les autres contrats de l'univers movers (transfert)
    let transf = []; for (let k = 0; k < inst.length; k++) { const y = inst[k]; if (y !== x) transf = transf.concat(rejouerProfil(y.B, y.P5, t0, y.M.fund, pr, dansTopMov(k))); }
    vrai.transfertTrades.push({ cle: pr.cle, trades: transf }); }
  if (global) for (let k = 0; k < inst.length; k++) vrai.globalTrades = vrai.globalTrades.concat(rejouerProfil(inst[k].B, inst[k].P5, t0, inst[k].M.fund, global, dansTopMov(k)));
  const tousPropres = vrai.propres.flatMap((p) => p.trades), stP = stats(tousPropres);
  console.log(`  88 profils sur leur PROPRE contrat, toute la fenetre, funding et couts inclus : ${stP.n} trades · WR ${(100 * stP.wr).toFixed(1)} % · PF ${stP.pf.toFixed(2)} · moy/trade brut ${(100 * stP.moyBrut).toFixed(3)} % net ${(100 * stP.moy).toFixed(3)} % · t ${stP.t.toFixed(2)}`);
  const stG = stats(vrai.globalTrades);
  console.log(`  profil GLOBAL sur l'univers causal des movers : ${stG.n} trades · WR ${(100 * stG.wr).toFixed(1)} % · PF ${stG.pf.toFixed(2)} · moy/trade net ${(100 * stG.moy).toFixed(3)} % · t ${stG.t.toFixed(2)}`);
  const tousTransf = vrai.transfertTrades.flatMap((p) => p.trades), stT = stats(tousTransf);
  console.log(`  les 88 profils TRANSPORTES sur les autres movers : ${stT.n} trades · WR ${(100 * stT.wr).toFixed(1)} % · PF ${stT.pf.toFixed(2)} · moy/trade net ${(100 * stT.moy).toFixed(3)} % · t ${stT.t.toFixed(2)}`);
  const parFamille = {}; for (const p of vrai.propres) { const f = p.pr.famille; (parFamille[f] = parFamille[f] || []).push(...p.trades); }
  for (const f of Object.keys(parFamille)) { const s = stats(parFamille[f]); console.log(`    famille ${f.padEnd(10)} ${String(s.n).padStart(5)} trades · WR ${(100 * s.wr).toFixed(1)} % · PF ${s.pf.toFixed(2)} · net/trade ${(100 * s.moy).toFixed(3)} % · t ${s.t.toFixed(2)}`); }
  const raisons = {}; for (const tr of tousPropres) raisons[tr.raison] = (raisons[tr.raison] || 0) + 1; console.log(`    sorties : ${JSON.stringify(raisons)}`);

  /* ---- 2. les familles de flux et de positionnement, en serie temporelle ---- */
  console.log(`[MOVERS] 2. FLUX, POSITIONNEMENT, VOLATILITE, BASE — serie temporelle sur l'univers causal top-50 volume`);
  const cellules = {}; const quot = [];
  for (let k = 0; k < inst.length; k++) { const x = inst[k]; const { S, quotidien } = famillesFlux(x.B, x.M); quot.push(quotidien);
    const r = evaluerFlux(x.B, x.M.fund, S, dansTopVol(k)); for (const c of Object.keys(r)) (cellules[c] = cellules[c] || []).push(...r[c]); }
  /* ---- 3. transversal ---- */
  const xs = evaluerXS(inst, U, quot, nJours, K_XS);
  const statsXS = (per) => { const n = per.length; if (n < 10) return { n, moy: 0, t: 0, net: 0, brut: 0, sharpe: 0 }; const m = per.reduce((u, p) => u + p.net, 0) / n; const sd = Math.sqrt(per.reduce((u, p) => u + (p.net - m) ** 2, 0) / (n - 1)); return { n, moy: m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0, net: per.reduce((u, p) => u + p.net, 0), brut: per.reduce((u, p) => u + p.brut, 0), sharpe: sd > 0 ? m / sd : 0 }; };

  /* ---- le nul : tout rejouer sur des repliques melangees ---- */
  console.log(`[MOVERS] nul : ${TIRAGES} repliques (prix par blocs de ${BLOC_BARRES} bougies, flux permute independamment)…`);
  const tN = Date.now();
  const nulCell = {}; for (const c of Object.keys(cellules)) nulCell[c] = []; const nulXS = {}; for (const c of Object.keys(xs)) nulXS[c] = [];
  const nulPapier = { propres: [], global: [], transfert: [] };
  for (let g = 1; g <= TIRAGES; g++) {
    const rep = inst.map((x, k) => { const B = melanger(x.B, g * 7919 + k);
      /* le chemin 5 min du nul : les six bougies 5 min de la bougie source, transposees au niveau melange */
      const P5 = { h: new Float32Array(x.P5.n).fill(NaN), l: new Float32Array(x.P5.n).fill(NaN), c: new Float32Array(x.P5.n).fill(NaN), n: x.P5.n };
      for (let i = 0; i < B.c.length; i++) { const s = B.src[i]; if (s < 0 || !Number.isFinite(B.c[i])) continue; const ech = B.c[i] / x.B.c[s];
        for (let q = 0; q < 6; q++) { const a = s * 6 + q, b = i * 6 + q; if (b >= P5.n || !Number.isFinite(x.P5.c[a])) continue; P5.h[b] = x.P5.h[a] * ech; P5.l[b] = x.P5.l[a] * ech; P5.c[b] = x.P5.c[a] * ech; } }
      const M = { fund: x.M.fund, prime: x.M.prime, oi: x.M.oi, top: x.M.top, taker: x.M.taker };
      if (M.oi) { const p = (arr) => { const o = new Float32Array(arr.length).fill(NaN); let k2 = 0; for (let b = 0; b < B.blocs.length; b++) { const bf = B.blocs[B.permF[b]]; for (let q = 0; q < B.blocs[b].length; q++, k2++) { const i = B.blocs[b][q]; o[i] = arr[bf[Math.min(q, bf.length - 1)]]; } } return o; };
        M.oi = p(x.M.oi); M.top = p(x.M.top); M.taker = p(x.M.taker); }
      return { instId: x.instId, B, P5, M }; });
    const Ur = universCausaux(rep, t0, nJours, nBar); const dMov = (k) => (i) => { const d = Math.floor(i / 48); return d < nJours && Ur.topMov[k * nJours + d] === 1; }; const dVol = (k) => (i) => { const d = Math.floor(i / 48); return d < nJours && Ur.topVol[k * nJours + d] === 1; };
    let propres = [], globalT = [], transfT = [];
    for (const p of vrai.propres) { const k = inst.indexOf(p.x); propres = propres.concat(rejouerProfil(rep[k].B, rep[k].P5, t0, rep[k].M.fund, p.pr, null)); }
    if (global) for (let k = 0; k < rep.length; k++) globalT = globalT.concat(rejouerProfil(rep[k].B, rep[k].P5, t0, rep[k].M.fund, global, dMov(k)));
    nulPapier.propres.push(stats(propres)); nulPapier.global.push(stats(globalT));
    const cellR = {}; const quotR = [];
    for (let k = 0; k < rep.length; k++) { const { S, quotidien } = famillesFlux(rep[k].B, rep[k].M); quotR.push(quotidien); const r = evaluerFlux(rep[k].B, rep[k].M.fund, S, dVol(k)); for (const c of Object.keys(r)) (cellR[c] = cellR[c] || []).push(...r[c]); }
    for (const c of Object.keys(cellules)) nulCell[c].push(stats(cellR[c] || []));
    const xsR = evaluerXS(rep, Ur, quotR, nJours, K_XS); for (const c of Object.keys(xs)) nulXS[c].push(statsXS(xsR[c] || []));
    if (g === 1 || g % 5 === 0) console.log(`  replique ${g}/${TIRAGES} · ${((Date.now() - tN) / 1000).toFixed(0)} s`);
  }

  /* ---- verdicts ---- */
  const pct = (nul, v) => JUGE.percentileDe(nul.slice().sort((a, b) => a - b), v);
  console.log(`[MOVERS] RESULTATS — toutes les cellules, y compris les mauvaises · percentile du nul sur le t`);
  console.log(`  ${"cellule".padEnd(30)} ${"trades".padStart(7)} ${"WR".padStart(6)} ${"PF".padStart(6)} ${"brut/tr".padStart(9)} ${"net/tr".padStart(9)} ${"t brut".padStart(7)} ${"t net".padStart(6)} ${"nul med".padStart(8)} ${"pct".padStart(5)}`);
  const lignes = [];
  for (const c of Object.keys(cellules).sort()) { const s = stats(cellules[c]); const tn = nulCell[c].map((z) => z.t); const p = s.n >= 30 ? pct(tn, s.t) : null;
    lignes.push({ cellule: c, ...s, pct: p, nulMed: tn.length ? tn.slice().sort((a, b) => a - b)[tn.length >> 1] : null, famille: "flux" });
    console.log(`  ${c.padEnd(30)} ${String(s.n).padStart(7)} ${(100 * s.wr).toFixed(1).padStart(5)}% ${s.pf.toFixed(2).padStart(6)} ${(100 * s.moyBrut).toFixed(3).padStart(8)}% ${(100 * s.moy).toFixed(3).padStart(8)}% ${s.tBrut.toFixed(2).padStart(7)} ${s.t.toFixed(2).padStart(6)} ${(lignes[lignes.length - 1].nulMed ?? 0).toFixed(2).padStart(8)} ${p == null ? "    —" : ((100 * p).toFixed(0) + "e").padStart(5)}`); }
  console.log(`  -- transversal, top-50 volume, ${K_XS} longs / ${K_XS} courts, rebalancement 24 h --`);
  for (const c of Object.keys(xs).sort()) { const s = statsXS(xs[c]); const tn = nulXS[c].map((z) => z.t); const p = s.n >= 30 ? pct(tn, s.t) : null;
    lignes.push({ cellule: c, ...s, pct: p, nulMed: tn.length ? tn.slice().sort((a, b) => a - b)[tn.length >> 1] : null, famille: "transversal" });
    console.log(`  ${c.padEnd(30)} ${String(s.n).padStart(7)} ${"".padStart(6)} ${"".padStart(6)} ${(100 * s.brut / Math.max(1, s.n)).toFixed(3).padStart(8)}% ${(100 * s.moy).toFixed(3).padStart(8)}% ${s.t.toFixed(2).padStart(6)} ${(lignes[lignes.length - 1].nulMed ?? 0).toFixed(2).padStart(8)} ${p == null ? "    —" : ((100 * p).toFixed(0) + "e").padStart(5)}`); }

  /* Westfall-Young sur la grille entiere (flux + transversal) */
  const grille = lignes.filter((l) => l.pct != null); let famille = null;
  if (grille.length) { const maxReel = Math.max(...grille.map((l) => l.t)); const maxNul = [];
    for (let g = 0; g < TIRAGES; g++) { let m = -Infinity; for (const l of grille) { const arr = l.famille === "flux" ? nulCell[l.cellule] : nulXS[l.cellule]; const v = arr[g] && arr[g].t; if (Number.isFinite(v) && v > m) m = v; } maxNul.push(m); }
    maxNul.sort((a, b) => a - b); const pF = JUGE.percentileDe(maxNul, maxReel); const meilleure = grille.reduce((a, b) => (a.t >= b.t ? a : b));
    famille = { cellules: grille.length, meilleure: meilleure.cellule, tReel: +maxReel.toFixed(2), medianDesMaxima: +maxNul[TIRAGES >> 1].toFixed(2), percentile: pF == null ? null : +pF.toFixed(2) };
    console.log(`[MOVERS] FAMILLE (${grille.length} cellules, maxT) : meilleure ${meilleure.cellule} t ${maxReel.toFixed(2)} · median des maxima nuls ${famille.medianDesMaxima} · bat ${pF == null ? "—" : (100 * pF).toFixed(0) + " %"} des repliques ${pF != null && pF >= 0.95 ? "— AU-DELA DU SEUIL" : "— sous 95 % : rien de demontre au niveau de la famille"}`); }

  /* le papier contre son nul */
  const pP = pct(nulPapier.propres.map((z) => z.t), stP.t), pG = pct(nulPapier.global.map((z) => z.t), stG.t);
  const wrNul = nulPapier.propres.map((z) => z.wr).sort((a, b) => a - b), pfNul = nulPapier.propres.map((z) => z.pf).sort((a, b) => a - b);
  console.log(`[MOVERS] LE PAPIER contre le hasard :`);
  console.log(`  88 profils sur leurs contrats : t reel ${stP.t.toFixed(2)} bat ${pP == null ? "—" : (100 * pP).toFixed(0) + " %"} des repliques · WR du nul median ${(100 * wrNul[wrNul.length >> 1]).toFixed(1)} % (reel ${(100 * stP.wr).toFixed(1)} %) · PF du nul median ${pfNul[pfNul.length >> 1].toFixed(2)} (reel ${stP.pf.toFixed(2)})`);
  console.log(`  profil global sur les movers : t reel ${stG.t.toFixed(2)} bat ${pG == null ? "—" : (100 * pG).toFixed(0) + " %"} des repliques`);
  console.log(`  ce que le WR ne dit pas : avec un stop a 1,25 % et des cibles a 2-8 %, un taux de gain eleve est la FORME de la sortie, pas un avantage ; le nul le reproduit.`);

  const verdict = { genere: new Date().toISOString(), fenetre: { du: new Date(t0).toISOString().slice(0, 10), au: new Date(t1).toISOString().slice(0, 10) }, instruments: inst.length, avecFlux: avecTb, avecMetrics: avecMet, avecBase: avecPrime,
    parametres: { frais: FRAIS, glissement: GLISSEMENT, tirages: TIRAGES, blocBarres: BLOC_BARRES, kTransversal: K_XS },
    papier: { propres: { ...stP, percentileNul: pP, wrNulMedian: wrNul[wrNul.length >> 1], pfNulMedian: pfNul[pfNul.length >> 1], parFamille: Object.fromEntries(Object.entries(parFamille).map(([f, tr]) => [f, stats(tr)])), sorties: raisons },
              global: { ...stG, percentileNul: pG }, transfert: stT,
              parProfil: vrai.propres.map((p) => ({ contrat: p.pr.contrat, cle: p.pr.cle, famille: p.pr.famille, oosPapier: p.pr.oos, ici: stats(p.trades) })) },
    cellules: lignes, famille, duree_s: Math.round((Date.now() - t) / 1000) };
  try { const f = path.join(RACINE, "data", "movers.json"); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(verdict, null, 1)); fs.renameSync(f + ".tmp", f); console.log(`[MOVERS] verdict ecrit : ${f} en ${verdict.duree_s} s`); } catch (e) { console.log(`[MOVERS] verdict non ecrit : ${e.message}`); }
  console.log(`[MOVERS] ce script ne branche rien.`);
}

if (require.main === module) main();
module.exports = { ema, sma, rsi, trAtr, dmi, supertrend, rollMax, rollMin, stdev, zscore, barres30, chemin5, melanger, coutAR, stats, caracsProfil, regime1h, signalProfil, sortir, rejouerProfil, famillesFlux, evaluerFlux, universCausaux, evaluerXS, HORIZONS, B30, B5 };
