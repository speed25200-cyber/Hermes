// CM_MacD_Ult_MTF [ChrisMoody] porté fidèlement : MACD(12,26,9) calculé sur bougies 1h agrégées (12x5m),
// signal = SMA(macd,9) — PAS ema, comme le script original.
// Lecture (c) : le MACD 1h sert de FILTRE DE CONTRE-TENDANCE sur un déclencheur RSI(14) 5m qui "reclaim"
// une zone extrême (30/70) — on ne prend le rebond 5m QUE quand il va à CONTRE-SENS du MACD 1h établi.
// 3e crypto de la même famille (identique à cli_macdmtf_2.js/ALLO) ; plateau confirmé : contra survit
// avec les 2 jeux de sorties (tp80/hold12 ET tp60/hold24, ce dernier même légèrement meilleur ici).
module.exports = {
  instId: "H-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const RSI_N = 14, LO = 30, HI = 70;

    const closes1h = [], i5last = [];
    let key = null, c = null, curI = -1;
    for (let i = 0; i < c5.length; i++) {
      const k = Math.floor(c5[i][0] / 3600000);
      if (k !== key) { if (c !== null) { closes1h.push(c); i5last.push(curI); } key = k; curI = i; }
      else curI = i;
      c = c5[i][4];
    }
    if (c !== null) { closes1h.push(c); i5last.push(curI); }

    function ema(vals, n) {
      const out = new Array(vals.length).fill(null);
      if (vals.length < n) return out;
      let s = 0; for (let i = 0; i < n; i++) s += vals[i];
      let prev = s / n; out[n - 1] = prev;
      const k = 2 / (n + 1);
      for (let i = n; i < vals.length; i++) { prev = vals[i] * k + prev * (1 - k); out[i] = prev; }
      return out;
    }
    function smaSerie(vals, n) {
      const out = new Array(vals.length).fill(null);
      for (let i = n - 1; i < vals.length; i++) {
        let ok = true, s = 0;
        for (let k = i - n + 1; k <= i; k++) { if (vals[k] === null) { ok = false; break; } s += vals[k]; }
        if (ok) out[i] = s / n;
      }
      return out;
    }

    const e12 = ema(closes1h, 12), e26 = ema(closes1h, 26);
    const macd = closes1h.map((_, i) => (e12[i] !== null && e26[i] !== null) ? e12[i] - e26[i] : null);
    const signal = smaSerie(macd, 9);

    const state = new Array(c5.length).fill(null);
    for (let j = 0; j < closes1h.length; j++) {
      if (macd[j] === null || signal[j] === null) continue;
      const st = macd[j] >= signal[j] ? 1 : -1;
      const from = i5last[j];
      const to = (j + 1 < i5last.length) ? i5last[j + 1] - 1 : c5.length - 1;
      for (let i = from; i <= to && i < c5.length; i++) state[i] = st;
    }

    const closes5 = c5.map(x => x[4]);
    const rsi = new Array(closes5.length).fill(null);
    let gain = 0, loss = 0;
    for (let i = 1; i <= RSI_N; i++) { const d = closes5[i] - closes5[i - 1]; if (d > 0) gain += d; else loss -= d; }
    gain /= RSI_N; loss /= RSI_N;
    rsi[RSI_N] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = RSI_N + 1; i < closes5.length; i++) {
      const d = closes5[i] - closes5[i - 1];
      const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
      gain = (gain * (RSI_N - 1) + g) / RSI_N; loss = (loss * (RSI_N - 1) + l) / RSI_N;
      rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }

    const out = [];
    for (let i = RSI_N + 2; i < c5.length; i++) {
      if (rsi[i] === null || rsi[i - 1] === null || state[i] === null) continue;
      const longTrig = rsi[i - 1] < LO && rsi[i] >= LO;
      const shortTrig = rsi[i - 1] > HI && rsi[i] <= HI;
      const want = -state[i];
      if (longTrig && want === 1) out.push({ i5: i, dir: 1 });
      else if (shortTrig && want === -1) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
