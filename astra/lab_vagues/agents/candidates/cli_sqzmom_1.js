// cli_sqzmom_1 ZETA : Squeeze Momentum Indicator [LazyBear] (SQZMOM_LB), port Pine FIDELE
// (BB20/2 dans KC20/1.5xTR ; val = linreg(close - avg(avg(hh20,ll20), sma20), 20, 0)).
// Lecture CONTRE-PIED (b) : pic de "val" en zone EXTREME (z-score adaptatif >= 1.5 sur fenetre
// causale 48h, equivalent percentile PAR CRYPTO) qui decroche -> transition Pine EXACTE
// lime->green (val>0 puis val<=val[1]) ou red->maroon (val<0 puis val>=val[1]) = essoufflement,
// on prend le contre-pied. Exit standard tp80/act30/hold12.
// Scan tools/cli_sqzmom_scan.js : plateau plein sur ZETA -> fade positif des DEUX cotes (IS/OOS)
// sur les 3 crans de Z (1.5/2/2.5) ET les 2 exits (E1/E2) simultanement (6/6 cellules positives),
// pas un pic isole. worst +5,80 (IS 8,69/38, OOS 5,80/26, pfOOS 1,55).
// Mort confirme au passage : "cont" (suivre l'acceleration au lieu de la fader) est negatif
// partout sur ZETA (-3 a -19) -> le sens gagnant ici est bien le contre-pied, pas la continuation.
const LEN = 20, MULT_KC = 1.5, W = 576, Z = 1.5;

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
function stdevSMA(vals, n, smaVals) {
  const out = new Array(vals.length).fill(null);
  let s2 = 0;
  for (let i = 0; i < vals.length; i++) {
    s2 += vals[i] * vals[i];
    if (i >= n) s2 -= vals[i - n] * vals[i - n];
    if (i >= n - 1) {
      const mean = smaVals[i], varr = s2 / n - mean * mean;
      out[i] = Math.sqrt(Math.max(0, varr));
    }
  }
  return out;
}
function trueRange(h, l, c) {
  const out = new Array(h.length);
  out[0] = h[0] - l[0];
  for (let i = 1; i < h.length; i++) out[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
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
  instId: "ZETA-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
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
