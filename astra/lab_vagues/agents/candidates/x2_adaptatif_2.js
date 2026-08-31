// DASH : RANGE ADAPTATIF — pas de seuil absolu (ex. range > X %) : le seuil est le
// percentile 93 empirique du RANGE (H-L)/C de DASH LUI-MÊME sur ses 14 derniers jours
// glissants (CALIB 4032 bougies), recalibré chaque jour (causal, fenêtre [d-4032, d)).
// Une bougie dont le range dépasse SON propre seuil est une bougie extrême pour CETTE
// crypto -> fade de son sens (bougie haussière extrême -> short, baissière -> long).
// Bougie de confirmation : la bougie suivante doit continuer dans le sens du fade.
// Robustesse : la recette « bougie de confirmation + exit E1 » est gagnante quel que
// soit le percentile (85 à 97) et le filtre volume (on/off) — plateau dense d'environ
// 14 cases positives qui décroissent progressivement de 8,02 à 0,5 avant de croiser 0 ;
// seul E2 (hold plus court) casse l'edge, cohérent avec la leçon labo « hold 8-12h+
// domine » déjà confirmée sur d'autres familles. Rapport :
// tools/rapports/x2_adaptatif_scan2_resultats.json.
const CALIB = 4032, STEP = 288, PCT = 93;

function percentileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return Infinity;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sorted[idx];
}

module.exports = {
  instId: "DASH-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length;
    const out = [];
    if (n < CALIB + 500) return out;
    const o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n);
    for (let i = 0; i < n; i++) { o[i] = c5[i][1]; h[i] = c5[i][2]; l[i] = c5[i][3]; c[i] = c5[i][4]; }
    const rangePct = new Float64Array(n);
    for (let i = 0; i < n; i++) rangePct[i] = (h[i] - l[i]) / c[i] * 100;

    const nBlocks = Math.max(0, Math.floor((n - CALIB) / STEP) + 1);
    const thRange = new Float64Array(nBlocks);
    for (let b = 0; b < nBlocks; b++) {
      const d = CALIB + b * STEP, ws = d - CALIB, we = d;
      const rng = Array.from(rangePct.slice(ws, we)).sort((a, b2) => a - b2);
      thRange[b] = percentileSorted(rng, PCT);
    }

    for (let i = CALIB; i < n - 3; i++) {
      const b = Math.min(nBlocks - 1, Math.floor((i - CALIB) / STEP));
      if (b < 0) continue;
      const thr = thRange[b];
      if (!isFinite(thr) || rangePct[i] <= thr) continue;
      let dir = 0;
      if (c[i] > o[i]) dir = -1; else if (c[i] < o[i]) dir = 1;
      if (!dir) continue;
      const j = i + 1;
      const moved = dir > 0 ? c[j] > c[i] : c[j] < c[i];
      if (moved) out.push({ i5: j, dir });
    }
    return out;
  }
};
