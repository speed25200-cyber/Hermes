/* ============================================================================
   Les signaux HERMES — la bibliothèque UNIQUE.

   Ces fonctions étaient écrites dans app/main.js, au cœur du moteur. Elles en
   sont extraites pour une raison qui n'est pas du rangement : le chercheur de
   perles doit évaluer EXACTEMENT ce que le moteur tradera. Deux copies d'un
   indicateur divergent toujours — un arrondi, un décalage d'indice — et l'on
   se retrouve à sélectionner une stratégie sur une formule et à en trader une
   autre. Une seule source, deux consommateurs : l'écart est impossible par
   construction.

   Tout est pur : des tableaux de bougies entrent, une direction sort.
   Une bougie est [ts, open, high, low, close, volume], la série est
   ascendante (la plus ancienne d'abord) et ne contient QUE des bougies
   closes. La seule mémoire nécessaire — « ai-je déjà signalé cette bougie
   15 m » — est portée par l'appelant via le paramètre etat, jamais par le
   module : un backtest qui rejoue l'histoire ne doit pas hériter de la
   mémoire du backtest précédent.
   ============================================================================ */
"use strict";

function rsi14(closes) {
  const p = 14;
  if (closes.length < p + 2) return null;
  let g = 0, pr = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else pr -= d; }
  g /= p; pr /= p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
  }
  return 100 - 100 / (1 + g / (pr || 1e-12));
}

function zScore(closes, p) {
  if (closes.length < p) return null;
  const w = closes.slice(-p);
  const m = w.reduce((a, b) => a + b, 0) / p;
  const sd = Math.sqrt(Math.max(0, w.reduce((a, b) => a + (b - m) * (b - m), 0) / p));
  return sd > 0 ? (closes[closes.length - 1] - m) / sd : null;
}

function runLen(closes) {
  let run = 0, sgn = 0;
  for (let i = closes.length - 1; i > 0; i--) {
    const d = Math.sign(closes[i] - closes[i - 1]);
    if (d === 0) break;
    if (sgn === 0) { sgn = d; run = 1; }
    else if (d === sgn) run++;
    else break;
  }
  return { run, sgn };
}

/* Position du close dans le range des 288 dernières bougies (24 h). */
function rangePos24h(c5) {
  const n = c5.length;
  if (n < 288) return null;
  let hh = -Infinity, ll = Infinity;
  for (let k = n - 288; k < n; k++) { if (c5[k][2] > hh) hh = c5[k][2]; if (c5[k][3] < ll) ll = c5[k][3]; }
  return hh > ll ? (c5[n - 1][4] - ll) / (hh - ll) : 0.5;
}

/* Canal de Keltner EMA20 ± mult×ATR10 (Wilder) — dernier ET avant-dernier point. */
function keltnerLast2(c5, mult) {
  const n = c5.length;
  if (n < 60) return null;
  let ema = c5[0][4], atr = null, prevC = c5[0][4];
  const kE = 2 / 21;
  let out1 = null, out2 = null;
  for (let i = 1; i < n; i++) {
    const h = c5[i][2], l = c5[i][3], c = c5[i][4];
    const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    atr = atr === null ? tr : (atr * 9 + tr) / 10;
    ema = ema + kE * (c - ema);
    prevC = c;
    if (i === n - 2) out2 = { upper: ema + mult * atr, lower: ema - mult * atr };
    if (i === n - 1) out1 = { upper: ema + mult * atr, lower: ema - mult * atr };
  }
  return { last: out1, prev: out2 };
}

/* Les noms de signaux que le moteur sait évaluer. Le chercheur s'en sert
   comme grille : tout nom ici est testable, tout nom testé est tradable. */
const SIGNAUX = ["rsi5m", "z48_5m", "run5_5m", "rsi_regime", "meche_regime",
                 "keltner3", "donchian_fade", "roc_vol", "bb_range",
                 "vwap_reclaim", "double_extreme", "meche5m", "meche15m"];

/* Évalue un signal sur une série de bougies 5 m closes.
     sig   : un nom de SIGNAUX
     c5    : bougies ascendantes [[ts,o,h,l,c,v],...]
     etat  : objet possédé par l'appelant ; seul meche15m y écrit
             (etat.lastClosed15 = ts de la dernière 15 m signalée)
   Retour : 1 long, -1 short, 0 rien. */
function evalSignal(sig, c5, etat) {
  etat = etat || {};
  const closes = c5.map(x => x[4]);
  if (sig === "rsi5m") {
    const r = rsi14(closes.slice(-60));
    if (r == null) return 0;
    return r < 25 ? 1 : (r > 75 ? -1 : 0);
  }
  if (sig === "z48_5m") {
    const z = zScore(closes, 48);
    if (z == null) return 0;
    return z > 2.5 ? -1 : (z < -2.5 ? 1 : 0);
  }
  if (sig === "run5_5m") {
    const { run, sgn } = runLen(closes.slice(-12));
    return (run >= 5 && sgn !== 0) ? -sgn : 0;
  }
  if (sig === "rsi_regime") {           // ENSO v2 : RSI extrême + moitié favorable du range 24h
    const r = rsi14(closes.slice(-60));
    const pos = rangePos24h(c5);
    if (r == null || pos == null) return 0;
    if (r < 25 && pos < 0.5) return 1;
    if (r > 75 && pos > 0.5) return -1;
    return 0;
  }
  if (sig === "meche_regime") {         // GPS gen_regime_3 : mèche 60% + vol 2x + moitié favorable
    const n = c5.length - 1;
    if (n < 288 + 1) return 0;
    const [, o, h, l, cl, v] = c5[n];
    const range = h - l;
    if (!(range > 0)) return 0;
    let vs = 0; for (let k = n - 20; k < n; k++) vs += c5[k][5];
    vs /= 20;
    if (!(vs > 0)) return 0;
    const pos = rangePos24h(c5);
    if (pos == null) return 0;
    const wLo = (Math.min(o, cl) - l) / range, wHi = (h - Math.max(o, cl)) / range, vm = v / vs;
    if (wLo >= 0.6 && vm >= 2 && pos < 0.5) return 1;
    if (wHi >= 0.6 && vm >= 2 && pos > 0.5) return -1;
    return 0;
  }
  if (sig === "keltner3") {             // reclaim du canal EMA20±3ATR10
    const kc = keltnerLast2(c5, 3);
    if (!kc || !kc.last || !kc.prev) return 0;
    const n = c5.length - 1;
    const cNow = c5[n][4], cPrev = c5[n - 1][4];
    if (cPrev < kc.prev.lower && cNow > kc.last.lower) return 1;
    if (cPrev > kc.prev.upper && cNow < kc.last.upper) return -1;
    return 0;
  }
  if (sig === "donchian_fade") {        // compression Donchian (P15 sur 288) puis fade de la 1re cassure
    const n = c5.length - 1, N_DON = 20;
    if (n < N_DON + 250) return 0;
    const width = [];
    for (let i = N_DON; i <= n; i++) {
      let mx = -Infinity, mn = Infinity;
      for (let k = i - N_DON; k < i; k++) { if (c5[k][2] > mx) mx = c5[k][2]; if (c5[k][3] < mn) mn = c5[k][3]; }
      width.push({ i, w: (mx - mn) / c5[i][4], hi: mx, lo: mn });
    }
    const prev = width[width.length - 2];            // compression mesurée AVANT la cassure
    if (!prev) return 0;
    let below = 0, cnt = 0;
    for (let k = Math.max(0, width.length - 2 - 288); k < width.length - 2; k++) { cnt++; if (width[k].w <= prev.w) below++; }
    if (cnt < 200 || (100 * below / cnt) > 15) return 0;
    if (c5[n][4] > prev.hi) return -1;               // cassure haussière d'un canal compressé -> fade short
    if (c5[n][4] < prev.lo) return 1;
    return 0;
  }
  if (sig === "roc_vol") {              // ROC12 étiré + volume >= 2,5x médiane 24h -> fade
    const n = c5.length - 1;
    if (n < 288) return 0;
    const rc = (c5[n][4] / c5[n - 12][4] - 1) * 100;
    const vols = [];
    for (let k = n - 287; k <= n; k++) vols.push(c5[k][5]);
    vols.sort((a, b) => a - b);
    const med = vols.length % 2 ? vols[vols.length >> 1] : (vols[(vols.length >> 1) - 1] + vols[vols.length >> 1]) / 2;
    if (!(med > 0) || c5[n][5] / med < 2.5) return 0;
    const bull = c5[n][4] > c5[n][1];
    if (rc < -1.5 && !bull) return 1;
    if (rc > 1.5 && bull) return -1;
    return 0;
  }
  if (sig === "bb_range") {             // reclaim des bandes Bollinger + dixième extrême du range 24h
    const n = c5.length - 1;
    if (n < 288) return 0;
    function pctB(i) {
      let s = 0, s2 = 0;
      for (let k = i - 19; k <= i; k++) { s += c5[k][4]; s2 += c5[k][4] * c5[k][4]; }
      const m = s / 20, sd = Math.sqrt(Math.max(0, s2 / 20 - m * m));
      const up = m + 2 * sd, lo = m - 2 * sd;
      if (up <= lo) return null;
      return (c5[i][4] - lo) / (up - lo);
    }
    const bNow = pctB(n), bPrev = pctB(n - 1);
    if (bNow == null || bPrev == null) return 0;
    const pos = rangePos24h(c5);
    if (pos == null) return 0;
    if (bPrev <= 0 && bNow > 0 && pos <= 0.10) return 1;
    if (bPrev >= 1 && bNow < 1 && pos >= 0.90) return -1;
    return 0;
  }
  if (sig === "vwap_reclaim") {         // reclaim de bande VWAP session ±2σ + bougie de reprise
    const n = c5.length - 1, DAY = 86400000, WARM = 36, K = 2;
    if (n < 101) return 0;
    let day = -1, cv = 0, cpv = 0, cpv2 = 0, k = 0;
    let wNow = null, sNow = null, wPrev = null, sPrev = null, bodNow = 0;
    for (let i = 0; i <= n; i++) {
      const d = Math.floor(c5[i][0] / DAY);
      if (d !== day) { day = d; cv = 0; cpv = 0; cpv2 = 0; k = 0; }
      const tp = (c5[i][2] + c5[i][3] + c5[i][4]) / 3, v = Math.max(c5[i][5], 0);
      cv += v; cpv += tp * v; cpv2 += tp * tp * v; k++;
      if (i === n - 1 && cv > 0) { const m = cpv / cv; wPrev = m; sPrev = Math.sqrt(Math.max(cpv2 / cv - m * m, 0)); }
      if (i === n) { bodNow = k; if (cv > 0) { const m = cpv / cv; wNow = m; sNow = Math.sqrt(Math.max(cpv2 / cv - m * m, 0)); } }
    }
    if (wNow == null || !(sNow > 0) || bodNow < WARM) return 0;
    if (wPrev == null || !(sPrev > 0)) return 0;
    const z = (c5[n][4] - wNow) / sNow, zPrev = (c5[n - 1][4] - wPrev) / sPrev;
    const oN = c5[n][1], clN = c5[n][4];
    if (zPrev <= -K && z > -K && z < 0 && clN > oN) return 1;
    if (zPrev >= K && z < K && z > 0 && clN < oN) return -1;
    return 0;
  }
  if (sig === "double_extreme") {       // double toucher d'un extrême 12h + rebond confirmé
    const n = c5.length - 1, W = 144, GAP = 12, TOL = 0.003, BOUNCE = 0.01;
    if (n < W + 2) return 0;
    let mn = Infinity, mx = -Infinity, iMn = -1, iMx = -1;
    for (let k = n - W; k <= n - GAP; k++) {
      if (c5[k][3] < mn) { mn = c5[k][3]; iMn = k; }
      if (c5[k][2] > mx) { mx = c5[k][2]; iMx = k; }
    }
    const o = c5[n][1], h = c5[n][2], l = c5[n][3], cl = c5[n][4];
    if (l >= mn * (1 - TOL) && l <= mn * (1 + TOL) && cl > o) {
      let rb = -Infinity;
      for (let k = iMn + 1; k < n; k++) if (c5[k][4] > rb) rb = c5[k][4];
      if (rb >= mn * (1 + BOUNCE)) return 1;
    }
    if (h <= mx * (1 + TOL) && h >= mx * (1 - TOL) && cl < o) {
      let rb = Infinity;
      for (let k = iMx + 1; k < n; k++) if (c5[k][4] < rb) rb = c5[k][4];
      if (rb <= mx * (1 - BOUNCE)) return -1;
    }
    return 0;
  }
  if (sig === "meche5m" || sig === "meche15m") {
    let serie = c5;
    if (sig === "meche15m") {
      // reconstitue les 15m alignées, ne signale qu'une fois par 15m close
      const q = [];
      for (let i = 0; i + 3 <= c5.length; ) {
        if ((c5[i][0] / 300000) % 3 !== 0) { i++; continue; }
        if (i + 3 > c5.length) break;
        const tri = c5.slice(i, i + 3);
        q.push([tri[0][0], tri[0][1], Math.max(...tri.map(x => x[2])), Math.min(...tri.map(x => x[3])), tri[2][4], tri.reduce((a, x) => a + x[5], 0)]);
        i += 3;
      }
      serie = q;
      if (!serie.length) return 0;
      if (etat.lastClosed15 === serie[serie.length - 1][0]) return 0;
      etat.lastClosed15 = serie[serie.length - 1][0];
    }
    if (serie.length < 32) return 0;
    const d = serie[serie.length - 1];
    const [, o, h, l, cl, v] = d;
    const corps = Math.abs(cl - o), haut = h - Math.max(o, cl), bas = Math.min(o, cl) - l;
    let mv = 0;
    for (let k = serie.length - 31; k < serie.length - 1; k++) mv += serie[k][5];
    mv /= 30;
    if (v > 2 * mv && haut > 2 * corps && haut > 0.004 * cl) return -1;
    if (v > 2 * mv && bas > 2 * corps && bas > 0.004 * cl) return 1;
    return 0;
  }

  /* ------------------------------------------------------------------
     LES SIGNAUX DE SUITE DE TENDANCE.

     Ils ne sont PAS dans la liste SIGNAUX par défaut : le moteur ne les
     jouera pas et le chercheur ne les testera pas tant que personne ne
     l'aura demandé explicitement. Ils existent pour une raison précise,
     et cette raison est une mesure.

     Le banc a rejoué le procédé de sélection sur douze mois, puis sur
     les mêmes douze mois avec l'ordre des journées mélangé. Mélanger
     détruit une seule chose : la continuation des tendances. Les treize
     signaux actuels — qui parient tous CONTRE le mouvement en cours —
     rapportent +0,0128 de marge par trade sur les données mélangées et
     −0,0012 sur le vrai marché. Ils réussissent mieux dans un monde
     sans tendances, ce qui est une façon mesurée de dire que les
     tendances du vrai marché sont ce qui les tue.

     Si cette lecture est juste, elle fait une prédiction vérifiable :
     des signaux qui SUIVENT le mouvement doivent se comporter à
     l'inverse — mieux sur le vrai marché que sur le mélange. La
     prédiction peut échouer, et c'est tout l'intérêt : ces six signaux
     sont l'expérience qui la teste.

     Cinq d'entre eux sont l'inversion exacte d'un signal existant, pour
     que la comparaison ne porte que sur le SENS du pari et sur rien
     d'autre.
     ------------------------------------------------------------------ */

  if (sig === "donchian_suit") {        // même compression Donchian, mais on SUIT la cassure
    const n = c5.length - 1, N_DON = 20;
    if (n < N_DON + 250) return 0;
    const width = [];
    for (let i = N_DON; i <= n; i++) {
      let mx = -Infinity, mn = Infinity;
      for (let k = i - N_DON; k < i; k++) { if (c5[k][2] > mx) mx = c5[k][2]; if (c5[k][3] < mn) mn = c5[k][3]; }
      width.push({ i, w: (mx - mn) / c5[i][4], hi: mx, lo: mn });
    }
    const prev = width[width.length - 2];
    if (!prev) return 0;
    let below = 0, cnt = 0;
    for (let k = Math.max(0, width.length - 2 - 288); k < width.length - 2; k++) { cnt++; if (width[k].w <= prev.w) below++; }
    if (cnt < 200 || (100 * below / cnt) > 15) return 0;
    if (c5[n][4] > prev.hi) return 1;                // cassure haussière -> on suit
    if (c5[n][4] < prev.lo) return -1;
    return 0;
  }

  if (sig === "keltner_suit") {         // sortie du canal EMA20±3ATR10, dans le sens de la sortie
    const kc = keltnerLast2(c5, 3);
    if (!kc || !kc.last || !kc.prev) return 0;
    const n = c5.length - 1;
    const cNow = c5[n][4], cPrev = c5[n - 1][4];
    if (cPrev <= kc.prev.upper && cNow > kc.last.upper) return 1;
    if (cPrev >= kc.prev.lower && cNow < kc.last.lower) return -1;
    return 0;
  }

  if (sig === "roc_suit") {             // ROC12 étiré + volume : on suit au lieu de contrer
    const n = c5.length - 1;
    if (n < 288) return 0;
    const rc = (c5[n][4] / c5[n - 12][4] - 1) * 100;
    const vols = [];
    for (let k = n - 287; k <= n; k++) vols.push(c5[k][5]);
    vols.sort((a, b) => a - b);
    const med = vols.length % 2 ? vols[vols.length >> 1] : (vols[(vols.length >> 1) - 1] + vols[vols.length >> 1]) / 2;
    if (!(med > 0) || c5[n][5] / med < 2.5) return 0;
    const bull = c5[n][4] > c5[n][1];
    if (rc > 1.5 && bull) return 1;
    if (rc < -1.5 && !bull) return -1;
    return 0;
  }

  if (sig === "run5_suit") {            // cinq bougies dans le même sens : on suit
    const { run, sgn } = runLen(closes.slice(-12));
    return (run >= 5 && sgn !== 0) ? sgn : 0;
  }

  if (sig === "canal24_suit") {         // cassure du plus haut / plus bas de 24 h
    const n = c5.length - 1;
    if (n < 289) return 0;
    let hh = -Infinity, ll = Infinity;
    for (let k = n - 288; k < n; k++) { if (c5[k][2] > hh) hh = c5[k][2]; if (c5[k][3] < ll) ll = c5[k][3]; }
    if (!(hh > ll)) return 0;
    if (c5[n][4] > hh) return 1;
    if (c5[n][4] < ll) return -1;
    return 0;
  }

  if (sig === "ema_croise") {           // EMA20 traverse EMA60 : la tendance sous sa forme la plus simple
    const n = c5.length - 1;
    if (n < 200) return 0;
    const ema = (p) => {
      const k = 2 / (p + 1);
      let e = closes[closes.length - 200];
      const out = [];
      for (let i = closes.length - 200; i < closes.length; i++) { e = e + k * (closes[i] - e); out.push(e); }
      return out;
    };
    const r = ema(20), l = ema(60);
    const m = r.length - 1;
    if (m < 1) return 0;
    if (r[m - 1] <= l[m - 1] && r[m] > l[m]) return 1;
    if (r[m - 1] >= l[m - 1] && r[m] < l[m]) return -1;
    return 0;
  }

  return 0;
}

/* Les signaux de suite de tendance, nommés à part. Le chercheur peut
   recevoir cette liste par son environnement ; par défaut il ne voit
   que SIGNAUX, et la production ne change pas d'un iota. */
const SIGNAUX_SUITE = ["donchian_suit", "keltner_suit", "roc_suit",
                       "run5_suit", "canal24_suit", "ema_croise"];

module.exports = { rsi14, zScore, runLen, rangePos24h, keltnerLast2, evalSignal, SIGNAUX, SIGNAUX_SUITE };
