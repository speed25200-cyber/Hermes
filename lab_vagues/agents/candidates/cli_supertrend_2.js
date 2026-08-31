// SuperTrend [Pine v4, script client] porté fidèlement : ATR(10) Wilder x3 sur hl2, bandes up/dn
// portées causalement, trend flip (voir cli_supertrend_1.js pour le détail). Le flip NU est mort
// (ronde 4). Lecture (b) : DISTANCE au SuperTrend en PERCENTILE EXTRÊME -> surextension -> FADE.
// distToST[i] = étirement du prix au-delà de la ligne, DANS LE SENS du trend en cours (trend=1 :
// (close-up)/close ; trend=-1 : (dn-close)/close) — toujours "combien le prix a couru par rapport à
// sa propre ligne". Seuil ADAPTATIF PROPRE à la crypto (pas un seuil absolu générique — leçon
// x2_adaptatif/x4_reliquat confirmée partout ailleurs dans le labo) : percentile 95 de distToST sur
// une calibration CAUSALE de 7 jours (2016 bougies), recalibrée à chaque frontière de jour calendaire
// (bloc-jour, la fenêtre ne contient jamais le jour en cours). Mode RECLAIM (pas le simple
// franchissement) : le signal se déclenche quand distToST RETOMBE sous le seuil après l'avoir dépassé
// — la surextension qui se dégonfle, pas l'instant où elle apparaît (confirmation "reclaim > touch",
// la leçon la plus reproduite du labo). Direction = CONTRE le trend en cours (fade).
// Plateau sur MET : TOUTE la famille B_dist est positive sur cette crypto (10/10 combos calib{7j,14j} x
// percentile{85,90,95} x mode{X,R} x exits{E1,E2} testés, de +0,9 à +6,99, aucune cellule négative) —
// le mode reclaim P95/7j est le sommet mais pas un pic isolé.
module.exports = {
  instId: "MET-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const Periods = 10, Mult = 3.0;
    const CALIB_N = 7 * 288, PCT = 0.95;
    const n = c5.length;

    const tr = new Float64Array(n), atr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const h = c5[i][2], l = c5[i][3];
      tr[i] = i === 0 ? (h - l) : Math.max(h - l, Math.abs(h - c5[i - 1][4]), Math.abs(l - c5[i - 1][4]));
    }
    let seed = 0;
    for (let i = 0; i < Periods; i++) seed += tr[i];
    atr[Periods - 1] = seed / Periods;
    for (let i = Periods; i < n; i++) atr[i] = (atr[i - 1] * (Periods - 1) + tr[i]) / Periods;
    for (let i = 0; i < Periods - 1; i++) atr[i] = atr[Periods - 1];

    const up = new Float64Array(n), dn = new Float64Array(n), trend = new Int8Array(n), dist = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const hl2 = (c5[i][2] + c5[i][3]) / 2;
      const rawUp = hl2 - Mult * atr[i];
      const rawDn = hl2 + Mult * atr[i];
      const up1 = i > 0 ? up[i - 1] : rawUp;
      const dn1 = i > 0 ? dn[i - 1] : rawDn;
      up[i] = (i > 0 && c5[i - 1][4] > up1) ? Math.max(rawUp, up1) : rawUp;
      dn[i] = (i > 0 && c5[i - 1][4] < dn1) ? Math.min(rawDn, dn1) : rawDn;
      const prevTrend = i > 0 ? trend[i - 1] : 1;
      trend[i] = (prevTrend === -1 && c5[i][4] > dn1) ? 1 : (prevTrend === 1 && c5[i][4] < up1) ? -1 : prevTrend;
      const close = c5[i][4];
      dist[i] = trend[i] === 1 ? (close - up[i]) / close : (dn[i] - close) / close;
    }

    // --- calibration causale bloc-jour : seuil P95 recalculé à chaque frontière de jour calendaire
    //     à partir des CALIB_N bougies STRICTEMENT antérieures (jamais le jour en cours) ---
    const thr = new Float64Array(n).fill(NaN);
    const dayOf = new Int32Array(n);
    for (let i = 0; i < n; i++) dayOf[i] = Math.floor(c5[i][0] / 86400000);
    let dayStart = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || dayOf[i] !== dayOf[dayStart]) {
        const lo = Math.max(0, dayStart - CALIB_N);
        if (dayStart - lo >= 500) {
          const win = Array.from(dist.subarray(lo, dayStart)).sort((a, b) => a - b);
          const p = win[Math.floor(PCT * (win.length - 1))];
          for (let k = dayStart; k < i; k++) thr[k] = p;
        }
        dayStart = i;
      }
    }

    const out = [];
    for (let i = 30; i < n - 2; i++) {
      const th = thr[i];
      if (Number.isNaN(th)) continue;
      const above = dist[i] >= th, prevAbove = dist[i - 1] >= th;
      if (!(prevAbove && !above)) continue; // RECLAIM : retombe sous le seuil après l'avoir dépassé
      const dir = trend[i] === 1 ? -1 : 1; // FADE : contre le trend étiré
      out.push({ i5: i, dir });
    }
    return out;
  }
};
