// HMSTR : fade d'une série de 3 bougies 5m consécutives, uniquement autour des heures
// de funding (0h/8h/16h UTC ±1h).
// Comparaison 24h/24 (mêmes exits) : worst -3,60 → la fenêtre funding donne +6,82.
module.exports = {
  instId: "HMSTR-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
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
      const dir = run >= 3 ? -1 : run <= -3 ? 1 : 0;
      if (!dir) continue;
      if (FUND(new Date(c5[i][0]).getUTCHours())) out.push({ i5: i, dir });
    }
    return out;
  }
};
