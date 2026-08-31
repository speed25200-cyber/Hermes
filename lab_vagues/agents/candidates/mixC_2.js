// mixC_2 — BREV : Force Index(13) au rang percentile EXTRÊME sur 24h glissantes (pression acheteuse ou
// vendeuse anormale par rapport au régime récent de l'actif — rang plutôt que seuil absolu, car l'échelle
// brute prix×volume du Force Index n'est pas comparable d'un actif à l'autre) CONFIRMÉ par la dernière
// bougie qui montre déjà un rejet net (mèche >= 2× le corps, côté rejet cohérent avec le sens du fade).
// Logique en une phrase : quand la pression achat/vente (Force Index lissé 13) atteint un extrême jamais vu
// depuis 24h ET que la bougie qui l'a produite montre déjà un rejet mèche/corps marqué, c'est un dernier
// sursaut à contre-courant qu'on fade.
// Réglages retenus par le scanner mix_scan_mixC.js : FORCE13_PCTL setting0 (rang <=10 / >=90 sur 288
// bougies = 24h) × WICK_RATIO setting0 (mèche >= 2× corps). Exits standard E1.
// Autonome : tout le calcul est ici (Force Index via "technicalindicators", le reste en calcul manuel causal).
const { ForceIndex } = require("technicalindicators");

const R288 = 288; // ~24h de bougies 5m
const PCTL_LO = 10, PCTL_HI = 90;
const WICK_TH = 2;

function alignEnd(n, arr) {
  const pad = n - arr.length;
  const out = new Array(Math.max(0, pad)).fill(null);
  for (let k = 0; k < arr.length; k++) out.push(arr[k]);
  return out;
}

// Rang percentile causal (0-100) de vals[i] parmi la fenêtre [i-window+1, i] (incluse).
function rollingPercentileRank(vals, window) {
  const n = vals.length, out = new Array(n).fill(null);
  for (let i = window - 1; i < n; i++) {
    let below = 0;
    const v = vals[i];
    for (let k = i - window + 1; k <= i; k++) if (vals[k] <= v) below++;
    out[i] = 100 * below / window;
  }
  return out;
}

module.exports = {
  instId: "BREV-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length;
    const open = c5.map(b => b[1]);
    const high = c5.map(b => b[2]);
    const low = c5.map(b => b[3]);
    const close = c5.map(b => b[4]);
    const vol = c5.map(b => b[5]);

    const fi = ForceIndex.calculate({ close, volume: vol, period: 13 });
    const fiAligned = alignEnd(n, fi).map(v => (v == null ? 0 : v));
    const fiPctl = rollingPercentileRank(fiAligned, R288);

    const out = [];
    for (let i = 100; i < n; i++) {
      const p = fiPctl[i];
      if (p == null) continue;
      const forceLong = p <= PCTL_LO, forceShort = p >= PCTL_HI;
      if (!forceLong && !forceShort) continue;

      const body = Math.max(Math.abs(close[i] - open[i]), close[i] * 1e-6);
      const upperWick = high[i] - Math.max(open[i], close[i]);
      const lowerWick = Math.min(open[i], close[i]) - low[i];
      const ratioUp = upperWick / body, ratioDown = lowerWick / body;
      const wickShort = ratioUp >= WICK_TH && ratioUp > ratioDown;
      const wickLong = ratioDown >= WICK_TH && ratioDown > ratioUp;

      if (forceLong && wickLong) out.push({ i5: i, dir: 1 });
      else if (forceShort && wickShort) out.push({ i5: i, dir: -1 });
    }
    return out;
  },
};
