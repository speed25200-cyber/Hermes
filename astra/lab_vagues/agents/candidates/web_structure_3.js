// CRV : faux breakout de niveau rond (psychologique). Niveaux = multiples de
// 10 % de la puissance de 10 du prix (modulo — ex. 0.50, 0.60...). Si la bougie perce
// le premier rond au-dessus/en dessous en mèche mais REFERME du mauvais côté, c'est un
// piège à breakout (doc : sweep du rond -> fade) : short sous le rond percé à la hausse,
// long au-dessus du rond balayé à la baisse.
const F = 0.1; // pas de grille : 0.1 × 10^floor(log10(prix))

module.exports = {
  instId: "CRV-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const out = [];
    for (let i = 100; i < c5.length; i++) {
      const pc = c5[i - 1][4], h = c5[i][2], l = c5[i][3], c = c5[i][4];
      const s = Math.pow(10, Math.floor(Math.log10(pc))) * F;
      const Lup = Math.ceil(pc / s) * s;   // 1er niveau rond au-dessus
      const Ldn = Math.floor(pc / s) * s;  // 1er niveau rond en dessous
      if (pc < Lup && h > Lup && c < Lup) out.push({ i5: i, dir: -1 });
      else if (pc > Ldn && l < Ldn && c > Ldn && Ldn > 0) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
