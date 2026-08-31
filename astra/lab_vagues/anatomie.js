// Anatomie des vagues : détecte les vagues (pompes) dans les bougies 5m collectées,
// puis simule la structure de trade EXACTE du bot live (TP +2,5% prix / SL -1% prix /
// trailing 0,5% activé à +0,5%) dans les DEUX sens à chaque déclencheur :
//   - SHORT = fade (le style live actuel : on shorte la vague)
//   - LONG  = surf (on monte sur la vague dans son sens)
// But : savoir, chiffres réels à l'appui, quel déclencheur/sens/sortie rapporte le plus
// SANS réduire la fréquence. Règle d'ambiguïté bougie : le PIRE cas d'abord (SL avant TP).
// Validation : 20 premiers jours = échantillon, 10 derniers = hors-échantillon.
const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "data");
const SPEC = { tpPx: 0.025, slPx: 0.010, trailActPx: 0.005, trailPx: 0.005 }; // structure du bot live
const COUT_PX = 0.0020;      // aller-retour : taker 2×0,05% + slippage 2×0,05% (en % prix)
const LEV = 20;
const MAX_HOLD = 576;        // 48 h en bougies 5m
const OOS_JOURS = 10;        // hors-échantillon = 10 derniers jours

// Grille de déclencheurs de vague : hausse de P% en L bougies, volume ≥ V× la médiane 24h
const GRID = [];
for (const pumpPct of [0.03, 0.05, 0.08, 0.12])
  for (const lookback of [6, 12, 24])
    for (const volX of [1, 2, 3])
      GRID.push({ pumpPct, lookback, volX });

function medVol(candles, i) {
  const from = Math.max(0, i - 288); // 24 h
  const v = [];
  for (let k = from; k < i; k++) v.push(candles[k][5]);
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

/* Simule un trade complet depuis la bougie d'entrée (entrée = close de candles[i]).
   dir: +1 long / -1 short. Retourne le PnL en % prix (net de coûts) et la durée. */
function simTrade(candles, i, dir) {
  const entry = candles[i][4];
  const tp = entry * (1 + dir * SPEC.tpPx);
  let sl = entry * (1 - dir * SPEC.slPx);
  let best = entry, trailOn = false;
  const end = Math.min(candles.length - 1, i + MAX_HOLD);
  for (let k = i + 1; k <= end; k++) {
    const [, , hi, lo] = candles[k];
    const adverse = dir > 0 ? lo : hi;
    const favor = dir > 0 ? hi : lo;
    // pire cas d'abord : le stop (fixe ou trail) touché dans la bougie prime sur le TP
    if (dir > 0 ? adverse <= sl : adverse >= sl)
      return { pnl: (dir > 0 ? sl / entry - 1 : 1 - sl / entry) - COUT_PX, dur: k - i, exit: trailOn ? "trail" : "sl" };
    if (dir > 0 ? favor >= tp : favor <= tp)
      return { pnl: SPEC.tpPx - COUT_PX, dur: k - i, exit: "tp" };
    // mise à jour du trailing sur le close (approximation 5m, raffinable en 1m)
    const close = candles[k][4];
    if (dir > 0 ? close > best : close < best) best = close;
    const gain = dir > 0 ? best / entry - 1 : 1 - best / entry;
    if (gain >= SPEC.trailActPx) {
      trailOn = true;
      const t = dir > 0 ? best * (1 - SPEC.trailPx) : best * (1 + SPEC.trailPx);
      if (dir > 0 ? t > sl : t < sl) sl = t;
    }
  }
  const last = candles[end][4];
  return { pnl: (dir > 0 ? last / entry - 1 : 1 - last / entry) - COUT_PX, dur: end - i, exit: "temps" };
}

function agg(trades) {
  if (!trades.length) return null;
  const n = trades.length;
  const wins = trades.filter(t => t.pnl > 0);
  const sum = trades.reduce((s, t) => s + t.pnl, 0);
  const gPos = wins.reduce((s, t) => s + t.pnl, 0);
  const gNeg = -trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  return {
    n,
    winrate: +(100 * wins.length / n).toFixed(1),
    espPricePct: +(100 * sum / n).toFixed(3),          // espérance % prix / trade (net)
    espMargePct: +(100 * sum / n * LEV).toFixed(1),    // idem en % de la MARGE (levier 20)
    pf: gNeg > 0 ? +(gPos / gNeg).toFixed(2) : 99,
    durMed: trades.map(t => t.dur).sort((a, b) => a - b)[Math.floor(n / 2)]
  };
}

function main() {
  const files = fs.readdirSync(DATA).filter(f => f.endsWith(".json"));
  console.log("instruments:", files.length);
  const results = [];
  for (const cfg of GRID) {
    const trades = { shortIS: [], shortOOS: [], longIS: [], longOOS: [] };
    let joursTotal = 0;
    for (const f of files) {
      let c;
      try { c = JSON.parse(fs.readFileSync(path.join(DATA, f))); } catch { continue; }
      if (c.length < 400) continue;
      const tOOS = c[c.length - 1][0] - OOS_JOURS * 86400 * 1000;
      joursTotal += (c[c.length - 1][0] - c[0][0]) / 86400000;
      let busyUntil = -1; // pas de ré-entrée tant qu'un trade est ouvert (comme le bot live)
      for (let i = cfg.lookback + 1; i < c.length - 2; i++) {
        if (i <= busyUntil) continue;
        const ref = c[i - cfg.lookback][4];
        if (!(ref > 0)) continue;
        const pump = c[i][4] / ref - 1;
        if (pump < cfg.pumpPct) continue;
        const mv = medVol(c, i);
        if (mv > 0 && c[i][5] < cfg.volX * mv) continue;
        const isOOS = c[i][0] >= tOOS;
        const s = simTrade(c, i, -1);
        const l = simTrade(c, i, +1);
        busyUntil = i + Math.max(s.dur, l.dur);
        (isOOS ? trades.shortOOS : trades.shortIS).push(s);
        (isOOS ? trades.longOOS : trades.longIS).push(l);
      }
    }
    const nTot = trades.shortIS.length + trades.shortOOS.length;
    const sigJour = joursTotal > 0 ? +((nTot / (joursTotal / files.length))).toFixed(1) : 0;
    results.push({
      cfg: `pompe +${(cfg.pumpPct * 100)}% en ${cfg.lookback * 5}min vol≥${cfg.volX}x`,
      signauxParJour: sigJour,
      short: { is: agg(trades.shortIS), oos: agg(trades.shortOOS) },
      long: { is: agg(trades.longIS), oos: agg(trades.longOOS) }
    });
    console.log("fait:", results[results.length - 1].cfg, "signaux/j:", sigJour);
  }
  fs.writeFileSync(path.join(__dirname, "resultats.json"), JSON.stringify(results, null, 1));

  // Classement : rentable net des coûts DANS les deux périodes (anti-surajustement)
  const lignes = [];
  for (const r of results)
    for (const dir of ["short", "long"]) {
      const x = r[dir];
      if (!x.is || !x.oos || x.is.n < 200) continue;
      lignes.push({
        config: r.cfg, sens: dir, signauxParJour: r.signauxParJour,
        n: x.is.n + x.oos.n,
        "esp%marge_IS": x.is.espMargePct, "esp%marge_OOS": x.oos.espMargePct,
        winrate_OOS: x.oos.winrate, pf_OOS: x.oos.pf
      });
    }
  lignes.sort((a, b) => Math.min(b["esp%marge_IS"], b["esp%marge_OOS"]) - Math.min(a["esp%marge_IS"], a["esp%marge_OOS"]));
  console.log("\n=== TOP 12 (le pire des 2 périodes doit être bon) ===");
  console.table(lignes.slice(0, 12));
  console.log("=== FLOP 3 ===");
  console.table(lignes.slice(-3));
  fs.writeFileSync(path.join(__dirname, "classement.json"), JSON.stringify(lignes, null, 1));
}

main();
