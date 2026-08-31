// Bollinger 15m extrême : close hors des bandes 20/2 sigma sur 15m -> retour à la moyenne (fade).
module.exports = {
  instId: "SOON-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const period = 15 * 60 * 1000;
    const t = []; let cur = null;
    for (let i = 0; i < c5.length; i++) {
      const b = Math.floor(c5[i][0] / period);
      if (!cur || cur.b !== b) { if (cur) t.push(cur); cur = { b, i5fin: i, c: c5[i][4] }; }
      else { cur.c = c5[i][4]; cur.i5fin = i; }
    }
    if (cur) t.push(cur);
    const per = 20, k = 2, out = [];
    for (let i = per; i < t.length; i++) {
      let s = 0, s2 = 0;
      for (let j = i - per + 1; j <= i; j++) { s += t[j].c; s2 += t[j].c * t[j].c; }
      const m = s / per, sd = Math.sqrt(Math.max(s2 / per - m * m, 0));
      if (sd <= 0) continue;
      if (t[i].c < m - k * sd) out.push({ i5: t[i].i5fin, dir: 1 });   // sous la bande basse -> long
      else if (t[i].c > m + k * sd) out.push({ i5: t[i].i5fin, dir: -1 }); // au-dessus de la bande haute -> short
    }
    return out;
  }
};
