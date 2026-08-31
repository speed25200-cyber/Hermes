// ACT (Achain) : Donchian WIDTH — compression du canal réel (percentile bas de (haut20-bas20)/close
// sur les 288 barres précédentes) puis FADE de la 1re cassure (close hors du canal N=20 compressé
// → on joue le retour, pas la continuation). Reliquat classique jamais porté proprement (README) :
// la largeur DONCHIAN (extrema réels), pas Bollinger/ATR (déjà testés en ronde web_squeeze/inv_efficacite).
// Robustesse : famille F (fade) dense sur ACT — N20/PC15/PC25 × E1/E2 tous positifs ou quasi nuls,
// jamais wildly négatif ; le mode C (continuation) lui est franchement perdant partout (-4 à -12) —
// signature cohérente avec la leçon "le sens gagnant est idiosyncratique par crypto" (squeeze/mur/EDN).
const N_DON = 20, PCTL = 15, WPCT = 288;

module.exports = {
  instId: "ACT-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  detect(c5) {
    const n = c5.length, out = [];
    const high = new Array(n), low = new Array(n), close = new Array(n);
    for (let i = 0; i < n; i++) { high[i] = +c5[i][2]; low[i] = +c5[i][3]; close[i] = +c5[i][4]; }

    const hi = new Float64Array(n).fill(NaN), lo = new Float64Array(n).fill(NaN), width = new Float64Array(n).fill(NaN);
    for (let i = N_DON; i < n; i++) {
      let mx = -Infinity, mn = Infinity;
      for (let k = i - N_DON; k < i; k++) { if (high[k] > mx) mx = high[k]; if (low[k] < mn) mn = low[k]; }
      hi[i] = mx; lo[i] = mn;
      width[i] = (mx - mn) / close[i];
    }
    // percentile-rank causal de width[i] vs les WPCT valeurs précédentes (i exclu)
    function pctRank(i) {
      const start = i - WPCT;
      if (start < 0) return NaN;
      let below = 0, cnt = 0;
      for (let k = start; k < i; k++) { const v = width[k]; if (Number.isNaN(v)) continue; cnt++; if (v <= width[i]) below++; }
      if (cnt < WPCT * 0.8) return NaN;
      return 100 * below / cnt;
    }

    for (let i = N_DON + WPCT; i < n - 1; i++) {
      const wp = pctRank(i - 1); // compression mesurée AVANT la bougie de cassure (zéro futur)
      if (Number.isNaN(wp) || wp > PCTL) continue;
      if (Number.isNaN(hi[i - 1]) || Number.isNaN(lo[i - 1])) continue;
      let dir = 0;
      if (close[i] > hi[i - 1]) dir = -1;      // cassure haussière d'un canal compressé -> FADE (short)
      else if (close[i] < lo[i - 1]) dir = 1;  // cassure baissière -> FADE (long)
      if (dir) out.push({ i5: i, dir });
    }
    return out;
  }
};
