// SHIB : CM Williams Vix Fix [Chris Moody] — VIX synthétique de FOND, formule Pine EXACTE
// (tradingview.com "CM_Williams_Vix_Fix_Finds_Market_Bottoms") :
//   wvf = ((highest(close, 30) - low) / highest(close, 30)) * 100
//   bande de Bollinger PROPRE au wvf (mid=sma(wvf,20), upper=mid+2*stdev(wvf,20))
// + symétrique inversé pour les SOMMETS (demandé, jamais publié tel quel sur TV) :
//   wvfTop = ((high - lowest(close, 30)) / lowest(close, 30)) * 100, même Bollinger dédiée.
// mode R (relâchement/reclaim) : le wvf ÉTAIT au-dessus de SA bande, retombe EN DESSOUS =
// la capitulation (fond) / l'euphorie (sommet) vient de culminer et de refluer -> retournement
// CONFIRMÉ (cf. leçon "reclaim > touch" reconfirmée 6x dans le journal, jamais testée sur
// Vix Fix). wvfLow qui reflue -> LONG ; wvfTop qui reflue -> SHORT.
// Aucun repaint : highest/lowest/mid/std tout causal (fenêtres [i-len+1..i]).
// Robustesse (banc 30 j) : pd30/mult2/R domine (bbl20 worst 7.98, bbl14 voisin worst 5.51,
// même signe, même mode) ; pd30/mult2/X (même pd) reste positif (worst 2.14-2.51) — plateau
// cohérent sur l'axe pd, R > X sur SHIB (le reclaim bat le touch, comme partout ailleurs).
const PD = 30, BBL = 20, MULT = 2.0, WARM = 300;

function rollingMax(arr, len) {
  const n = arr.length, out = new Float64Array(n).fill(NaN), dq = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && arr[dq[dq.length - 1]] <= arr[i]) dq.pop();
    dq.push(i);
    while (dq[0] <= i - len) dq.shift();
    if (i >= len - 1) out[i] = arr[dq[0]];
  }
  return out;
}
function rollingMin(arr, len) {
  const n = arr.length, out = new Float64Array(n).fill(NaN), dq = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && arr[dq[dq.length - 1]] >= arr[i]) dq.pop();
    dq.push(i);
    while (dq[0] <= i - len) dq.shift();
    if (i >= len - 1) out[i] = arr[dq[0]];
  }
  return out;
}
function rollingMeanStd(arr, len) { // causal ; ne cumule que le FINI (arr a un préfixe NaN)
  const n = arr.length, mean = new Float64Array(n).fill(NaN), std = new Float64Array(n).fill(NaN);
  let s = 0, s2 = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (!Number.isNaN(v)) { s += v; s2 += v * v; cnt++; }
    if (i >= len) {
      const vOut = arr[i - len];
      if (!Number.isNaN(vOut)) { s -= vOut; s2 -= vOut * vOut; cnt--; }
    }
    if (cnt === len) {
      const m = s / len, va = Math.max(0, s2 / len - m * m);
      mean[i] = m; std[i] = Math.sqrt(va);
    }
  }
  return { mean, std };
}
function genSignals(wvf, mean, std, dirSign, warm) {
  const out = [];
  for (let i = warm; i < wvf.length; i++) {
    const u = mean[i] + MULT * std[i], up1 = mean[i - 1] + MULT * std[i - 1];
    if (Number.isNaN(u) || Number.isNaN(up1) || Number.isNaN(wvf[i]) || Number.isNaN(wvf[i - 1])) continue;
    if (wvf[i - 1] > up1 && wvf[i] <= u) out.push({ i5: i, dir: dirSign });
  }
  return out;
}

module.exports = {
  instId: "SHIB-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const high = c5.map(x => x[2]), low = c5.map(x => x[3]), close = c5.map(x => x[4]);
    const hc = rollingMax(close, PD), lc = rollingMin(close, PD);
    const wvfLow = new Float64Array(c5.length).fill(NaN), wvfTop = new Float64Array(c5.length).fill(NaN);
    for (let i = 0; i < c5.length; i++) {
      if (!Number.isNaN(hc[i]) && hc[i] > 0) wvfLow[i] = (hc[i] - low[i]) / hc[i] * 100;
      if (!Number.isNaN(lc[i]) && lc[i] > 0) wvfTop[i] = (high[i] - lc[i]) / lc[i] * 100;
    }
    const bLow = rollingMeanStd(wvfLow, BBL), bTop = rollingMeanStd(wvfTop, BBL);
    const sigLong = genSignals(wvfLow, bLow.mean, bLow.std, 1, WARM);
    const sigShort = genSignals(wvfTop, bTop.mean, bTop.std, -1, WARM);
    return sigLong.concat(sigShort);
  }
};
