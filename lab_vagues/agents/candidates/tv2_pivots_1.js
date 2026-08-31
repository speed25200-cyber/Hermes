// PNUT : Pivot Points journaliers CLASSIQUES (méthode "Floor Trader" standard, TradingView
// "Pivot Points Standard") calculés sur le JOUR CALENDAIRE UTC PRÉCÉDENT :
//   PP = (Hveille+Lveille+Cveille)/3   R1 = 2*PP-Lveille   S1 = 2*PP-Hveille
// Signal = fade de N'IMPORTE LEQUEL des 3 niveaux, rejet(X) OU reclaim(R) confondus : PP joue son
// rôle local (support/résistance selon le côté d'approche), S1 = support pur (fade LONG), R1 =
// résistance pure (fade SHORT). Nécessaire ici : chaque niveau PRIS SEUL est trop rare sur 30 j
// pour passer le seuil n>=60 du banc (1 seul niveau/jour, souvent jamais retouché) — combiner les
// 3 niveaux × 2 modes en UN signal ("le prix vient de refuser un pivot journalier, peu importe
// lequel") est la seule lecture de cette famille qui débite assez de trades sur une crypto LIBRE.
// ⚠️ Famille globalement FAIBLE sur ce dataset (le meilleur niveau isolé, PP-reclaim sur BICO,
// atteint worst +6,64 mais BICO est déjà mieux servie par inv_murs_2, +8,05) : PNUT +5,52 est le
// meilleur résultat combiné disponible sur une crypto encore libre, sous l'objectif +6.
// Aucun repaint : niveaux du jour d calculés sur le jour d-1 ENTIER ; reclaim exige un niveau
// stable entre i-1/i (pas de bascule de jour UTC comptée comme un reclaim de marché).
const WARM = 320;

function dailyPivotLevels(c5) {
  const n = c5.length;
  const dayRec = new Map();
  for (let i = 0; i < n; i++) {
    const ts = c5[i][0], h = c5[i][2], l = c5[i][3], c = c5[i][4];
    const d = Math.floor(ts / 86400000);
    let rec = dayRec.get(d);
    if (!rec) dayRec.set(d, { h, l, c });
    else { if (h > rec.h) rec.h = h; if (l < rec.l) rec.l = l; rec.c = c; }
  }
  const lvlByDay = new Map();
  for (const [d, rec] of dayRec) {
    const PP = (rec.h + rec.l + rec.c) / 3;
    lvlByDay.set(d + 1, { PP, S1: 2 * PP - rec.h, R1: 2 * PP - rec.l });
  }
  const PPa = new Float64Array(n).fill(NaN), S1a = new Float64Array(n).fill(NaN), R1a = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const d = Math.floor(c5[i][0] / 86400000);
    const lv = lvlByDay.get(d);
    if (lv) { PPa[i] = lv.PP; S1a[i] = lv.S1; R1a[i] = lv.R1; }
  }
  return { PP: PPa, S1: S1a, R1: R1a };
}

function genLevelSignals(levelArr, close, high, low, role, mode, warm) {
  const out = [];
  for (let i = warm; i < close.length; i++) {
    const L = levelArr[i], Lp = levelArr[i - 1];
    if (Number.isNaN(L) || Number.isNaN(Lp)) continue;
    if (mode === "X") {
      if (role !== "res" && low[i] <= L && close[i] > L) out.push({ i5: i, dir: 1 });
      if (role !== "sup" && high[i] >= L && close[i] < L) out.push({ i5: i, dir: -1 });
    } else {
      if (L !== Lp) continue;
      if (role !== "res" && close[i - 1] < Lp && close[i] >= L) out.push({ i5: i, dir: 1 });
      if (role !== "sup" && close[i - 1] > Lp && close[i] <= L) out.push({ i5: i, dir: -1 });
    }
  }
  return out;
}

module.exports = {
  instId: "PNUT-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const high = c5.map(x => x[2]), low = c5.map(x => x[3]), close = c5.map(x => x[4]);
    const lvl = dailyPivotLevels(c5);
    const out = [];
    for (const mode of ["X", "R"]) {
      out.push(...genLevelSignals(lvl.PP, close, high, low, "piv", mode, WARM));
      out.push(...genLevelSignals(lvl.S1, close, high, low, "sup", mode, WARM));
      out.push(...genLevelSignals(lvl.R1, close, high, low, "res", mode, WARM));
    }
    return out;
  }
};
