// wr_exits_2 — ACT (base LIVE : x4_reliquat_1.js, fade de cassure d'un canal Donchian(20)
// compressé, percentile bas de largeur sur 288 barres).
// LEVIER SORTIES SEUL : detect() intact. TP +60% -> +30% de marge, trail activé à mi-chemin
// (+15%, callback 5% inchangé), hold 8h conservé (h12 quasi identique, testé = plateau).
// AVANT (live x4_reliquat_1) tp60/act20/hold8  : wr 73,5/71,4  esp +7,90/+11,96 (worst = 7,90)
// APRÈS (wr_exits_2)         tp30/act15/hold8  : wr 76,4/69,6  esp +6,83/+6,52  (worst = 6,52, 83% de l'avant)
// Plateau : voisin tp30/act15/hold12 aussi valide (wr 79,2/69,6, esp 7,37/6,02) — 2 holds
// adjacents tiennent tous les deux, pas un pic isolé.
const N_DON = 20, PCTL = 15, WPCT = 288;

module.exports = {
  instId: "ACT-USDT-SWAP",
  exits: { tp: 0.30, sl: 0.30, act: 0.15, cb: 0.05, holdH: 8 },
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
