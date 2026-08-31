// Scan Squeeze Momentum Indicator [LazyBear] (SQZMOM_LB) : port FIDELE des formules Pine.
// BB(20,2) DANS Keltner(20,1.5xTR) = squeeze ; val = linreg(close - avg(avg(hh20,ll20), sma20), 20, 0).
// bcolor Pine EXACT : val>0 & val>val[1] -> lime (accel haussier) ; val>0 & val<=val[1] -> green (essoufflement) ;
//                     val<0 & val<val[1] -> red (accel baissier)  ; val<0 & val>=val[1] -> maroon (essoufflement).
// 3 lectures demandees :
//  (a) release  : sortie de squeeze (sqzOn[i-1] -> !sqzOn[i]) jouee dans le sens de val[i] (deja mort ronde 2, teste pour verif)
//  (b) fade     : pic de val en zone EXTREME qui decroit (transition lime->green ou red->maroon) -> CONTRE-PIED
//  (c) cont     : val EXTREME qui ACCELERE (lime/red qui se prolonge) -> SUIT le sens (adaptation "signal brut")
// "extreme" = lecture PERCENTILE PAR CRYPTO : z-score adaptatif de val sur fenetre causale glissante W
// (equivalent percentile sous hypothese ~gaussienne, meme convention que z-SMA48/PSAR/x2_adaptatif du labo).
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require("../harness_lib.js");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const BLOCK = new Set(["AAPL","SPX","TSLA","NVDA","MSTR","SKHYNIX","SKHY","SNDK","CRCL","HOOD","COIN","GOOG","GOOGL",
  "META","AMZN","MSFT","AMD","INTC","QQQ","GLD","XAUT","TRUMP","AXTI","MRVL","MU","NBIS","SOXL","SOXS","TQQQ","EWY",
  "CXMT","SAMSUNG","XIAOMI","UNITREE","ZHIPU","MINIMAX","XAU","XAG","XCU","BEAT","BZ","CBRS","CL","CC","CHIP","DRAM",
  "SLX","ROBO","SPCX","SPACE","LITE","OPG","BARD","SKDD","SNXX","AAOI","AVGO","TSM","SPY","BILL",
  "ASML","HPE","OKTA","XBI","ZM","XPT","USDC"]);

const CLAIMED = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, "_sqzmom_claimed.json"), "utf8")));

function listeInstruments() {
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => f.replace(".json", ""))
    .filter(id => !BLOCK.has(id.split("-")[0]) && !CLAIMED.has(id));
}

// ---------- indicateur SQZMOM_LB fidele ----------
const LEN = 20, MULT_BB = 2.0, LEN_KC = 20, MULT_KC = 1.5;

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
// stdev Pine (population, biais /n) via sommes glissantes
function stdevSMA(vals, n, smaVals) {
  const out = new Array(vals.length).fill(null);
  let s2 = 0;
  for (let i = 0; i < vals.length; i++) {
    s2 += vals[i] * vals[i];
    if (i >= n) s2 -= vals[i - n] * vals[i - n];
    if (i >= n - 1) {
      const mean = smaVals[i];
      const varr = s2 / n - mean * mean;
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
// max/min glissant causal (deque monotone), inclusif, longueur n
function rollingExtreme(vals, n, isMax) {
  const out = new Array(vals.length).fill(null);
  const dq = []; // indices
  for (let i = 0; i < vals.length; i++) {
    while (dq.length && (isMax ? vals[dq[dq.length - 1]] <= vals[i] : vals[dq[dq.length - 1]] >= vals[i])) dq.pop();
    dq.push(i);
    if (dq[0] <= i - n) dq.shift();
    if (i >= n - 1) out[i] = vals[dq[0]];
  }
  return out;
}
// linreg endpoint (offset 0) glissant, O(1) amorti via sommes Sy/Sxy
function linregEndpoint(y, n) {
  const N = y.length;
  const out = new Array(N).fill(null);
  const S1 = n * (n - 1) / 2, S2 = (n - 1) * n * (2 * n - 1) / 6;
  const denom = n * S2 - S1 * S1;
  let Sy = 0, Sxy = 0;
  for (let i = 0; i < N; i++) {
    if (i < n - 1) { Sy += y[i]; continue; }
    if (i === n - 1) {
      Sy += y[i];
      Sxy = 0;
      for (let k = 0; k < n; k++) Sxy += k * y[i - n + 1 + k];
    } else {
      const yOld = y[i - n], yNew = y[i];
      Sxy = Sxy - Sy + yOld + (n - 1) * yNew;
      Sy = Sy - yOld + yNew;
    }
    const slope = (n * Sxy - S1 * Sy) / denom;
    out[i] = Sy / n + slope * (n - 1) / 2; // = intercept + slope*(n-1)
  }
  return out;
}

function calcIndic(c5) {
  const N = c5.length;
  const h = new Array(N), l = new Array(N), c = new Array(N);
  for (let i = 0; i < N; i++) { h[i] = c5[i][2]; l[i] = c5[i][3]; c[i] = c5[i][4]; }
  const basis = sma(c, LEN);
  const dev = stdevSMA(c, LEN, basis).map((s, i) => s === null ? null : MULT_BB * s);
  const upperBB = basis.map((b, i) => b === null ? null : b + dev[i]);
  const lowerBB = basis.map((b, i) => b === null ? null : b - dev[i]);

  const ma = sma(c, LEN_KC);
  const tr = trueRange(h, l, c);
  const rangema = sma(tr, LEN_KC);
  const upperKC = ma.map((m, i) => m === null || rangema[i] === null ? null : m + rangema[i] * MULT_KC);
  const lowerKC = ma.map((m, i) => m === null || rangema[i] === null ? null : m - rangema[i] * MULT_KC);

  const sqzOn = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    if (upperBB[i] === null || upperKC[i] === null) continue;
    sqzOn[i] = (lowerBB[i] > lowerKC[i]) && (upperBB[i] < upperKC[i]);
  }

  const hh = rollingExtreme(h, LEN_KC, true);
  const ll = rollingExtreme(l, LEN_KC, false);
  const smaC = sma(c, LEN_KC);
  const src = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    if (hh[i] === null || ll[i] === null || smaC[i] === null) continue;
    src[i] = c[i] - (((hh[i] + ll[i]) / 2) + smaC[i]) / 2;
  }
  const srcFilled = src.map(v => v === null ? 0 : v);
  const valRaw = linregEndpoint(srcFilled, LEN_KC);
  const val = new Array(N).fill(null);
  for (let i = 0; i < N; i++) if (src[i] !== null) val[i] = valRaw[i];

  return { val, sqzOn };
}

// z-score causal (fenetre glissante W, sommes glissantes O(1)) -> equivalent percentile par crypto
function rollingZ(val, W) {
  const N = val.length;
  const z = new Array(N).fill(null);
  let s = 0, s2 = 0, cnt = 0;
  const buf = [];
  for (let i = 0; i < N; i++) {
    const v = val[i];
    if (v !== null) { buf.push(v); s += v; s2 += v * v; cnt++; }
    else buf.push(null);
    if (buf.length > W) {
      const old = buf.shift();
      if (old !== null) { s -= old; s2 -= old * old; cnt--; }
    }
    if (v !== null && cnt >= Math.floor(W * 0.6)) {
      const mean = s / cnt, varr = Math.max(1e-12, s2 / cnt - mean * mean);
      const sd = Math.sqrt(varr);
      z[i] = sd > 1e-9 ? (v - mean) / sd : 0;
    }
  }
  return z;
}

// ---------- lectures ----------
function sigsRelease(val, sqzOn, N) {
  const out = [];
  for (let i = 400; i < N - 2; i++) {
    if (sqzOn[i - 1] === true && sqzOn[i] === false && val[i] !== null) {
      const dir = val[i] > 0 ? 1 : val[i] < 0 ? -1 : 0;
      if (dir) out.push({ i5: i, dir });
    }
  }
  return out;
}
// fade (contre-pied) : val[i-1] extreme (|z|>=Z) et val[i] decroche (lime->green / red->maroon, formule Pine exacte)
function sigsFade(val, z, N, Z) {
  const out = [];
  for (let i = 400; i < N - 2; i++) {
    if (val[i] === null || val[i - 1] === null || z[i - 1] === null) continue;
    if (val[i - 1] > 0 && z[i - 1] >= Z && val[i] <= val[i - 1]) out.push({ i5: i, dir: -1 }); // pic haussier essouffle -> short
    else if (val[i - 1] < 0 && z[i - 1] <= -Z && val[i] >= val[i - 1]) out.push({ i5: i, dir: 1 }); // creux baissier essouffle -> long
  }
  return out;
}
// continuation (signal brut) : val EXTREME et ACCELERE (1re bougie fraiche en zone extreme, lime/red qui se prolonge)
function sigsCont(val, z, N, Z) {
  const out = [];
  for (let i = 400; i < N - 2; i++) {
    if (val[i] === null || val[i - 1] === null || z[i] === null || z[i - 1] === null) continue;
    const nowUp = val[i] > 0 && val[i] > val[i - 1];   // lime
    const nowDn = val[i] < 0 && val[i] < val[i - 1];   // red
    if (nowUp && z[i] >= Z && z[i - 1] < Z) out.push({ i5: i, dir: 1 });
    else if (nowDn && z[i] <= -Z && z[i - 1] > -Z) out.push({ i5: i, dir: -1 });
  }
  return out;
}

const EXIT_STD = { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 };
const EXIT_ALT = { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 };

function evalSignals(sigs, c5, exits) {
  if (sigs.length < 20) return null;
  const mod = { detect: () => sigs, exits };
  const r = evaluer(mod, c5);
  if (!r.A || !r.B) return null;
  return {
    espIS: r.A.esp, espOOS: r.B.esp, wrOOS: r.B.wr, nIS: r.A.n, nOOS: r.B.n, pfOOS: r.B.pf,
    worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
    valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15
  };
}

function liquiditeOk(c5) {
  const N = c5.length;
  let s = 0;
  for (let i = Math.max(0, N - 288); i < N; i++) s += c5[i][6] || 0;
  return s >= 100000;
}

module.exports = { calcIndic, rollingZ, sigsRelease, sigsFade, sigsCont, evalSignals, EXIT_STD, EXIT_ALT, chargerCandles: require("../harness_lib.js").chargerCandles };

function main() {
  const ids = listeInstruments();
  console.error(`Univers libre: ${ids.length} instruments (apres blocklist + deja reclames)`);
  const rows = [];
  const W = 576; // ~48h, fenetre causale pour le z-score adaptatif
  let done = 0, skipLiq = 0;
  for (const instId of ids) {
    let c5;
    try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
    if (!c5 || c5.length < 2000) continue;
    if (!liquiditeOk(c5)) { skipLiq++; continue; }
    const { val, sqzOn } = calcIndic(c5);
    const z = rollingZ(val, W);
    const N = c5.length;

    // (a) release dans le sens de val
    for (const [exLbl, ex] of [["E1", EXIT_STD], ["E2", EXIT_ALT]]) {
      const res = evalSignals(sigsRelease(val, sqzOn, N), c5, ex);
      if (res) rows.push({ fam: "a_release", params: exLbl, instId, ...res });
    }
    // (b) fade x Z x exit
    for (const Z of [1.5, 2.0, 2.5]) {
      for (const [exLbl, ex] of [["E1", EXIT_STD], ["E2", EXIT_ALT]]) {
        const res = evalSignals(sigsFade(val, z, N, Z), c5, ex);
        if (res) rows.push({ fam: "b_fade", params: `Z${Z}_${exLbl}`, instId, ...res });
      }
    }
    // (c) continuation x Z x exit
    for (const Z of [1.5, 2.0, 2.5]) {
      for (const [exLbl, ex] of [["E1", EXIT_STD], ["E2", EXIT_ALT]]) {
        const res = evalSignals(sigsCont(val, z, N, Z), c5, ex);
        if (res) rows.push({ fam: "c_cont", params: `Z${Z}_${exLbl}`, instId, ...res });
      }
    }
    done++;
    if (done % 40 === 0) console.error(`... ${done}/${ids.length} (skipLiq ${skipLiq})`);
  }
  rows.sort((a, b) => b.worst - a.worst);
  const valides = rows.filter(r => r.valide);
  console.error(`Total lignes: ${rows.length}, valides: ${valides.length}, testes: ${done}, skipLiq: ${skipLiq}`);
  fs.mkdirSync(path.join(__dirname, "rapports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "rapports", "cli_sqzmom_scan_resultats.json"),
    JSON.stringify({ top150: rows.slice(0, 150), validesTop80: valides.slice(0, 80) }, null, 1));
  console.log(JSON.stringify(valides.slice(0, 50), null, 1));
}
if (require.main === module) main();
