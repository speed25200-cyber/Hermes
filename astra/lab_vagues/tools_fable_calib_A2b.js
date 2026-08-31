// tools_fable_calib_A2b — ITÉRATION 2, étape A2b (amendement A4) : 10 cellules resserrées,
// exits FIGÉS tp0.8/sl0.3/act0.2/cb0.15/hold12 (choix plateau B2), verrou 12 h, banc3.
// AFFICHAGE : aout_IS (esp/wr/n) + n_ep2 (compte seul).
// Qualification : wr_IS >= 65.5 ET esp_IS >= 4.5 ET n_IS >= 55 ET n_ep2 >= 60.
// Choix : max wr_IS, départage esp_IS puis n_IS. Repli : « ret1h seul » (voir NOTES A4).
// Usage : node tools_fable_calib_A2b.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const EXC = { tp: 0.8, sl: 0.3, act: 0.2, cb: 0.15, holdH: 12 };
const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const contre = (nd, f, t) => (nd > 0 && f.ret1h <= -t) || (nd < 0 && f.ret1h >= t);

const { corpus, midAout } = chargerCorpus();
for (const inst of Object.values(corpus)) {
  const prev = [];
  for (const s of inst.sigs) {
    if (prev.length >= 20) { let lt = 0; for (const v of prev) if (v < s.f.volSpike) lt++; s.f.volRankPrev = lt / prev.length; }
    else s.f.volRankPrev = -1;
    prev.push(s.f.volSpike);
  }
}
const rk = (f, p) => f.volRankPrev < 0 || f.volRankPrev >= p;

const mk = (nom, dec) => ({ nom, lockHold: true, ex: EXC, exKey: "EXC", decide: dec });
const variantes = [
  mk("1. vol2.5 + ret1h + volRank p80", (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f, 0) && rk(f, 0.8) ? nd : 0; }),
  mk("2. vol2.5 + ret1h + volRank p90", (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f, 0) && rk(f, 0.9) ? nd : 0; }),
  mk("3. vol2.0 + ret1h + volRank p70", (d, s, f) => { const nd = -d; return f.volSpike >= 2 && acc(nd, f.rangePos) && contre(nd, f, 0) && rk(f, 0.7) ? nd : 0; }),
  mk("4. vol2.0 + ret1h + volRank p80", (d, s, f) => { const nd = -d; return f.volSpike >= 2 && acc(nd, f.rangePos) && contre(nd, f, 0) && rk(f, 0.8) ? nd : 0; }),
  mk("5. vol2.5 + ret1h>=0.5% + volRank p70", (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f, 0.005) && rk(f, 0.7) ? nd : 0; }),
  mk("6. vol2.5 + ret1h>=1% + volRank p70", (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f, 0.01) && rk(f, 0.7) ? nd : 0; }),
  mk("7. score[2,2.5) + ret1h + volRank p70", (d, s, f) => { const nd = -d; return s < 2.5 && f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f, 0) && rk(f, 0.7) ? nd : 0; }),
  mk("8. score[2,2.1) + ret1h + volRank p70", (d, s, f) => { const nd = -d; return s < 2.1 && f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f, 0) && rk(f, 0.7) ? nd : 0; }),
  mk("9. vol3.0 + ret1h + volRank p70", (d, s, f) => { const nd = -d; return f.volSpike >= 3 && acc(nd, f.rangePos) && contre(nd, f, 0) && rk(f, 0.7) ? nd : 0; }),
  mk("10. vol2.0 + ret1h + volRank p90", (d, s, f) => { const nd = -d; return f.volSpike >= 2 && acc(nd, f.rangePos) && contre(nd, f, 0) && rk(f, 0.9) ? nd : 0; }),
];

const res = evaluer(corpus, midAout, variantes);
console.log("\n=== ÉTAPE A2b — 10 cellules, aout_IS SEUL + n_ep2 (compte) · exits tp0.8/act0.2/cb0.15 ===");
console.log("(qualif : wr_IS >= 65.5, esp_IS >= 4.5, n_IS >= 55, n_ep2 >= 60)\n");
const q = [];
variantes.forEach((V, k) => {
  const a = agg(res[k].aout_IS);
  const nEp2 = res[k].epoque2.length;
  const ok = a.n && a.wr >= 65.5 && a.esp >= 4.5 && a.n >= 55 && nEp2 >= 60;
  if (ok) q.push({ nom: V.nom, ...a, nEp2 });
  console.log((ok ? "* " : "  ") + V.nom.padEnd(40),
    a.n ? `esp_IS ${String(a.esp).padStart(7)}% wr_IS ${String(a.wr).padStart(5)} n_IS ${String(a.n).padStart(4)}` : "—".padStart(30),
    ` n_ep2 ${String(nEp2).padStart(4)}`);
});
q.sort((x, y) => y.wr - x.wr || y.esp - x.esp || y.n - x.n);
console.log("\nQUALIFIÉS (max wr_IS / esp / n) :");
q.forEach(c => console.log(`  ${c.nom} · esp_IS ${c.esp}% wr_IS ${c.wr}% n_IS ${c.n} · n_ep2 ${c.nEp2}`));
if (!q.length) console.log("  (vide) -> REPLI pré-enregistré : « ret1h seul » tp0.8 act0.2 cb0.15 (NOTES A4)");
