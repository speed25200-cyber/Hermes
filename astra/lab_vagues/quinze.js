// Mission client 30/08 : sélectionner 15 cryptos « qui bougent bien » et construire
// 1 stratégie SUR MESURE par crypto (long ET short), même principe que le live :
// déclencheur de mouvement -> entrée -> sorties TP/SL/trail de la spec validée.
//
// Spec sorties (levier x15) : TP +80 % marge (5,333 % prix) / SL -30 % (2 % prix)
// / trail 5 % de marge (0,333 % prix) activé à +20 % (1,333 % prix).
// Coûts : entrée maker + sortie déclenchée marché ~0,12 % prix aller-retour.
//
// Anti-surajustement : grille VOLONTAIREMENT grossière, chaque stratégie doit être
// positive nette sur les 20 premiers jours ET les 10 derniers (n OOS >= 8), pire cas
// compté dans la bougie. Sans candidat robuste -> la crypto est déclarée « sans edge ».
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "data");
const LEV = 15;
const COUT_PX = 0.0012;
const SPEC = { tp: 0.80 / LEV, sl: 0.30 / LEV, act: 0.20 / LEV, cb: 0.05 / LEV };
const MAX_HOLD = 576;
const OOS_JOURS = 10;

const NON_CRYPTO = /^(AAPL|SPX|TSLA|NVDA|MSTR|META|GOOGL?|AMZN|COIN|HOOD|QQQ|GLD|XAUT?|OIL|CRCL|SBET|TRUMP)-/;

/* Familles de stratégies testées par crypto (déclencheur symétrique haut/bas) :
   move = |variation| sur lookback bougies ; sens = fade (contre) ou follow (avec). */
const GRID = [];
for (const movePct of [0.02, 0.04, 0.07])
  for (const lookback of [6, 12, 36])
    for (const volX of [1, 2])
      for (const sens of ["fade", "follow"])
        GRID.push({ movePct, lookback, volX, sens });

function medVol(c, i) {
  const from = Math.max(0, i - 288), v = [];
  for (let k = from; k < i; k++) v.push(c[k][5]);
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function sim(c, i, dir) {
  const entry = c[i][4];
  const tpPx = dir > 0 ? entry * (1 + SPEC.tp) : entry * (1 - SPEC.tp);
  let slPx = dir > 0 ? entry * (1 - SPEC.sl) : entry * (1 + SPEC.sl);
  let best = entry;
  const end = Math.min(c.length - 1, i + MAX_HOLD);
  for (let k = i + 1; k <= end; k++) {
    const hi = c[k][2], lo = c[k][3];
    const advHit = dir > 0 ? lo <= slPx : hi >= slPx;
    if (advHit) return { pnl: (dir > 0 ? slPx / entry - 1 : 1 - slPx / entry) - COUT_PX, dur: k - i };
    const favHit = dir > 0 ? hi >= tpPx : lo <= tpPx;
    if (favHit) return { pnl: SPEC.tp - COUT_PX, dur: k - i };
    const close = c[k][4];
    if (dir > 0 ? close > best : close < best) best = close;
    if ((dir > 0 ? best / entry - 1 : 1 - best / entry) >= SPEC.act) {
      const t = dir > 0 ? best * (1 - SPEC.cb) : best * (1 + SPEC.cb);
      if (dir > 0 ? t > slPx : t < slPx) slPx = t;
    }
  }
  return { pnl: (dir > 0 ? c[end][4] / entry - 1 : 1 - c[end][4] / entry) - COUT_PX, dur: end - i };
}

function agg(l) {
  if (!l.length) return null;
  const n = l.length, w = l.filter(t => t.pnl > 0).length;
  const sum = l.reduce((s, t) => s + t.pnl, 0);
  const gp = l.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gn = -l.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  return { n, wr: +(100 * w / n).toFixed(1), esp: +(100 * sum / n * LEV).toFixed(2), pf: gn > 0 ? +(gp / gn).toFixed(2) : 99 };
}

function main() {
  /* 1) Sélection des 15 : score = volatilité (amplitude 5m moyenne) x racine du volume,
     cryptos uniquement, données complètes. */
  const univers = JSON.parse(fs.readFileSync(path.join(__dirname, "univers.json")));
  const cands = [];
  for (const u of univers) {
    if (NON_CRYPTO.test(u.instId)) continue;
    const f = path.join(DATA, u.instId + ".json");
    if (!fs.existsSync(f)) continue;
    let c;
    try { c = JSON.parse(fs.readFileSync(f)); } catch { continue; }
    if (c.length < 8000) continue;
    let amp = 0;
    for (let i = 1; i < c.length; i++) amp += Math.abs(c[i][4] / c[i - 1][4] - 1);
    amp /= c.length;
    cands.push({ instId: u.instId, volUsd: u.volUsd, amp, score: amp * Math.sqrt(u.volUsd), candles: c });
  }
  cands.sort((a, b) => b.score - a.score);
  const quinze = cands.slice(0, 15);
  console.log("=== 15 CRYPTOS SELECTIONNEES (volatilite x volume) ===");
  quinze.forEach((q, i) => console.log((i + 1) + ".", q.instId.replace("-USDT-SWAP", ""), "amp5m", (q.amp * 100).toFixed(3) + "%", "vol24h", Math.round(q.volUsd / 1e6) + "M$"));

  /* 2) Recherche par crypto */
  const strategies = [];
  for (const q of quinze) {
    const c = q.candles;
    const tOOS = c[c.length - 1][0] - OOS_JOURS * 86400 * 1000;
    let best = null;
    const evals = [];
    for (const g of GRID) {
      const is = [], oos = [];
      let busy = -1;
      for (let i = g.lookback + 1; i < c.length - 2; i++) {
        if (i <= busy) continue;
        const ref = c[i - g.lookback][4];
        if (!(ref > 0)) continue;
        const mv = c[i][4] / ref - 1;
        if (Math.abs(mv) < g.movePct) continue;
        const mvol = medVol(c, i);
        if (mvol > 0 && c[i][5] < g.volX * mvol) continue;
        const dir = g.sens === "fade" ? (mv > 0 ? -1 : 1) : (mv > 0 ? 1 : -1);
        const t = sim(c, i, dir);
        t.dir = dir;
        (c[i][0] >= tOOS ? oos : is).push(t);
        busy = i + t.dur;
      }
      const A = agg(is), B = agg(oos);
      if (!A || !B || B.n < 8) continue;
      const worst = Math.min(A.esp, B.esp);
      evals.push({ g, A, B, worst });
      if (A.esp > 0 && B.esp > 0 && (!best || worst > best.worst)) best = { g, A, B, worst };
    }
    evals.sort((a, b) => b.worst - a.worst);
    strategies.push({
      instId: q.instId, amp: q.amp, volUsd: q.volUsd,
      retenue: best, meilleureMemeSiNegative: evals[0] || null
    });
    const b = best || evals[0];
    console.log(q.instId.replace("-USDT-SWAP", ""),
      best ? "STRATEGIE TROUVEE" : "sans edge robuste",
      b ? `[${b.g.sens} |move|>=${b.g.movePct * 100}% ${b.g.lookback * 5}min vol>=${b.g.volX}x] IS ${b.A.esp}% OOS ${b.B.esp}% (n=${b.A.n + b.B.n})` : "");
  }

  fs.writeFileSync(path.join(__dirname, "quinze_resultats.json"), JSON.stringify(strategies, null, 1));
  const ok = strategies.filter(s => s.retenue);
  console.log(`\n=== BILAN : ${ok.length}/15 cryptos avec stratégie positive IS ET OOS ===`);
  for (const s of ok) {
    const r = s.retenue;
    console.log(s.instId.replace("-USDT-SWAP", ""), `${r.g.sens} |move|>=${r.g.movePct * 100}% en ${r.g.lookback * 5}min vol>=${r.g.volX}x`,
      `| esp IS ${r.A.esp}% OOS ${r.B.esp}% marge/trade | wr OOS ${r.B.wr}% | pf OOS ${r.B.pf} | ~${((r.A.n + r.B.n) / 30).toFixed(1)} trades/j`);
  }
}

main();
