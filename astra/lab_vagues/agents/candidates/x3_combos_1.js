// TRUST : COMBO 2 ingrédients validés ailleurs = VWAP-out (reclaim de bande VWAP session,
// ingrédient du champion SOON web_vwap_1) x bougie de reprise (confirmation, ingrédient du
// champion PIEVERSE web_structure_1) — jamais croisés ensemble avant cet agent.
// Bande resserrée à 1,5σ (voisin de grille du K=2 champion) : le prix referme DANS la bande
// ET la bougie du signal clôture dans le sens du retour (corps, pas mèche) -> mean-reversion.
// Robustesse : plateau EXCEPTIONNEL sur TRUST — keltner_conf, keltner_range24, vwap_conf,
// vwap_range24, vwap_vol2x sont TOUS positifs sur plusieurs exits/paramètres (mult 2/3, K 1,5/2) ;
// cette ligne (K1,5 + bougie conf, hold24) est la meilleure valide:true (n>=60).
// Crypto libre (Trust, listée OKX perp nov. 2025, aucun champion au registre).
module.exports = {
  instId: "TRUST-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const DAY = 86400000, WARM = 36, K = 1.5, out = [];
    const N = c5.length;
    const vwap = new Array(N).fill(null), sig = new Array(N).fill(null), bod = new Array(N).fill(0);
    let day = -1, cv = 0, cpv = 0, cpv2 = 0, k = 0;
    for (let i = 0; i < N; i++) {
      const d = Math.floor(c5[i][0] / DAY);
      if (d !== day) { day = d; cv = 0; cpv = 0; cpv2 = 0; k = 0; }
      const tp = (c5[i][2] + c5[i][3] + c5[i][4]) / 3, v = Math.max(c5[i][5], 0);
      cv += v; cpv += tp * v; cpv2 += tp * tp * v; k++;
      bod[i] = k;
      if (cv > 0) { const m = cpv / cv; vwap[i] = m; sig[i] = Math.sqrt(Math.max(cpv2 / cv - m * m, 0)); }
    }
    for (let i = 101; i < N; i++) {
      const w = vwap[i], s = sig[i];
      if (w == null || !(s > 0) || bod[i] < WARM) continue;
      if (vwap[i - 1] == null || !(sig[i - 1] > 0)) continue;
      const z = (c5[i][4] - w) / s, zPrev = (c5[i - 1][4] - vwap[i - 1]) / sig[i - 1];
      const o = c5[i][1], c = c5[i][4];
      if (zPrev <= -K && z > -K && z < 0 && c > o) out.push({ i5: i, dir: 1 });   // reclaim + bougie de reprise haussière
      else if (zPrev >= K && z < K && z > 0 && c < o) out.push({ i5: i, dir: -1 }); // symétrique baissière
    }
    return out;
  }
};
