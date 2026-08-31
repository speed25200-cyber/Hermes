// 2Z (DoubleZero) : mèche de rejet du bord de la zone de valeur du profil 24 h (famille volprofile_).
// Même profil incrémental que volprofile_1 (288 bougies 5 m, tranches log 0,25 %, POC, VA 70 %).
// Signal « rejet classique du bord » : la bougie PERCE le bord de la zone de valeur en séance (mèche
// au-delà du VAH/VAL) mais REFERME dedans la même bougie, clôture encore du côté sorti du POC, et la
// clôture précédente était déjà dans la zone (excursion en mèche pure = stops pris puis rejet) → fade
// vers le POC. Aucun filtre — le signal nu est la meilleure ligne 2Z valide.
// Banc 30 j : worst +4,41 (IS 4,41/43, OOS 4,76/26, pfOOS 1,62) — crypto LIBRE (DoubleZero, vraie crypto,
// infra réseau Solana). Voisinage : varej stab E2 2,80 valide · varej adx OOS 10,15 (n<60) · pocrec
// stab W576 8-11 mais n~20. ⚠️ sous la barre haircut-1m (+6,5) : verif90 très nette exigée avant promotion.
module.exports = {
  instId: "2Z-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  detect(c5) {
    const W = 288, LN = Math.log(1.0025), VA = 0.70;
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
    for (let i = 300; i < n; i++) {
      const pc = poc[i], vh = vah[i], vl = val[i];
      if (Number.isNaN(pc) || Number.isNaN(vh)) continue;
      const cl = c5[i][4], clP = c5[i - 1][4];
      if (c5[i][2] > vh && cl <= vh && cl > pc && clP <= vh) out.push({ i5: i, dir: -1 });
      else if (c5[i][3] < vl && cl >= vl && cl < pc && clP >= vl) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
