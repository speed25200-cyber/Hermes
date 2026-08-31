// FARTCOIN : balayage de liquidité (stop hunt) sur extrême 12 h. La bougie mèche
// SOUS le plus bas des 144 barres précédentes (où dorment les stops) puis referme
// AU-DESSUS -> les stops sont pris, on joue le snap-back long ; symétrique sur le
// plus haut -> short. Reclaim même bougie, aucune profondeur mini (grille grossière).
const N = 144;

module.exports = {
  instId: "FARTCOIN-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const out = [];
    const dqLo = [], dqHi = [];
    for (let i = 0; i < c5.length; i++) {
      if (i >= Math.max(100, N)) {
        while (dqLo.length && dqLo[0] < i - N) dqLo.shift();
        while (dqHi.length && dqHi[0] < i - N) dqHi.shift();
        const L = c5[dqLo[0]][3], H = c5[dqHi[0]][2]; // extrêmes des N barres AVANT i
        const h = c5[i][2], l = c5[i][3], c = c5[i][4];
        if (l < L && c > L) out.push({ i5: i, dir: 1 });
        else if (h > H && c < H) out.push({ i5: i, dir: -1 });
      }
      while (dqLo.length && c5[dqLo[dqLo.length - 1]][3] >= c5[i][3]) dqLo.pop();
      dqLo.push(i);
      while (dqHi.length && c5[dqHi[dqHi.length - 1]][2] <= c5[i][2]) dqHi.pop();
      dqHi.push(i);
    }
    return out;
  }
};
