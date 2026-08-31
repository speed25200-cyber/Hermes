// OPN (OpenLedger) : Parabolic SAR — distance signée (close-SAR)/close en %, seuil ADAPTATIF par
// percentile PROPRE à la crypto (recalibré chaque jour calendaire UTC sur les 14 j précédentes,
// leçon x2_adaptatif : 14j > seuil absolu générique) ; entrée en RECLAIM = la surextension (percentile
// >=90 de |distance|) qui RETOMBE sous le seuil la bougie suivante -> l'excès est épuisé, fade vers le SAR.
// Reliquat classique jamais porté proprement (README) : la distance au SAR (surextension), pas le
// "flip après excès" déjà testé par ti_arsenal (11 valides, best PIEVERSE 7,61 < son champion).
// Robustesse : mode RECLAIM dense sur OPN — P90/P95 × step classic/fast × E1/E2 = 8 cellules valides,
// toutes positives (0,03 à 7,43) ; le mode franchissement (X) casse en OOS sur les mêmes réglages
// (P95 X : -5,9/-6,4/-6,8) -> re-confirme "reclaim > touch" (9e+ fois dans ce labo), pas un signal contradictoire.
const ti = require("technicalindicators");
const STEP = 0.02, MAX = 0.2, PCTL = 90, CALIB = 4032; // 14 j en barres 5 m

module.exports = {
  instId: "OPN-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length, out = [];
    const high = new Array(n), low = new Array(n), close = new Array(n), ts = new Array(n);
    for (let i = 0; i < n; i++) { high[i] = +c5[i][2]; low[i] = +c5[i][3]; close[i] = +c5[i][4]; ts[i] = +c5[i][0]; }

    const psar = Float64Array.from(ti.PSAR.calculate({ high, low, step: STEP, max: MAX }));
    const dist = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (!Number.isNaN(psar[i])) dist[i] = (close[i] - psar[i]) / close[i] * 100;

    // percentile-rank causal de |dist| vs la distribution [d-CALIB, d) du jour calendaire courant
    const dayIdx = ts.map(t => Math.floor(t / 86400000));
    const pr = new Float64Array(n).fill(NaN);
    const startsOfDay = [];
    let dCur = null;
    for (let i = 0; i < n; i++) if (dCur !== dayIdx[i]) { dCur = dayIdx[i]; startsOfDay.push(i); }
    for (const s0 of startsOfDay) {
      const from = Math.max(0, s0 - CALIB);
      if (s0 - from < CALIB * 0.5) continue;
      const arr = [];
      for (let k = from; k < s0; k++) { const v = Math.abs(dist[k]); if (!Number.isNaN(v)) arr.push(v); }
      if (arr.length < 200) continue;
      arr.sort((a, b) => a - b);
      let i = s0;
      while (i < n && dayIdx[i] === dayIdx[s0]) {
        const v = Math.abs(dist[i]);
        if (!Number.isNaN(v)) {
          let lo = 0, hi = arr.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
          pr[i] = 100 * lo / arr.length;
        }
        i++;
      }
    }

    for (let i = 1; i < n - 1; i++) {
      if (Number.isNaN(pr[i]) || Number.isNaN(pr[i - 1]) || Number.isNaN(dist[i])) continue;
      const wasExtreme = pr[i - 1] >= PCTL, isExtreme = pr[i] >= PCTL;
      if (!(wasExtreme && !isExtreme)) continue; // reclaim : sortie de la zone de surextension
      const dir = dist[i] > 0 ? -1 : 1; // surextension -> fade vers le SAR
      out.push({ i5: i, dir });
    }
    return out;
  }
};
