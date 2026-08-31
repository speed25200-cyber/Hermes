// BICO (Biconomy) : reclaim du bord de la zone de valeur + bougie de retournement, en régime plat
// (famille volprofile_). Même profil incrémental que volprofile_1 (288 bougies 5 m, tranches log
// 0,25 %, POC, VA 70 %). Signal : clôture précédente HORS zone de valeur, clôture courante revenue
// DEDANS, encore du côté sorti, ET bougie de retournement vers le POC (close<open pour un short —
// leçon « bougie de confirmation » PIEVERSE/Fisher), sous ADX14-15m < 25 (pas de trend day).
// Banc 30 j : worst +4,37 (IS 5,21/41, OOS 4,37/29, pfOOS 1,36) — crypto LIBRE. Voisinage cohérent
// sous adx : varecC E1 4,15 · varec nu de conf E2 2,69 · varec E1 1,84 — le trio conf+adx+E2 est le
// haut d'une petite famille, pas un pic isolé. ⚠️ sous la barre haircut-1m (+6,5) : verif90 exigée.
const ti = require("technicalindicators");
module.exports = {
  instId: "BICO-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  detect(c5) {
    const W = 288, LN = Math.log(1.0025), VA = 0.70, ADX_MAX = 25;
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
    const h15 = [], l15 = [], c15 = [], e15 = [];
    for (let i = 0; i + 2 < n; ) {
      const t0 = c5[i][0];
      if (t0 % 900000 !== 0) { i++; continue; }
      if (c5[i + 1][0] - t0 !== 300000 || c5[i + 2][0] - t0 !== 600000) { i++; continue; }
      h15.push(Math.max(c5[i][2], c5[i + 1][2], c5[i + 2][2]));
      l15.push(Math.min(c5[i][3], c5[i + 1][3], c5[i + 2][3]));
      c15.push(c5[i + 2][4]); e15.push(i + 2);
      i += 3;
    }
    const adxArr = ti.adx({ high: h15, low: l15, close: c15, period: 14 });
    const oA = c15.length - adxArr.length;
    const adx = new Array(n).fill(null);
    let m = 0, cur = null;
    for (let i = 0; i < n; i++) {
      while (m < e15.length && e15[m] <= i) { const j = m - oA; if (j >= 0) cur = adxArr[j].adx; m++; }
      adx[i] = cur;
    }
    for (let i = 300; i < n; i++) {
      const pc = poc[i], vh = vah[i], vl = val[i], vhP = vah[i - 1], vlP = val[i - 1];
      if (Number.isNaN(pc) || Number.isNaN(vh) || Number.isNaN(vhP)) continue;
      if (adx[i] === null || adx[i] >= ADX_MAX) continue;
      const cl = c5[i][4], clP = c5[i - 1][4], op = c5[i][1];
      if (clP > vhP && cl <= vh && cl > pc && cl < op) out.push({ i5: i, dir: -1 });
      else if (clP < vlP && cl >= vl && cl < pc && cl > op) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
