// HYPE : SÉRIE ADAPTATIVE — pas de longueur de série fixe (5/7 bougies, déjà tout testé
// et perdant en générique) : le seuil est le percentile 85 empirique du RETOUR CUMULÉ
// des runs de HYPE LUI-MÊME (|clôture actuelle / clôture juste avant le début du run - 1|)
// sur ses 14 derniers jours glissants (CALIB 4032), recalibré chaque jour (causal). Un run
// d'au moins 2 bougies dont le retour cumulé dépasse SON propre seuil -> fade du sens du
// run. Bougie de confirmation : la bougie suivante doit continuer dans le sens du fade.
// Robustesse : IS 8,47 / OOS 8,53 quasi identiques (pas d'écart IS/OOS suspect) ; voisin
// direct sans confirmation (même pct/minLen/exit) worst 6,64 toujours positif ; famille
// minLen=3 (runs plus longs) reste positive à un niveau plus faible (2,5-3,9) — pas un
// pic isolé. Rapport : tools/rapports/x2_adaptatif_scan2_resultats.json.
const CALIB = 4032, STEP = 288, PCT = 85, MIN_LEN = 2;

function percentileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return Infinity;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sorted[idx];
}

module.exports = {
  instId: "HYPE-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length;
    const out = [];
    if (n < CALIB + 500) return out;
    const c = new Float64Array(n);
    for (let i = 0; i < n; i++) c[i] = c5[i][4];

    const runLen = new Int32Array(n), runRetAbs = new Float64Array(n), runSign = new Int8Array(n);
    let prevSign = 0;
    for (let i = 1; i < n; i++) {
      const ret = c[i] / c[i - 1] - 1;
      const s = ret > 0 ? 1 : (ret < 0 ? -1 : prevSign);
      runLen[i] = (s === prevSign && s !== 0) ? runLen[i - 1] + 1 : 1;
      runSign[i] = s; prevSign = s;
      const base = c[Math.max(0, i - runLen[i])];
      runRetAbs[i] = Math.abs(c[i] / base - 1) * 100;
    }

    const nBlocks = Math.max(0, Math.floor((n - CALIB) / STEP) + 1);
    const thSerie = new Float64Array(nBlocks);
    for (let b = 0; b < nBlocks; b++) {
      const d = CALIB + b * STEP, ws = d - CALIB, we = d;
      const ser = Array.from(runRetAbs.slice(ws, we)).sort((a, b2) => a - b2);
      thSerie[b] = percentileSorted(ser, PCT);
    }

    for (let i = CALIB; i < n - 3; i++) {
      if (runLen[i] < MIN_LEN) continue;
      const b = Math.min(nBlocks - 1, Math.floor((i - CALIB) / STEP));
      if (b < 0) continue;
      const ths = thSerie[b];
      if (!isFinite(ths) || runRetAbs[i] <= ths) continue;
      const dir = runSign[i] > 0 ? -1 : 1;
      const j = i + 1;
      const moved = dir > 0 ? c[j] > c[i] : c[j] < c[i];
      if (moved) out.push({ i5: j, dir });
    }
    return out;
  }
};
