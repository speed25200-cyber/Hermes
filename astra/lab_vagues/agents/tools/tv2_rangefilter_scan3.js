// PASSE 3 — correction RF (agent tv2_rangefilter_, 31/08)
// Bug de conception en passe 1/2 : le "band touch" (close hors hband/lband) du Range Filter DW
// est quasi IMPOSSIBLE par construction (rngfilt colle à ±smrng du prix, ~1 touche/8000 bougies
// sur BTC) -> zéro signal. Le vrai signal DE l'indicateur (script guikroth vérifié) est le flip
// CondIni (longCondition/shortCondition = 1er retour de prix au-dessus/dessous de filt après un
// régime opposé, avec upward/downward>0). Recette demandée : FADE de ce retour dans le filtre.
const fs = require("fs");
const path = require("path");
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

function rangeFilterFlip(c5, per, mult) {
  const close = c5.map(r => r[4]);
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
  const upward = new Float64Array(n).fill(0), downward = new Float64Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (filt[i] > filt[i - 1]) upward[i] = upward[i - 1] + 1;
    else if (filt[i] < filt[i - 1]) upward[i] = 0; else upward[i] = upward[i - 1];
    if (filt[i] < filt[i - 1]) downward[i] = downward[i - 1] + 1;
    else if (filt[i] > filt[i - 1]) downward[i] = 0; else downward[i] = downward[i - 1];
  }
  return { close, filt, upward, downward };
}

const WARM = 700;
function sigRFfade(c5, per, mult, conf) {
  const { close, filt, upward, downward } = rangeFilterFlip(c5, per, mult);
  const out = [];
  let condIni = 0;
  for (let i = 1; i < c5.length - 2; i++) {
    const longCond = close[i] > filt[i] && upward[i] > 0;
    const shortCond = close[i] < filt[i] && downward[i] > 0;
    const prevCondIni = condIni;
    if (longCond) condIni = 1; else if (shortCond) condIni = -1;
    if (i < WARM) continue;
    let d = 0;
    if (longCond && prevCondIni === -1) d = -1;   // retour haussier dans le filtre -> FADE -> short
    else if (shortCond && prevCondIni === 1) d = 1; // retour baissier dans le filtre -> FADE -> long
    if (!d) continue;
    if (conf) {
      const o = c5[i][1], c = c5[i][4];
      if (d > 0 && c < o) continue;
      if (d < 0 && c > o) continue;
    }
    out.push({ i5: i, dir: d });
  }
  return out;
}

const RF_PER = [20, 50, 100], RF_MULT = [1.5, 2.0, 3.0], RF_CONF = [0, 1];

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith("-USDT-SWAP.json"));
const res = [];
let done = 0;
for (const f of files) {
  const inst = f.replace(".json", "");
  const base = inst.replace("-USDT-SWAP", "");
  if (BLOCK.has(base) || PROTECT.has(base)) continue;
  let c5; try { c5 = chargerCandles("data", inst); } catch (e) { continue; }
  if (!c5 || c5.length < 3000) continue;

  for (const per of RF_PER) for (const mult of RF_MULT) for (const conf of RF_CONF) {
    const sigs = sigRFfade(c5, per, mult, conf);
    if (sigs.length < 20) continue;
    for (const ex of Object.keys(EXITS)) {
      const r = evaluer({ instId: inst, exits: EXITS[ex], detect: () => sigs }, c5);
      if (!r.A || !r.B) continue;
      res.push({ fam: "RF", inst, per, mult, conf, ex, espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
        wrOOS: r.B.wr, pfOOS: r.B.pf, worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
        valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15 });
    }
  }
  done++;
  if (done % 40 === 0) console.error(`... ${done} cryptos`);
}
res.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "tv2_rangefilter_scan3_resultats.json"), JSON.stringify(res, null, 1));

const valides = res.filter(r => r.valide);
const bestParCrypto = {};
for (const r of valides) { if (!bestParCrypto[r.inst] || r.worst > bestParCrypto[r.inst].worst) bestParCrypto[r.inst] = r; }
const libres = Object.values(bestParCrypto).filter(r => {
  const champ = baseline[r.inst];
  return !champ || r.worst > champ.worst;
}).sort((a, b) => b.worst - a.worst);

console.log(JSON.stringify({ cryptos: done, lignes: res.length, valides: valides.length, top: libres.slice(0, 20) }, null, 1));
