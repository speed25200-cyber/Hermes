// SCAN "PACK FILTRES DE RANGE" (agent tv2_rangefilter_, 31/08) — indicateurs communautaires TradingView :
// A) Range Filter [DW] (DonovanWall / guikroth version, formule Pine v4 vérifiée sur le web,
//    prorealcode + tradingviewscript.blogspot.com) : filtre de bruit par bande ATR lissée
//    (smoothrng = EMA(EMA(|Δsrc|,per), 2·per-1)·mult ; rngfilt = filtre récursif borné par la bande).
//    Recette demandée : FADE du retour dans le filtre après une sortie (reclaim des bandes hband/lband).
// B) Half Trend (everget / deepwiki, formule vérifiée) : amplitude highest/lowest + SMA(high/low),
//    flip causal trend 0/1 sans repaint (on ignore les niveaux atrHigh/atrLow, non nécessaires au signal).
//    Recette : FADE du retournement de canal (le flip = prise de stops, on joue le snap-back) — même
//    lignée que UT Bot fadé (déjà mort, ne pas refaire tel quel) mais indicateur structurellement différent.
// C) SSL Channel (ErwinBeckers/prorealcode, formule vérifiée : Hlv état ±1 sur close vs SMA(high)/SMA(low)).
//    Recette demandée : FADE du faux flip Hlv (croisement SMA high/low).
// Toutes causales strictes (aucun regard vers l'avant). Exits FONDATEURS E1/E2 uniquement (pas de balayage
// de sorties a posteriori — leçon O/YGG/STABLE). Grilles GROSSIÈRES (2-3 valeurs par paramètre).
const fs = require("fs");
const path = require("path");
const AG = "C:/Users/Administrator/Desktop/HERMES_V4_LIVE/lab_vagues/agents";
const { chargerCandles, evaluer } = require(path.join(AG, "harness_lib.js"));

const DATA_DIR = path.join(AG, "..", "data");
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};

// Blocklist actions tokenisées / commodities / trackers (fusion des blocklists déjà établies dans le journal)
const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI AXS BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY " +
  "GOOGL GOOG INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK " +
  "SNXX SOXL SOXS SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD").split(" "));
// Cryptos protégées (champions forts / EN_LIVE) — n'y toucher que si on bat leur score bi-époque (hors scope ici)
const PROTECT = new Set(["PIEVERSE", "ENSO", "GRASS", "GPS", "SOON", "O", "USELESS", "AXS", "MANA", "LUNA", "MEGA", "NES"]);

const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, "tv2_baseline_resultats.json")));

// ---------- indicateurs (causaux stricts) ----------
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
  for (let i = 0; i < n; i++) {
    s += x[i]; if (i >= p) s -= x[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
}
function rmaATR(c5, p) {
  const n = c5.length, atr = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 1; i < n; i++) {
    const h = c5[i][2], l = c5[i][3], pc = c5[i - 1][4];
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (i <= p) { sum += tr; if (i === p) atr[i] = sum / p; }
    else atr[i] = (atr[i - 1] * (p - 1) + tr) / p;
  }
  return atr;
}

// A) Range Filter [DW] : filt/hband/lband
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

// B) Half Trend : suite trend[] 0=up/1=down (flip causal, sans repaint)
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

// C) SSL Channel : Hlv[] etat +1/-1
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

// ---------- signaux ----------
const WARM = 700;

function sigRangeFilterFadeReclaim(c5, per, mult) {
  const close = c5.map(r => r[4]);
  const { hband, lband } = rangeFilter(close, per, mult);
  const out = [];
  for (let i = WARM; i < c5.length - 2; i++) {
    const c = close[i], cp = close[i - 1];
    if (cp > hband[i - 1] && c <= hband[i]) out.push({ i5: i, dir: -1 }); // reclaim depuis le haut -> fade -> short
    else if (cp < lband[i - 1] && c >= lband[i]) out.push({ i5: i, dir: 1 }); // reclaim depuis le bas -> fade -> long
  }
  return out;
}

function sigHalfTrend(c5, amplitude, fade) {
  const trend = halfTrend(c5, amplitude);
  const out = [];
  for (let i = WARM; i < c5.length - 2; i++) {
    if (trend[i] === 0 && trend[i - 1] === 1) out.push({ i5: i, dir: fade ? -1 : 1 });  // flip haussier
    else if (trend[i] === 1 && trend[i - 1] === 0) out.push({ i5: i, dir: fade ? 1 : -1 }); // flip baissier
  }
  return out;
}

function sigSSLFade(c5, period) {
  const hlv = sslHlv(c5, period);
  const out = [];
  for (let i = WARM; i < c5.length - 2; i++) {
    if (hlv[i] === 1 && hlv[i - 1] === -1) out.push({ i5: i, dir: -1 });  // faux flip haussier -> fade -> short
    else if (hlv[i] === -1 && hlv[i - 1] === 1) out.push({ i5: i, dir: 1 }); // faux flip baissier -> fade -> long
  }
  return out;
}

// ---------- scan ----------
const RF_PER = [50, 100], RF_MULT = [2.0, 3.0, 4.0];
const HT_AMP = [2, 4, 6];
const SSL_PER = [10, 20, 34];

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith("-USDT-SWAP.json"));
const res = [];
let done = 0;
for (const f of files) {
  const inst = f.replace(".json", "");
  const base = inst.replace("-USDT-SWAP", "");
  if (BLOCK.has(base) || PROTECT.has(base)) continue;
  let c5; try { c5 = chargerCandles("data", inst); } catch (e) { continue; }
  if (!c5 || c5.length < 3000) continue;

  // A) Range Filter fade-reclaim
  for (const per of RF_PER) for (const mult of RF_MULT) {
    const sigs = sigRangeFilterFadeReclaim(c5, per, mult);
    if (sigs.length < 20) continue;
    for (const ex of Object.keys(EXITS)) {
      const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
      if (!r.A || !r.B) continue;
      res.push({ fam: "RF", inst, per, mult, ex, espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
        wrOOS: r.B.wr, pfOOS: r.B.pf, worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
        valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15 });
    }
  }

  // B) Half Trend fade + momentum (comparatif)
  for (const amp of HT_AMP) for (const fade of [true, false]) {
    const sigs = sigHalfTrend(c5, amp, fade);
    if (sigs.length < 20) continue;
    for (const ex of Object.keys(EXITS)) {
      const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
      if (!r.A || !r.B) continue;
      res.push({ fam: fade ? "HT_fade" : "HT_mom", inst, amp, ex, espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
        wrOOS: r.B.wr, pfOOS: r.B.pf, worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
        valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15 });
    }
  }

  // C) SSL Channel fade
  for (const per of SSL_PER) {
    const sigs = sigSSLFade(c5, per);
    if (sigs.length < 20) continue;
    for (const ex of Object.keys(EXITS)) {
      const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
      if (!r.A || !r.B) continue;
      res.push({ fam: "SSL_fade", inst, per, ex, espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
        wrOOS: r.B.wr, pfOOS: r.B.pf, worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
        valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15 });
    }
  }

  done++;
  if (done % 40 === 0) console.error(`... ${done} cryptos`);
}
res.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "tv2_rangefilter_scan_resultats.json"), JSON.stringify(res, null, 1));

// Top valide, en respectant 1 STRAT/CRYPTO vs baseline existant
const valides = res.filter(r => r.valide);
const bestParCrypto = {};
for (const r of valides) { if (!bestParCrypto[r.inst] || r.worst > bestParCrypto[r.inst].worst) bestParCrypto[r.inst] = r; }
const libres = Object.values(bestParCrypto).filter(r => {
  const base = r.inst.replace("-USDT-SWAP", "");
  const champ = baseline[r.inst];
  return !champ || r.worst > champ.worst;
}).sort((a, b) => b.worst - a.worst);

console.log(JSON.stringify({
  cryptos: done, lignes: res.length, valides: valides.length,
  top_libres_ou_meilleurs: libres.slice(0, 20)
}, null, 1));
