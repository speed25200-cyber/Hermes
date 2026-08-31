// Bibliothèque partagée : CM_MacD_Ult_MTF [ChrisMoody] porté fidèlement (MACD 12/26/9, signal=SMA du macd,
// calculé sur bougies 1h agrégées depuis les 5m) + les 3 lectures (croisement brut/fade, histogramme
// exhaustion/continuation, filtre de sens sur RSI 5m reclaim).
const { chargerCandles, evaluer } = require("../harness_lib.js");

function agreger1h(c5) {
  const closes = [], i5last = [];
  let key = null, c = null, curI = -1;
  for (let i = 0; i < c5.length; i++) {
    const k = Math.floor(c5[i][0] / 3600000);
    if (k !== key) {
      if (c !== null) { closes.push(c); i5last.push(curI); }
      key = k; curI = i;
    } else curI = i;
    c = c5[i][4];
  }
  if (c !== null) { closes.push(c); i5last.push(curI); }
  return { closes, i5last };
}

function ema(vals, n) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < n) return out;
  let s = 0;
  for (let i = 0; i < n; i++) s += vals[i];
  let prev = s / n;
  out[n - 1] = prev;
  const k = 2 / (n + 1);
  for (let i = n; i < vals.length; i++) { prev = vals[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function smaSerie(vals, n) {
  const out = new Array(vals.length).fill(null);
  for (let i = 0; i < vals.length; i++) {
    if (i < n - 1) continue;
    let ok = true, s = 0;
    for (let k = i - n + 1; k <= i; k++) { if (vals[k] === null) { ok = false; break; } s += vals[k]; }
    if (ok) out[i] = s / n;
  }
  return out;
}
function calcMACD1h(closes) {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macd = closes.map((_, i) => (e12[i] !== null && e26[i] !== null) ? e12[i] - e26[i] : null);
  const signal = smaSerie(macd, 9);
  const hist = macd.map((m, i) => (m !== null && signal[i] !== null) ? m - signal[i] : null);
  return { macd, signal, hist };
}
function rsi(c5, n) {
  const closes = c5.map(x => x[4]);
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    gain = (gain * (n - 1) + g) / n; loss = (loss * (n - 1) + l) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function sigsA(bars, mode) {
  const { macd, signal } = calcMACD1h(bars.closes);
  const out = [];
  for (let j = 1; j < bars.closes.length; j++) {
    if (macd[j] === null || signal[j] === null || macd[j - 1] === null || signal[j - 1] === null) continue;
    const upNow = macd[j] >= signal[j], upPrev = macd[j - 1] >= signal[j - 1];
    if (upNow && !upPrev) out.push({ i5: bars.i5last[j], dir: mode === "raw" ? 1 : -1 });
    else if (!upNow && upPrev) out.push({ i5: bars.i5last[j], dir: mode === "raw" ? -1 : 1 });
  }
  return out;
}

function sigsB(bars, mode, K, L) {
  const { hist } = calcMACD1h(bars.closes);
  const absH = hist.map(h => h === null ? null : Math.abs(h));
  const out = [];
  for (let j = 1; j < bars.closes.length; j++) {
    if (hist[j] === null || hist[j - 1] === null) continue;
    let s = 0, cnt = 0;
    for (let k = Math.max(0, j - L); k < j; k++) { if (absH[k] !== null) { s += absH[k]; cnt++; } }
    if (cnt < L * 0.6) continue;
    const moy = s / cnt;
    const extremeNow = absH[j] > K * moy, extremePrev = absH[j - 1] > K * moy;
    const histA_IsUp = hist[j] > hist[j - 1] && hist[j] > 0;
    const histA_IsDown = hist[j] < hist[j - 1] && hist[j] > 0;
    const histA_IsUp_prev = j >= 2 && hist[j - 1] > hist[j - 2] && hist[j - 1] > 0;
    const histB_IsDown = hist[j] < hist[j - 1] && hist[j] <= 0;
    const histB_IsUp = hist[j] > hist[j - 1] && hist[j] <= 0;
    const histB_IsDown_prev = j >= 2 && hist[j - 1] < hist[j - 2] && hist[j - 1] <= 0;
    if (mode === "exhaustion") {
      if (histA_IsDown && histA_IsUp_prev && extremePrev) out.push({ i5: bars.i5last[j], dir: -1 });
      else if (histB_IsUp && histB_IsDown_prev && extremePrev) out.push({ i5: bars.i5last[j], dir: 1 });
    } else {
      if (histA_IsUp && extremeNow && !extremePrev) out.push({ i5: bars.i5last[j], dir: 1 });
      else if (histB_IsDown && extremeNow && !extremePrev) out.push({ i5: bars.i5last[j], dir: -1 });
    }
  }
  return out;
}

function stateMap(c5, bars) {
  const { macd, signal } = calcMACD1h(bars.closes);
  const state = new Array(c5.length).fill(null);
  for (let j = 0; j < bars.closes.length; j++) {
    if (macd[j] === null || signal[j] === null) continue;
    const st = macd[j] >= signal[j] ? 1 : -1;
    const from = bars.i5last[j];
    const to = (j + 1 < bars.i5last.length) ? bars.i5last[j + 1] - 1 : c5.length - 1;
    for (let i = from; i <= to && i < c5.length; i++) state[i] = st;
  }
  return state;
}
function sigsC(c5, bars, mode, rsiN, lo, hi) {
  const r = rsi(c5, rsiN);
  const st = stateMap(c5, bars);
  const out = [];
  for (let i = rsiN + 2; i < c5.length; i++) {
    if (r[i] === null || r[i - 1] === null || st[i] === null) continue;
    const longTrig = r[i - 1] < lo && r[i] >= lo;
    const shortTrig = r[i - 1] > hi && r[i] <= hi;
    const want = mode === "trend" ? st[i] : -st[i];
    if (longTrig && want === 1) out.push({ i5: i, dir: 1 });
    else if (shortTrig && want === -1) out.push({ i5: i, dir: -1 });
  }
  return out;
}

module.exports = { chargerCandles, evaluer, agreger1h, calcMACD1h, rsi, sigsA, sigsB, sigsC, stateMap };
