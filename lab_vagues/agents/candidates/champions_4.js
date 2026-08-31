// Champion AXS (5 bougies 5m consécutives -> fade, tp0.8 act0.3 12h, worst nu 6.79) + UN ingrédient : trail respirant (callback 15 % au lieu de 5 %).
module.exports = {
  instId: "AXS-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.10, holdH: 12 },
  detect(c5) {
    const out = [];
    let run = 0, sgn = 0;
    for (let i = 1; i < c5.length; i++) {
      const d = Math.sign(c5[i][4] - c5[i - 1][4]);
      if (d !== 0 && d === sgn) run++; else { run = 1; sgn = d; }
      if (run >= 5 && sgn !== 0) out.push({ i5: i, dir: -sgn });
    }
    return out;
  }
};
