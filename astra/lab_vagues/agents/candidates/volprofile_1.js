// NEIRO : rejet du bord de la zone de valeur du profil de volume 24 h, POC stable (famille volprofile_).
// Profil incrémental : 288 bougies 5 m glissantes, tranches de prix LOG de 0,25 %, volume de chaque
// bougie réparti uniformément sur les tranches couvertes par [low, high] ; POC = tranche au volume max,
// zone de valeur = 70 % du volume par expansion depuis le POC. Signal : la clôture précédente était
// SORTIE de la zone de valeur, la clôture courante y RENTRE (reclaim du bord), encore du côté sorti
// → fade vers le POC. Filtre : POC stable (amplitude <= 0,5 % sur la dernière heure) = profil accepté,
// le fade vers la valeur ne se joue qu'en marché équilibré (doctrine volume profile).
// Banc 30 j : worst +7,01 (IS 7,01/41, OOS 10,95/37, pfOOS 2,06) — bat le champion NEIRO en place
// (tv_transforms_3, 6,95). Voisinage très dense : varec nu 6,09 · +conf 6,43 · varej 4,2-4,4 ·
// règle 80 % 4,52 · W576 4,2+ — toutes les lectures profil sont positives sur NEIRO ;
// la variante ADX<25 double l'espérance (16,4/21,5) mais n=44 < 60.
module.exports = {
  instId: "NEIRO-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const W = 288, LN = Math.log(1.0025), VA = 0.70, STAB_BARS = 12, STAB_TOL = 0.005;
    const n = c5.length, out = [];
    const poc = new Float64Array(n).fill(NaN), vah = new Float64Array(n).fill(NaN), val = new Float64Array(n).fill(NaN);
    const bucketOf = p => Math.floor(Math.log(p) / LN);
    const parts = c => {
      const v = Math.max(c[5], 0);
      if (!(v > 0)) return null;
      const bLo = bucketOf(c[3]), bHi = bucketOf(c[2]);
      return { bLo, bHi, share: v / (bHi - bLo + 1) };
    };
    const vol = new Map();
    for (let i = 0; i < n; i++) {
      const add = parts(c5[i]);
      if (add) for (let b = add.bLo; b <= add.bHi; b++) vol.set(b, (vol.get(b) || 0) + add.share);
      if (i >= W) {
        const rem = parts(c5[i - W]);
        if (rem) for (let b = rem.bLo; b <= rem.bHi; b++) {
          const nv = (vol.get(b) || 0) - rem.share;
          if (nv <= 1e-9) vol.delete(b); else vol.set(b, nv);
        }
      }
      if (i < W - 1 || vol.size === 0) continue;
      let pocB = 0, maxV = -1, total = 0, minB = Infinity, maxB = -Infinity;
      for (const [b, v] of vol) {
        total += v;
        if (v > maxV) { maxV = v; pocB = b; }
        if (b < minB) minB = b;
        if (b > maxB) maxB = b;
      }
      if (!(total > 0)) continue;
      let lo = pocB, hi = pocB, cum = maxV;
      const cible = VA * total;
      while (cum < cible && (lo > minB || hi < maxB)) {
        const vUp = hi < maxB ? (vol.get(hi + 1) || 0) : -1;
        const vDn = lo > minB ? (vol.get(lo - 1) || 0) : -1;
        if (vUp >= vDn) { hi++; cum += vUp; } else { lo--; cum += vDn; }
      }
      poc[i] = Math.exp((pocB + 0.5) * LN); vah[i] = Math.exp((hi + 1) * LN); val[i] = Math.exp(lo * LN);
    }
    const pocStable = i => {
      let mn = Infinity, mx = -Infinity;
      for (let k = i - STAB_BARS; k <= i; k++) {
        const v = poc[k];
        if (Number.isNaN(v)) return false;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      return mx / mn - 1 <= STAB_TOL;
    };
    for (let i = 300; i < n; i++) {
      const pc = poc[i], vh = vah[i], vl = val[i], vhP = vah[i - 1], vlP = val[i - 1];
      if (Number.isNaN(pc) || Number.isNaN(vh) || Number.isNaN(vhP)) continue;
      const cl = c5[i][4], clP = c5[i - 1][4];
      if (clP > vhP && cl <= vh && cl > pc && pocStable(i)) out.push({ i5: i, dir: -1 });
      else if (clP < vlP && cl >= vl && cl < pc && pocStable(i)) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
