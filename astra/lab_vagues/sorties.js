// Balayage des STRUCTURES DE SORTIE : entrées fixées (les 2 meilleurs déclencheurs
// de vague en short), on fait varier TP / SL / trailing autour de la spec actuelle.
// Chaque trade stocke son PnL BRUT ; les coûts sont déduits ensuite selon 2 modèles :
//   taker (actuel)  : 0,20 % prix aller-retour (frais 2×0,05 % + slippage)
//   maker (limite)  : 0,10 % prix aller-retour (frais 2×0,02 % + moins de slippage)
// Validation IS (20 premiers jours) / OOS (10 derniers). Pire cas d'abord dans la bougie.
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "data");
const LEV = 20;
const MAX_HOLD = 576;
const OOS_JOURS = 10;

const ENTREES = [
  { nom: "short pompe +3% en 30min vol>=3x", pumpPct: 0.03, lookback: 6, volX: 3 },
  { nom: "short pompe +8% en 60min vol>=2x", pumpPct: 0.08, lookback: 12, volX: 2 }
];

// Grille de sorties (en % PRIX ; à ×20 : ×20 en % de marge). 999 = absent.
const TPS = [0.015, 0.025, 0.04, 999];            // spec actuelle : 0.025
const SLS = [0.0075, 0.010, 0.015];               // spec actuelle : 0.010
const TRAILS = [                                   // spec actuelle : act 0.005 / cb 0.005
  { act: 0.005, cb: 0.005 }, { act: 0.010, cb: 0.005 },
  { act: 0.010, cb: 0.010 }, { act: 0.020, cb: 0.010 }, null
];

function medVol(c, i) {
  const from = Math.max(0, i - 288), v = [];
  for (let k = from; k < i; k++) v.push(c[k][5]);
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

/* Short uniquement (le fade = style live). PnL BRUT en % prix. */
function simShort(c, i, tp, sl, trail) {
  const entry = c[i][4];
  const tpPx = tp < 900 ? entry * (1 - tp) : 0;
  let slPx = entry * (1 + sl);
  let best = entry, trailOn = false;
  const end = Math.min(c.length - 1, i + MAX_HOLD);
  for (let k = i + 1; k <= end; k++) {
    const hi = c[k][2], lo = c[k][3];
    if (hi >= slPx) return { pnl: 1 - slPx / entry, dur: k - i };
    if (tpPx && lo <= tpPx) return { pnl: tp, dur: k - i };
    if (trail) {
      const close = c[k][4];
      if (close < best) best = close;
      if (1 - best / entry >= trail.act) {
        trailOn = true;
        const t = best * (1 + trail.cb);
        if (t < slPx) slPx = t;
      }
    }
  }
  return { pnl: 1 - c[end][4] / entry, dur: end - i };
}

function agg(list, coutPx) {
  if (list.length < 100) return null;
  const n = list.length;
  let sum = 0, w = 0, gp = 0, gn = 0;
  for (const t of list) {
    const p = t.pnl - coutPx;
    sum += p;
    if (p > 0) { w++; gp += p; } else gn -= p;
  }
  return { n, wr: +(100 * w / n).toFixed(1), esp: +(100 * sum / n * LEV).toFixed(2), pf: gn > 0 ? +(gp / gn).toFixed(2) : 99 };
}

function main() {
  const files = fs.readdirSync(DATA).filter(f => f.endsWith(".json"));
  const all = {};

  for (const E of ENTREES) {
    // 1) détecter une fois toutes les entrées de ce déclencheur
    const entries = []; // {file, candles idx, isOOS}
    for (const f of files) {
      let c;
      try { c = JSON.parse(fs.readFileSync(path.join(DATA, f))); } catch { continue; }
      if (c.length < 400) continue;
      const tOOS = c[c.length - 1][0] - OOS_JOURS * 86400 * 1000;
      let busy = -1;
      const idx = [];
      for (let i = E.lookback + 1; i < c.length - 2; i++) {
        if (i <= busy) continue;
        const ref = c[i - E.lookback][4];
        if (!(ref > 0) || c[i][4] / ref - 1 < E.pumpPct) continue;
        const mv = medVol(c, i);
        if (mv > 0 && c[i][5] < E.volX * mv) continue;
        idx.push({ i, oos: c[i][0] >= tOOS });
        busy = i + 48; // ~4 h de blocage par symbole, approx du slot vivant
      }
      if (idx.length) entries.push({ c, idx });
    }

    // 2) balayer les sorties sur ces entrées
    for (const tp of TPS) for (const sl of SLS) for (const tr of TRAILS) {
      const key = `${E.nom} | TP ${tp < 900 ? (tp * 100) + "%" : "aucun"} SL ${(sl * 100)}% trail ${tr ? (tr.act * 100) + "/" + (tr.cb * 100) : "aucun"}`;
      const is = [], oos = [];
      for (const { c, idx } of entries)
        for (const { i, oos: o } of idx) {
          const t = simShort(c, i, tp, sl, tr);
          (o ? oos : is).push(t);
        }
      all[key] = {
        taker: { is: agg(is, 0.0020), oos: agg(oos, 0.0020) },
        maker: { is: agg(is, 0.0010), oos: agg(oos, 0.0010) }
      };
    }
    console.log("entrées balayées:", E.nom);
  }

  fs.writeFileSync(path.join(__dirname, "sorties_resultats.json"), JSON.stringify(all, null, 1));

  // classement : pire des 2 périodes, coûts TAKER (conditions actuelles)
  const rows = Object.entries(all)
    .filter(([, v]) => v.taker.is && v.taker.oos)
    .map(([k, v]) => ({
      config: k, n: v.taker.is.n + v.taker.oos.n,
      taker_IS: v.taker.is.esp, taker_OOS: v.taker.oos.esp,
      maker_IS: v.maker.is.esp, maker_OOS: v.maker.oos.esp,
      wr_OOS: v.taker.oos.wr, pf_OOS: v.taker.oos.pf
    }))
    .sort((a, b) => Math.min(b.taker_IS, b.taker_OOS) - Math.min(a.taker_IS, a.taker_OOS));
  console.log("\n=== TOP 15 structures de sortie (esp. en % de MARGE/trade, net) ===");
  console.table(rows.slice(0, 15));
  console.log("=== la spec ACTUELLE pour comparaison ===");
  console.table(rows.filter(r => r.config.includes("TP 2.5% SL 1% trail 0.5/0.5")));
}

main();
