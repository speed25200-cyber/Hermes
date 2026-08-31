// cli_sqzmom_2 XTZ : meme lecture que cli_sqzmom_1 (Squeeze Momentum LazyBear, contre-pied du
// pic de "val" en zone extreme z-score adaptatif >= 1.5, cf. cli_sqzmom_1 pour le detail formules).
// Exit ALT tp60/act20/hold8 (petite variante de seuils/duree par rapport a _1).
// Scan tools/cli_sqzmom_scan.js : plateau sur XTZ specifique a l'exit court (hold8) -> Z1.5/2/2.5
// TOUS positifs des deux cotes en E2 (3/3), mais E1 (hold12) negatif partout -> la sortie compte
// autant que le signal ici (coherent avec la lecon "l'exit fait partie de la recette", cf. journal).
// worst +5,37 (IS 5,37/50, OOS 6,34/34, pfOOS 1,87).
const LEN = 20, W = 576, Z = 1.5;

function sma(vals, n) {
  const out = new Array(vals.length).fill(null);
  let s = 0;
  for (let i = 0; i < vals.length; i++) {
    s += vals[i];
    if (i >= n) s -= vals[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
function rollingExtreme(vals, n, isMax) {
  const out = new Array(vals.length).fill(null);
  const dq = [];
  for (let i = 0; i < vals.length; i++) {
    while (dq.length && (isMax ? vals[dq[dq.length - 1]] <= vals[i] : vals[dq[dq.length - 1]] >= vals[i])) dq.pop();
    dq.push(i);
    if (dq[0] <= i - n) dq.shift();
    if (i >= n - 1) out[i] = vals[dq[0]];
  }
  return out;
}
function linregEndpoint(y, n) {
  const N = y.length;
  const out = new Array(N).fill(null);
  const S1 = n * (n - 1) / 2, S2 = (n - 1) * n * (2 * n - 1) / 6;
  const denom = n * S2 - S1 * S1;
  let Sy = 0, Sxy = 0;
  for (let i = 0; i < N; i++) {
    if (i < n - 1) { Sy += y[i]; continue; }
    if (i === n - 1) { Sy += y[i]; Sxy = 0; for (let k = 0; k < n; k++) Sxy += k * y[i - n + 1 + k]; }
    else {
      const yOld = y[i - n], yNew = y[i];
      Sxy = Sxy - Sy + yOld + (n - 1) * yNew;
      Sy = Sy - yOld + yNew;
    }
    const slope = (n * Sxy - S1 * Sy) / denom;
    out[i] = Sy / n + slope * (n - 1) / 2;
  }
  return out;
}
function calcVal(c5) {
  const N = c5.length;
  const h = new Array(N), l = new Array(N), c = new Array(N);
  for (let i = 0; i < N; i++) { h[i] = c5[i][2]; l[i] = c5[i][3]; c[i] = c5[i][4]; }
  const hh = rollingExtreme(h, LEN, true);
  const ll = rollingExtreme(l, LEN, false);
  const smaC = sma(c, LEN);
  const src = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    if (hh[i] === null || ll[i] === null || smaC[i] === null) continue;
    src[i] = c[i] - (((hh[i] + ll[i]) / 2) + smaC[i]) / 2;
  }
  const raw = linregEndpoint(src.map(v => v === null ? 0 : v), LEN);
  return src.map((v, i) => v === null ? null : raw[i]);
}
function rollingZ(val, W) {
  const N = val.length;
  const z = new Array(N).fill(null);
  let s = 0, s2 = 0, cnt = 0;
  const buf = [];
  for (let i = 0; i < N; i++) {
    const v = val[i];
    if (v !== null) { buf.push(v); s += v; s2 += v * v; cnt++; } else buf.push(null);
    if (buf.length > W) { const old = buf.shift(); if (old !== null) { s -= old; s2 -= old * old; cnt--; } }
    if (v !== null && cnt >= Math.floor(W * 0.6)) {
      const mean = s / cnt, varr = Math.max(1e-12, s2 / cnt - mean * mean), sd = Math.sqrt(varr);
      z[i] = sd > 1e-9 ? (v - mean) / sd : 0;
    }
  }
  return z;
}

module.exports = {
  instId: "XTZ-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  detect(c5) {
    const N = c5.length, out = [];
    const val = calcVal(c5);
    const z = rollingZ(val, W);
    for (let i = 400; i < N - 2; i++) {
      if (val[i] === null || val[i - 1] === null || z[i - 1] === null) continue;
      if (val[i - 1] > 0 && z[i - 1] >= Z && val[i] <= val[i - 1]) out.push({ i5: i, dir: -1 });
      else if (val[i - 1] < 0 && z[i - 1] <= -Z && val[i] >= val[i - 1]) out.push({ i5: i, dir: 1 });
    }
    return out;
  }
};
