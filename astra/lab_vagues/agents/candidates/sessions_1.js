// PLUME : fade d'une série de 5 bougies 5m consécutives, uniquement autour des heures
// de funding (0h/8h/16h UTC ±1h) ; tenue max 8 h = jusqu'au funding suivant.
// Comparaison 24h/24 (mêmes exits) : worst -7,49 → la fenêtre funding le retourne en +9,90.
module.exports = {
  instId: "PLUME-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 8 },
  detect(c5) {
    const out = [];
    const FUND = h => (h === 23 || h === 0 || h === 1 || h === 7 || h === 8 || h === 9 || h === 15 || h === 16 || h === 17);
    let run = 0;
    for (let i = 1; i < c5.length; i++) {
      const d = c5[i][4] - c5[i][1]; // close - open
      if (d > 0) run = run > 0 ? run + 1 : 1;
      else if (d < 0) run = run < 0 ? run - 1 : -1;
      else run = 0;
      if (i < 100) continue;
      const dir = run >= 5 ? -1 : run <= -5 ? 1 : 0;
      if (!dir) continue;
      if (FUND(new Date(c5[i][0]).getUTCHours())) out.push({ i5: i, dir });
    }
    return out;
  }
};
