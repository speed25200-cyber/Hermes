// LEVIER CONFIRMATION — ACT (base x4_reliquat_1, EN_LIVE) + confirmation DÉCALÉE : le signal
// nu passait DÉJÀ le seuil client (wr >= 65 % des deux côtés) ; sert de contrôle "le filtre ne
// doit pas casser un signal déjà bon". Entrée reportée d'1 bougie : la bougie suivant la cassure
// fadée du canal Donchian compressé doit ELLE AUSSI clôturer dans le sens du trade.
// Signal nu (test_harness) : wrIS 73,5 / wrOOS 71,4 · espIS 7,90 / espOOS 11,96 (n 49+21).
// Avec confirmation décalée : wrIS 68,2 / wrOOS 77,8 · espIS 5,59 / espOOS 12,71 (n 44+18).
// -> reste >= 65 % des DEUX côtés (corrige encore le côté OOS, 71,4->77,8) ; esp > 0 des deux
// côtés et >= 60 % de l'esp nu (5,59>=4,74 ; 12,71>=7,18). Gain net mais MODESTE ici : le signal
// nu était déjà bon, la confirmation ne fait qu'échanger un peu d'IS contre plus de robustesse OOS.
const N_DON = 20, PCTL = 15, WPCT = 288;

module.exports = {
  instId: "ACT-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  detect(c5) {
    const n = c5.length, raw = [];
    const high = new Array(n), low = new Array(n), close = new Array(n);
    for (let i = 0; i < n; i++) { high[i] = +c5[i][2]; low[i] = +c5[i][3]; close[i] = +c5[i][4]; }

    const hi = new Float64Array(n).fill(NaN), lo = new Float64Array(n).fill(NaN), width = new Float64Array(n).fill(NaN);
    for (let i = N_DON; i < n; i++) {
      let mx = -Infinity, mn = Infinity;
      for (let k = i - N_DON; k < i; k++) { if (high[k] > mx) mx = high[k]; if (low[k] < mn) mn = low[k]; }
      hi[i] = mx; lo[i] = mn;
      width[i] = (mx - mn) / close[i];
    }
    function pctRank(i) {
      const start = i - WPCT;
      if (start < 0) return NaN;
      let below = 0, cnt = 0;
      for (let k = start; k < i; k++) { const v = width[k]; if (Number.isNaN(v)) continue; cnt++; if (v <= width[i]) below++; }
      if (cnt < WPCT * 0.8) return NaN;
      return 100 * below / cnt;
    }

    for (let i = N_DON + WPCT; i < n - 1; i++) {
      const wp = pctRank(i - 1);
      if (Number.isNaN(wp) || wp > PCTL) continue;
      if (Number.isNaN(hi[i - 1]) || Number.isNaN(lo[i - 1])) continue;
      let dir = 0;
      if (close[i] > hi[i - 1]) dir = -1;
      else if (close[i] < lo[i - 1]) dir = 1;
      if (dir) raw.push({ i5: i, dir });
    }

    // CONFIRMATION DÉCALÉE : bougie i+1 doit clôturer dans le sens du trade -> entrée à i+1.
    const out = [];
    for (const s of raw) {
      const j = s.i5 + 1;
      if (j >= n - 2) continue;
      const o = c5[j][1], c = c5[j][4];
      if (s.dir === 1 ? c > o : c < o) out.push({ i5: j, dir: s.dir });
    }
    return out;
  }
};
