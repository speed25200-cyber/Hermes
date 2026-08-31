// QTUM : Ichimoku — rejet du NUAGE réel (spanA/spanB, périodes classiques 9/26/52, déplacement 26),
// pas juste la distance au kijun (déjà testée par ti_arsenal, 0 valide / sous-champion). Le nuage
// "vu" à la bougie i vient des spans calculés à i-26 (décalage classique du tracé) : la bougie
// mèche DANS le nuage puis referme DEHORS -> rejet (mean-reversion), en accord avec "reclaim > touch".
// Robustesse : conf=0 classic marche sur E1 (6,73) ET E2 (0,97), jamais négatif ; le réglage crypto-
// adjusted (20/60/120) est plus faible en IS mais son OOS est fort sur les 4 lignes (5 à 14) -> le
// signal généralise vers l'avant, pas un artefact d'une seule cellule de grille.
const ti = require("technicalindicators");
const CONV = 9, BASE = 26, SPAN = 52, DISP = 26;

module.exports = {
  instId: "QTUM-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length, out = [];
    const high = new Array(n), low = new Array(n), close = new Array(n);
    for (let i = 0; i < n; i++) { high[i] = +c5[i][2]; low[i] = +c5[i][3]; close[i] = +c5[i][4]; }

    const raw = ti.IchimokuCloud.calculate({ high, low, conversionPeriod: CONV, basePeriod: BASE, spanPeriod: SPAN, displacement: DISP });
    const offset = n - raw.length;
    const spanA = new Float64Array(n).fill(NaN), spanB = new Float64Array(n).fill(NaN);
    for (let j = 0; j < raw.length; j++) { spanA[offset + j] = raw[j].spanA; spanB[offset + j] = raw[j].spanB; }
    const topCloud = new Float64Array(n).fill(NaN), botCloud = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const j = i - DISP;
      if (j < 0 || Number.isNaN(spanA[j]) || Number.isNaN(spanB[j])) continue;
      topCloud[i] = Math.max(spanA[j], spanB[j]);
      botCloud[i] = Math.min(spanA[j], spanB[j]);
    }

    for (let i = SPAN + DISP + 5; i < n - 1; i++) {
      if (Number.isNaN(topCloud[i]) || Number.isNaN(botCloud[i]) || Number.isNaN(topCloud[i - 1]) || Number.isNaN(botCloud[i - 1])) continue;
      // LONG : prix au-dessus du nuage, mèche dedans (rejet du support), referme au-dessus
      if (close[i - 1] > topCloud[i - 1] && low[i] <= topCloud[i] && close[i] > topCloud[i]) out.push({ i5: i, dir: 1 });
      // SHORT : prix sous le nuage, mèche dedans (rejet de résistance), referme dessous
      if (close[i - 1] < botCloud[i - 1] && high[i] >= botCloud[i] && close[i] < botCloud[i]) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
