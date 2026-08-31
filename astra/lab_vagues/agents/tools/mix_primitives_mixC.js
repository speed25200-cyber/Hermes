// Agent mixC — 10 primitives causales imposées : Parabolic SAR (côté+distance), ADX14 (plat),
// Aroon(14), MACD histogramme (signe+extrême, % du prix), KST, ForceIndex13, OBV (pente 24 bougies),
// EOM (Ease of Movement), série de bougies consécutives (3/5), ratio mèche/corps de la dernière bougie.
// Interface imposée (même contrat que mixA/mixB) : primitive(c5, i, setting) -> { long: bool, short: bool }.
// 2 réglages GROSSIERS par primitive (setting 0 = large, setting 1 = étroit/extrême), sauf ADX_FLAT qui
// n'a pas de sens directionnel propre : long===short (pur filtre/gate de régime, comme VOLR dans mixA).
// Toutes les séries sont calculées UNE SEULE FOIS par tableau de bougies (cache WeakMap) puis relues à
// l'indice i : cache de performance, pas d'état — aucune bougie > i n'est jamais lue (causal strict).
"use strict";
const { ADX, PSAR, MACD, KST, ForceIndex, OBV } = require("technicalindicators");

const cache = new WeakMap();
const R288 = 288; // ~24h de bougies 5m, fenêtre de régime pour les percentiles

function alignEnd(n, arr) {
  // technicalindicators renvoie des séries plus courtes (chauffe consommée en tête) ; repad en tête avec
  // `null` pour que série[i] corresponde à la bougie i.
  const pad = n - arr.length;
  const out = new Array(Math.max(0, pad)).fill(null);
  for (let k = 0; k < arr.length; k++) out.push(arr[k]);
  return out;
}

function rollingSMA(vals, period) {
  const n = vals.length, out = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Rang percentile causal (0-100) de vals[i] parmi la fenêtre [i-window+1, i] (elle-même incluse).
// Les positions sans valeur réelle (avant chauffe) sont remplies à 0 par l'appelant — imprécision mineure
// acceptée au même titre que mixB (compensée par le fait qu'on ne LIT le résultat qu'après la fenêtre pleine
// ET après la chauffe propre à chaque série amont).
function rollingPercentileRank(vals, window) {
  const n = vals.length, out = new Array(n).fill(null);
  for (let i = window - 1; i < n; i++) {
    let below = 0;
    const v = vals[i];
    for (let k = i - window + 1; k <= i; k++) if (vals[k] <= v) below++;
    out[i] = 100 * below / window;
  }
  return out;
}

// Aroon(14) causal : périodes écoulées depuis le plus haut / plus bas dans la fenêtre [i-period, i].
function computeAroon(high, low, period) {
  const n = high.length;
  const up = new Array(n).fill(null), down = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    let iMaxH = i, vMaxH = high[i];
    let iMinL = i, vMinL = low[i];
    for (let k = i - 1; k >= i - period; k--) {
      if (high[k] >= vMaxH) { vMaxH = high[k]; iMaxH = k; } // >= : préfère l'occurrence la + récente
      if (low[k] <= vMinL) { vMinL = low[k]; iMinL = k; }
    }
    up[i] = 100 * (period - (i - iMaxH)) / period;
    down[i] = 100 * (period - (i - iMinL)) / period;
  }
  return { up, down };
}

// EOM (Ease of Movement) causal, lissé SMA14. Échelle arbitraire (dépend de vol/range) — sans importance
// puisqu'on ne lit ce signal qu'à travers un rang percentile (unit-free).
function computeEOM(high, low, vol) {
  const n = high.length;
  const raw = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const midMove = (high[i] + low[i]) / 2 - (high[i - 1] + low[i - 1]) / 2;
    const boxH = high[i] - low[i];
    if (boxH > 0 && vol[i] > 0) raw[i] = midMove / (vol[i] / boxH);
  }
  return rollingSMA(raw, 14);
}

function getSeries(c5) {
  let s = cache.get(c5);
  if (s) return s;
  const n = c5.length;
  const open = c5.map(b => b[1]);
  const high = c5.map(b => b[2]);
  const low = c5.map(b => b[3]);
  const close = c5.map(b => b[4]);
  const vol = c5.map(b => b[5]);

  s = { open, high, low, close, vol };

  // 1) Parabolic SAR : côté = signe(close-sar), distance = (close-sar)/close en %.
  const psar = PSAR.calculate({ high, low, step: 0.02, max: 0.2 }); // longueur == n
  s.psarDistPct = close.map((c, i) => (psar[i] == null ? null : (c - psar[i]) / c * 100));

  // 2) ADX14 : force de tendance (0-100), aucun sens directionnel propre -> pur filtre "plat".
  const adx = ADX.calculate({ period: 14, close, high, low });
  s.adx14 = alignEnd(n, adx.map(o => o.adx));

  // 3) Aroon(14) : oscillateur up-down (-100..100).
  const aroon = computeAroon(high, low, 14);
  s.aroonOsc = aroon.up.map((u, i) => (u == null || aroon.down[i] == null ? null : u - aroon.down[i]));

  // 4) MACD histogramme, normalisé en % du prix (l'échelle brute dépend du prix de l'actif).
  const macd = MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const macdAligned = alignEnd(n, macd.map(o => o.histogram));
  s.macdHistPct = macdAligned.map((h, i) => (h == null ? null : h / close[i] * 100));

  // 5) KST (Know Sure Thing) — déjà en unités "pourcent" (somme pondérée de SMA(ROC)), comparable
  // grossièrement d'un actif à l'autre.
  const kst = KST.calculate({ values: close, ROCPer1: 10, ROCPer2: 15, ROCPer3: 20, ROCPer4: 30, SMAROCPer1: 10, SMAROCPer2: 10, SMAROCPer3: 10, SMAROCPer4: 15 });
  s.kst = alignEnd(n, kst.map(o => o.kst));

  // 6) ForceIndex13 (brut, échelle prix×volume arbitraire) -> lu via rang percentile (unit-free).
  const fi = ForceIndex.calculate({ close, volume: vol, period: 13 });
  const fiAligned = alignEnd(n, fi).map(v => (v == null ? 0 : v));
  s.fiPctl = rollingPercentileRank(fiAligned, R288);

  // 7) OBV, pente sur 24 bougies (2h) -> rang percentile.
  const obv = OBV.calculate({ close, volume: vol });
  const obvAligned = alignEnd(n, obv);
  const obvSlope = new Array(n).fill(0);
  for (let i = 24; i < n; i++) if (obvAligned[i] != null && obvAligned[i - 24] != null) obvSlope[i] = obvAligned[i] - obvAligned[i - 24];
  s.obvSlopePctl = rollingPercentileRank(obvSlope, R288);

  // 8) EOM lissé -> rang percentile.
  const eom = computeEOM(high, low, vol).map(v => (v == null ? 0 : v));
  s.eomPctl = rollingPercentileRank(eom, R288);

  // 9) Série de bougies consécutives (streak haussier/baissier, réinitialisé au changement de sens).
  const bullStreak = new Array(n).fill(0), bearStreak = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const bull = close[i] > open[i], bear = close[i] < open[i];
    bullStreak[i] = bull ? bullStreak[i - 1] + 1 : 0;
    bearStreak[i] = bear ? bearStreak[i - 1] + 1 : 0;
  }
  s.bullStreak = bullStreak;
  s.bearStreak = bearStreak;

  cache.set(c5, s);
  return s;
}

// --- 10 primitives, 2 réglages GROSSIERS chacune -----------------------------------------------------
const PRIMS = {};

// 1) PSAR_DIST : distance normalisée au SAR ; extension du côté SAR = épuisement -> fade.
PRIMS.PSAR_DIST = {
  settings: [{ th: 1.0 }, { th: 2.0 }], // % du prix
  fn(c5, i, setting) {
    const s = getSeries(c5);
    const d = s.psarDistPct[i];
    if (d == null) return { long: false, short: false };
    const th = PRIMS.PSAR_DIST.settings[setting].th;
    // close loin AU-DESSUS du SAR (uptrend étiré) -> fade short ; loin EN-DESSOUS -> fade long.
    return { long: d <= -th, short: d >= th };
  },
};

// 2) ADX_FLAT : régime plat (ADX bas) -> confirme qu'on est en range, favorable au fade. Pas de sens
// directionnel propre : long===short (comme VOLR dans mixA / DONCHIAN_WIDTH_PCTL dans mixB).
PRIMS.ADX_FLAT = {
  settings: [{ th: 20 }, { th: 15 }], // setting1 = régime encore plus plat (extrême)
  fn(c5, i, setting) {
    const s = getSeries(c5);
    const v = s.adx14[i];
    if (v == null) return { long: false, short: false };
    const th = PRIMS.ADX_FLAT.settings[setting].th;
    const flat = v <= th;
    return { long: flat, short: flat };
  },
};

// 3) AROON_OSC : tendance très unilatérale (up-down proche de ±100) -> épuisement -> fade.
PRIMS.AROON_OSC = {
  settings: [{ th: 80 }, { th: 90 }],
  fn(c5, i, setting) {
    const s = getSeries(c5);
    const v = s.aroonOsc[i];
    if (v == null) return { long: false, short: false };
    const th = PRIMS.AROON_OSC.settings[setting].th;
    return { long: v <= -th, short: v >= th };
  },
};

// 4) MACD_HIST : histogramme étiré (% du prix) -> momentum extrême -> fade.
PRIMS.MACD_HIST = {
  settings: [{ th: 0.15 }, { th: 0.30 }], // % du prix
  fn(c5, i, setting) {
    const s = getSeries(c5);
    const v = s.macdHistPct[i];
    if (v == null) return { long: false, short: false };
    const th = PRIMS.MACD_HIST.settings[setting].th;
    return { long: v <= -th, short: v >= th };
  },
};

// 5) KST : oscillateur de momentum lissé étiré -> fade.
PRIMS.KST = {
  settings: [{ th: 10 }, { th: 20 }],
  fn(c5, i, setting) {
    const s = getSeries(c5);
    const v = s.kst[i];
    if (v == null) return { long: false, short: false };
    const th = PRIMS.KST.settings[setting].th;
    return { long: v <= -th, short: v >= th };
  },
};

// 6) FORCE13_PCTL : Force Index (13) au rang extrême (pression acheteuse/vendeuse anormale) -> fade.
// FI très positif (achat en force) = zone de blow-off -> short ; très négatif (vente en force) -> long.
PRIMS.FORCE13_PCTL = {
  settings: [{ lo: 10, hi: 90 }, { lo: 5, hi: 95 }],
  fn(c5, i, setting) {
    const s = getSeries(c5);
    const v = s.fiPctl[i];
    if (v == null) return { long: false, short: false };
    const { lo, hi } = PRIMS.FORCE13_PCTL.settings[setting];
    return { long: v <= lo, short: v >= hi };
  },
};

// 7) OBV_SLOPE_PCTL : pente OBV sur 24 bougies au rang extrême (accumulation/distribution anormale) -> fade.
PRIMS.OBV_SLOPE_PCTL = {
  settings: [{ lo: 10, hi: 90 }, { lo: 5, hi: 95 }],
  fn(c5, i, setting) {
    const s = getSeries(c5);
    const v = s.obvSlopePctl[i];
    if (v == null) return { long: false, short: false };
    const { lo, hi } = PRIMS.OBV_SLOPE_PCTL.settings[setting];
    return { long: v <= lo, short: v >= hi };
  },
};

// 8) EOM_PCTL : Ease of Movement au rang extrême (mouvement anormalement "facile" dans un sens) -> fade.
PRIMS.EOM_PCTL = {
  settings: [{ lo: 10, hi: 90 }, { lo: 5, hi: 95 }],
  fn(c5, i, setting) {
    const s = getSeries(c5);
    const v = s.eomPctl[i];
    if (v == null) return { long: false, short: false };
    const { lo, hi } = PRIMS.EOM_PCTL.settings[setting];
    return { long: v <= lo, short: v >= hi };
  },
};

// 9) STREAK : N bougies consécutives de même sens -> épuisement directionnel -> fade.
PRIMS.STREAK = {
  settings: [{ n: 3 }, { n: 5 }],
  fn(c5, i, setting) {
    const s = getSeries(c5);
    const n = PRIMS.STREAK.settings[setting].n;
    return { long: s.bearStreak[i] >= n, short: s.bullStreak[i] >= n };
  },
};

// 10) WICK_RATIO : dernière bougie, mèche >> corps (rejet) -> fade dans le sens du rejet.
PRIMS.WICK_RATIO = {
  settings: [{ th: 2 }, { th: 3 }],
  fn(c5, i, setting) {
    const s = getSeries(c5);
    const o = s.open[i], h = s.high[i], l = s.low[i], c = s.close[i];
    const body = Math.max(Math.abs(c - o), c * 1e-6);
    const upperWick = h - Math.max(o, c);
    const lowerWick = Math.min(o, c) - l;
    const th = PRIMS.WICK_RATIO.settings[setting].th;
    const ratioUp = upperWick / body, ratioDown = lowerWick / body;
    const short = ratioUp >= th && ratioUp > ratioDown; // rejet en haut -> fade short
    const long = ratioDown >= th && ratioDown > ratioUp; // rejet en bas -> fade long
    return { long, short };
  },
};

const NAMES = Object.keys(PRIMS); // 10 primitives, ordre stable

module.exports = { PRIMS, NAMES, getSeries, R288 };
