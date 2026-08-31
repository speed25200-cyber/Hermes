// Bibliothèque partagée agent tv2_pivots_ (Pack PIVOTS, 31/08) : niveaux journaliers causaux
// (Pivot Points classiques + Camarilla) et bandes STARC, + générateur générique de signaux
// rejet/reclaim. Utilisée par tv2_pivots_scan1/2/3.js et par les candidats retenus.

// Calcule, pour chaque bougie 5m de c5, les niveaux du jour UTC CALENDAIRE PRÉCÉDENT (00:00->24:00 UTC).
// dayIdx = floor(ts/86400000) correspond exactement aux jours calendaires UTC (ts en ms epoch),
// donc 100% causal : le niveau utilisé pour le jour d est calculé sur le jour d-1 ENTIER, qui est
// terminé avant que la 1re bougie du jour d n'existe. Renvoie des Float64Array alignés sur c5,
// NaN tant que le jour précédent n'est pas disponible (1er jour partiel du dataset).
function dailyPivotLevels(c5) {
  const n = c5.length;
  const dayRec = new Map(); // dayIdx -> {h,l,c}
  for (let i = 0; i < n; i++) {
    const ts = c5[i][0], h = c5[i][2], l = c5[i][3], c = c5[i][4];
    const d = Math.floor(ts / 86400000);
    let rec = dayRec.get(d);
    if (!rec) { dayRec.set(d, { h, l, c }); }
    else { if (h > rec.h) rec.h = h; if (l < rec.l) rec.l = l; rec.c = c; }
  }
  const dayLevels = new Map(); // dayIdx+1 -> {PP,S1,R1,H3,L3} calculés depuis dayIdx
  for (const [d, rec] of dayRec) {
    const PP = (rec.h + rec.l + rec.c) / 3;
    const R1 = 2 * PP - rec.l, S1 = 2 * PP - rec.h;
    const range = rec.h - rec.l;
    const H3 = rec.c + range * 1.1 / 4, L3 = rec.c - range * 1.1 / 4;
    dayLevels.set(d + 1, { PP, S1, R1, H3, L3 });
  }
  const out = { PP: new Float64Array(n).fill(NaN), S1: new Float64Array(n).fill(NaN),
    R1: new Float64Array(n).fill(NaN), H3: new Float64Array(n).fill(NaN), L3: new Float64Array(n).fill(NaN) };
  for (let i = 0; i < n; i++) {
    const d = Math.floor(c5[i][0] / 86400000);
    const lv = dayLevels.get(d);
    if (lv) { out.PP[i] = lv.PP; out.S1[i] = lv.S1; out.R1[i] = lv.R1; out.H3[i] = lv.H3; out.L3[i] = lv.L3; }
  }
  return out;
}

// Générateur générique rejet(X)/reclaim(R) d'un niveau (array aligné sur c5).
// role: "sup" = support pur (fade LONG uniquement, ex S1/L3)
//       "res" = résistance pure (fade SHORT uniquement, ex R1/H3)
//       "piv" = pivot double rôle (les deux issues testées, mutuellement exclusives sur une bougie, ex PP)
// mode "X" (rejet même bougie) : mèche qui perce le niveau, clôture qui referme du bon côté.
// mode "R" (reclaim) : clôture qui était de l'autre côté au i-1, revient du bon côté au i.
// requireStable (déf. true) : pour les niveaux DISCRETS (pivots journaliers, constants toute la
//          journée puis sautent une fois/jour), exige L===Lp -> filtre l'artefact de bascule de
//          jour UTC (le saut du niveau lui-même n'est pas un reclaim de marché). Pour les niveaux
//          CONTINUS recalculés à chaque bougie (bandes STARC/SMA glissante), passer false : exiger
//          l'égalité bit-à-bit tuerait quasiment tout signal (Lp change à chaque barre).
function genLevelSignals(levelArr, close, high, low, role, mode, warm, requireStable = true) {
  const out = [];
  for (let i = warm; i < close.length; i++) {
    const L = levelArr[i], Lp = levelArr[i - 1];
    if (Number.isNaN(L) || Number.isNaN(Lp)) continue;
    if (mode === "X") {
      if (role !== "res" && low[i] <= L && close[i] > L) out.push({ i5: i, dir: 1 });
      if (role !== "sup" && high[i] >= L && close[i] < L) out.push({ i5: i, dir: -1 });
    } else {
      if (requireStable && L !== Lp) continue;
      if (role !== "res" && close[i - 1] < Lp && close[i] >= L) out.push({ i5: i, dir: 1 });
      if (role !== "sup" && close[i - 1] > Lp && close[i] <= L) out.push({ i5: i, dir: -1 });
    }
  }
  return out;
}

// STARC bands (Stoller Average Range Channel) : basis = SMA(close,N), bande = basis ± mult*ATR(N).
// ATR causal = moyenne mobile simple du True Range (pas de repaint, warm-up = N).
function rollingMean(arr, len) {
  const n = arr.length, out = new Float64Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += arr[i];
    if (i >= len) s -= arr[i - len];
    if (i >= len - 1) out[i] = s / len;
  }
  return out;
}
function starcBands(c5, N, mult) {
  const n = c5.length;
  const high = c5.map(x => x[2]), low = c5.map(x => x[3]), close = c5.map(x => x[4]);
  const tr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    tr[i] = i === 0 ? high[i] - low[i] : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  const atr = rollingMean(tr, N), sma = rollingMean(close, N);
  const upper = new Float64Array(n).fill(NaN), lower = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(sma[i]) && !Number.isNaN(atr[i])) { upper[i] = sma[i] + mult * atr[i]; lower[i] = sma[i] - mult * atr[i]; }
  }
  return { upper, lower, sma, atr, high, low, close };
}

module.exports = { dailyPivotLevels, genLevelSignals, starcBands, rollingMean };
