// Support and Resistance Levels with Breaks [LuxAlgo] (4e bloc de Indicateurs.txt), port Pine FIDELE :
//   pivots hauts/bas leftBars=rightBars=15 (ta.pivothigh/pivotlow), niveau = fixnan(pivot[1]) donc
//   UTILISABLE seulement 15+1=16 barres après le sommet/creux du pivot (décalage causal EXACT du script,
//   pas juste "à peu près 15") ; osc volume = 100*(ema5(vol)-ema10(vol))/ema10(vol), volumeThresh=20 ;
//   "Break" volumé = crossover/crossunder du niveau SANS forme de mèche opposée dominante + osc>seuil ;
//   "Bull/Bear Wick" = même croisement MAIS avec une mèche opposée (basse pour Bull, haute pour Bear)
//   plus grande que le corps — AUCUN filtre volume dans le script d'origine sur ces 2 conditions.
// 3 lectures demandées par le client :
//   (a) WICK = cassure en mèche qui referme du bon côté -> sweep de liquidité codifié -> testé en
//       CONTRE-PIED (fade du Bull/Bear Wick) ET en sens brut, pour laisser les données trancher.
//   (b) VOLBREAK = cassure confirmée par le pic de volume (osc>seuil, pas de mèche dominante) jouée
//       en CONTINUATION (sens brut) ET en contre-pied.
//   (c) REJET = approche du niveau (mèche qui teste le niveau à tol% près) SANS le casser, avec
//       volume FAIBLE (osc < seuil bas) -> rejet simple, fade vers le milieu du range (+ sens inverse
//       "follow" testé aussi par prudence).
// Univers : data/ moins blocklist actions moins instId déjà réclamés par un candidates/*.js existant,
// plancher de liquidité 100k$/24h (notionnel estimé vol*close sur les 288 dernières bougies).
const fs = require("fs");
const path = require("path");
const { chargerCandles, sim, agg } = require("../harness_lib.js");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const CAND_DIR = path.join(__dirname, "..", "candidates");
const OOS_JOURS = 10;

// ---------- blocklist actions/ETF/commo (README + additions vues en ronde) ----------
const BLOCK = new Set(`AAPL SPX TSLA NVDA MSTR SKHYNIX SKHY SNDK CRCL HOOD COIN GOOG GOOGL META AMZN MSFT AMD INTC
QQQ GLD XAUT TRUMP AXTI MRVL MU NBIS SOXL SOXS TQQQ EWY CXMT SAMSUNG XIAOMI UNITREE ZHIPU MINIMAX
XAU XAG XCU BEAT BZ CBRS CL CC CHIP DRAM SLX ROBO SPCX SPACE LITE OPG BARD SKDD SNXX AAOI AVGO TSM
SPY BILL ASML HPE OKTA XBI ZM XPT USDC`.split(/\s+/).filter(Boolean));

function baseTicker(instId) { return instId.replace(/-USDT-SWAP$/, ""); }

// ---------- instId déjà réclamés par un candidates/*.js (règle 1 stratégie/crypto) ----------
const claimed = new Set();
for (const f of fs.readdirSync(CAND_DIR).filter(x => x.endsWith(".js"))) {
  const txt = fs.readFileSync(path.join(CAND_DIR, f), "utf8");
  const m = txt.match(/instId\s*:\s*"([^"]+)"/);
  if (m) claimed.add(m[1]);
}

// ---------- EMA standard (seed = SMA des n premières valeurs) ----------
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

// ---------- pivots hauts/bas leftBars/rightBars (extremum STRICT sur toute la fenêtre) ----------
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

// niveau = fixnan(pivot[1]) : la valeur du pivot confirmé à p (p+right) devient visible à p+right+1,
// puis reste tenue (forward-fill) jusqu'au pivot suivant. LAG = right+1, EXACT du script (pas d'à-peu-près).
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

// ---------- évaluation IS/OOS directe (identique à harness_lib.evaluer) ----------
function evalSignals(c5, sigs) {
  const tOOS = c5[c5.length - 1][0] - OOS_JOURS * 86400 * 1000;
  const is = [], oos = [];
  let busy = -1;
  for (const s of sigs) {
    if (s.i5 <= busy || s.i5 >= c5.length - 2 || !s.dir) continue;
    const t = sim(c5, s.i5, s.dir, s.exits);
    busy = s.i5 + t.dur;
    (c5[s.i5][0] >= tOOS ? oos : is).push(t);
  }
  return { A: agg(is), B: agg(oos) };
}

function pack(r) {
  return {
    espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
    wrOOS: r.B.wr, pfOOS: r.B.pf,
    worst: +Math.min(r.A.esp, r.B.esp).toFixed(2),
    valide: r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15,
  };
}

const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
};

const LEFT = 15, RIGHT = 15; // defaults EXACTS du script LuxAlgo, non balayés (fidélité)

// ---------- univers ----------
const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
let univ = files.map(f => f.replace(/\.json$/, ""))
  .filter(id => !BLOCK.has(baseTicker(id).toUpperCase()))
  .filter(id => !claimed.has(id));

console.error(`univers filtré : ${univ.length} / ${files.length}`);

const rows = [];
let processed = 0;
for (const instId of univ) {
  processed++;
  let c5;
  try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
  if (c5.length < 3000) continue;

  const N = c5.length;
  let notional = 0;
  for (let i = Math.max(0, N - 288); i < N; i++) notional += c5[i][5] * c5[i][4];
  if (notional < 100000) continue;

  const highs = new Float64Array(N), lows = new Float64Array(N), opens = new Float64Array(N),
    closes = new Float64Array(N), vols = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    opens[i] = c5[i][1]; highs[i] = c5[i][2]; lows[i] = c5[i][3]; closes[i] = c5[i][4]; vols[i] = c5[i][5];
  }

  const { isPH, isPL } = computePivots(highs, lows, LEFT, RIGHT);
  let nPiv = 0; for (let i = 0; i < N; i++) nPiv += isPH[i] + isPL[i];
  if (nPiv < 10) continue;
  const { res, sup } = buildLevels(N, isPH, isPL, highs, lows, RIGHT);

  const e5 = ema(vols, 5), e10 = ema(vols, 10);
  const osc = new Float64Array(N).fill(NaN);
  for (let i = 0; i < N; i++) if (!Number.isNaN(e10[i]) && e10[i] !== 0) osc[i] = 100 * (e5[i] - e10[i]) / e10[i];

  // conditions structurelles exactes du script (pas de futur : ne lit que i et i-1)
  const crossUpRes = new Uint8Array(N), crossDownSup = new Uint8Array(N), bullWick = new Uint8Array(N), bearWick = new Uint8Array(N);
  for (let i = 1; i < N; i++) {
    if (!Number.isNaN(res[i]) && !Number.isNaN(res[i - 1])) {
      if (closes[i] > res[i] && closes[i - 1] <= res[i - 1]) crossUpRes[i] = 1;
    }
    if (!Number.isNaN(sup[i]) && !Number.isNaN(sup[i - 1])) {
      if (closes[i] < sup[i] && closes[i - 1] >= sup[i - 1]) crossDownSup[i] = 1;
    }
    if (crossUpRes[i]) {
      const openLow = opens[i] - lows[i], closeOpen = closes[i] - opens[i];
      if (openLow > closeOpen) bullWick[i] = 1;
    }
    if (crossDownSup[i]) {
      const openClose = opens[i] - closes[i], highOpen = highs[i] - opens[i];
      if (openClose < highOpen) bearWick[i] = 1;
    }
  }

  const WARM = 200;

  // === (a) WICK sweep : contre-pied ET brut ===
  for (const sense of ["contra", "raw"]) {
    for (const exK of Object.keys(EXITS)) {
      const sigs = [];
      for (let i = WARM; i < N - 2; i++) {
        if (bullWick[i]) sigs.push({ i5: i, dir: sense === "contra" ? -1 : 1, exits: EXITS[exK] });
        else if (bearWick[i]) sigs.push({ i5: i, dir: sense === "contra" ? 1 : -1, exits: EXITS[exK] });
      }
      if (sigs.length < 15) continue;
      const r = evalSignals(c5, sigs);
      if (!r.A || !r.B) continue;
      rows.push({ fam: "a_wick", instId, params: `sense=${sense}`, ex: exK, ...pack(r) });
    }
  }

  // === (b) VOLBREAK : continuation ET contre-pied, grille grossière du seuil volume ===
  for (const volThresh of [10, 15, 20, 25, 30, 40]) {
    for (const sense of ["cont", "contra"]) {
      for (const exK of Object.keys(EXITS)) {
        const sigs = [];
        for (let i = WARM; i < N - 2; i++) {
          if (Number.isNaN(osc[i])) continue;
          if (crossUpRes[i] && !bullWick[i] && osc[i] > volThresh) sigs.push({ i5: i, dir: sense === "cont" ? 1 : -1, exits: EXITS[exK] });
          else if (crossDownSup[i] && !bearWick[i] && osc[i] > volThresh) sigs.push({ i5: i, dir: sense === "cont" ? -1 : 1, exits: EXITS[exK] });
        }
        if (sigs.length < 15) continue;
        const r = evalSignals(c5, sigs);
        if (!r.A || !r.B) continue;
        rows.push({ fam: "b_volbreak", instId, params: `vt=${volThresh},sense=${sense}`, ex: exK, ...pack(r) });
      }
    }
  }

  // === (c) REJET simple du niveau, volume FAIBLE (approche sans casser) ===
  for (const tol of [0.001, 0.002, 0.003, 0.005]) {
    for (const volLow of [-20, -10, 0, 10]) {
      for (const sense of ["fade", "follow"]) {
        for (const exK of Object.keys(EXITS)) {
          const sigs = [];
          for (let i = WARM; i < N - 2; i++) {
            if (Number.isNaN(osc[i]) || osc[i] >= volLow) continue;
            if (!Number.isNaN(res[i]) && highs[i] >= res[i] * (1 - tol) && closes[i] < res[i]) {
              sigs.push({ i5: i, dir: sense === "fade" ? -1 : 1, exits: EXITS[exK] });
            } else if (!Number.isNaN(sup[i]) && lows[i] <= sup[i] * (1 + tol) && closes[i] > sup[i]) {
              sigs.push({ i5: i, dir: sense === "fade" ? 1 : -1, exits: EXITS[exK] });
            }
          }
          if (sigs.length < 15) continue;
          const r = evalSignals(c5, sigs);
          if (!r.A || !r.B) continue;
          rows.push({ fam: "c_reject", instId, params: `tol=${tol},volLow=${volLow},sense=${sense}`, ex: exK, ...pack(r) });
        }
      }
    }
  }

  if (processed % 50 === 0) console.error(`... ${processed}/${univ.length} instruments, ${rows.length} lignes`);
}

rows.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "rapports", "cli_srlux_scan_resultats.json"), JSON.stringify(rows, null, 1));
console.error(`TOTAL : ${rows.length} lignes, ${rows.filter(r => r.valide).length} valides.`);
console.log(JSON.stringify(rows.filter(r => r.valide).slice(0, 80), null, 1));
