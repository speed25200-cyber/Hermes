// Banc d'essai COMMUN à tous les agents chercheurs de stratégies.
// Règles non négociables (identiques aux études précédentes) :
//   levier x15 · coûts 0,12 % prix A/R · SL cap -30 % marge · pire cas dans la bougie
//   IS = 20 premiers jours / OOS = 10 derniers · un trade bloque le symbole jusqu'à sa sortie.
const fs = require("fs");
const path = require("path");
const LEV = 15, COUT_PX = 0.0012, OOS_JOURS = 10;

function chargerCandles(dossier, instId) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", dossier, instId + ".json")));
}

/* exits = { tp, sl(<=0.30), act, cb, holdH } en % de MARGE (ex. tp:0.60). */
function sim(c5, i5, dir, ex) {
  const entry = c5[i5][4];
  const tpPx = ex.tp / LEV, slPx0 = Math.min(ex.sl, 0.30) / LEV;
  const actPx = (ex.act ?? 99) / LEV, cbPx = (ex.cb ?? 0.05) / LEV;
  const hold = Math.round((ex.holdH ?? 12) * 12);
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  let sl = dir > 0 ? entry * (1 - slPx0) : entry * (1 + slPx0);
  let best = entry;
  const end = Math.min(c5.length - 1, i5 + hold);
  for (let k = i5 + 1; k <= end; k++) {
    const hi = c5[k][2], lo = c5[k][3];
    if (dir > 0 ? lo <= sl : hi >= sl) return { pnl: (dir > 0 ? sl / entry - 1 : 1 - sl / entry) - COUT_PX, dur: k - i5 };
    if (dir > 0 ? hi >= tp : lo <= tp) return { pnl: tpPx - COUT_PX, dur: k - i5 };
    const close = c5[k][4];
    if (dir > 0 ? close > best : close < best) best = close;
    if ((dir > 0 ? best / entry - 1 : 1 - best / entry) >= actPx) {
      const t = dir > 0 ? best * (1 - cbPx) : best * (1 + cbPx);
      if (dir > 0 ? t > sl : t < sl) sl = t;
    }
  }
  return { pnl: (dir > 0 ? c5[end][4] / entry - 1 : 1 - c5[end][4] / entry) - COUT_PX, dur: end - i5 };
}

function agg(l) {
  if (!l.length) return null;
  const n = l.length, w = l.filter(t => t.pnl > 0).length;
  const sum = l.reduce((s, t) => s + t.pnl, 0);
  const gp = l.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gn = -l.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  return { n, wr: +(100 * w / n).toFixed(1), esp: +(100 * sum / n * LEV).toFixed(2), pf: gn > 0 ? +(gp / gn).toFixed(2) : 99 };
}

/* Évalue un module candidat { instId, exits, detect(c5)->[{i5,dir}] } sur une série.
   coupureTs : les trades entrés APRÈS sont ignorés (pour la validation 60 j). */
function evaluer(mod, c5, opts = {}) {
  const tOOS = c5[c5.length - 1][0] - OOS_JOURS * 86400 * 1000;
  const sigs = mod.detect(c5) || [];
  const is = [], oos = [];
  let busy = -1;
  for (const s of sigs.sort((a, b) => a.i5 - b.i5)) {
    if (s.i5 <= busy || s.i5 >= c5.length - 2 || !s.dir) continue;
    if (opts.coupureTs && c5[s.i5][0] >= opts.coupureTs) continue;
    const t = sim(c5, s.i5, s.dir, mod.exits);
    busy = s.i5 + t.dur;
    (c5[s.i5][0] >= tOOS ? oos : is).push(t);
  }
  return { A: agg(is), B: agg(oos), all: agg(is.concat(oos)) };
}

module.exports = { chargerCandles, sim, agg, evaluer, LEV, COUT_PX };
