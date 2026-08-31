// Stochastic RSI(14,14,3,3) extrême : croisement K/D EN ZONE de survente/surachat (<7 / >93)
// + bougie de confirmation (clôture dans le sens du fade) — fade classique de l'excès.
module.exports = {
  instId: "UNI-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const T = 7, rsiP = 14, stochP = 14, kSmooth = 3, dSmooth = 3;
    const closes = c5.map(x => x[4]);
    const n = closes.length;

    // RSI(14) causal (Wilder)
    const rsi = new Array(n).fill(null);
    let gain = 0, loss = 0;
    for (let i = 1; i <= rsiP && i < n; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= rsiP; loss /= rsiP;
    rsi[rsiP] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = rsiP + 1; i < n; i++) {
      const d = closes[i] - closes[i - 1];
      const g = d >= 0 ? d : 0, l = d < 0 ? -d : 0;
      gain = (gain * (rsiP - 1) + g) / rsiP;
      loss = (loss * (rsiP - 1) + l) / rsiP;
      rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }

    // Stoch(RSI, 14) brut
    const raw = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (rsi[i] == null) continue;
      let lo = Infinity, hi = -Infinity, ok = true;
      for (let k = i - stochP + 1; k <= i; k++) {
        if (k < 0 || rsi[k] == null) { ok = false; break; }
        if (rsi[k] < lo) lo = rsi[k];
        if (rsi[k] > hi) hi = rsi[k];
      }
      if (!ok) continue;
      raw[i] = hi === lo ? 50 : 100 * (rsi[i] - lo) / (hi - lo);
    }

    // K = SMA3(raw), D = SMA3(K)
    function sma(arr, p) {
      const out = new Array(arr.length).fill(null);
      let sum = 0, cnt = 0;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] == null) { sum = 0; cnt = 0; continue; }
        sum += arr[i]; cnt++;
        if (i >= p && arr[i - p] != null) { sum -= arr[i - p]; cnt--; }
        if (cnt >= p) out[i] = sum / p;
      }
      return out;
    }
    const K = sma(raw, kSmooth), D = sma(K, dSmooth);

    const out = [];
    for (let i = 101; i < n; i++) {
      if (K[i] == null || D[i] == null || K[i - 1] == null || D[i - 1] == null) continue;
      const crossUp = K[i - 1] <= D[i - 1] && K[i] > D[i] && K[i] < T;       // survente, K recroise D vers le haut
      const crossDown = K[i - 1] >= D[i - 1] && K[i] < D[i] && K[i] > (100 - T); // surachat, K recroise D vers le bas
      if (crossUp) { if (c5[i][4] > c5[i - 1][4]) out.push({ i5: i, dir: 1 }); }
      else if (crossDown) { if (c5[i][4] < c5[i - 1][4]) out.push({ i5: i, dir: -1 }); }
    }
    return out;
  }
};
