// Avalement haussier/baissier 5m après une série de 3 bougies dans le même sens : le retournement de flux se fade en sens inverse de la série.
module.exports = {
  instId: "SOPH-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const RUN = 3, out = [];
    for (let i = RUN + 1; i < c5.length; i++) {
      const o = c5[i][1], c = c5[i][4], po = c5[i - 1][1], pc = c5[i - 1][4];
      let down = 0, up = 0;
      for (let j = i - 1; j >= 1 && c5[j][4] < c5[j][1]; j--) down++;
      for (let j = i - 1; j >= 1 && c5[j][4] > c5[j][1]; j--) up++;
      if (down >= RUN && c > o && c >= po && o <= pc) out.push({ i5: i, dir: 1 });
      else if (up >= RUN && c < o && c <= po && o >= pc) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
