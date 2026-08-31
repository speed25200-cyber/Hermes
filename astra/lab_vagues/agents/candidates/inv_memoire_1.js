// MNIV — MÉMOIRE DES NIVEAUX (invention) — ICP, lecture « matched » (le niveau dans SON rôle)
// Carte causale des niveaux : tranches log de 0,25 %. Chaque pivot fractal confirmé (aile 6 bougies,
// confirmé 6 bougies après l'extrême) dépose w = min(vol/moyVol96, 4) dans sa tranche et ses 2
// voisines (demi-poids : un niveau est une zone) ; mémoire décayée en demi-vie 24 h → poids du
// niveau = pivots × récence × volume. Côtés séparés : mémoire-support (pivots BAS) / mémoire-résistance (pivots HAUTS).
// Lecture (2 phrases) : quand une vraie impulsion 15 min (>= 3× le bruit moyen) amène le prix au
// contact (<= 0,6 %) d'un niveau à mémoire-support (chute) ou mémoire-résistance (montée) >= 1,5 pivots
// efficaces dont il était éloigné 30 min avant, ET que la vitesse s'éteint à l'approche
// (|15 min courantes| <= 50 % des 15 min précédentes), le niveau se rappelle au marché : on fade
// l'approche (long sur le support, short sous la résistance). Zéro look-ahead.
const L = 6;          // aile du pivot fractal
const HALF = 24;      // demi-vie de la mémoire (heures)
const M = 1.5;        // seuil de mémoire du côté cohérent (pivots efficaces)
const D = 0.006;      // distance de contact au niveau (log)
const DEC = 0.5;      // extinction de vitesse exigée
const MINK = 3;       // approche réelle : |v 15 min| >= 3 × bruit moyen par bougie
const SMOOTH = 1;     // dépôt aussi sur les tranches voisines (demi-poids)
const LNB = Math.log(1.0025);
const WREF = 96, VCAP = 4, S = 3, F = 6, WARM = 600;

function precalc(c5) {
  const n = c5.length;
  const avgV = new Float64Array(n).fill(NaN), avgA = new Float64Array(n).fill(NaN);
  let sv = 0, sa = 0; const qv = [], qa = [];
  for (let i = 0; i < n; i++) {
    if (qv.length >= WREF) { avgV[i] = sv / qv.length; avgA[i] = sa / qa.length; }
    const v = +c5[i][5] || 0;
    qv.push(v); sv += v; if (qv.length > WREF) sv -= qv.shift();
    if (i > 0) { const d = Math.abs(c5[i][4] - c5[i - 1][4]); qa.push(d); sa += d; if (qa.length > WREF) sa -= qa.shift(); }
  }
  return { avgV, avgA };
}

function pivots(c5) {
  const out = [], n = c5.length;
  for (let j = L; j < n - L; j++) {
    const h = c5[j][2], l = c5[j][3];
    let ph = true, pl = true;
    for (let k = 1; k <= L && (ph || pl); k++) {
      if (c5[j - k][2] >= h || c5[j + k][2] > h) ph = false;
      if (c5[j - k][3] <= l || c5[j + k][3] < l) pl = false;
    }
    if (ph) out.push({ conf: j + L, j, price: h, isHigh: true });
    if (pl) out.push({ conf: j + L, j, price: l, isHigh: false });
  }
  out.sort((a, b) => a.conf - b.conf);
  return out;
}

module.exports = {
  instId: "ICP-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length;
    const pre = precalc(c5), pvs = pivots(c5);
    const decay = Math.pow(0.5, 1 / (HALF * 12));
    const bins = new Map(); // bin -> [sLow, sHigh, lastIdx]
    const out = [];
    const lnC = new Float64Array(n);
    for (let i = 0; i < n; i++) lnC[i] = Math.log(c5[i][4]);
    const dep = (b, w, isHigh, j) => {
      let e = bins.get(b);
      if (e) { const d = Math.pow(decay, j - e[2]); e[0] *= d; e[1] *= d; e[2] = j; }
      else { e = [0, 0, j]; bins.set(b, e); }
      if (isHigh) e[1] += w; else e[0] += w;
    };
    let pi = 0;
    for (let i = 0; i < n; i++) {
      while (pi < pvs.length && pvs[pi].conf === i) {
        const p = pvs[pi++];
        const va = pre.avgV[p.j];
        const w = (va > 0 && !Number.isNaN(va)) ? Math.min((+c5[p.j][5] || 0) / va, VCAP) : 1;
        const b = Math.floor(Math.log(p.price) / LNB);
        dep(b, w, p.isHigh, p.j);
        if (SMOOTH) { dep(b - 1, w / 2, p.isHigh, p.j); dep(b + 1, w / 2, p.isHigh, p.j); }
      }
      if (i < WARM || i >= n - 2) continue;
      const noise = pre.avgA[i];
      if (!(noise > 0)) continue;
      const vPrev = c5[i - S][4] - c5[i - 2 * S][4];
      const vNow = c5[i][4] - c5[i - S][4];
      if (Math.abs(vPrev) < MINK * noise) continue;
      const dirApp = vPrev > 0 ? 1 : -1;
      const lnc = lnC[i], b0 = Math.floor(lnc / LNB);
      let bestB = -1, bestTot = 0, bestE = null;
      for (let b = b0 - 3; b <= b0 + 3; b++) {
        const e = bins.get(b);
        if (!e) continue;
        const ctr = (b + 0.5) * LNB, dd = ctr - lnc;
        if (Math.abs(dd) > D) continue;
        if (dirApp < 0 && dd > 0.5 * LNB) continue;
        if (dirApp > 0 && dd < -0.5 * LNB) continue;
        const dc = Math.pow(decay, i - e[2]);
        const tot = (e[0] + e[1]) * dc;
        if (tot > bestTot) { bestTot = tot; bestB = b; bestE = [e[0] * dc, e[1] * dc]; }
      }
      if (bestB < 0) continue;
      const ctr = (bestB + 0.5) * LNB;
      if (Math.abs(lnC[i - F] - ctr) <= D) continue;
      const sMatch = dirApp < 0 ? bestE[0] : bestE[1];
      if (sMatch < M) continue;
      if (Math.abs(vNow) > DEC * Math.abs(vPrev)) continue;
      out.push({ i5: i, dir: -dirApp });
    }
    return out;
  }
};
