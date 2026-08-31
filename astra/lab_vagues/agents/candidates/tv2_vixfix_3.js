// MINA : CM Williams Vix Fix [Chris Moody] — même formule EXACTE que tv2_vixfix_2 (SHIB),
// mode X (franchissement) au lieu de R : wvf VIENT de dépasser SA propre bande de Bollinger
// -> on trade le pic de capitulation/euphorie lui-même, pas son reflux.
//   wvfLow = ((highest(close, 30) - low) / highest(close, 30)) * 100 -> LONG au franchissement
//   wvfTop = ((high - lowest(close, 30)) / lowest(close, 30)) * 100  -> SHORT au franchissement
//   bande : mid=sma(wvf,26), upper=mid+2*stdev(wvf,26) (bbl plus long que SHIB : MINA respire
//   plus lentement, bbl20 sous-performe ici — cf. voisin).
// Aucun repaint : highest/lowest/mid/std tout causal (fenêtres [i-len+1..i]).
// Robustesse (banc 30 j) : pd30/mult2/X domine (bbl26 worst 6.93) ; voisin pd22/bbl20/mult1.5/X
// worst 6.28 (même mode X, pd et bbl proches) — 2 cellules solides sur la même diagonale pd/bbl,
// contrairement à SHIB c'est le FRANCHISSEMENT qui gagne sur MINA (pas le reclaim) : le couple
// crypto×mode est idiosyncratique, cohérent avec la leçon du journal (recette non transplantable).
const PD = 30, BBL = 26, MULT = 2.0, WARM = 300;

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
    if (wvf[i] > u && wvf[i - 1] <= up1) out.push({ i5: i, dir: dirSign });
  }
  return out;
}

module.exports = {
  instId: "MINA-USDT-SWAP",
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
