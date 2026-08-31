// Agent mixA — 10 primitives causales (RSI14, Stoch %K, Williams %R, CCI20, MFI14, ROC12, TRIX18,
// Ultimate Oscillator 7/14/28, Awesome Oscillator (normalisé %), ratio de volume vs médiane 24h).
// Chaque primitive expose EXACTEMENT 2 réglages GROSSIERS (setting 0 = large, setting 1 = étroit/extrême).
// Interface imposée : primitive(c5, i, setting) -> { long: bool, short: bool }.
// Toutes les séries sont calculées UNE SEULE FOIS par tableau de bougies (cache WeakMap) puis relues à
// l'indice i : c'est un cache de performance, pas un état — aucune bougie > i n'est jamais lue (causal strict).
"use strict";
const { RSI, Stochastic, WilliamsR, CCI, MFI, ROC, TRIX, AwesomeOscillator } = require("technicalindicators");

const cache = new WeakMap();

function alignEnd(n, arr) {
  // Les fonctions de technicalindicators renvoient des séries plus courtes que l'entrée (période de chauffe
  // consommée en tête) ; on repadde avec `null` en tête pour que série[i] corresponde bien à la bougie i.
  const pad = n - arr.length;
  const out = new Array(Math.max(0, pad)).fill(null);
  for (let k = 0; k < arr.length; k++) out.push(arr[k]);
  return out;
}

function computeUO(high, low, close) {
  // Ultimate Oscillator (Larry Williams, 7/14/28) — absent de technicalindicators, calcul causal manuel.
  const n = close.length;
  const bp = new Array(n).fill(0), tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const pc = close[i - 1];
    bp[i] = close[i] - Math.min(low[i], pc);
    tr[i] = Math.max(high[i], pc) - Math.min(low[i], pc);
  }
  const out = new Array(n).fill(null);
  // sommes glissantes 7/14/28 tenues incrémentalement (O(n), strictement causal : à l'indice i on n'utilise
  // que bp/tr des bougies <= i).
  let sBP7 = 0, sTR7 = 0, sBP14 = 0, sTR14 = 0, sBP28 = 0, sTR28 = 0;
  for (let i = 1; i < n; i++) {
    sBP7 += bp[i]; sTR7 += tr[i];
    sBP14 += bp[i]; sTR14 += tr[i];
    sBP28 += bp[i]; sTR28 += tr[i];
    if (i - 7 >= 1) { sBP7 -= bp[i - 7]; sTR7 -= tr[i - 7]; }
    if (i - 14 >= 1) { sBP14 -= bp[i - 14]; sTR14 -= tr[i - 14]; }
    if (i - 28 >= 1) { sBP28 -= bp[i - 28]; sTR28 -= tr[i - 28]; }
    if (i >= 28) {
      const a7 = sTR7 > 0 ? sBP7 / sTR7 : 0;
      const a14 = sTR14 > 0 ? sBP14 / sTR14 : 0;
      const a28 = sTR28 > 0 ? sBP28 / sTR28 : 0;
      out[i] = 100 * (4 * a7 + 2 * a14 + a28) / 7;
    }
  }
  return out;
}

function computeVolRatio(vol) {
  // ratio = volume de la bougie / MÉDIANE des 288 bougies précédentes (24h de 5m), fenêtre glissante causale.
  const n = vol.length, W = 288;
  const out = new Array(n).fill(null);
  const win = []; // copie triée de la fenêtre courante
  function insert(v) {
    let lo = 0, hi = win.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (win[mid] < v) lo = mid + 1; else hi = mid; }
    win.splice(lo, 0, v);
  }
  function remove(v) {
    let lo = 0, hi = win.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (win[mid] === v) { win.splice(mid, 1); return; }
      if (win[mid] < v) lo = mid + 1; else hi = mid - 1;
    }
  }
  for (let i = 0; i < n; i++) {
    insert(vol[i]);
    if (win.length > W) remove(vol[i - W]);
    if (i >= W - 1) {
      const m = win.length >> 1;
      const med = win.length % 2 ? win[m] : (win[m - 1] + win[m]) / 2;
      out[i] = med > 0 ? vol[i] / med : null;
    }
  }
  return out;
}

function getSeries(c5) {
  let s = cache.get(c5);
  if (s) return s;
  const n = c5.length;
  const close = c5.map(b => b[4]);
  const high = c5.map(b => b[2]);
  const low = c5.map(b => b[3]);
  const vol = c5.map(b => b[5]);

  s = {};
  s.rsi14 = alignEnd(n, RSI.calculate({ period: 14, values: close }));
  const sto = Stochastic.calculate({ period: 14, signalPeriod: 3, high, low, close });
  s.stochK = alignEnd(n, sto.map(o => o.k));
  s.willr14 = alignEnd(n, WilliamsR.calculate({ period: 14, high, low, close }));
  s.cci20 = alignEnd(n, CCI.calculate({ period: 20, high, low, close }));
  s.mfi14 = alignEnd(n, MFI.calculate({ period: 14, high, low, close, volume: vol }));
  s.roc12 = alignEnd(n, ROC.calculate({ period: 12, values: close })); // déjà en % (ex. 1.2 = +1.2%)
  s.trix18 = alignEnd(n, TRIX.calculate({ period: 18, values: close })); // déjà en %
  s.uo = computeUO(high, low, close);
  const ao = AwesomeOscillator.calculate({ high, low, fastPeriod: 5, slowPeriod: 34 });
  const aoAligned = alignEnd(n, ao);
  s.aoPct = aoAligned.map((v, i) => (v == null ? null : (100 * v) / close[i])); // normalisé en % du prix
  s.volr = computeVolRatio(vol);
  s.bull = c5.map(b => b[4] > b[1]); // clôture > ouverture (pour donner un sens au ratio de volume)

  cache.set(c5, s);
  return s;
}

// --- 10 primitives, 2 réglages GROSSIERS chacune -----------------------------------------------------
// Convention commune (sauf VOLR) : long = fade d'un extrême BAS (valeur < lo), short = fade d'un extrême
// HAUT (valeur > hi). C'est la lecture "A = setup extrême" du contrat.
function oscillatorPrimitive(seriesKey, settings) {
  return function (c5, i, setting) {
    const s = getSeries(c5)[seriesKey];
    const v = s[i];
    if (v == null) return { long: false, short: false };
    const { lo, hi } = settings[setting];
    return { long: v < lo, short: v > hi };
  };
}

const PRIMS = {
  RSI14: { settings: [{ lo: 25, hi: 75 }, { lo: 20, hi: 80 }], fn: null },
  STOCHK: { settings: [{ lo: 20, hi: 80 }, { lo: 10, hi: 90 }], fn: null },
  WILLR: { settings: [{ lo: -80, hi: -20 }, { lo: -90, hi: -10 }], fn: null },
  CCI20: { settings: [{ lo: -100, hi: 100 }, { lo: -150, hi: 150 }], fn: null },
  MFI14: { settings: [{ lo: 20, hi: 80 }, { lo: 10, hi: 90 }], fn: null },
  ROC12: { settings: [{ lo: -1.5, hi: 1.5 }, { lo: -3, hi: 3 }], fn: null }, // %
  TRIX18: { settings: [{ lo: -0.03, hi: 0.03 }, { lo: -0.06, hi: 0.06 }], fn: null }, // %
  UO: { settings: [{ lo: 30, hi: 70 }, { lo: 20, hi: 80 }], fn: null },
  AO: { settings: [{ lo: -0.5, hi: 0.5 }, { lo: -1.0, hi: 1.0 }], fn: null }, // % du prix
};
PRIMS.RSI14.fn = oscillatorPrimitive("rsi14", PRIMS.RSI14.settings);
PRIMS.STOCHK.fn = oscillatorPrimitive("stochK", PRIMS.STOCHK.settings);
PRIMS.WILLR.fn = oscillatorPrimitive("willr14", PRIMS.WILLR.settings);
PRIMS.CCI20.fn = oscillatorPrimitive("cci20", PRIMS.CCI20.settings);
PRIMS.MFI14.fn = oscillatorPrimitive("mfi14", PRIMS.MFI14.settings);
PRIMS.ROC12.fn = oscillatorPrimitive("roc12", PRIMS.ROC12.settings);
PRIMS.TRIX18.fn = oscillatorPrimitive("trix18", PRIMS.TRIX18.settings);
PRIMS.UO.fn = oscillatorPrimitive("uo", PRIMS.UO.settings);
PRIMS.AO.fn = oscillatorPrimitive("aoPct", PRIMS.AO.settings);

// VOLR : pas d'extrême haut/bas — la bougie donne le sens (grosse mèche/volume baissier = capitulation =
// fade LONG ; grosse bougie haussière = blow-off = fade SHORT). 2 réglages = seuil de spike du ratio.
PRIMS.VOLR = {
  settings: [{ th: 1.5 }, { th: 2.5 }],
  fn: function (c5, i, setting) {
    const s = getSeries(c5);
    const v = s.volr[i];
    if (v == null) return { long: false, short: false };
    const spike = v >= PRIMS.VOLR.settings[setting].th;
    if (!spike) return { long: false, short: false };
    return { long: !s.bull[i], short: s.bull[i] };
  },
};

const NAMES = Object.keys(PRIMS); // 10 primitives, ordre stable

module.exports = { PRIMS, NAMES, getSeries };
