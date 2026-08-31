// Awesome Oscillator (SMA5-SMA34 du prix médian) « twin peaks » : deux pics confirmés de MÊME
// signe, le second plus faible que le premier (momentum qui s'épuise) — fade au 2e pic confirmé.
module.exports = {
  instId: "AAVE-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const L = 3; // fenêtre de confirmation causale du pic/creux
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

    // pics/creux confirmés causalement (fenêtre L de chaque côté, confirmé L bougies après l'extrême)
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
      if (a.val > 0 && b.val > 0 && b.val < a.val) out.push({ i5: b.i, dir: -1 }); // twin peaks haussiers => fade short
    }
    for (let k = 1; k < troughs.length; k++) {
      const a = troughs[k - 1], b = troughs[k];
      if (a.val < 0 && b.val < 0 && b.val > a.val) out.push({ i5: b.i, dir: 1 }); // twin peaks baissiers => fade long
    }
    return out;
  }
};
