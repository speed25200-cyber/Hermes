// tools_fable_calib_B2 — ITÉRATION 2, étape B2 : grille de sorties sur les entrées
// INCHANGÉES des 3 combos du top A2. AFFICHAGE aout_IS SEUL + n_ep2 (compte).
// Grille : tp {0.6, 0.8} x act {0.15, 0.2, 0.25} x cb {0.1, 0.15, 0.2} · sl 0.3 · hold 12 figés.
// Qualification : wr_IS >= 65 ET esp_IS >= 4.5 ET n_IS >= 55 ET n_ep2 >= 60 ET
//   plateau (tous les voisins ±1 cran axe-par-axe dans la grille : esp_IS >= 2).
// CHOIX : max du MIN de wr_IS sur le voisinage ±1 (cellule incluse) ; départage esp_IS puis n_IS.
// Usage : node tools_fable_calib_B2.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const contre = (nd, f) => (nd > 0 && f.ret1h <= 0) || (nd < 0 && f.ret1h >= 0);

const { corpus, midAout } = chargerCorpus();
// augmentation causale volRankPrev (identique it1/A2)
for (const inst of Object.values(corpus)) {
  const prev = [];
  for (const s of inst.sigs) {
    if (prev.length >= 20) { let lt = 0; for (const v of prev) if (v < s.f.volSpike) lt++; s.f.volRankPrev = lt / prev.length; }
    else s.f.volRankPrev = -1;
    prev.push(s.f.volSpike);
  }
}

const combos = [
  ["A: ret1h+volRankP70", (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f) && (f.volRankPrev < 0 || f.volRankPrev >= 0.7) ? nd : 0; }],
  ["B: ret1h seul", (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f) ? nd : 0; }],
  ["C: ret1h+cap<2.5", (d, s, f) => { const nd = -d; return s < 2.5 && f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f) ? nd : 0; }],
];
const TPs = [0.6, 0.8], ACTs = [0.15, 0.2, 0.25], CBs = [0.1, 0.15, 0.2];

const variantes = [], meta = [];
combos.forEach(([cn, dec], ci) => {
  TPs.forEach((tp, ti) => ACTs.forEach((act, ai) => CBs.forEach((cb, bi) => {
    const ex = { tp, sl: 0.3, act, cb, holdH: 12 };
    meta.push({ ci, ti, ai, bi, cn, tp, act, cb });
    variantes.push({ nom: `${cn} tp${tp} act${act} cb${cb}`, lockHold: true, ex, exKey: JSON.stringify(ex), decide: dec });
  })));
});

const res = evaluer(corpus, midAout, variantes);
const cells = meta.map((m, k) => {
  const a = agg(res[k].aout_IS);
  return { ...m, k, esp: a.esp || 0, wr: a.wr || 0, n: a.n || 0, nEp2: res[k].epoque2.length };
});
const at = (ci, ti, ai, bi) => cells.find(c => c.ci === ci && c.ti === ti && c.ai === ai && c.bi === bi);
function voisins(c) {
  const v = [];
  for (const [dt, da, db] of [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]) {
    const x = at(c.ci, c.ti + dt, c.ai + da, c.bi + db);
    if (x) v.push(x);
  }
  return v;
}

console.log("\n=== ÉTAPE B2 — grille de sorties, aout_IS SEUL + n_ep2 (compte) ===");
console.log("(qualif : wr_IS>=65, esp_IS>=4.5, n_IS>=55, n_ep2>=60, voisins ±1 esp_IS>=2 ; choix = max minWr voisinage)\n");
const qual = [];
for (const c of cells) {
  const vs = voisins(c);
  const plateau = vs.every(x => x.esp >= 2);
  const minWr = Math.min(c.wr, ...vs.map(x => x.wr));
  const ok = c.wr >= 65 && c.esp >= 4.5 && c.n >= 55 && c.nEp2 >= 60 && plateau;
  if (ok) qual.push({ ...c, minWr });
  console.log((ok ? "* " : "  ") + `${c.cn} tp${c.tp} act${c.act} cb${c.cb}`.padEnd(40),
    `esp_IS ${String(c.esp).padStart(7)}% wr_IS ${String(c.wr).padStart(5)} n_IS ${String(c.n).padStart(4)}`,
    ` minWrVois ${String(minWr).padStart(5)}`, plateau ? "" : " (pas plateau)");
}
qual.sort((x, y) => y.minWr - x.minWr || y.esp - x.esp || y.n - x.n);
console.log("\nQUALIFIÉS (tri minWr voisinage / esp / n) :");
qual.slice(0, 8).forEach(c => console.log(`  ${c.cn} tp${c.tp} act${c.act} cb${c.cb} · esp_IS ${c.esp}% wr_IS ${c.wr}% n_IS ${c.n} · minWrVois ${c.minWr} · n_ep2 ${c.nEp2}`));
if (!qual.length) {
  console.log("  (vide) — repli pré-enregistré : meilleure cellule plateau sans le seuil wr>=65 :");
  const rep = cells.filter(c => c.esp >= 4.5 && c.n >= 55 && c.nEp2 >= 60 && voisins(c).every(x => x.esp >= 2))
    .map(c => ({ ...c, minWr: Math.min(c.wr, ...voisins(c).map(x => x.wr)) }))
    .sort((x, y) => y.minWr - x.minWr || y.esp - x.esp || y.n - x.n);
  rep.slice(0, 5).forEach(c => console.log(`  ${c.cn} tp${c.tp} act${c.act} cb${c.cb} · esp_IS ${c.esp}% wr_IS ${c.wr}% n_IS ${c.n} · minWrVois ${c.minWr} · n_ep2 ${c.nEp2}`));
}
