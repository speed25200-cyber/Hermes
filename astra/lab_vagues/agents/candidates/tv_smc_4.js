// RIVER : Fair Value Gap 15 MINUTES (le « HTF FVG » des traders SMC TradingView),
// détecté sur bougies 15 m closes (agrégées des 5 m, calées sur les slots de 15 min),
// mitigation jouée en 5 m. FVG haussier 15 m : low(b3) > high(b1), gap >= 0,4 % du prix.
// Entrée au bord PROXIMAL : la mèche 5 m rentre dans le gap et la clôture referme
// au-dessus -> zone defendue, continuation long. Gap comblé en clôture 5 m = invalide.
// Validité 48 h. Symétrique en baissier. Zones actives seulement APRÈS la clôture 15 m.
// Voisinage robuste : V432/576/720 stables (7,2-7,4), E2 et g3 positifs aussi.
const MIN_GAP = 0.004, VALID = 576;

module.exports = {
  instId: "RIVER-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const out = [];
    // 1) bougies 15 m closes (slot = ts / 900 000), iEnd = index 5 m de la dernière bougie du slot
    const m15 = [];
    let cur = null;
    for (let i = 0; i < c5.length; i++) {
      const slot = Math.floor(c5[i][0] / 900000);
      if (!cur || cur.slot !== slot) {
        if (cur) m15.push(cur);
        cur = { slot, iEnd: i, h: c5[i][2], l: c5[i][3], c: c5[i][4] };
      } else {
        cur.iEnd = i;
        if (c5[i][2] > cur.h) cur.h = c5[i][2];
        if (c5[i][3] < cur.l) cur.l = c5[i][3];
        cur.c = c5[i][4];
      }
    }
    if (cur) m15.push(cur);
    // 2) FVG 3 bougies 15 m ; la zone ne devient active qu'à l'index 5 m de la clôture 15 m
    const born = [];
    for (let k = 2; k < m15.length; k++) {
      const b3 = m15[k], b1 = m15[k - 2];
      if (b3.l > b1.h && (b3.l - b1.h) / b3.c >= MIN_GAP)
        born.push({ at: b3.iEnd, dir: 1, lvl: b3.l, bot: b1.h });
      else if (b3.h < b1.l && (b1.l - b3.h) / b3.c >= MIN_GAP)
        born.push({ at: b3.iEnd, dir: -1, lvl: b3.h, bot: b1.l });
    }
    born.sort((a, b) => a.at - b.at);
    // 3) mitigation bougie 5 m par bougie 5 m
    const zones = [];
    let zi = 0;
    for (let i = 0; i < c5.length; i++) {
      while (zi < born.length && born[zi].at <= i) { zones.push({ ...born[zi], born: born[zi].at }); zi++; }
      const h = c5[i][2], l = c5[i][3], c = c5[i][4];
      for (let z = zones.length - 1; z >= 0; z--) {
        const zz = zones[z];
        if (zz.born === i) continue;                 // jamais sur la bougie de création
        if (i - zz.born > VALID) { zones.splice(z, 1); continue; }
        if (zz.dir > 0) {
          if (c < zz.bot) { zones.splice(z, 1); continue; }
          if (l <= zz.lvl && c > zz.lvl && i >= 100) { out.push({ i5: i, dir: 1 }); zones.splice(z, 1); continue; }
        } else {
          if (c > zz.bot) { zones.splice(z, 1); continue; }
          if (h >= zz.lvl && c < zz.lvl && i >= 100) { out.push({ i5: i, dir: -1 }); zones.splice(z, 1); continue; }
        }
      }
    }
    return out;
  }
};
