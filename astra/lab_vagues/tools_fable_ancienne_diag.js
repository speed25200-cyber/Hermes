// Diagnostic : pourquoi aout_OOS diverge-t-il d'aout_IS ?
// 1) régime BTC sur les fenêtres ; 2) décomposition par CÔTÉ tradé du INV+vol ; 3) esp par jour.
const path = require("path");
const { chargerCorpus, evaluer, agg, E1, LEV } = require(path.join(__dirname, "tools_fable_ancienne_banc.js"));
const fs = require("fs");

const { corpus, midAout } = chargerCorpus();

// régime BTC
for (const f of ["data_fable/BTC-USDT-SWAP.json", "data90/BTC-USDT-SWAP.json"]) {
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) continue;
  const c = JSON.parse(fs.readFileSync(p));
  const at = ts => { let best = null; for (const r of c) if (Math.abs(r[0] - ts) < 6e5) { best = r; break; } return best; };
  const pts = ["2026-08-29T16:00Z", "2026-08-30T04:00Z", "2026-08-30T12:30Z", "2026-08-31T00:00Z", "2026-08-31T10:50Z"];
  console.log("\nBTC (" + f + "):");
  for (const t of pts) { const r = at(Date.parse(t)); if (r) console.log(" ", t, r[4]); }
  break;
}

// variantes ciblées, décomposées par côté
const mk = (nom, cote) => ({ nom, decide: (d, s, f) => { const nd = -d; if (s < 2.1 || f.volSpike < 1.5) return 0; if (cote && Math.sign(nd) !== cote) return 0; return nd; } });
const variantes = [
  mk("INV s2.1 v1.5 (tous)", 0),
  mk("INV s2.1 v1.5 ACHATS (fade un short-signal)", 1),
  mk("INV s2.1 v1.5 VENTES (fade un long-signal)", -1),
  { nom: "ORIG s2.1 v1.5 (contrôle)", decide: (d, s, f) => (s >= 2.1 && f.volSpike >= 1.5) ? d : 0 }
];
const res = evaluer(corpus, midAout, variantes);
const fmt = a => a.n ? `${a.esp}% wr${a.wr} n${a.n}` : "—";
console.log("\ncôté".padEnd(46), "aout_IS", "· aout_OOS", "· epoque2");
variantes.forEach((V, k) => console.log(V.nom.padEnd(45), fmt(agg(res[k].aout_IS)), "|", fmt(agg(res[k].aout_OOS)), "|", fmt(agg(res[k].epoque2))));

// esp par tranche de 6h (variante 0)
const tr = {};
for (const [ts, pnl] of res[0]._ts || []) {
  const d = new Date(ts).toISOString().slice(0, 13);
  const b = d.slice(0, 11) + String(Math.floor(+d.slice(11) / 6) * 6).padStart(2, "0");
  (tr[b] = tr[b] || []).push(pnl);
}
console.log("\nINV s2.1 v1.5 par tranche 6h :");
for (const b of Object.keys(tr).sort()) { const a = agg(tr[b]); console.log(" ", b + "h", (a.esp + "%").padStart(8), "wr" + a.wr, "n" + a.n); }
