// PRIMITIVES CAUSALES — agent mixB. 10 indicateurs, 2 réglages GROSSIERS chacun.
// Chaque primitive est un état {long, short} par bougie (Uint8Array 0/1), calculé UNE FOIS
// par crypto via buildContext(c5) puis lu par primitive(ctx, level) -> {long, short}.
// "long" = bar EN zone extrême basse (candidate à un fade haussier) ; "short" = zone extrême haute.
// Primitives non directionnelles (largeur Donchian %ile, ATR %ile) : long===short (pur filtre/gate).
// Zéro futur : toute fenêtre glissante ne lit que [.., i].
"use strict";
const ti = require("technicalindicators");

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
function rollingStd(vals, period, sma) {
  const n = vals.length, out = new Array(n).fill(null);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sumSq += vals[i] * vals[i];
    if (i >= period) sumSq -= vals[i - period] * vals[i - period];
    if (i >= period - 1) {
      const meanSq = sumSq / period, variance = meanSq - sma[i] * sma[i];
      out[i] = Math.sqrt(Math.max(0, variance));
    }
  }
  return out;
}
// Aligne un résultat technicalindicators (qui commence à un offset) sur la longueur complète.
function alignTI(n, arr) {
  const off = n - arr.length, out = new Array(n).fill(null);
  for (let k = 0; k < arr.length; k++) out[off + k] = arr[k];
  return out;
}
// Rolling max/min via deque monotone (O(n)), fenêtre [i-period+1, i].
function rollingMax(vals, period) {
  const n = vals.length, out = new Array(n).fill(null), dq = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && vals[dq[dq.length - 1]] <= vals[i]) dq.pop();
    dq.push(i);
    while (dq[0] <= i - period) dq.shift();
    if (i >= period - 1) out[i] = vals[dq[0]];
  }
  return out;
}
function rollingMin(vals, period) {
  const n = vals.length, out = new Array(n).fill(null), dq = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && vals[dq[dq.length - 1]] >= vals[i]) dq.pop();
    dq.push(i);
    while (dq[0] <= i - period) dq.shift();
    if (i >= period - 1) out[i] = vals[dq[0]];
  }
  return out;
}
// Rang percentile (0-100) de vals[i] parmi la fenêtre [i-window+1, i] (elle-même incluse).
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

const R288 = 288; // ~24h de bougies 5m

function buildContext(c5) {
  const n = c5.length;
  const open = new Array(n), high = new Array(n), low = new Array(n), close = new Array(n), vol = new Array(n), ts = new Array(n);
  for (let i = 0; i < n; i++) { const c = c5[i]; ts[i] = c[0]; open[i] = c[1]; high[i] = c[2]; low[i] = c[3]; close[i] = c[4]; vol[i] = c[5]; }

  const sma20 = rollingSMA(close, 20), std20 = rollingStd(close, 20, sma20);
  const sma48 = rollingSMA(close, 48), std48 = rollingStd(close, 48, sma48);

  const ema20arr = ti.EMA.calculate({ period: 20, values: close });
  const ema20 = alignTI(n, ema20arr);
  const ema96arr = ti.EMA.calculate({ period: 96, values: close });
  const ema96 = alignTI(n, ema96arr);

  const atr14arr = ti.ATR.calculate({ period: 14, high, low, close });
  const atr14 = alignTI(n, atr14arr);

  const hi20 = rollingMax(high, 20), lo20 = rollingMin(low, 20);
  const hi288 = rollingMax(high, R288), lo288 = rollingMin(low, R288);

  // Largeur Donchian(20) en % du close + rang percentile sur 288 bougies passées.
  const donWidth = new Array(n).fill(null);
  for (let i = 0; i < n; i++) if (hi20[i] != null && close[i] > 0) donWidth[i] = (hi20[i] - lo20[i]) / close[i];
  const donWidthPctl = rollingPercentileRank(donWidth.map(v => v == null ? 0 : v), R288);

  const atrPctl = rollingPercentileRank(atr14.map(v => v == null ? 0 : v), R288);

  // VWAP ancré jour UTC + écart-type pondéré volume (warm-up 36 barres = 3h dans la journée).
  const vwap = new Array(n).fill(null), vwapSigma = new Array(n).fill(null), barsInDay = new Array(n).fill(0);
  {
    let cumPV = 0, cumV = 0, cumPV2 = 0, curDay = null, cnt = 0;
    for (let i = 0; i < n; i++) {
      const day = Math.floor(ts[i] / 86400000);
      if (day !== curDay) { curDay = day; cumPV = 0; cumV = 0; cumPV2 = 0; cnt = 0; }
      const p = close[i], v = Math.max(vol[i], 1e-9);
      cumPV += p * v; cumV += v; cumPV2 += p * p * v; cnt++;
      barsInDay[i] = cnt;
      if (cumV > 0) {
        const vw = cumPV / cumV;
        vwap[i] = vw;
        const variance = cumPV2 / cumV - vw * vw;
        vwapSigma[i] = Math.sqrt(Math.max(0, variance));
      }
    }
  }

  // Mass Index de Dorsey (EMA9 du range, double EMA9, ratio, somme 25).
  const rangeHL = new Array(n);
  for (let i = 0; i < n; i++) rangeHL[i] = high[i] - low[i];
  const singleEmaArr = ti.EMA.calculate({ period: 9, values: rangeHL });
  const singleEma = alignTI(n, singleEmaArr);
  const singleEmaFilled = singleEma.map(v => v == null ? 0 : v);
  const doubleEmaArr = ti.EMA.calculate({ period: 9, values: singleEmaFilled });
  const doubleEma = alignTI(n, doubleEmaArr);
  const ratio = new Array(n).fill(null);
  for (let i = 0; i < n; i++) if (singleEma[i] != null && doubleEma[i] != null && doubleEma[i] > 0) ratio[i] = singleEma[i] / doubleEma[i];
  const massIndex = rollingSMA(ratio.map(v => v == null ? 1 : v), 25).map(v => v == null ? null : v * 25);

  return { n, open, high, low, close, vol, ts, sma20, std20, sma48, std48, ema20, ema96, atr14, hi20, lo20, hi288, lo288, donWidthPctl, atrPctl, vwap, vwapSigma, barsInDay, massIndex };
}

// ---- Les 10 primitives ----------------------------------------------------
// Chaque entrée : { key, directional, levels:[levelParams x2], build(ctx, levelParams) -> {long:Uint8Array, short:Uint8Array} }

function boolArr(n) { return new Uint8Array(n); }

const PRIMS = [
  {
    key: "BB_PCTB", directional: true, label: "Bollinger %B(20,2)",
    levels: [{ lo: 0.0, hi: 1.0 }, { lo: -0.1, hi: 1.1 }],
    build(ctx, p) {
      const { n, close, sma20, std20 } = ctx, L = boolArr(n), S = boolArr(n);
      for (let i = 19; i < n; i++) {
        if (std20[i] == null) continue;
        const upper = sma20[i] + 2 * std20[i], lower = sma20[i] - 2 * std20[i];
        if (upper <= lower) continue;
        const pctB = (close[i] - lower) / (upper - lower);
        if (pctB <= p.lo) L[i] = 1; else if (pctB >= p.hi) S[i] = 1;
      }
      return { long: L, short: S };
    }
  },
  {
    key: "KELTNER_POS", directional: true, label: "position Keltner EMA20±mult·ATR14",
    levels: [{ mult: 2 }, { mult: 3 }],
    build(ctx, p) {
      const { n, close, ema20, atr14 } = ctx, L = boolArr(n), S = boolArr(n);
      for (let i = 0; i < n; i++) {
        if (ema20[i] == null || atr14[i] == null || atr14[i] <= 0) continue;
        const pos = (close[i] - ema20[i]) / (p.mult * atr14[i]);
        if (pos <= -1) L[i] = 1; else if (pos >= 1) S[i] = 1;
      }
      return { long: L, short: S };
    }
  },
  {
    key: "DONCHIAN_POS", directional: true, label: "position Donchian20",
    levels: [{ lo: 0.10, hi: 0.90 }, { lo: 0.02, hi: 0.98 }],
    build(ctx, p) {
      const { n, close, hi20, lo20 } = ctx, L = boolArr(n), S = boolArr(n);
      for (let i = 19; i < n; i++) {
        if (hi20[i] == null) continue;
        const rng = hi20[i] - lo20[i];
        if (!(rng > 0)) continue;
        const pos = (close[i] - lo20[i]) / rng;
        if (pos <= p.lo) L[i] = 1; else if (pos >= p.hi) S[i] = 1;
      }
      return { long: L, short: S };
    }
  },
  {
    key: "DONCHIAN_WIDTH_PCTL", directional: false, label: "largeur Donchian20 (%ile 288b, compression)",
    levels: [{ pct: 20 }, { pct: 10 }],
    build(ctx, p) {
      const { n, donWidthPctl } = ctx, L = boolArr(n), S = boolArr(n);
      for (let i = R288 - 1; i < n; i++) {
        if (donWidthPctl[i] == null) continue;
        if (donWidthPctl[i] <= p.pct) { L[i] = 1; S[i] = 1; }
      }
      return { long: L, short: S };
    }
  },
  {
    key: "ATR_PCTL", directional: false, label: "ATR14 (%ile 288b, compression)",
    levels: [{ pct: 20 }, { pct: 10 }],
    build(ctx, p) {
      const { n, atrPctl } = ctx, L = boolArr(n), S = boolArr(n);
      for (let i = R288 - 1; i < n; i++) {
        if (atrPctl[i] == null) continue;
        if (atrPctl[i] <= p.pct) { L[i] = 1; S[i] = 1; }
      }
      return { long: L, short: S };
    }
  },
  {
    key: "SMA48_Z", directional: true, label: "z-score close vs SMA48",
    levels: [{ t: 2 }, { t: 3 }],
    build(ctx, p) {
      const { n, close, sma48, std48 } = ctx, L = boolArr(n), S = boolArr(n);
      for (let i = 47; i < n; i++) {
        if (std48[i] == null || std48[i] <= 0) continue;
        const z = (close[i] - sma48[i]) / std48[i];
        if (z <= -p.t) L[i] = 1; else if (z >= p.t) S[i] = 1;
      }
      return { long: L, short: S };
    }
  },
  {
    key: "EMA96_DIST", directional: true, label: "distance EMA96 (unités ATR14)",
    levels: [{ t: 2 }, { t: 3 }],
    build(ctx, p) {
      const { n, close, ema96, atr14 } = ctx, L = boolArr(n), S = boolArr(n);
      for (let i = 0; i < n; i++) {
        if (ema96[i] == null || atr14[i] == null || atr14[i] <= 0) continue;
        const dist = (close[i] - ema96[i]) / atr14[i];
        if (dist <= -p.t) L[i] = 1; else if (dist >= p.t) S[i] = 1;
      }
      return { long: L, short: S };
    }
  },
  {
    key: "VWAP_DAY_SIGMA", directional: true, label: "distance VWAP jour (σ pondéré volume)",
    levels: [{ t: 2 }, { t: 3 }],
    build(ctx, p) {
      const { n, close, vwap, vwapSigma, barsInDay } = ctx, L = boolArr(n), S = boolArr(n);
      for (let i = 0; i < n; i++) {
        if (barsInDay[i] < 36 || vwap[i] == null || vwapSigma[i] == null || vwapSigma[i] <= 0) continue;
        const d = (close[i] - vwap[i]) / vwapSigma[i];
        if (d <= -p.t) L[i] = 1; else if (d >= p.t) S[i] = 1;
      }
      return { long: L, short: S };
    }
  },
  {
    key: "RANGE24H_POS", directional: true, label: "position range 24h (288b)",
    levels: [{ lo: 0.20, hi: 0.80 }, { lo: 0.10, hi: 0.90 }],
    build(ctx, p) {
      const { n, close, hi288, lo288 } = ctx, L = boolArr(n), S = boolArr(n);
      for (let i = R288 - 1; i < n; i++) {
        if (hi288[i] == null) continue;
        const rng = hi288[i] - lo288[i];
        if (!(rng > 0)) continue;
        const pos = (close[i] - lo288[i]) / rng;
        if (pos <= p.lo) L[i] = 1; else if (pos >= p.hi) S[i] = 1;
      }
      return { long: L, short: S };
    }
  },
  {
    key: "MASS_INDEX", directional: true, label: "Mass Index Dorsey (renflement 25b)",
    levels: [{ hi: 27, lo: 26.5 }, { hi: 26, lo: 25.5 }],
    build(ctx, p) {
      const { n, close, massIndex } = ctx, L = boolArr(n), S = boolArr(n);
      let armed = false, armIdx = -1;
      for (let i = 25; i < n; i++) {
        if (massIndex[i] == null) continue;
        if (!armed && massIndex[i] >= p.hi) { armed = true; armIdx = i; }
        else if (armed && massIndex[i] < p.lo) {
          armed = false;
          const j0 = Math.max(0, i - 25);
          const trendUp = close[i] > close[j0];
          if (trendUp) S[i] = 1; else L[i] = 1; // renflement en hausse -> retournement baissier attendu (short), et inversement
        }
      }
      return { long: L, short: S };
    }
  }
];

module.exports = { buildContext, PRIMS, rollingSMA, rollingStd, rollingMax, rollingMin, rollingPercentileRank, alignTI, R288 };
