// ETHFI : Fair Value Gap (ICT/SMC TradingView) avec filtre de DÉPLACEMENT, entrée au 50 %.
// Formule exacte 3 bougies : FVG haussier si low[i] > high[i-2] (zone = [high[i-2], low[i]]),
// bougie centrale = vraie impulsion (corps >= 2x corps moyen 20). Gap minimal 0,3 % du prix.
// Mitigation « consequent encroachment » : la mèche revient jusqu'au MILIEU du gap et la
// clôture referme au-dessus -> la zone est défendue, on joue la continuation. Gap comblé
// en clôture = zone morte. Validité 12 h. Symétrique en baissier.
// Voisinage robuste : g2/g3 x V144/V288 x E1/E2 tous positifs (worst 5,57 a 8,39).
const MIN_GAP = 0.003, VALID = 144, DISP = 2;

module.exports = {
  instId: "ETHFI-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.30, cb: 0.05, holdH: 8 },
  detect(c5) {
    const out = [];
    const gaps = []; // {dir, bot, lvl, born}
    let sum = 0;
    const bodies = [];
    for (let i = 0; i < c5.length; i++) {
      const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4];
      for (let g = gaps.length - 1; g >= 0; g--) {
        const z = gaps[g];
        if (i - z.born > VALID) { gaps.splice(g, 1); continue; }
        if (z.dir > 0) {
          if (c < z.bot) { gaps.splice(g, 1); continue; }        // gap comblé -> invalide
          if (l <= z.lvl && c > z.lvl && i >= 100) { out.push({ i5: i, dir: 1 }); gaps.splice(g, 1); continue; }
        } else {
          if (c > z.bot) { gaps.splice(g, 1); continue; }
          if (h >= z.lvl && c < z.lvl && i >= 100) { out.push({ i5: i, dir: -1 }); gaps.splice(g, 1); continue; }
        }
      }
      if (i >= 22) {
        const h1 = c5[i - 2][2], l1 = c5[i - 2][3];
        const body2 = Math.abs(c5[i - 1][4] - c5[i - 1][1]);
        if (body2 >= DISP * (sum / 20)) {                        // impulsion réelle
          if (l > h1 && (l - h1) / c >= MIN_GAP)
            gaps.push({ dir: 1, bot: h1, lvl: (l + h1) / 2, born: i });
          else if (h < l1 && (l1 - h) / c >= MIN_GAP)
            gaps.push({ dir: -1, bot: l1, lvl: (h + l1) / 2, born: i });
        }
      }
      bodies.push(Math.abs(c - o)); sum += Math.abs(c - o);
      if (bodies.length > 20) sum -= bodies[bodies.length - 21];
    }
    return out;
  }
};
