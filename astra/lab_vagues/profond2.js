// Variante demandée par le client (30/08) : mêmes indicateurs personnels par crypto,
// mais GROS TP (+40/60/80 % de marge) avec TRAIL 5 % de marge (activation +10/20/30 %),
// SL cap -30 %, hold 12 h/24 h. Scan des 232 cryptos, top 15 par la PIRE des 2 périodes.
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "data");
const LEV = 15;
const COUT_PX = 0.0012;
const OOS_JOURS = 10;

const NON_CRYPTO = /^(AAPL|SPX|TSLA|NVDA|MSTR|META|GOOGL?|AMZN|COIN|HOOD|QQQ|GLD|XAUT?|OIL|CRCL|SBET|SNDK|SKHY|SKHYNIX|TRUMP)-/;
const IDS = fs.readdirSync(DATA).filter(f => f.endsWith(".json")).map(f => f.replace(".json", "")).filter(id => !NON_CRYPTO.test(id));

function aggreger(c5, mult) {
  const out = [];
  for (let i = 0; i + mult <= c5.length; i += mult) {
    let o = c5[i][1], h = -Infinity, l = Infinity, v = 0;
    for (let k = i; k < i + mult; k++) { h = Math.max(h, c5[k][2]); l = Math.min(l, c5[k][3]); v += c5[k][5]; }
    out.push([c5[i][0], o, h, l, c5[i + mult - 1][4], v, i + mult - 1]);
  }
  return out;
}
function rsi(closes, p = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, pr = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (i <= p) { if (d > 0) g += d; else pr -= d; if (i === p) out[i] = 100 - 100 / (1 + (g / p) / ((pr / p) || 1e-12)); continue; }
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
    if (i >= p - 1) { const m = s / p; sma[i] = m; std[i] = Math.sqrt(Math.max(0, s2 / p - m * m)); }
  }
  return { sma, std };
}

/* Trade avec TP + SL + TRAILING (pire cas d'abord). Tous les pct en MARGE. */
function sim(c5, i5, dir, ex) {
  const entry = c5[i5][4];
  const tpPx = ex.tp / LEV, slPx0 = ex.sl / LEV, actPx = ex.act / LEV, cbPx = ex.cb / LEV;
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  let sl = dir > 0 ? entry * (1 - slPx0) : entry * (1 + slPx0);
  let best = entry;
  const end = Math.min(c5.length - 1, i5 + ex.hold);
  for (let k = i5 + 1; k <= end; k++) {
    const hi = c5[k][2], lo = c5[k][3];
    if (dir > 0 ? lo <= sl : hi >= sl)
      return { pnl: (dir > 0 ? sl / entry - 1 : 1 - sl / entry) - COUT_PX, dur: k - i5 };
    if (dir > 0 ? hi >= tp : lo <= tp)
      return { pnl: tpPx - COUT_PX, dur: k - i5 };
    const close = c5[k][4];
    if (dir > 0 ? close > best : close < best) best = close;
    if ((dir > 0 ? best / entry - 1 : 1 - best / entry) >= actPx) {
      const t = dir > 0 ? best * (1 - cbPx) : best * (1 + cbPx);
      if (dir > 0 ? t > sl : t < sl) sl = t;
    }
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

function* signaux(c5) {
  const frames = [
    { nom: "5m", c: c5.map((x, i) => [...x.slice(0, 6), i]) },
    { nom: "15m", c: aggreger(c5, 3) },
    { nom: "1h", c: aggreger(c5, 12) }
  ];
  for (const F of frames) {
    const closes = F.c.map(x => x[4]);
    const r = rsi(closes);
    for (const seuil of [15, 20, 25])
      yield { nom: `RSI14-${F.nom} <${seuil}/>${100 - seuil}`,
        list: F.c.map((x, i) => r[i] == null ? null : (r[i] < seuil ? { i5: x[6], dir: 1 } : (r[i] > 100 - seuil ? { i5: x[6], dir: -1 } : null))).filter(Boolean) };
    for (const p of [48, 96]) {
      if (F.c.length < p + 5) continue;
      const { sma, std } = smaStd(closes, p);
      for (const z of [2.5, 3.5])
        yield { nom: `zScore-SMA${p}-${F.nom} |z|>${z}`,
          list: F.c.map((x, i) => (sma[i] == null || !std[i]) ? null : ((closes[i] - sma[i]) / std[i] > z ? { i5: x[6], dir: -1 } : ((closes[i] - sma[i]) / std[i] < -z ? { i5: x[6], dir: 1 } : null))).filter(Boolean) };
    }
    for (const runN of [5, 7]) {
      const list = [];
      let run = 0, sgn = 0;
      for (let i = 1; i < F.c.length; i++) {
        const d = Math.sign(F.c[i][4] - F.c[i - 1][4]);
        if (d !== 0 && d === sgn) run++; else { run = 1; sgn = d; }
        if (run >= runN && sgn !== 0) list.push({ i5: F.c[i][6], dir: -sgn });
      }
      yield { nom: `${runN} bougies ${F.nom} (fade)`, list };
    }
    {
      const list = [];
      for (let i = 30; i < F.c.length; i++) {
        const [, o, h, l, cl, v] = F.c[i];
        const corps = Math.abs(cl - o), haut = h - Math.max(o, cl), bas = Math.min(o, cl) - l;
        let mv = 0; const from = Math.max(0, i - 30);
        for (let k = from; k < i; k++) mv += F.c[k][5];
        mv /= (i - from);
        if (v > 2 * mv && haut > 2 * corps && haut > 0.004 * cl) list.push({ i5: F.c[i][6], dir: -1 });
        if (v > 2 * mv && bas > 2 * corps && bas > 0.004 * cl) list.push({ i5: F.c[i][6], dir: 1 });
      }
      yield { nom: `mèche épuisement ${F.nom} + vol 2x`, list };
    }
  }
}

const EXITS = [];
for (const tp of [0.40, 0.60, 0.80])
  for (const act of [0.10, 0.20, 0.30])
    for (const hold of [144, 288])
      EXITS.push({ tp, sl: 0.30, act, cb: 0.05, hold });

function main() {
  const rapport = [];
  let fait = 0;
  for (const instId of IDS) {
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
          const t = sim(c5, s.i5, s.dir, ex);
          busy = s.i5 + t.dur;
          (c5[s.i5][0] >= tOOS ? oos : is).push(t);
        }
        const A = agg(is), B = agg(oos);
        if (!A || !B || B.n < 15 || A.n + B.n < 60) continue;
        if (!(A.esp > 0 && B.esp > 0)) continue;
        evals.push({ sig: sig.nom, ex, A, B, worst: Math.min(A.esp, B.esp) });
      }
    }
    evals.sort((a, b) => b.worst - a.worst);
    if (evals[0]) rapport.push({ instId, retenue: evals[0], top3: evals.slice(0, 3) });
    if (++fait % 40 === 0) console.log("scanné:", fait + "/" + IDS.length);
  }
  rapport.sort((a, b) => b.retenue.worst - a.retenue.worst);
  fs.writeFileSync(path.join(__dirname, "profond2_resultats.json"), JSON.stringify(rapport, null, 1));
  console.log(`\n=== ${rapport.length} cryptos rentables (2 périodes) avec GROS TP + trail 5 % — TOP 15 ===`);
  rapport.slice(0, 15).forEach((x, i) => {
    const R = x.retenue;
    console.log(String(i + 1).padStart(2) + ".", x.instId.replace("-USDT-SWAP", "").padEnd(9),
      ("wr " + R.A.wr + "/" + R.B.wr + "%").padEnd(15),
      ("esp " + R.A.esp + "/" + R.B.esp + "%").padEnd(18),
      ("n=" + (R.A.n + R.B.n)).padEnd(7),
      R.sig, "| TP +" + R.ex.tp * 100 + "% trail 5% act +" + R.ex.act * 100 + "% max", (R.ex.hold / 12) + "h");
  });
}

main();
