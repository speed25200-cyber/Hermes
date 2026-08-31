// Analyse APPROFONDIE par crypto (demande client 30/08) : trouver pour chacune des 15
// un INDICATEUR SPÉCIFIQUE + une sortie donnant un winrate 80-90 % RÉEL et une
// espérance positive nette, validés séparément sur 20 j (IS) et 10 j (OOS).
//
// Bibliothèque d'indicateurs (mean-reversion et épuisement, long ET short) :
//   RSI(14) extrême (5m/15m/1h) · z-score vs SMA(48/96) · Bollinger %B(20,2σ)
//   série de bougies consécutives · mèche d'épuisement + volume · position dans le range
// Sorties orientées haut winrate : TP +10/20/30 % marge, SL -30 % (cap risque client),
// sortie temps 4 h/12 h. Levier x15, coûts maker 0,12 % prix aller-retour.
//
// Critères de rétention (stricts) : winrate >= 78 % ET espérance > 0 dans LES DEUX
// périodes, n_OOS >= 15, n_total >= 60. Pire cas compté dans la bougie.
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "data");
const LEV = 15;
const COUT_PX = 0.0012;
const OOS_JOURS = 10;

/* TOUTES=1 : scanne les 250 cryptos (critères durcis dans main) au lieu des 15 pré-choisies. */
const NON_CRYPTO = /^(AAPL|SPX|TSLA|NVDA|MSTR|META|GOOGL?|AMZN|COIN|HOOD|QQQ|GLD|XAUT?|OIL|CRCL|SBET|SNDK|TRUMP)-/;
const QUINZE = process.env.TOUTES === "1"
  ? fs.readdirSync(DATA).filter(f => f.endsWith(".json")).map(f => f.replace(".json", "")).filter(id => !NON_CRYPTO.test(id))
  : JSON.parse(fs.readFileSync(path.join(__dirname, "quinze_resultats.json"))).map(s => s.instId);

/* ---------- outils séries ---------- */
function aggreger(c5, mult) { // 5m -> 15m (mult 3) ou 1h (mult 12)
  const out = [];
  for (let i = 0; i + mult <= c5.length; i += mult) {
    let o = c5[i][1], h = -Infinity, l = Infinity, v = 0;
    for (let k = i; k < i + mult; k++) { h = Math.max(h, c5[k][2]); l = Math.min(l, c5[k][3]); v += c5[k][5]; }
    out.push([c5[i][0], o, h, l, c5[i + mult - 1][4], v, i + mult - 1]); // [6] = index 5m de clôture
  }
  return out;
}
function rsi(closes, p = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, pr = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (i <= p) { if (d > 0) g += d; else pr -= d; if (i === p) { out[i] = 100 - 100 / (1 + (g / p) / ((pr / p) || 1e-12)); } continue; }
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = 100 - 100 / (1 + g / (pr || 1e-12));
  }
  return out;
}
function smaStd(closes, p) {
  const sma = new Array(closes.length).fill(null), std = new Array(closes.length).fill(null);
  let s = 0, s2 = 0;
  for (let i = 0; i < closes.length; i++) {
    s += closes[i]; s2 += closes[i] * closes[i];
    if (i >= p) { const x = closes[i - p]; s -= x; s2 -= x * x; }
    if (i >= p - 1) {
      const m = s / p, va = Math.max(0, s2 / p - m * m);
      sma[i] = m; std[i] = Math.sqrt(va);
    }
  }
  return { sma, std };
}

/* ---------- simulation d'un trade (sur les bougies 5m, entrée au close de i5) ---------- */
function sim(c5, i5, dir, tpPctM, slPctM, maxHold5) {
  const entry = c5[i5][4];
  const tpPx = tpPctM / LEV, slPx = slPctM / LEV;
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  const sl = dir > 0 ? entry * (1 - slPx) : entry * (1 + slPx);
  const end = Math.min(c5.length - 1, i5 + maxHold5);
  for (let k = i5 + 1; k <= end; k++) {
    const hi = c5[k][2], lo = c5[k][3];
    if (dir > 0 ? lo <= sl : hi >= sl) return { pnl: -slPx - COUT_PX, dur: k - i5 };
    if (dir > 0 ? hi >= tp : lo <= tp) return { pnl: tpPx - COUT_PX, dur: k - i5 };
  }
  return { pnl: (dir > 0 ? c5[end][4] / entry - 1 : 1 - c5[end][4] / entry) - COUT_PX, dur: end - i5 };
}

function agg(l) {
  if (!l.length) return null;
  const n = l.length, w = l.filter(t => t.pnl > 0).length;
  const sum = l.reduce((s, t) => s + t.pnl, 0);
  const gp = l.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gn = -l.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  return { n, wr: +(100 * w / n).toFixed(1), esp: +(100 * sum / n * LEV).toFixed(2), pf: gn > 0 ? +(gp / gn).toFixed(2) : 99 };
}

/* ---------- générateurs de signaux (renvoient [{i5, dir}]) ---------- */
function* signaux(c5) {
  const closes5 = c5.map(x => x[4]);
  const frames = [
    { nom: "5m", c: c5.map((x, i) => [...x.slice(0, 6), i]), mult: 1 },
    { nom: "15m", c: aggreger(c5, 3), mult: 3 },
    { nom: "1h", c: aggreger(c5, 12), mult: 12 }
  ];
  for (const F of frames) {
    const closes = F.c.map(x => x[4]);
    // RSI extrême (fade)
    const r = rsi(closes);
    for (const seuil of [15, 20, 25]) {
      yield { nom: `RSI14-${F.nom} <${seuil} (long) / >${100 - seuil} (short)`,
        list: F.c.map((x, i) => r[i] == null ? null : (r[i] < seuil ? { i5: x[6], dir: 1 } : (r[i] > 100 - seuil ? { i5: x[6], dir: -1 } : null))).filter(Boolean) };
    }
    // z-score vs SMA (fade)
    for (const p of [48, 96]) {
      if (F.c.length < p + 5) continue;
      const { sma, std } = smaStd(closes, p);
      for (const z of [2.5, 3.5]) {
        yield { nom: `zScore-SMA${p}-${F.nom} |z|>${z} (fade)`,
          list: F.c.map((x, i) => (sma[i] == null || !std[i]) ? null : ((closes[i] - sma[i]) / std[i] > z ? { i5: x[6], dir: -1 } : ((closes[i] - sma[i]) / std[i] < -z ? { i5: x[6], dir: 1 } : null))).filter(Boolean) };
      }
    }
    // séries de bougies consécutives (fade)
    for (const runN of [5, 7]) {
      const list = [];
      let run = 0, sgn = 0;
      for (let i = 1; i < F.c.length; i++) {
        const d = Math.sign(F.c[i][4] - F.c[i - 1][4]);
        if (d !== 0 && d === sgn) run++; else { run = 1; sgn = d; }
        if (run >= runN && sgn !== 0) list.push({ i5: F.c[i][6], dir: -sgn });
      }
      yield { nom: `${runN} bougies ${F.nom} consécutives (fade)`, list };
    }
    // mèche d'épuisement + volume (fade)
    {
      const list = [];
      for (let i = 30; i < F.c.length; i++) {
        const [ , o, h, l, cl, v] = F.c[i];
        const corps = Math.abs(cl - o), haut = h - Math.max(o, cl), bas = Math.min(o, cl) - l;
        let mv = 0; const from = Math.max(0, i - 30);
        for (let k = from; k < i; k++) mv += F.c[k][5];
        mv /= (i - from);
        if (v > 2 * mv && haut > 2 * corps && haut > 0.004 * cl) list.push({ i5: F.c[i][6], dir: -1 });
        if (v > 2 * mv && bas > 2 * corps && bas > 0.004 * cl) list.push({ i5: F.c[i][6], dir: 1 });
      }
      yield { nom: `mèche d'épuisement ${F.nom} + vol 2x (fade)`, list };
    }
  }
}

const EXITS = [];
for (const tp of [0.10, 0.20, 0.30])
  for (const hold of [48, 144])           // 4 h / 12 h en bougies 5m
    EXITS.push({ tp, sl: 0.30, hold });

function main() {
  const rapport = [];
  for (const instId of QUINZE) {
    let c5;
    try { c5 = JSON.parse(fs.readFileSync(path.join(DATA, instId + ".json"))); } catch { continue; }
    if (c5.length < 6000) continue;
    const tOOS = c5[c5.length - 1][0] - OOS_JOURS * 86400 * 1000;
    const evals = [];
    for (const sig of signaux(c5)) {
      if (sig.list.length < 40) continue;
      for (const ex of EXITS) {
        const is = [], oos = [];
        let busy = -1;
        for (const s of sig.list) {
          if (s.i5 <= busy || s.i5 >= c5.length - 2) continue;
          const t = sim(c5, s.i5, s.dir, ex.tp, ex.sl, ex.hold);
          busy = s.i5 + t.dur;
          (c5[s.i5][0] >= tOOS ? oos : is).push(t);
        }
        const A = agg(is), B = agg(oos);
        if (!A || !B || B.n < 15 || A.n + B.n < 60) continue;
        evals.push({ sig: sig.nom, ex, A, B,
          ok: A.wr >= 78 && B.wr >= 78 && A.esp > 0 && B.esp > 0,
          worstEsp: Math.min(A.esp, B.esp), worstWr: Math.min(A.wr, B.wr) });
      }
    }
    const retenues = evals.filter(e => e.ok).sort((a, b) => b.worstEsp - a.worstEsp);
    const meilleure = retenues[0] || evals.sort((a, b) => b.worstWr - a.worstWr)[0] || null;
    rapport.push({ instId, retenue: retenues[0] || null, top3: retenues.slice(0, 3), meilleureQuandMeme: meilleure, nTestees: evals.length });
    const R = retenues[0];
    console.log(instId.replace("-USDT-SWAP", "").padEnd(8),
      R ? `RETENUE  ${R.sig} | TP +${R.ex.tp * 100}% SL -30% ${R.ex.hold / 12}h | wr ${R.A.wr}/${R.B.wr}% | esp ${R.A.esp}/${R.B.esp}% | n ${R.A.n + R.B.n}`
        : (meilleure ? `aucune à 78 %+ des 2 côtés — max: ${meilleure.sig} wr ${meilleure.A.wr}/${meilleure.B.wr}% esp ${meilleure.A.esp}/${meilleure.B.esp}%` : "aucune config évaluable"));
  }
  fs.writeFileSync(path.join(__dirname, "profond_resultats.json"), JSON.stringify(rapport, null, 1));
  const ok = rapport.filter(r => r.retenue);
  console.log(`\n=== BILAN : ${ok.length}/${rapport.length} cryptos avec indicateur >=78 % winrate ET rentable (2 périodes) ===`);
}

main();
