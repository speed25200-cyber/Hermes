// LA RECETTE REINE (GPS 4/4) sur territoire vierge : mèche d'épuisement 5m (mèche >= 60 % du range +
// volume >= 1,5x SMA20) fadée UNIQUEMENT dans la moitié favorable du range 24h (long moitié basse,
// short moitié haute). SHELL-USDT-SWAP est ABSENTE de profond_tous_resultats.json (jamais scannée
// avant ce round) et n'a AUCUN candidat déposé (crypto réelle confirmée par instCategory OKX="1").
// Exit standard imposé (pas de balayage) : tp80/sl30/act30/cb5/hold12.
// Plateau (grille grossière wick x vol, mêmes exits, test_harness) :
//   w0.5v1.5 +2.70 · w0.6v1.5 +5.63 (retenu) · w0.6v2 +1.89 · w0.7v1.5 +1.63 · w0.6v2.5 +1.61 · w0.7v2 +1.62 —
//   7/9 cellules du voisinage positives (les 2 seules négatives, w0.5v2/-0.02 et w0.5v2.5/-0.14, sont ~nulles).
module.exports = {
  instId: "SHELL-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const vs = new Array(c5.length).fill(null);
    let s = 0;
    for (let i = 0; i < c5.length; i++) {
      s += c5[i][5];
      if (i >= 20) s -= c5[i - 20][5];
      if (i >= 19) vs[i] = s / 20;
    }
    const R = 288, pos = new Array(c5.length).fill(null);
    const dqH = [], dqL = [];
    for (let i = 0; i < c5.length; i++) {
      while (dqH.length && c5[dqH[dqH.length - 1]][2] <= c5[i][2]) dqH.pop();
      dqH.push(i);
      while (dqL.length && c5[dqL[dqL.length - 1]][3] >= c5[i][3]) dqL.pop();
      dqL.push(i);
      while (dqH[0] <= i - R) dqH.shift();
      while (dqL[0] <= i - R) dqL.shift();
      if (i >= R - 1) { const hh = c5[dqH[0]][2], ll = c5[dqL[0]][3]; pos[i] = hh > ll ? (c5[i][4] - ll) / (hh - ll) : 0.5; }
    }
    const out = [];
    for (let i = 300; i < c5.length; i++) {
      const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4], range = h - l;
      if (!(range > 0) || vs[i] == null || !(vs[i] > 0) || pos[i] == null) continue;
      const wLo = (Math.min(o, c) - l) / range, wHi = (h - Math.max(o, c)) / range, vm = c5[i][5] / vs[i];
      if (wLo >= 0.6 && vm >= 1.5 && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
      else if (wHi >= 0.6 && vm >= 1.5 && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
