// Support and Resistance Levels with Breaks [LuxAlgo] (4e bloc de Indicateurs.txt), port Pine FIDELE :
// pivots hauts/bas leftBars=rightBars=15 (ta.pivothigh/pivotlow), niveau = fixnan(pivot[1]) donc
// UTILISABLE seulement 15+1=16 barres après le sommet/creux du pivot (décalage causal EXACT du
// script, pas approximé) ; osc volume = 100*(ema5(vol)-ema10(vol))/ema10(vol) (formule du script,
// pas utilisé ici comme seuil de cassure mais comme jauge de calme/agitation).
// Lecture (c) demandée par le client : le prix TESTE un niveau (mèche à tol% du niveau) SANS le
// casser (close reste du bon côté), pendant que osc < seuil bas = personne ne pousse fort contre
// le niveau. Sur AUCTION, ce test "sans opposition" n'est PAS un rejet qui tient : il ANNONCE la
// cassure à venir -> on prend le sens de la cassure anticipée (long si test de résistance, short si
// test de support), pas le fade. Grille tol{0.1/0.2/0.3/0.5%} x volLow{-20/-10/0/10} x sense{fade,
// follow} x exit{E1,E2} : sense=follow domine massivement (12/16 cellules IS+OOS>0 en E1, contre
// 0/16 pour fade) et tol serré (0.1-0.2%) + volLow>=-10 forme un plateau dense et cohérent
// (5,00 / 5,20 / 4,51 / 3,88 tous positifs des deux côtés) — la cellule retenue (tol=0.2%,
// volLow=10) est le centre haut de ce plateau, pas un pic isolé.
const LEFT = 15, RIGHT = 15;
const TOL = 0.002, VOL_LOW = 10;

function ema(vals, n) {
  const N = vals.length;
  const out = new Float64Array(N).fill(NaN);
  if (N < n) return out;
  let s = 0; for (let i = 0; i < n; i++) s += vals[i];
  let prev = s / n; out[n - 1] = prev;
  const k = 2 / (n + 1);
  for (let i = n; i < N; i++) { prev = vals[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

function computePivots(highs, lows, left, right) {
  const n = highs.length;
  const isPH = new Uint8Array(n), isPL = new Uint8Array(n);
  for (let i = left; i < n - right; i++) {
    const hv = highs[i], lv = lows[i];
    let hMax = true, lMin = true;
    for (let k = i - left; k <= i + right; k++) {
      if (k === i) continue;
      if (hMax && highs[k] >= hv) hMax = false;
      if (lMin && lows[k] <= lv) lMin = false;
      if (!hMax && !lMin) break;
    }
    if (hMax) isPH[i] = 1;
    if (lMin) isPL[i] = 1;
  }
  return { isPH, isPL };
}

// niveau = fixnan(pivot[1]) : LAG = right+1, forward-fill jusqu'au pivot suivant
function buildLevels(n, isPH, isPL, highs, lows, right) {
  const LAG = right + 1;
  const res = new Float64Array(n).fill(NaN), sup = new Float64Array(n).fill(NaN);
  let curRes = NaN, curSup = NaN;
  for (let i = 0; i < n; i++) {
    const p = i - LAG;
    if (p >= 0) {
      if (isPH[p]) curRes = highs[p];
      if (isPL[p]) curSup = lows[p];
    }
    res[i] = curRes; sup[i] = curSup;
  }
  return { res, sup };
}

module.exports = {
  instId: "AUCTION-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const N = c5.length;
    const opens = new Float64Array(N), highs = new Float64Array(N), lows = new Float64Array(N),
      closes = new Float64Array(N), vols = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      opens[i] = c5[i][1]; highs[i] = c5[i][2]; lows[i] = c5[i][3]; closes[i] = c5[i][4]; vols[i] = c5[i][5];
    }
    const { isPH, isPL } = computePivots(highs, lows, LEFT, RIGHT);
    const { res, sup } = buildLevels(N, isPH, isPL, highs, lows, RIGHT);
    const e5 = ema(vols, 5), e10 = ema(vols, 10);
    const osc = new Float64Array(N).fill(NaN);
    for (let i = 0; i < N; i++) if (!Number.isNaN(e10[i]) && e10[i] !== 0) osc[i] = 100 * (e5[i] - e10[i]) / e10[i];

    const out = [];
    for (let i = 200; i < N - 2; i++) {
      if (Number.isNaN(osc[i]) || osc[i] >= VOL_LOW) continue;
      // test de résistance sans cassure : la mèche haute approche à TOL% mais le close reste dessous
      if (!Number.isNaN(res[i]) && highs[i] >= res[i] * (1 - TOL) && closes[i] < res[i]) {
        out.push({ i5: i, dir: 1 }); // follow : on anticipe la cassure vers le haut
        continue;
      }
      // test de support sans cassure : la mèche basse approche à TOL% mais le close reste dessus
      if (!Number.isNaN(sup[i]) && lows[i] <= sup[i] * (1 + TOL) && closes[i] > sup[i]) {
        out.push({ i5: i, dir: -1 }); // follow : on anticipe la cassure vers le bas
      }
    }
    return out;
  }
};
