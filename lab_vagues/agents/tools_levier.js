// Question client : un levier > 15 serait-il meilleur ? Réponse par les données.
// Les exits sont en % de MARGE : à levier plus fort, les mêmes cibles de marge =
// des distances de PRIX plus serrées (plus de bruit, plus de SL) ET des coûts plus
// lourds en marge (0,12 % prix × levier). On rejoue les 5 SURVIVANTS du test acide
// sur les 60 jours vierges (data90) à levier 10/15/20/25/30.
const fs = require("fs");
const path = require("path");
const COUT_PX = 0.0012;
const MODS = ["web_structure_1", "multiech_2", "patterns_2", "oscillo_3", "multiech_1"];

function sim(c5, i5, dir, ex, LEV) {
  const entry = c5[i5][4];
  const tpPx = ex.tp / LEV, slPx0 = Math.min(ex.sl, 0.30) / LEV;
  const actPx = (ex.act ?? 99) / LEV, cbPx = (ex.cb ?? 0.05) / LEV;
  const hold = Math.round((ex.holdH ?? 12) * 12);
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  let sl = dir > 0 ? entry * (1 - slPx0) : entry * (1 + slPx0);
  let best = entry;
  const end = Math.min(c5.length - 1, i5 + hold);
  for (let k = i5 + 1; k <= end; k++) {
    const hi = c5[k][2], lo = c5[k][3];
    if (dir > 0 ? lo <= sl : hi >= sl) return { pnl: (dir > 0 ? sl / entry - 1 : 1 - sl / entry) - COUT_PX, dur: k - i5 };
    if (dir > 0 ? hi >= tp : lo <= tp) return { pnl: tpPx - COUT_PX, dur: k - i5 };
    const close = c5[k][4];
    if (dir > 0 ? close > best : close < best) best = close;
    if ((dir > 0 ? best / entry - 1 : 1 - best / entry) >= actPx) {
      const t = dir > 0 ? best * (1 - cbPx) : best * (1 + cbPx);
      if (dir > 0 ? t > sl : t < sl) sl = t;
    }
  }
  return { pnl: (dir > 0 ? c5[end][4] / entry - 1 : 1 - c5[end][4] / entry) - COUT_PX, dur: end - i5 };
}

console.log("levier : esp %MARGE/trade (net) sur les 60 j vierges · [winrate]");
console.log("module".padEnd(24), "x10".padStart(9), "x15".padStart(9), "x20".padStart(9), "x25".padStart(9), "x30".padStart(9));
for (const m of MODS) {
  const mod = require(path.join(__dirname, "candidates", m + ".js"));
  const c5 = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data90", mod.instId + ".json")));
  const coupure = c5[c5.length - 1][0] - 30 * 86400 * 1000;
  const sigs = (mod.detect(c5) || []).sort((a, b) => a.i5 - b.i5);
  const ligne = [(m + " (" + mod.instId.replace("-USDT-SWAP", "") + ")").padEnd(24)];
  for (const LEV of [10, 15, 20, 25, 30]) {
    const trades = [];
    let busy = -1;
    for (const s of sigs) {
      if (s.i5 <= busy || s.i5 >= c5.length - 2 || !s.dir) continue;
      if (c5[s.i5][0] >= coupure) continue;
      const t = sim(c5, s.i5, s.dir, mod.exits, LEV);
      busy = s.i5 + t.dur;
      trades.push(t);
    }
    const n = trades.length, w = trades.filter(t => t.pnl > 0).length;
    const esp = trades.reduce((a, t) => a + t.pnl, 0) / n * LEV * 100;
    ligne.push((esp.toFixed(2) + "[" + Math.round(100 * w / n) + "]").padStart(9));
  }
  console.log(ligne.join(" "));
}
