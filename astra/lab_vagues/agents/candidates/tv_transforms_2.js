// UB : retournement Renko — briques de 1,5×ATR14 (5 m), construction close-based
// standard : continuation = 1 brique au-delà du bord, retournement = 2 briques
// (1 pour annuler + 1 opposée). Après une série d'au moins 3 briques dans un sens,
// la 1re brique de retournement = les stops de la jambe sont pris → on entre dans
// le sens du retournement (fade de la jambe étendue). La taille de brique est figée
// à chaque retournement avec l'ATR du moment (aucun recalcul rétroactif = 0 repaint).
// Robustesse (banc 30 j) : k1.5/N3 E1+E3 8.35, E2 6.98 ; k1.5/N4 11.45 (n=55) ;
// k1/N4 5.92 ; k1.5/N2 4.60 — tout le voisinage k×N est positif.
const K = 1.5, N = 3, ATRLEN = 14, WARM = 300;

function atrSeries(c5, len) { // Wilder
  const n = c5.length, out = new Array(n).fill(NaN);
  let atr = 0;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(c5[i][2] - c5[i][3], Math.abs(c5[i][2] - c5[i - 1][4]), Math.abs(c5[i][3] - c5[i - 1][4]));
    if (i <= len) { atr += tr / len; if (i === len) out[i] = atr; }
    else { atr = (atr * (len - 1) + tr) / len; out[i] = atr; }
  }
  return out;
}

module.exports = {
  instId: "UB-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const atr = atrSeries(c5, ATRLEN);
    const out = [], n = c5.length;
    let top = NaN, bot = NaN, dir = 0, run = 0, B = NaN;
    for (let i = 0; i < n; i++) {
      const c = c5[i][4];
      if (isNaN(atr[i])) continue;
      if (isNaN(B)) { B = K * atr[i]; top = c; bot = c; continue; }
      if (dir === 0) {
        if (c >= top + B) { const m = Math.floor((c - top) / B); top += m * B; bot = top - B; dir = 1; run = m; }
        else if (c <= bot - B) { const m = Math.floor((bot - c) / B); bot -= m * B; top = bot + B; dir = -1; run = m; }
        continue;
      }
      if (dir === 1) {
        if (c >= top + B) { const m = Math.floor((c - top) / B); top += m * B; bot = top - B; run += m; }
        else if (c <= bot - B) { // 2 briques sous le sommet : retournement
          const prevRun = run, m = Math.floor((bot - c) / B);
          top = bot; bot = bot - m * B; dir = -1; run = m; B = K * atr[i];
          if (i >= WARM && prevRun >= N) out.push({ i5: i, dir: -1 });
        }
      } else {
        if (c <= bot - B) { const m = Math.floor((bot - c) / B); bot -= m * B; top = bot + B; run += m; }
        else if (c >= top + B) {
          const prevRun = run, m = Math.floor((c - top) / B);
          bot = top; top = top + m * B; dir = 1; run = m; B = K * atr[i];
          if (i >= WARM && prevRun >= N) out.push({ i5: i, dir: 1 });
        }
      }
    }
    return out;
  }
};
