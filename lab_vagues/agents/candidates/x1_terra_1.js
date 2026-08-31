// TERRITOIRE VIERGE (au-dela du top 250, jamais scanne). OL (Openledger) :
// RSI14 qui VIENT DE franchir l'extreme (25/75) -- pas un etat continu, le franchissement --
// fade UNIQUEMENT dans la moitie favorable du range 24h (meme architecture que gen_regime_3 GPS
// / gen_regime_5 AEON : filtre "moitie de range" applique a un signal simple).
// Robustesse : meme famille positive sur RSI 30/70 (E2 +4,29, E4 +4,99) et sur mecheRegime nu
// (w0,5 v2 E1 +4,98, OOS +12,73) -- l'edge d'OL n'est pas un artefact d'une seule lecture.
const ti = require("technicalindicators");
const LO = 25, HI = 75, R = 288;

module.exports = {
  instId: "OL-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  detect(c5) {
    const N = c5.length;
    const closes = new Array(N);
    for (let i = 0; i < N; i++) closes[i] = +c5[i][4];
    const rsiArr = ti.rsi({ period: 14, values: closes });
    const off = N - rsiArr.length;
    const rsi = new Array(N).fill(null);
    for (let i = 0; i < rsiArr.length; i++) rsi[off + i] = rsiArr[i];

    const pos = new Array(N).fill(null);
    const dqH = [], dqL = [];
    for (let i = 0; i < N; i++) {
      const h = +c5[i][2], l = +c5[i][3];
      while (dqH.length && c5[dqH[dqH.length - 1]][2] <= h) dqH.pop();
      dqH.push(i);
      while (dqL.length && c5[dqL[dqL.length - 1]][3] >= l) dqL.pop();
      dqL.push(i);
      while (dqH[0] <= i - R) dqH.shift();
      while (dqL[0] <= i - R) dqL.shift();
      if (i >= R - 1) { const hh = c5[dqH[0]][2], ll = c5[dqL[0]][3]; pos[i] = hh > ll ? (c5[i][4] - ll) / (hh - ll) : 0.5; }
    }

    const out = [];
    for (let i = 300; i < N; i++) {
      if (rsi[i] == null || rsi[i - 1] == null || pos[i] == null) continue;
      if (rsi[i - 1] >= LO && rsi[i] < LO && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
      else if (rsi[i - 1] <= HI && rsi[i] > HI && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
