// fable1_1 — ACT (Achain) : detect INTACT de x4_reliquat_1 (fade de cassure d'un canal Donchian(20)
// compressé — percentile bas 15 de la largeur sur 288 barres), converti en HAUT WINRATE par
// sorties courtes : TP +20 % de marge, trail activé à mi-chemin (+10 %, cb 5 %), hold 24 h, SL 30 %.
// Logique en une phrase : l'entrée mean-reverting prouvée BI-ÉPOQUE (+0,45/+3,94 avec sorties longues)
// encaisse tôt (tp<<sl) — le winrate vient de la géométrie, l'espérance vient de l'edge d'entrée.
// Banc 30 j (test_harness) : wr 76,6/81,5 · esp +1,26/+5,89 · n 64+27.
// Fenêtres vierges (scan fable1, data90 coupure 30 j / data180) :
//   60 j récents  : wr 74,5 · esp +0,66 · n 188
//   90-180 j      : wr 76,8 · esp +1,33 · n 237
// Plateau (tools/rapports/fable1_scan_resultats.json) : 8/18 cellules de la grille passent les
// 3 fenêtres (tp15_noTrail h8/12/24, tp20_noTrail h24, tp20_act10 h8/12/24, tp30_act15 h12/24) ;
// la même recette tp30_act15_h12 passe AUSSI sur GPS (fable1_2) = recette commune, pas un pic.
// ⚠️ Risque connu : trail cb5 = biais 5m→1m (~−15 % d'esp relatif, chantier 1 m) — marges wr ≈ +10 pts.
const N_DON = 20, PCTL = 15, WPCT = 288;

module.exports = {
  instId: "ACT-USDT-SWAP",
  exits: { tp: 0.20, sl: 0.30, act: 0.10, cb: 0.05, holdH: 24 },
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
