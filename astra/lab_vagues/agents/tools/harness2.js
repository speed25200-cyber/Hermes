// harness2 — copie de harness_lib avec simulation ÉTENDUE des sorties (chantier sorties2_).
// N'ALTÈRE PAS harness_lib.js : mêmes règles non négociables (levier x15, coûts 0,12 % prix A/R
// par unité fermée, SL cap -30 % marge, pire cas dans la bougie, blocage du symbole).
// Extensions optionnelles dans `exits` :
//   ptp   : TP PARTIEL — niveau en % de MARGE (ex. 0.20) ; ferme `pfrac` (défaut 0.5) de la
//           position au toucher intrabougie (comme le TP), le reste continue avec TP/SL/trail.
//   pfrac : fraction fermée au TP partiel (défaut 0.5).
//   be    : BREAK-EVEN — quand le gain (sur clôtures, même mécanique que l'activation du trail)
//           atteint ce % de MARGE, le SL remonte au prix d'entrée (jamais redescendu).
//           Sortie BE = 0 % prix - coûts = -1,8 % de marge (les coûts restent payés).
// Sans ptp/be, sim2 est arithmétiquement IDENTIQUE à harness_lib.sim (contrôle au centime).
// Conventions pire-cas conservées : dans une bougie, SL testé AVANT ptp/tp (pessimiste) ;
// ptp < tp sur le chemin -> partiel crédité avant le TP plein de la même bougie (cohérent chemin) ;
// be/trail calculés sur la clôture, effectifs à la bougie suivante (zéro look-ahead).
const { chargerCandles, agg, LEV, COUT_PX } = require("../harness_lib.js");

function sim2(c5, i5, dir, ex) {
  const entry = c5[i5][4];
  const tpPx = ex.tp / LEV, slPx0 = Math.min(ex.sl, 0.30) / LEV;
  const actPx = (ex.act ?? 99) / LEV, cbPx = (ex.cb ?? 0.05) / LEV;
  const bePx = ex.be != null ? ex.be / LEV : null;
  const ptpPx = ex.ptp != null ? ex.ptp / LEV : null;
  const pfrac = ex.pfrac ?? 0.5;
  const hold = Math.round((ex.holdH ?? 12) * 12);
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  const ptp = ptpPx != null ? (dir > 0 ? entry * (1 + ptpPx) : entry * (1 - ptpPx)) : null;
  let sl = dir > 0 ? entry * (1 - slPx0) : entry * (1 + slPx0);
  let best = entry;
  let frac = 1, real = 0, ptpFait = false;
  const end = Math.min(c5.length - 1, i5 + hold);
  const pxPnl = px => (dir > 0 ? px / entry - 1 : 1 - px / entry);
  for (let k = i5 + 1; k <= end; k++) {
    const hi = c5[k][2], lo = c5[k][3];
    if (dir > 0 ? lo <= sl : hi >= sl)
      return { pnl: real + frac * (pxPnl(sl) - COUT_PX), dur: k - i5, sortie: ptpFait ? "sl_apres_partiel" : "sl", partiel: ptpFait };
    if (ptp !== null && !ptpFait && (dir > 0 ? hi >= ptp : lo <= ptp)) {
      real += pfrac * (ptpPx - COUT_PX); frac -= pfrac; ptpFait = true;
    }
    if (dir > 0 ? hi >= tp : lo <= tp)
      return { pnl: real + frac * (tpPx - COUT_PX), dur: k - i5, sortie: "tp", partiel: ptpFait };
    const close = c5[k][4];
    if (dir > 0 ? close > best : close < best) best = close;
    const gain = dir > 0 ? best / entry - 1 : 1 - best / entry;
    if (bePx !== null && gain >= bePx && (dir > 0 ? entry > sl : entry < sl)) sl = entry;
    if (gain >= actPx) {
      const t = dir > 0 ? best * (1 - cbPx) : best * (1 + cbPx);
      if (dir > 0 ? t > sl : t < sl) sl = t;
    }
  }
  return { pnl: real + frac * (pxPnl(c5[end][4]) - COUT_PX), dur: end - i5, sortie: "timeout", partiel: ptpFait };
}

/* Rejoue les signaux d'un module avec des sorties de remplacement (opts.exits, défaut mod.exits).
   Même sélection/blocage que harness_lib.evaluer ; opts.sigs = signaux pré-calculés (detect coûteux). */
function evaluer2(mod, c5, opts = {}) {
  const ex = opts.exits ?? mod.exits;
  const sigs = (opts.sigs ?? mod.detect(c5) ?? []).slice().sort((a, b) => a.i5 - b.i5);
  const trades = [];
  let busy = -1;
  for (const s of sigs) {
    if (s.i5 <= busy || s.i5 >= c5.length - 2 || !s.dir) continue;
    if (opts.coupureTs && c5[s.i5][0] >= opts.coupureTs) continue;
    const t = sim2(c5, s.i5, s.dir, ex);
    t.i5 = s.i5; t.dir = s.dir; t.ts = c5[s.i5][0];
    busy = s.i5 + t.dur;
    trades.push(t);
  }
  return trades;
}

/* Métriques risque (mêmes conventions que tools/risque.js : capital 100, mise 10 par trade,
   courbe séquentielle) + agrégat espérance. Les pnl sont en fraction de PRIX -> marge = pnl*LEV. */
function metriques(trades) {
  const a = agg(trades);
  if (!a) return null;
  let cap = 100, peak = 100, ddMax = 0, pertes = 0, pertesMax = 0;
  const margs = trades.map(t => t.pnl * LEV * 100);
  for (const m of margs) {
    cap += 10 * (m / 100);
    if (cap > peak) peak = cap;
    ddMax = Math.max(ddMax, (peak - cap) / peak * 100);
    if (m <= 0) { pertes++; pertesMax = Math.max(pertesMax, pertes); } else pertes = 0;
  }
  const mu = margs.reduce((s, x) => s + x, 0) / margs.length;
  const sd = Math.sqrt(margs.reduce((s, x) => s + (x - mu) * (x - mu), 0) / margs.length);
  const sorties = {};
  for (const t of trades) sorties[t.sortie] = (sorties[t.sortie] || 0) + 1;
  return {
    n: a.n, esp: a.esp, wr: a.wr, pf: a.pf,
    sigma: +sd.toFixed(2), ratio: sd > 0 ? +(mu / sd).toFixed(3) : null,
    ddMax: +ddMax.toFixed(2), capFinal: +cap.toFixed(1),
    pireTrade: +Math.min(...margs).toFixed(1), seriePertes: pertesMax, sorties
  };
}

module.exports = { chargerCandles, sim2, evaluer2, metriques, agg, LEV, COUT_PX };
