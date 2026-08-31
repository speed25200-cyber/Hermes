// tv2_knn_2 — DATA-USDT-SWAP
// Même famille que tv2_knn_1 (port causal de "Machine Learning: Lorentzian Classification", jdehorty) mais
// distance LORENTZIENNE ln(1+|d|) (moins sensible aux outliers de features que Manhattan) + bougie de
// confirmation (clôture dans le sens du signal) avant d'entrer.
// Vecteur : [RSI14, z-score(close vs SMA48), position range 24h, ratio volume vs SMA20], squashé 0..1 (tanh).
// k=20 plus proches voisins CAUSAUX parmi les <=2000 bougies passées, vote sur le signe du retour à +12
// bougies, signal si vote net >=12/20 (80%) ET la bougie du signal confirme la direction.
"use strict";

const RSI_P = 14, SMA_W = 48, RANGE_W = 288, VOL_W = 20;
const START = RANGE_W + 5;
const HORIZON = 12;
const POOL = 2000;
const K = 20;
const T = 12; // seuil de vote net (12/20 = 80%)

function rsi(closes, period) {
  const n = closes.length, out = new Float64Array(n).fill(NaN);
  let gain = 0, loss = 0;
  for (let i = 1; i <= period && i < n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d >= 0 ? d : 0, l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function zscoreCloseVsSma(closes, W) {
  const n = closes.length, out = new Float64Array(n).fill(NaN);
  let sum = 0, sumsq = 0;
  for (let i = 0; i < n; i++) {
    sum += closes[i]; sumsq += closes[i] * closes[i];
    if (i >= W) { sum -= closes[i - W]; sumsq -= closes[i - W] * closes[i - W]; }
    if (i >= W - 1) {
      const mean = sum / W;
      const variance = Math.max(0, sumsq / W - mean * mean);
      const sd = Math.sqrt(variance);
      out[i] = sd === 0 ? 0 : (closes[i] - mean) / sd;
    }
  }
  return out;
}

function posInRange(highs, lows, closes, W) {
  const n = highs.length, out = new Float64Array(n).fill(NaN);
  const maxDeq = [], minDeq = [];
  for (let i = 0; i < n; i++) {
    while (maxDeq.length && highs[maxDeq[maxDeq.length - 1]] <= highs[i]) maxDeq.pop();
    maxDeq.push(i);
    while (minDeq.length && lows[minDeq[minDeq.length - 1]] >= lows[i]) minDeq.pop();
    minDeq.push(i);
    while (maxDeq[0] <= i - W) maxDeq.shift();
    while (minDeq[0] <= i - W) minDeq.shift();
    if (i >= W - 1) {
      const hi = highs[maxDeq[0]], lo = lows[minDeq[0]];
      out[i] = hi === lo ? 0.5 : (closes[i] - lo) / (hi - lo);
    }
  }
  return out;
}

function volRatio(vols, W) {
  const n = vols.length, out = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += vols[i];
    if (i >= W) sum -= vols[i - W];
    if (i >= W - 1) { const m = sum / W; out[i] = m === 0 ? 1 : vols[i] / m; }
  }
  return out;
}

function tanhSquash(x, scale) { return 0.5 + 0.5 * Math.tanh(x / scale); }

module.exports = {
  instId: "DATA-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 24 },
  detect(c5) {
    const n = c5.length;
    const opens = new Float64Array(n), closes = new Float64Array(n), highs = new Float64Array(n), lows = new Float64Array(n), vols = new Float64Array(n);
    for (let i = 0; i < n; i++) { opens[i] = c5[i][1]; highs[i] = c5[i][2]; lows[i] = c5[i][3]; closes[i] = c5[i][4]; vols[i] = c5[i][6] ?? c5[i][5]; }
    const r = rsi(closes, RSI_P);
    const z = zscoreCloseVsSma(closes, SMA_W);
    const pr = posInRange(highs, lows, closes, RANGE_W);
    const vr = volRatio(vols, VOL_W);
    const f1 = new Float64Array(n), f2 = new Float64Array(n), f3 = new Float64Array(n), f4 = new Float64Array(n);
    const valid = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(r[i]) || Number.isNaN(z[i]) || Number.isNaN(pr[i]) || Number.isNaN(vr[i])) continue;
      f1[i] = r[i] / 100;
      f2[i] = tanhSquash(z[i], 2);
      f3[i] = Math.min(1, Math.max(0, pr[i]));
      f4[i] = tanhSquash(vr[i] - 1, 1);
      valid[i] = 1;
    }

    const out = [];
    const topDist = new Float64Array(K);
    const topLabel = new Int8Array(K);
    for (let i = START; i < n; i++) {
      if (!valid[i]) continue;
      const jMax = i - HORIZON; // le label du voisin j (retour à j+HORIZON) doit être connu au plus tard à i : AUCUN futur utilisé
      if (jMax < START) continue;
      const jMin = Math.max(START, i - POOL);
      let cnt = 0, worst = Infinity, worstIdx = -1;
      const a1 = f1[i], a2 = f2[i], a3 = f3[i], a4 = f4[i];
      for (let j = jMin; j <= jMax; j++) {
        if (!valid[j]) continue;
        const d = Math.log(1 + Math.abs(a1 - f1[j])) + Math.log(1 + Math.abs(a2 - f2[j])) +
                  Math.log(1 + Math.abs(a3 - f3[j])) + Math.log(1 + Math.abs(a4 - f4[j])); // Lorentzienne
        const lbl = closes[j + HORIZON] >= closes[j] ? 1 : -1;
        if (cnt < K) {
          topDist[cnt] = d; topLabel[cnt] = lbl; cnt++;
          if (cnt === K) { worst = -Infinity; for (let t = 0; t < K; t++) if (topDist[t] > worst) { worst = topDist[t]; worstIdx = t; } }
        } else if (d < worst) {
          topDist[worstIdx] = d; topLabel[worstIdx] = lbl;
          worst = -Infinity; for (let t = 0; t < K; t++) if (topDist[t] > worst) { worst = topDist[t]; worstIdx = t; }
        }
      }
      if (cnt < K) continue;
      let s = 0;
      for (let t = 0; t < K; t++) s += topLabel[t];
      if (s >= T) { if (closes[i] > opens[i]) out.push({ i5: i, dir: 1 }); }
      else if (s <= -T) { if (closes[i] < opens[i]) out.push({ i5: i, dir: -1 }); }
    }
    return out;
  }
};
