// Awesome Oscillator « twin peaks » (même famille que tv2_oscillo2_2) + bougie de confirmation
// (clôture qui repart déjà dans le sens du fade) — variante plus sélective.
module.exports = {
  instId: "ENS-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 24 },
  detect(c5) {
    const L = 3;
    const n = c5.length;
    const med = new Array(n);
    for (let i = 0; i < n; i++) med[i] = (c5[i][2] + c5[i][3]) / 2;

    function sma(arr, p) {
      const out = new Array(arr.length).fill(null);
      let sum = 0, cnt = 0;
      for (let i = 0; i < arr.length; i++) {
        sum += arr[i]; cnt++;
        if (i >= p) sum -= arr[i - p]; else cnt = i + 1;
        if (cnt >= p) out[i] = sum / p;
      }
      return out;
    }
    const s5 = sma(med, 5), s34 = sma(med, 34);
    const ao = new Array(n).fill(null);
    for (let i = 0; i < n; i++) if (s5[i] != null && s34[i] != null) ao[i] = s5[i] - s34[i];

    const peaks = [], troughs = [];
    for (let i = L; i < n; i++) {
      const p = i - L;
      if (ao[p] == null) continue;
      let isMax = true, isMin = true, ok = true;
      for (let k = p - L; k <= p + L; k++) {
        if (k < 0 || k >= n || ao[k] == null) { ok = false; break; }
        if (k === p) continue;
        if (ao[k] > ao[p]) isMax = false;
        if (ao[k] < ao[p]) isMin = false;
      }
      if (!ok) continue;
      if (isMax) peaks.push({ i, val: ao[p] });
      else if (isMin) troughs.push({ i, val: ao[p] });
    }

    const out = [];
    for (let k = 1; k < peaks.length; k++) {
      const a = peaks[k - 1], b = peaks[k];
      if (a.val > 0 && b.val > 0 && b.val < a.val) {
        if (c5[b.i][4] < c5[b.i - 1][4]) out.push({ i5: b.i, dir: -1 });
      }
    }
    for (let k = 1; k < troughs.length; k++) {
      const a = troughs[k - 1], b = troughs[k];
      if (a.val < 0 && b.val < 0 && b.val > a.val) {
        if (c5[b.i][4] > c5[b.i - 1][4]) out.push({ i5: b.i, dir: 1 });
      }
    }
    return out;
  }
};
