// XRP : MÈCHE ADAPTATIVE — pas de seuil absolu (ex. mèche > 0.4 %) : le seuil est le
// percentile 95 empirique des MÈCHES DOMINANTES de XRP LUI-MÊME sur ses 14 derniers jours
// glissants (CALIB 4032 bougies), recalibré chaque jour (causal : la fenêtre du bloc-jour d
// couvre [d-4032, d), jamais la journée courante). Mèche basse dominante > seuil -> long
// (rejet des prix bas) ; mèche haute dominante > seuil -> short. Confirmation double :
// volume au-dessus du percentile 85 de SON volume (même calibrage) + bougie suivante qui
// continue dans le sens du fade (leçon « bougie de confirmation » répétée dans le labo).
// Robustesse : famille dense sur XRP — 42/80 cases de la grille (pct 85-97 × volConfirm
// 0/1 × CALIB 7j/14j × exit E1/E2) espIS>0 ET espOOS>0 simultanément (53 %), E1 et E2
// marchent tous les deux. Rapport : tools/rapports/x2_adaptatif_scan2_resultats.json.
const CALIB = 4032, STEP = 288, PCT = 95, VOL_PCT = 85;

function percentileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return Infinity;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sorted[idx];
}

module.exports = {
  instId: "XRP-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length;
    const out = [];
    if (n < CALIB + 500) return out;
    const o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n), volCcy = new Float64Array(n);
    for (let i = 0; i < n; i++) { o[i] = c5[i][1]; h[i] = c5[i][2]; l[i] = c5[i][3]; c[i] = c5[i][4]; volCcy[i] = c5[i][6]; }
    const lowerW = new Float64Array(n), upperW = new Float64Array(n), wickDom = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const lw = (Math.min(o[i], c[i]) - l[i]) / c[i] * 100;
      const uw = (h[i] - Math.max(o[i], c[i])) / c[i] * 100;
      lowerW[i] = lw; upperW[i] = uw; wickDom[i] = Math.max(lw, uw);
    }

    const nBlocks = Math.max(0, Math.floor((n - CALIB) / STEP) + 1);
    const thWick = new Float64Array(nBlocks), thVol = new Float64Array(nBlocks);
    for (let b = 0; b < nBlocks; b++) {
      const d = CALIB + b * STEP, ws = d - CALIB, we = d;
      const wick = Array.from(wickDom.slice(ws, we)).sort((a, b2) => a - b2);
      const vol = Array.from(volCcy.slice(ws, we)).sort((a, b2) => a - b2);
      thWick[b] = percentileSorted(wick, PCT);
      thVol[b] = percentileSorted(vol, VOL_PCT);
    }

    for (let i = CALIB; i < n - 3; i++) {
      const b = Math.min(nBlocks - 1, Math.floor((i - CALIB) / STEP));
      if (b < 0) continue;
      const thw = thWick[b], thv = thVol[b];
      if (!isFinite(thw)) continue;
      if (!(volCcy[i] > thv)) continue;
      let dir = 0;
      if (lowerW[i] > thw) dir = 1; else if (upperW[i] > thw) dir = -1;
      if (!dir) continue;
      const j = i + 1;
      const moved = dir > 0 ? c[j] > c[i] : c[j] < c[i];
      if (moved) out.push({ i5: j, dir });
    }
    return out;
  }
};
