// SCAN "RELIQUAT CLASSIQUE" (agent x4_reliquat_, 31/08) — indicateurs classiques jamais portés proprement :
// Ichimoku (rejet du nuage réel spanA/spanB, pas juste distance au kijun déjà testée par ti_arsenal),
// Parabolic SAR (distance au SAR = surextension, seuil ADAPTATIF par percentile — pas le "flip après excès"
// déjà testé par ti_arsenal), KST de Pring (momentum, extrême z-score + reclaim du signal), Klinger Volume
// Oscillator (jamais testé, pas dans technicalindicators — implémenté à la main), Donchian WIDTH (compression
// en percentile bas du canal réel, pas Bollinger — déjà testé — ni ATR — déjà testé).
// Toutes les grilles sont GROSSIÈRES (2-3 crans/axe), 2 exits FONDATEURS choisis AVANT le scan (pas de
// balayage de sorties a posteriori — leçon O/YGG/STABLE).
const fs = require("fs");
const path = require("path");
const ti = require("technicalindicators");
const { chargerCandles, evaluer } = require("../harness_lib.js");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};

// Blocklist actions/commodités tokenisées (README + extensions vues en ronde, cf JOURNAL_RECHERCHE.md)
const BLOCK = new Set(("AAPL SPX TSLA NVDA MSTR SKHYNIX SKHY SNDK CRCL HOOD COIN GOOG GOOGL META AMZN MSFT AMD INTC QQQ " +
  "GLD XAUT TRUMP AXTI MRVL MU NBIS SOXL SOXS TQQQ EWY CXMT SAMSUNG XIAOMI UNITREE ZHIPU MINIMAX XAU XAG XCU BEAT BZ " +
  "CBRS CL CC CHIP DRAM SLX ROBO SPCX SPACE LITE OPG BARD SKDD SNXX AAOI AVGO TSM SPY BILL").split(" "));

// Cryptos déjà revendiquées par un candidates/*.js existant (règle 1 stratégie/crypto)
function dejaPris() {
  const dir = path.join(__dirname, "..", "candidates");
  const set = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const txt = fs.readFileSync(path.join(dir, f), "utf8");
    const m = txt.match(/instId:\s*"([^"]+)"/);
    if (m) set.add(m[1]);
  }
  return set;
}
const PRIS = dejaPris();

// ---------- Indicateurs (tout causal) ----------

// Ichimoku : spanA/spanB alignés sur l'index de bougie qui les VOIT (cloud "affichée" à la bougie i =
// calculée avec les données jusqu'à i-displacement ; en lisant l'array retourné par la lib à l'offset
// correspondant, on ne regarde jamais le futur — c'est même plus prudent que le tracé TradingView).
function ichimokuAlign(high, low, conv, base, span, disp) {
  const raw = ti.IchimokuCloud.calculate({ high, low, conversionPeriod: conv, basePeriod: base, spanPeriod: span, displacement: disp });
  const offset = high.length - raw.length; // raw[0] correspond à l'index "offset" de la bougie
  const n = high.length;
  const spanA = new Float64Array(n).fill(NaN), spanB = new Float64Array(n).fill(NaN);
  for (let j = 0; j < raw.length; j++) { spanA[offset + j] = raw[j].spanA; spanB[offset + j] = raw[j].spanB; }
  // cloud "vue" à la bougie i = valeurs calculées à i - disp (décalage classique du nuage)
  const topCloud = new Float64Array(n).fill(NaN), botCloud = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const j = i - disp;
    if (j < 0 || Number.isNaN(spanA[j]) || Number.isNaN(spanB[j])) continue;
    topCloud[i] = Math.max(spanA[j], spanB[j]);
    botCloud[i] = Math.min(spanA[j], spanB[j]);
  }
  return { topCloud, botCloud };
}

function psarSeries(high, low, step, max) {
  return Float64Array.from(ti.PSAR.calculate({ high, low, step, max }));
}

function kstSeries(closes, p) {
  const raw = ti.KST.calculate({
    values: closes, ROCPer1: p[0], ROCPer2: p[1], ROCPer3: p[2], ROCPer4: p[3],
    SMAROCPer1: p[4], SMAROCPer2: p[5], SMAROCPer3: p[6], SMAROCPer4: p[7], signalPeriod: p[8]
  });
  const offset = closes.length - raw.length;
  const n = closes.length;
  const kst = new Float64Array(n).fill(NaN), sig = new Float64Array(n).fill(NaN);
  for (let j = 0; j < raw.length; j++) { kst[offset + j] = raw[j].kst; sig[offset + j] = raw[j].signal; }
  return { kst, sig };
}

// Klinger Volume Oscillator (Stephen Klinger, 1977) — pas dans technicalindicators, implémentation manuelle causale.
function klingerSeries(high, low, close, vol) {
  const n = close.length;
  const dm = new Float64Array(n), T = new Int8Array(n), cm = new Float64Array(n), vf = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    dm[i] = high[i] - low[i];
    const hlc = high[i] + low[i] + close[i];
    const hlcPrev = i ? high[i - 1] + low[i - 1] + close[i - 1] : hlc;
    T[i] = (i === 0) ? 1 : (hlc > hlcPrev ? 1 : (hlc < hlcPrev ? -1 : T[i - 1]));
    if (i === 0) { cm[i] = dm[i]; continue; }
    cm[i] = (T[i] === T[i - 1]) ? cm[i - 1] + dm[i] : dm[i - 1] + dm[i];
    if (cm[i] > 0) vf[i] = vol[i] * Math.abs(2 * (dm[i] / cm[i] - 1)) * T[i] * 100;
  }
  const ema = (arr, period) => {
    const k = 2 / (period + 1), out = new Float64Array(arr.length).fill(NaN);
    let prev = null;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (Number.isNaN(v)) { out[i] = prev; continue; }
      prev = (prev === null) ? v : v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  };
  const emaShort = ema(vf, 34), emaLong = ema(vf, 55);
  const kvo = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) if (emaShort[i] != null && emaLong[i] != null) kvo[i] = emaShort[i] - emaLong[i];
  const sig = ema(Array.from(kvo), 13);
  return { kvo, sig: Float64Array.from(sig.map(v => v == null ? NaN : v)) };
}

// Donchian : plus haut/plus bas glissants sur N (EXCLUANT la bougie courante pour le niveau de cassure),
// largeur = (max-min)/close, percentile causal sur fenêtre WPCT glissante.
function donchian(high, low, close, N) {
  const n = close.length;
  const hi = new Float64Array(n).fill(NaN), lo = new Float64Array(n).fill(NaN), width = new Float64Array(n).fill(NaN);
  // deque simple (N est petit, recalcul direct — 30j*288 barres, N<=55, OK en O(n*N) ~ 8640*55 négligeable)
  for (let i = N; i < n; i++) {
    let mx = -Infinity, mn = Infinity;
    for (let k = i - N; k < i; k++) { if (high[k] > mx) mx = high[k]; if (low[k] < mn) mn = low[k]; }
    hi[i] = mx; lo[i] = mn;
    width[i] = (mx - mn) / close[i];
  }
  return { hi, lo, width };
}
function percentileRankCausal(series, i, W) {
  // rang percentile de series[i] parmi les W valeurs PRÉCÉDENTES (i exclu), causal.
  const start = i - W;
  if (start < 0) return NaN;
  let below = 0, cnt = 0;
  for (let k = start; k < i; k++) { const v = series[k]; if (Number.isNaN(v)) continue; cnt++; if (v <= series[i]) below++; }
  if (cnt < W * 0.8) return NaN;
  return 100 * below / cnt;
}

function range24(close, high, low, i) {
  // position dans le range 288 barres précédentes (0=bas, 1=haut), causal
  const start = i - 288;
  if (start < 0) return NaN;
  let mx = -Infinity, mn = Infinity;
  for (let k = start; k < i; k++) { if (high[k] > mx) mx = high[k]; if (low[k] < mn) mn = low[k]; }
  if (mx <= mn) return NaN;
  return (close[i] - mn) / (mx - mn);
}

// z-score causal vs SMA/std des W valeurs précédentes (série z, valeur courante exclue)
function zscoreCausal(series, W) {
  const n = series.length, z = new Float64Array(n).fill(NaN);
  for (let i = W; i < n; i++) {
    let s = 0, s2 = 0, cnt = 0;
    for (let k = i - W; k < i; k++) { const v = series[k]; if (Number.isNaN(v)) continue; s += v; s2 += v * v; cnt++; }
    if (cnt < W * 0.8) continue;
    const mean = s / cnt, varr = s2 / cnt - mean * mean;
    if (varr <= 0) continue;
    z[i] = (series[i] - mean) / Math.sqrt(varr);
  }
  return z;
}

// jour calendaire UTC (bloc-jour causal, comme x2_adaptatif) -> percentile ADAPTATIF recalibré chaque jour,
// fenêtre [d-CALIB, d) ne contient jamais le jour courant.
function seuilAdaptatifParJour(series, ts, CALIB_BARRES) {
  const n = series.length;
  const dayIdx = ts.map(t => Math.floor(t / 86400000));
  const out = new Float64Array(n).fill(NaN); // percentile-rank causal de |series[i]| vs sa distribution [d-CALIB, d)
  let dCur = null, windowStart = 0, sortedAbs = null;
  // regroupe par jour : pour chaque jour on calcule UNE fois la distribution des CALIB barres précédant le 1er index du jour
  const startsOfDay = [];
  for (let i = 0; i < n; i++) if (dCur !== dayIdx[i]) { dCur = dayIdx[i]; startsOfDay.push(i); }
  for (const s0 of startsOfDay) {
    const from = Math.max(0, s0 - CALIB_BARRES);
    if (s0 - from < CALIB_BARRES * 0.5) continue;
    const arr = [];
    for (let k = from; k < s0; k++) { const v = Math.abs(series[k]); if (!Number.isNaN(v)) arr.push(v); }
    if (arr.length < 200) continue;
    arr.sort((a, b) => a - b);
    // applique à toutes les bougies de ce jour (jusqu'au prochain changement de jour)
    let i = s0;
    while (i < n && dayIdx[i] === dayIdx[s0]) {
      const v = Math.abs(series[i]);
      if (!Number.isNaN(v)) {
        // recherche binaire du rang
        let lo = 0, hi = arr.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
        out[i] = 100 * lo / arr.length;
      }
      i++;
    }
  }
  return out;
}

// ---------- Scan ----------
let fichiers = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
const LIMIT = process.argv[2] ? parseInt(process.argv[2], 10) : null;
if (LIMIT) fichiers = fichiers.slice(0, LIMIT);
const lignes = [];
let scanned = 0;
const CALIB = 4032; // 14 jours en barres 5m (leçon x2_adaptatif : 14j > 7j)

for (const f of fichiers) {
  const instId = f.replace(".json", "");
  const base = instId.split("-")[0];
  if (BLOCK.has(base)) continue;
  if (PRIS.has(instId)) continue; // 1 stratégie/crypto : on ne rescanne pas les cryptos déjà prises
  let c5; try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
  if (!Array.isArray(c5) || c5.length < 4500) continue; // besoin d'assez d'historique pour warm-up+CALIB
  scanned++;

  const high = c5.map(x => x[2]), low = c5.map(x => x[3]), close = c5.map(x => x[4]), vol = c5.map(x => x[5]);
  const ts = c5.map(x => x[0]);
  const n = c5.length;

  function pushSig(sigs, fam, params) {
    if (sigs.length < 30) return;
    for (const ex of Object.keys(EXITS)) {
      const r = evaluer({ instId, exits: EXITS[ex], detect: () => sigs }, c5);
      if (!r.A || !r.B) continue;
      const valide = r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15;
      lignes.push({
        instId, fam, ...params, ex,
        espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
        wrOOS: r.B.wr, pfOOS: r.B.pf,
        worst: +Math.min(r.A.esp, r.B.esp).toFixed(2), valide
      });
    }
  }

  // ===== A) ICHIMOKU CLOUD REJECTION =====
  for (const [tag, conv, base_, span, disp] of [["classic", 9, 26, 52, 26], ["crypto", 20, 60, 120, 60]]) {
    if (n < span + disp + 50) continue;
    const { topCloud, botCloud } = ichimokuAlign(high, low, conv, base_, span, disp);
    for (const conf of [0, 1]) {
      const sigsLong = [], sigsShort = [];
      for (let i = span + disp + 5; i < n - 1; i++) {
        if (Number.isNaN(topCloud[i]) || Number.isNaN(botCloud[i]) || Number.isNaN(topCloud[i - 1]) || Number.isNaN(botCloud[i - 1])) continue;
        // LONG : était au-dessus du nuage, mèche dans le nuage (rejet du support), referme au-dessus
        if (close[i - 1] > topCloud[i - 1] && low[i] <= topCloud[i] && close[i] > topCloud[i]) {
          if (conf && !(close[i] > close[i - 1])) {} else sigsLong.push({ i5: i, dir: 1 });
        }
        // SHORT : était sous le nuage, mèche dans le nuage (rejet de résistance), referme sous
        if (close[i - 1] < botCloud[i - 1] && high[i] >= botCloud[i] && close[i] < botCloud[i]) {
          if (conf && !(close[i] < close[i - 1])) {} else sigsShort.push({ i5: i, dir: -1 });
        }
      }
      const sigs = sigsLong.concat(sigsShort);
      pushSig(sigs, "ICH", { periode: tag, conf });
    }
  }

  // ===== B) PARABOLIC SAR — surextension, seuil ADAPTATIF par percentile =====
  for (const [tag, step, max] of [["classic", 0.02, 0.2], ["fast", 0.03, 0.3]]) {
    const psar = psarSeries(high, low, step, max);
    const dist = new Float64Array(n).fill(NaN); // distance signée close-psar en % du close
    for (let i = 0; i < n; i++) if (!Number.isNaN(psar[i])) dist[i] = (close[i] - psar[i]) / close[i] * 100;
    const pr = seuilAdaptatifParJour(dist, ts, CALIB); // percentile-rank causal de |dist|
    for (const P of [90, 95]) {
      for (const mode of ["X", "R"]) {
        const sigs = [];
        for (let i = 1; i < n - 1; i++) {
          if (Number.isNaN(pr[i]) || Number.isNaN(dist[i])) continue;
          const extreme = pr[i] >= P;
          let fire = false;
          if (mode === "X") fire = extreme;
          else { const prevExtreme = !Number.isNaN(pr[i - 1]) && pr[i - 1] >= P; fire = prevExtreme && !extreme; } // reclaim : sortie de la zone extrême
          if (!fire) continue;
          const dir = dist[i] > 0 ? -1 : 1; // surextension → fade vers le SAR
          sigs.push({ i5: i, dir });
        }
        pushSig(sigs, "SAR", { periode: tag, P, mode });
      }
    }
  }

  // ===== C) KST de Pring — extrême z-score + reclaim du signal =====
  for (const [tag, p] of [["classic", [10, 15, 20, 30, 10, 10, 10, 15, 9]], ["fast", [6, 9, 12, 18, 6, 6, 6, 9, 6]]]) {
    if (n < 400) continue;
    const { kst, sig } = kstSeries(close, p);
    const z = zscoreCausal(Array.from(kst), 288);
    for (const T of [2, 2.5]) {
      for (const mode of ["X", "R"]) {
        const sigs = [];
        for (let i = 1; i < n - 1; i++) {
          if (Number.isNaN(z[i]) || Number.isNaN(kst[i]) || Number.isNaN(sig[i]) || Number.isNaN(sig[i - 1]) || Number.isNaN(kst[i - 1])) continue;
          const extreme = Math.abs(z[i]) >= T;
          let dir = 0;
          if (mode === "X") {
            // franchissement : KST croise le signal alors qu'il est en zone extrême
            const crossUp = kst[i - 1] <= sig[i - 1] && kst[i] > sig[i];
            const crossDn = kst[i - 1] >= sig[i - 1] && kst[i] < sig[i];
            if (extreme && z[i] < 0 && crossUp) dir = 1;
            if (extreme && z[i] > 0 && crossDn) dir = -1;
          } else {
            // reclaim : le z-score REVIENT sous le seuil après avoir été extrême (épuisement du momentum)
            const wasExtremeLow = z[i - 1] <= -T, wasExtremeHigh = z[i - 1] >= T;
            if (wasExtremeLow && z[i] > -T) dir = 1;
            if (wasExtremeHigh && z[i] < T) dir = -1;
          }
          if (dir) sigs.push({ i5: i, dir });
        }
        pushSig(sigs, "KST", { periode: tag, T, mode });
      }
    }
  }

  // ===== D) KLINGER VOLUME OSCILLATOR — croisement + filtre range24h (moitié favorable, leçon gen_regime) =====
  {
    const { kvo, sig } = klingerSeries(high, low, close, vol);
    for (const crossType of ["zero", "signal"]) {
      for (const RG of [0.5, 0.3]) {
        const sigs = [];
        for (let i = 289; i < n - 1; i++) {
          if (Number.isNaN(kvo[i]) || Number.isNaN(kvo[i - 1])) continue;
          const rg = range24(close, high, low, i);
          if (Number.isNaN(rg)) continue;
          let crossUp, crossDn;
          if (crossType === "zero") { crossUp = kvo[i - 1] <= 0 && kvo[i] > 0; crossDn = kvo[i - 1] >= 0 && kvo[i] < 0; }
          else { if (Number.isNaN(sig[i]) || Number.isNaN(sig[i - 1])) continue; crossUp = kvo[i - 1] <= sig[i - 1] && kvo[i] > sig[i]; crossDn = kvo[i - 1] >= sig[i - 1] && kvo[i] < sig[i]; }
          // fade : volume-force qui bascule haussier alors que le prix est dans le bas du range (achat de la capitulation), et inverse
          let dir = 0;
          if (crossUp && rg <= RG) dir = 1;
          if (crossDn && rg >= (1 - RG)) dir = -1;
          if (dir) sigs.push({ i5: i, dir });
        }
        pushSig(sigs, "KVO", { crossType, RG });
      }
    }
  }

  // ===== E) DONCHIAN WIDTH — compression (percentile bas) puis cassure, sens DOUBLE (continuation/fade) =====
  for (const N of [20, 55]) {
    const { hi, lo, width } = donchian(high, low, close, N);
    const wPct = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) wPct[i] = percentileRankCausal(width, i, 288);
    for (const PC of [15, 25]) {
      for (const sens of ["C", "F"]) {
        const sigs = [];
        for (let i = N + 289; i < n - 1; i++) {
          if (Number.isNaN(wPct[i - 1]) || wPct[i - 1] > PC) continue; // compression AVANT la bougie de cassure (pas de futur)
          if (Number.isNaN(hi[i - 1]) || Number.isNaN(lo[i - 1])) continue;
          let dir = 0;
          if (close[i] > hi[i - 1]) dir = sens === "C" ? 1 : -1;
          else if (close[i] < lo[i - 1]) dir = sens === "C" ? -1 : 1;
          if (dir) sigs.push({ i5: i, dir });
        }
        pushSig(sigs, "DONW", { N, PC, sens });
      }
    }
  }
}

lignes.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "rapports", "x4_reliquat_scan_resultats.json"), JSON.stringify(lignes, null, 1));
const valides = lignes.filter(l => l.valide);
console.log("cryptos scannées:", scanned, "lignes:", lignes.length, "valides:", valides.length);
for (const l of valides.slice(0, 60))
  console.log(`${l.instId} ${l.fam} worst ${l.worst} (IS ${l.espIS}/${l.nIS} OOS ${l.espOOS}/${l.nOOS} pf ${l.pfOOS} wr ${l.wrOOS}) ${JSON.stringify(l).slice(0,140)}`);
