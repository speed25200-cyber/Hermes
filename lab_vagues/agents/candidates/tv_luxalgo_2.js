// EDGE : Nadaraya-Watson Envelope (LuxAlgo) en mode NON-repainting (endpoint estimator) :
// out = somme pondérée gaussienne CAUSALE des 500 derniers closes (gauss(k,h)=exp(-k²/2h²)),
// bande = out ± 3 × SMA499(|close-out|). Le prix qui SORT de l'enveloppe = excès -> fade
// vers le centre (signal officiel du script : crossunder bas = long, crossover haut = short).
// h=6, mult=3 ; robustesse : h6_m3 valide sur les 4 exits (7,8-9,8), h4_m3 aussi (4,5-6,7).
const H = 6, MULT = 3, W = 499;

module.exports = {
  instId: "EDGE-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const n = c5.length, close = c5.map(r => r[4]);
    const K = Math.min(499, Math.ceil(H * 5.26)); // poids < 1e-6·w0 au-delà : troncature négligeable
    const w = new Float64Array(K + 1);
    let den = 0;
    for (let k = 0; k <= K; k++) { w[k] = Math.exp(-(k * k) / (2 * H * H)); den += w[k]; }
    const out2 = new Float64Array(n).fill(NaN), err = new Float64Array(n);
    const up = new Float64Array(n).fill(NaN), lo = new Float64Array(n).fill(NaN);
    let run = 0;
    for (let i = K; i < n; i++) {
      let s = 0;
      for (let k = 0; k <= K; k++) s += close[i - k] * w[k];
      out2[i] = s / den;
      err[i] = Math.abs(close[i] - out2[i]);
      run += err[i];
      if (i - K >= W) run -= err[i - W];
      if (i - K >= W - 1) {
        const mae = (run / W) * MULT;
        up[i] = out2[i] + mae; lo[i] = out2[i] - mae;
      }
    }
    const sigs = [];
    for (let i = 1001; i < n; i++) {
      if (isNaN(up[i]) || isNaN(up[i - 1])) continue;
      if (close[i - 1] > lo[i - 1] && close[i] < lo[i]) sigs.push({ i5: i, dir: 1 });       // sort en bas -> long
      else if (close[i - 1] < up[i - 1] && close[i] > up[i]) sigs.push({ i5: i, dir: -1 }); // sort en haut -> short
    }
    return sigs;
  }
};
