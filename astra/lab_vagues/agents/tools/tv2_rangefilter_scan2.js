// PASSE 2 — raffinement pack filtres de range (agent tv2_rangefilter_, 31/08)
// Passe 1 : RF quasi vide (per100/mult2-4 = bande trop lente pour un reclaim en 1 bougie) ;
//   HT_fade et SSL_fade vivants mais plafonnent sous +7 en valide -> on ajoute les 2 filtres
//   a-priori documentés par le journal (bougie de confirmation, régime plat ADX15m<25) et on
//   élargit les grilles (RF plus rapide, HT amplitude plus large, SSL période plus large).
const fs = require("fs");
const path = require("path");
const ti = require("technicalindicators");
const AG = "C:/Users/Administrator/Desktop/HERMES_V4_LIVE/lab_vagues/agents";
const { chargerCandles, evaluer } = require(path.join(AG, "harness_lib.js"));

const DATA_DIR = path.join(AG, "..", "data");
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};
const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI AXS BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY " +
  "GOOGL GOOG INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK " +
  "SNXX SOXL SOXS SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD").split(" "));
const PROTECT = new Set(["PIEVERSE", "ENSO", "GRASS", "GPS", "SOON", "O", "USELESS", "AXS", "MANA", "LUNA", "MEGA", "NES"]);
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, "tv2_baseline_resultats.json")));

function ema(x, t) {
  const n = x.length, out = new Float64Array(n).fill(NaN);
  const k = 2 / (t + 1);
  out[0] = x[0];
  for (let i = 1; i < n; i++) out[i] = x[i] * k + out[i - 1] * (1 - k);
  return out;
}
function sma(x, p) {
  const n = x.length, out = new Float64Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) { s += x[i]; if (i >= p) s -= x[i - p]; if (i >= p - 1) out[i] = s / p; }
  return out;
}
// ADX 15m agrégé causal (cf. ti_arsenal_3), disponible seulement à la clôture 15m
function adxMap15(c5) {
  const N = c5.length;
  const h = c5.map(r => r[2]), l = c5.map(r => r[3]), c = c5.map(r => r[4]);
  const h15 = [], l15 = [], c15 = [], e15 = [];
  for (let i = 0; i + 2 < N; ) {
    const t0 = c5[i][0];
    if (t0 % 900000 !== 0) { i++; continue; }
    if (c5[i + 1][0] - t0 !== 300000 || c5[i + 2][0] - t0 !== 600000) { i++; continue; }
    h15.push(Math.max(h[i], h[i + 1], h[i + 2]));
    l15.push(Math.min(l[i], l[i + 1], l[i + 2]));
    c15.push(c[i + 2]); e15.push(i + 2);
    i += 3;
  }
  const adxArr = ti.adx({ high: h15, low: l15, close: c15, period: 14 });
  const oA = c15.length - adxArr.length;
  const map = new Array(N).fill(null);
  let m = 0, cur = null;
  for (let i = 0; i < N; i++) {
    while (m < e15.length && e15[m] <= i) { const j = m - oA; if (j >= 0) cur = adxArr[j].adx; m++; }
    map[i] = cur;
  }
  return map;
}

// A) Range Filter rapide
function rangeFilter(close, per, mult) {
  const n = close.length;
  const diff = new Float64Array(n).fill(0);
  for (let i = 1; i < n; i++) diff[i] = Math.abs(close[i] - close[i - 1]);
  const avrng = ema(diff, per);
  const wper = per * 2 - 1;
  const smrng = ema(avrng, wper).map(v => v * mult);
  const filt = new Float64Array(n).fill(NaN);
  filt[0] = close[0];
  for (let i = 1; i < n; i++) {
    const x = close[i], r = smrng[i], prev = filt[i - 1];
    if (x > prev) filt[i] = (x - r < prev) ? prev : x - r;
    else filt[i] = (x + r > prev) ? prev : x + r;
  }
  const hband = new Float64Array(n), lband = new Float64Array(n);
  for (let i = 0; i < n; i++) { hband[i] = filt[i] + smrng[i]; lband[i] = filt[i] - smrng[i]; }
  return { hband, lband };
}

function halfTrend(c5, amplitude) {
  const n = c5.length;
  const high = c5.map(r => r[2]), low = c5.map(r => r[3]), close = c5.map(r => r[4]);
  const highma = sma(high, amplitude), lowma = sma(low, amplitude);
  const highPrice = new Float64Array(n).fill(NaN), lowPrice = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i < amplitude - 1) continue;
    let mx = -Infinity, mn = Infinity;
    for (let k = i - amplitude + 1; k <= i; k++) { if (high[k] > mx) mx = high[k]; if (low[k] < mn) mn = low[k]; }
    highPrice[i] = mx; lowPrice[i] = mn;
  }
  const trend = new Int8Array(n).fill(0);
  let nextTrend = 0, maxLowPrice = low[0], minHighPrice = high[0], curTrend = 0;
  for (let i = 1; i < n; i++) {
    if (Number.isNaN(highPrice[i]) || Number.isNaN(highma[i]) || Number.isNaN(lowma[i])) { trend[i] = curTrend; continue; }
    if (nextTrend === 1) {
      maxLowPrice = Math.max(lowPrice[i], maxLowPrice);
      if (highma[i] < maxLowPrice && close[i] < low[i - 1]) { curTrend = 1; nextTrend = 0; minHighPrice = highPrice[i]; }
    } else {
      minHighPrice = Math.min(highPrice[i], minHighPrice);
      if (lowma[i] > minHighPrice && close[i] > high[i - 1]) { curTrend = 0; nextTrend = 1; maxLowPrice = lowPrice[i]; }
    }
    trend[i] = curTrend;
  }
  return trend;
}

function sslHlv(c5, period) {
  const n = c5.length;
  const high = c5.map(r => r[2]), low = c5.map(r => r[3]), close = c5.map(r => r[4]);
  const smaHigh = sma(high, period), smaLow = sma(low, period);
  const hlv = new Int8Array(n).fill(0);
  let cur = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(smaHigh[i]) || Number.isNaN(smaLow[i])) { hlv[i] = cur; continue; }
    if (close[i] > smaHigh[i]) cur = 1;
    else if (close[i] < smaLow[i]) cur = -1;
    hlv[i] = cur;
  }
  return hlv;
}

const WARM = 700;

function sigRF(c5, per, mult, conf) {
  const close = c5.map(r => r[4]);
  const { hband, lband } = rangeFilter(close, per, mult);
  const out = [];
  for (let i = WARM; i < c5.length - 2; i++) {
    const c = close[i], cp = close[i - 1];
    let d = 0;
    if (cp > hband[i - 1] && c <= hband[i]) d = -1;
    else if (cp < lband[i - 1] && c >= lband[i]) d = 1;
    if (!d) continue;
    if (conf) {
      const o = c5[i][1];
      if (d > 0 && c < o) continue;
      if (d < 0 && c > o) continue;
    }
    out.push({ i5: i, dir: d });
  }
  return out;
}

function sigHT(c5, amplitude, conf, adxMax) {
  const trend = halfTrend(c5, amplitude);
  const adxMap = adxMax ? adxMap15(c5) : null;
  const out = [];
  for (let i = WARM; i < c5.length - 2; i++) {
    let d = 0;
    if (trend[i] === 0 && trend[i - 1] === 1) d = -1;
    else if (trend[i] === 1 && trend[i - 1] === 0) d = 1;
    if (!d) continue;
    if (adxMax && (adxMap[i] === null || adxMap[i] >= adxMax)) continue;
    if (conf) {
      const o = c5[i][1], c = c5[i][4];
      if (d > 0 && c < o) continue;
      if (d < 0 && c > o) continue;
    }
    out.push({ i5: i, dir: d });
  }
  return out;
}

function sigSSL(c5, period, conf, adxMax) {
  const hlv = sslHlv(c5, period);
  const adxMap = adxMax ? adxMap15(c5) : null;
  const out = [];
  for (let i = WARM; i < c5.length - 2; i++) {
    let d = 0;
    if (hlv[i] === 1 && hlv[i - 1] === -1) d = -1;
    else if (hlv[i] === -1 && hlv[i - 1] === 1) d = 1;
    if (!d) continue;
    if (adxMax && (adxMap[i] === null || adxMap[i] >= adxMax)) continue;
    if (conf) {
      const o = c5[i][1], c = c5[i][4];
      if (d > 0 && c < o) continue;
      if (d < 0 && c > o) continue;
    }
    out.push({ i5: i, dir: d });
  }
  return out;
}

const RF_PER = [14, 20, 28], RF_MULT = [1.0, 1.5, 2.0];
const HT_AMP = [3, 4, 5, 6, 8, 10, 14], HT_CONF = [0, 1], HT_ADX = [0, 25];
const SSL_PER = [10, 14, 20, 28, 34, 50], SSL_CONF = [0, 1], SSL_ADX = [0, 25];

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith("-USDT-SWAP.json"));
const res = [];
let done = 0;
for (const f of files) {
  const inst = f.replace(".json", "");
  const base = inst.replace("-USDT-SWAP", "");
  if (BLOCK.has(base) || PROTECT.has(base)) continue;
  let c5; try { c5 = chargerCandles("data", inst); } catch (e) { continue; }
  if (!c5 || c5.length < 3000) continue;

  for (const per of RF_PER) for (const mult of RF_MULT) for (const conf of [0, 1]) {
    const sigs = sigRF(c5, per, mult, conf);
    if (sigs.length < 20) continue;
    for (const ex of Object.keys(EXITS)) {
      const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
      if (!r.A || !r.B) continue;
      res.push({ fam: "RF", inst, per, mult, conf, ex, espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
        wrOOS: r.B.wr, pfOOS: r.B.pf, worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
        valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15 });
    }
  }

  for (const amp of HT_AMP) for (const conf of HT_CONF) for (const adxMax of HT_ADX) {
    const sigs = sigHT(c5, amp, conf, adxMax);
    if (sigs.length < 20) continue;
    for (const ex of Object.keys(EXITS)) {
      const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
      if (!r.A || !r.B) continue;
      res.push({ fam: "HT", inst, amp, conf, adxMax, ex, espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
        wrOOS: r.B.wr, pfOOS: r.B.pf, worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
        valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15 });
    }
  }

  for (const per of SSL_PER) for (const conf of SSL_CONF) for (const adxMax of SSL_ADX) {
    const sigs = sigSSL(c5, per, conf, adxMax);
    if (sigs.length < 20) continue;
    for (const ex of Object.keys(EXITS)) {
      const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
      if (!r.A || !r.B) continue;
      res.push({ fam: "SSL", inst, per, conf, adxMax, ex, espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
        wrOOS: r.B.wr, pfOOS: r.B.pf, worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
        valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15 });
    }
  }

  done++;
  if (done % 40 === 0) console.error(`... ${done} cryptos`);
}
res.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "tv2_rangefilter_scan2_resultats.json"), JSON.stringify(res, null, 1));

const valides = res.filter(r => r.valide);
const bestParCrypto = {};
for (const r of valides) { if (!bestParCrypto[r.inst] || r.worst > bestParCrypto[r.inst].worst) bestParCrypto[r.inst] = r; }
const libres = Object.values(bestParCrypto).filter(r => {
  const champ = baseline[r.inst];
  return !champ || r.worst > champ.worst;
}).sort((a, b) => b.worst - a.worst);

console.log(JSON.stringify({
  cryptos: done, lignes: res.length, valides: valides.length,
  top_libres_ou_meilleurs: libres.slice(0, 25)
}, null, 1));
