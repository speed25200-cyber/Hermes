// PENGU (Pudgy Penguins) : COMBO 2 ingrédients validés ailleurs = VWAP-out (reclaim de
// bande VWAP session, ingrédient du champion SOON web_vwap_1, bande 2σ = même largeur que
// SOON) x bougie de reprise (confirmation, ingrédient du champion PIEVERSE web_structure_1).
// Même recette que x3_combos_1 (TRUST) mais bande standard K=2σ au lieu de 1,5σ.
// Robustesse : plateau dense sur PENGU — vwap_conf ET vwap_range24 (l'autre confirmation
// testée) sont TOUS DEUX valide:true sur 2 exits chacun (hold12 et hold24), même bande K2 ;
// ce n'est pas un pic isolé. Crypto libre (aucun champion au registre).
module.exports = {
  instId: "PENGU-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 24 },
  detect(c5) {
    const DAY = 86400000, WARM = 36, K = 2, out = [];
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
      if (zPrev <= -K && z > -K && z < 0 && c > o) out.push({ i5: i, dir: 1 });
      else if (zPrev >= K && z < K && z > 0 && c < o) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
