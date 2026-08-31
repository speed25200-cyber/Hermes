// Simulateur honnête pour le LEVIER PRIX D'ENTRÉE (retracement) : au lieu d'entrer au close de la
// bougie de signal, on place un ordre LIMITE à -R % (long) / +R % (short) du close du signal, annulé
// si aucune bougie des WINDOW suivantes ne l'atteint (low<=limite en long, high>=limite en short —
// le harness standard entre TOUJOURS au close, il ne peut pas exprimer ce levier : d'où ce simulateur
// dédié, mêmes conventions strictes que harness_lib.js : LEV15, coûts 0,12 % A/R, sl cap -30 % marge,
// IS 20j / OOS 10j (coupure sur le timestamp du SIGNAL, pas du remplissage), blocage du symbole
// jusqu'à la clôture du trade). Zéro futur : le remplissage ne regarde que i5+1..i5+window, la sortie
// ne regarde que fillIdx+1..fillIdx+hold — mêmes garde-fous que le banc officiel.
const path = require("path");
const { chargerCandles, agg, LEV, COUT_PX } = require(path.join(__dirname, "..", "harness_lib.js"));
const OOS_JOURS = 10;

/* Retourne null si l'ordre limite n'est jamais touché dans la fenêtre (trade raté, pas compté). */
function simRetrace(c5, i5, dir, ex, retr, window) {
  const sigClose = c5[i5][4];
  const limit = dir > 0 ? sigClose * (1 - retr) : sigClose * (1 + retr);
  const endWin = Math.min(c5.length - 1, i5 + window);
  let fillIdx = -1;
  for (let k = i5 + 1; k <= endWin; k++) {
    const hi = c5[k][2], lo = c5[k][3];
    if (dir > 0 ? lo <= limit : hi >= limit) { fillIdx = k; break; }
  }
  if (fillIdx === -1) return null;

  const entry = limit; // remplissage AU PRIX LIMITE (convention standard, pas d'amélioration de prix créditée)
  const tpPx = ex.tp / LEV, slPx0 = Math.min(ex.sl, 0.30) / LEV;
  const actPx = (ex.act ?? 99) / LEV, cbPx = (ex.cb ?? 0.05) / LEV;
  const hold = Math.round((ex.holdH ?? 12) * 12);
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  let sl = dir > 0 ? entry * (1 - slPx0) : entry * (1 + slPx0);
  let best = entry;
  const end = Math.min(c5.length - 1, fillIdx + hold);
  for (let k = fillIdx + 1; k <= end; k++) {
    const hi = c5[k][2], lo = c5[k][3];
    if (dir > 0 ? lo <= sl : hi >= sl) return { pnl: (dir > 0 ? sl / entry - 1 : 1 - sl / entry) - COUT_PX, dur: k - i5, fillIdx };
    if (dir > 0 ? hi >= tp : lo <= tp) return { pnl: tpPx - COUT_PX, dur: k - i5, fillIdx };
    const close = c5[k][4];
    if (dir > 0 ? close > best : close < best) best = close;
    if ((dir > 0 ? best / entry - 1 : 1 - best / entry) >= actPx) {
      const t = dir > 0 ? best * (1 - cbPx) : best * (1 + cbPx);
      if (dir > 0 ? t > sl : t < sl) sl = t;
    }
  }
  return { pnl: (dir > 0 ? c5[end][4] / entry - 1 : 1 - c5[end][4] / entry) - COUT_PX, dur: end - i5, fillIdx };
}

function evaluerRetrace(mod, c5, retr, window) {
  const tOOS = c5[c5.length - 1][0] - OOS_JOURS * 86400 * 1000;
  const sigs = (mod.detect(c5) || []).filter(s => s && s.dir).sort((a, b) => a.i5 - b.i5);
  const is = [], oos = [];
  let busy = -1, nSig = 0, nFill = 0;
  for (const s of sigs) {
    if (s.i5 <= busy || s.i5 >= c5.length - 2) continue;
    nSig++;
    const t = simRetrace(c5, s.i5, s.dir, mod.exits, retr, window);
    if (!t) continue;
    nFill++;
    busy = s.i5 + t.dur;
    (c5[s.i5][0] >= tOOS ? oos : is).push(t);
  }
  return { A: agg(is), B: agg(oos), nSig, nFill };
}

module.exports = { chargerCandles, simRetrace, evaluerRetrace, agg, LEV, COUT_PX };
