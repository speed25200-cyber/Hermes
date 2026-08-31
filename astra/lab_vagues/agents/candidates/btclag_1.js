// CAP : BTC lead-lag — fade de l'excès relatif au BTC (signal cross-asset, famille btclag_).
// Logique : excès = rendement log CAP sur 4 h − β×rendement log BTC sur 4 h (β = régression
// des rendements 5 m sur 48 h glissantes) ; z-score de l'excès sur 24 h passées ; quand le
// z RECLAIM (repasse sous +2 après excès, encore positif) → short l'excès, symétrique long.
// Robustesse : plateau zr/T2/H48 = les 4 cases (B 288/576 × E1/E2) toutes positives (4,45-8,01) ;
// ⚠️ l'edge est propre à l'horizon 4 h (H12/H24 négatifs sur CAP). Exit fondateur E1.
const fs = require("fs");
const path = require("path");
const B = 576, H = 48, W = 288, T = 2;

function chargerBtc() {
  const map = new Map();
  for (const dossier of ["data90", "data"]) {
    const f = path.join(__dirname, "..", "..", dossier, "BTC-USDT-SWAP.json");
    if (fs.existsSync(f)) for (const c of JSON.parse(fs.readFileSync(f))) map.set(c[0], c[4]);
  }
  if (!map.size) throw new Error("BTC-USDT-SWAP introuvable dans data/ ou data90/");
  return map;
}

module.exports = {
  instId: "CAP-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const btcMap = chargerBtc();
    const n = c5.length;
    const La = new Float64Array(n), Lb = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      La[i] = Math.log(c5[i][4]);
      const b = btcMap.get(c5[i][0]);
      Lb[i] = b === undefined ? NaN : Math.log(b);
    }
    const ra = new Float64Array(n), rb = new Float64Array(n);
    for (let i = 1; i < n; i++) { ra[i] = La[i] - La[i - 1]; rb[i] = Lb[i] - Lb[i - 1]; }
    // β glissante sur B rendements 5 m
    const beta = new Float64Array(n).fill(NaN);
    let Sa = 0, Sb = 0, Sab = 0, Sbb = 0, bad = 0;
    for (let i = 1; i < n; i++) {
      const va = ra[i], vb = rb[i];
      if (Number.isNaN(va) || Number.isNaN(vb)) bad++; else { Sa += va; Sb += vb; Sab += va * vb; Sbb += vb * vb; }
      const j = i - B;
      if (j >= 1) {
        const wa = ra[j], wb = rb[j];
        if (Number.isNaN(wa) || Number.isNaN(wb)) bad--; else { Sa -= wa; Sb -= wb; Sab -= wa * wb; Sbb -= wb * wb; }
      }
      if (i >= B && bad === 0) {
        const cov = Sab / B - (Sa / B) * (Sb / B), vr = Sbb / B - (Sb / B) * (Sb / B);
        if (vr > 1e-12) beta[i] = cov / vr;
      }
    }
    // excès sur H bougies puis z-score sur les W bougies PASSÉES (i exclu) — zéro look-ahead
    const exc = new Float64Array(n).fill(NaN);
    for (let i = B; i < n; i++) {
      if (i < H || Number.isNaN(beta[i]) || Number.isNaN(Lb[i]) || Number.isNaN(Lb[i - H])) continue;
      exc[i] = (La[i] - La[i - H]) - beta[i] * (Lb[i] - Lb[i - H]);
    }
    const z = new Float64Array(n).fill(NaN);
    let S = 0, S2 = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const j = i - 1;
      if (j >= 0 && !Number.isNaN(exc[j])) { S += exc[j]; S2 += exc[j] * exc[j]; cnt++; }
      const k = i - W - 1;
      if (k >= 0 && !Number.isNaN(exc[k])) { S -= exc[k]; S2 -= exc[k] * exc[k]; cnt--; }
      if (cnt >= W * 0.9 && !Number.isNaN(exc[i])) {
        const m = S / cnt, v = S2 / cnt - m * m;
        if (v > 1e-18) z[i] = (exc[i] - m) / Math.sqrt(v);
      }
    }
    // reclaim : le z repasse sous le seuil mais l'excès est encore du même côté → fade
    const out = [], i0 = B + W + H + 2;
    for (let i = Math.max(i0, 1); i < n; i++) {
      const zi = z[i], zp = z[i - 1];
      if (Number.isNaN(zi) || Number.isNaN(zp)) continue;
      if (zp > T && zi <= T && zi > 0) out.push({ i5: i, dir: -1 });
      else if (zp < -T && zi >= -T && zi < 0) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
