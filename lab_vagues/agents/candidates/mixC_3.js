// mixC_3 — OP : Aroon(14) en extrême unilatéral (oscillateur up-down >= ±90) CONFIRMÉ par la dernière
// bougie qui montre un rejet EXTRÊME (mèche >= 3× le corps — filtre plus strict que mixC_1, côté rejet
// cohérent avec le sens du fade).
// Logique en une phrase : quand une tendance est tellement unilatérale qu'Aroon est à son extrême ET que la
// toute dernière bougie montre déjà un rejet mèche/corps TRÈS marqué (mèche triple du corps) dans le sens
// inverse, c'est un épuisement qu'on fade.
// Réglages retenus par le scanner mix_scan_mixC.js : AROON_OSC setting1 (seuil ±90) × WICK_RATIO setting1
// (mèche >= 3× corps). Exits standard E1. Même famille que mixC_1 (Aroon×mèche) mais crypto et réglage de
// mèche différents, confirmée indépendamment plateau+valide par le scanner sur cette crypto.
// Autonome : tout le calcul est ici, aucune dépendance au labo (seulement les tableaux OHLCV, pas de lib externe).
const AROON_PERIOD = 14, AROON_TH = 90;
const WICK_TH = 3; // mèche >= 3x le corps (plus strict que mixC_1)

function aroonOsc(high, low, period) {
  const n = high.length;
  const osc = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    let iMaxH = i, vMaxH = high[i];
    let iMinL = i, vMinL = low[i];
    for (let k = i - 1; k >= i - period; k--) {
      if (high[k] >= vMaxH) { vMaxH = high[k]; iMaxH = k; }
      if (low[k] <= vMinL) { vMinL = low[k]; iMinL = k; }
    }
    const up = 100 * (period - (i - iMaxH)) / period;
    const down = 100 * (period - (i - iMinL)) / period;
    osc[i] = up - down;
  }
  return osc;
}

module.exports = {
  instId: "OP-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length;
    const open = c5.map(b => b[1]);
    const high = c5.map(b => b[2]);
    const low = c5.map(b => b[3]);
    const close = c5.map(b => b[4]);

    const osc = aroonOsc(high, low, AROON_PERIOD);

    const out = [];
    for (let i = 100; i < n; i++) {
      const o = osc[i];
      if (o == null) continue;
      const aroonLong = o <= -AROON_TH, aroonShort = o >= AROON_TH;
      if (!aroonLong && !aroonShort) continue;

      const body = Math.max(Math.abs(close[i] - open[i]), close[i] * 1e-6);
      const upperWick = high[i] - Math.max(open[i], close[i]);
      const lowerWick = Math.min(open[i], close[i]) - low[i];
      const ratioUp = upperWick / body, ratioDown = lowerWick / body;
      const wickShort = ratioUp >= WICK_TH && ratioUp > ratioDown;
      const wickLong = ratioDown >= WICK_TH && ratioDown > ratioUp;

      if (aroonLong && wickLong) out.push({ i5: i, dir: 1 });
      else if (aroonShort && wickShort) out.push({ i5: i, dir: -1 });
    }
    return out;
  },
};
