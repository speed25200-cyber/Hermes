// tools_fable_calib_A2 — ITÉRATION 2, étape A2 : audit marginal du 2e slot de filtre.
// Exits figés EXC (tp0.8/sl0.3/act0.2/cb0.15/hold12), verrou 12 h, banc3 (zéro look-ahead).
// AFFICHAGE : aout_IS (esp/wr/n) + n_ep2 SEUL (compte de faisabilité, aucune perf).
// Qualification : esp_IS >= 4.5 ET n_IS >= 55 ET n_ep2 >= 60. Top 3 par wr_IS -> étape B2.
// Usage : node tools_fable_calib_A2.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const EXC = { tp: 0.8, sl: 0.3, act: 0.2, cb: 0.15, holdH: 12 };
const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const contre = (nd, f) => (nd > 0 && f.ret1h <= 0) || (nd < 0 && f.ret1h >= 0);

const { corpus, midAout } = chargerCorpus();

// ---- augmentations causales per-crypto (fenêtres expansives sur les signaux précédents) ----
let desordre = 0;
for (const inst of Object.values(corpus)) {
  const { c5, sigs } = inst;
  const prevVol = [], prevAbsRet = [];
  let lastTs = -Infinity;
  for (const s of sigs) {
    if (s.ts < lastTs) desordre++;
    lastTs = s.ts;
    s.f.vert = c5[s.i][4] > c5[s.i][1];
    if (prevVol.length >= 20) {
      let lt = 0; for (const v of prevVol) if (v < s.f.volSpike) lt++;
      s.f.volRankPrev = lt / prevVol.length;
    } else s.f.volRankPrev = -1;
    const ar = Math.abs(s.f.ret1h);
    if (prevAbsRet.length >= 20) {
      let lt = 0; for (const v of prevAbsRet) if (v < ar) lt++;
      s.f.retRankPrev = lt / prevAbsRet.length;
    } else s.f.retRankPrev = -1;
    prevVol.push(s.f.volSpike);
    prevAbsRet.push(ar);
  }
}
console.log("signaux hors ordre chronologique par instrument :", desordre, "(attendu 0)");

// ---- menu de filtres (nom, test(s, f, nd)) ----
const F = {
  ret1h: (s, f, nd) => contre(nd, f),
  ret1hP50: (s, f, nd) => contre(nd, f) && (f.retRankPrev < 0 || f.retRankPrev >= 0.5),
  reprise: (s, f, nd) => (nd > 0 && f.vert) || (nd < 0 && !f.vert),
  meche02: (s, f, nd) => (nd > 0 && f.mecheBasse >= 0.2) || (nd < 0 && f.mecheHaute >= 0.2),
  rsi45: (s, f, nd) => (nd > 0 && f.rsi < 45) || (nd < 0 && f.rsi > 55),
  range46: (s, f, nd) => (nd > 0 && f.rangePos < 0.4) || (nd < 0 && f.rangePos > 0.6),
  volP70: (s, f) => f.volRankPrev < 0 || f.volRankPrev >= 0.7,
  cap21: s => s < 2.1,
  cap25: s => s < 2.5,
};
const mk = (nom, V, fils) => ({
  nom, lockHold: true, ex: EXC, exKey: "EXC",
  decide: (d, s, f) => {
    const nd = -d;
    if (!(f.volSpike >= V && acc(nd, f.rangePos))) return 0;
    for (const ff of fils) if (!ff(s, f, nd)) return 0;
    return nd;
  }
});

const variantes = [
  mk("base seule (vol2.5)", 2.5, []),
  // singles
  mk("ret1h contre", 2.5, [F.ret1h]),
  mk("ret1h renforcé p50 per-crypto", 2.5, [F.ret1hP50]),
  mk("reprise", 2.5, [F.reprise]),
  mk("mèche accord 0.2", 2.5, [F.meche02]),
  mk("rsi accord 45", 2.5, [F.rsi45]),
  mk("range durci 0.4/0.6", 2.5, [F.range46]),
  mk("volRank p70", 2.5, [F.volP70]),
  mk("cap score <2.1", 2.5, [F.cap21]),
  mk("cap score <2.5", 2.5, [F.cap25]),
  // paires ret1h + X
  mk("ret1h + volRank p70 (=CALIB-1)", 2.5, [F.ret1h, F.volP70]),
  mk("ret1h + reprise", 2.5, [F.ret1h, F.reprise]),
  mk("ret1h + mèche 0.2", 2.5, [F.ret1h, F.meche02]),
  mk("ret1h + rsi 45", 2.5, [F.ret1h, F.rsi45]),
  mk("ret1h + range 0.4/0.6", 2.5, [F.ret1h, F.range46]),
  mk("ret1h + cap <2.1", 2.5, [F.ret1h, F.cap21]),
  mk("ret1h + cap <2.5", 2.5, [F.ret1h, F.cap25]),
  mk("ret1hP50 + volRank p70", 2.5, [F.ret1hP50, F.volP70]),
  mk("ret1hP50 + reprise", 2.5, [F.ret1hP50, F.reprise]),
  // sévérité volume
  mk("vol>=3 + ret1h", 3, [F.ret1h]),
  mk("vol>=3 + ret1h + cap <2.5", 3, [F.ret1h, F.cap25]),
  mk("vol>=2 + ret1h + reprise", 2, [F.ret1h, F.reprise]),
  mk("vol>=2 + ret1hP50 + reprise", 2, [F.ret1hP50, F.reprise]),
  // paires sans ret1h
  mk("reprise + volRank p70", 2.5, [F.reprise, F.volP70]),
  mk("mèche 0.2 + volRank p70", 2.5, [F.meche02, F.volP70]),
];

const res = evaluer(corpus, midAout, variantes);
console.log("\n=== ÉTAPE A2 — aout_IS SEUL + n_ep2 (compte) · exits EXC · verrou 12h ===");
console.log("(qualification : esp_IS >= 4.5 ET n_IS >= 55 ET n_ep2 >= 60 ; top 3 par wr_IS)\n");
const rows = [];
variantes.forEach((V, k) => {
  const a = agg(res[k].aout_IS);
  const nEp2 = res[k].epoque2.length; // COMPTE seulement — perf ep2 non calculée/affichée
  const ok = a.n && a.esp >= 4.5 && a.n >= 55 && nEp2 >= 60;
  rows.push({ nom: V.nom, ...a, nEp2, ok });
  console.log((ok ? "* " : "  ") + V.nom.padEnd(34),
    a.n ? `esp_IS ${String(a.esp).padStart(7)}% wr_IS ${String(a.wr).padStart(5)} n_IS ${String(a.n).padStart(4)}` : "—".padStart(30),
    ` n_ep2 ${String(nEp2).padStart(4)}`);
});
const top = rows.filter(r => r.ok).sort((x, y) => y.wr - x.wr || y.n - x.n).slice(0, 3);
console.log("\nTOP 3 (par wr_IS) -> étape B2 :");
top.forEach(r => console.log(`  ${r.nom} · esp_IS ${r.esp}% wr_IS ${r.wr}% n_IS ${r.n} · n_ep2 ${r.nEp2}`));
if (!top.length) console.log("  (aucun qualifié — voir NOTES pour la règle de repli)");
