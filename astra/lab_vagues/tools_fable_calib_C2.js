// tools_fable_calib_C2 — Étape C2 (amendement A3) : UN second filtre par-dessus le combo
// figé de l'étape C : INV s>=2 + vol>=2.5 + accord range moitiés + ret1h contre +
// tp0.8/sl0.3/act0.2/cb0.15/hold12 + verrou 12 h. AFFICHAGE aout_IS SEULEMENT.
// Adoption : wr_IS >= 65 ET esp_IS >= 4 ET n_IS >= 60, max wr_IS, départage n_IS ; sinon gel étape C.
// Usage : node tools_fable_calib_C2.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const EXC = { tp: 0.8, sl: 0.3, act: 0.2, cb: 0.15, holdH: 12 };
const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const contre = (nd, f) => (nd > 0 && f.ret1h <= 0) || (nd < 0 && f.ret1h >= 0);
const base = (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f) ? nd : 0; };

const { corpus, midAout } = chargerCorpus();
// augmentation causale (identique à l'étape B) : couleur de bougie + rang volume per-crypto
for (const inst of Object.values(corpus)) {
  const { c5, sigs } = inst;
  const prev = [];
  for (const s of sigs) {
    s.f.vert = c5[s.i][4] > c5[s.i][1];
    if (prev.length >= 20) { let lt = 0; for (const v of prev) if (v < s.f.volSpike) lt++; s.f.volRankPrev = lt / prev.length; }
    else s.f.volRankPrev = -1;
    prev.push(s.f.volSpike);
  }
}

const menu = [];
menu.push(["ref (étape C, aucun 2e filtre)", () => true]);
menu.push(["reprise (close sens trade)", (s, f, nd) => (nd > 0 && f.vert) || (nd < 0 && !f.vert)]);
for (const M of [0.2, 0.3]) menu.push([`meche accord ${M}`, (s, f, nd) => (nd > 0 && f.mecheBasse >= M) || (nd < 0 && f.mecheHaute >= M)]);
for (const R of [45, 40]) menu.push([`rsi accord ${R}`, (s, f, nd) => (nd > 0 && f.rsi < R) || (nd < 0 && f.rsi > 100 - R)]);
menu.push(["range 0.4/0.6 (durci)", (s, f, nd) => (nd > 0 && f.rangePos < 0.4) || (nd < 0 && f.rangePos > 0.6)]);
for (const P of [0.7, 0.8]) menu.push([`vol per-crypto p${P * 100}`, (s, f) => f.volRankPrev >= 0 ? f.volRankPrev >= P : true]);
for (const T of [0.005, 0.01]) menu.push([`ret1h contre >= ${T * 100}%`, (s, f, nd) => (nd > 0 && f.ret1h <= -T) || (nd < 0 && f.ret1h >= T)]);
menu.push(["plafond score < 2.1", s => s < 2.1]);
menu.push(["plafond score < 2.5", s => s < 2.5]);

const variantes = menu.map(([nom, ff]) => ({
  nom, lockHold: true, ex: EXC, exKey: "EXC",
  decide: (d, s, f) => { const nd = base(d, s, f); return nd && ff(s, f, nd) ? nd : 0; }
}));

const res = evaluer(corpus, midAout, variantes);
console.log("\n=== ÉTAPE C2 — second filtre, aout_IS SEULEMENT (adoption : wr>=65, esp>=4, n>=60) ===\n");
const qual = [];
variantes.forEach((V, k) => {
  const a = agg(res[k].aout_IS);
  const ok = a.n && a.wr >= 65 && a.esp >= 4 && a.n >= 60;
  if (ok && k > 0) qual.push({ nom: V.nom, ...a });
  console.log((ok ? "* " : "  ") + V.nom.padEnd(34), a.n ? `${String(a.esp).padStart(7)}% wr${String(a.wr).padStart(5)} n${String(a.n).padStart(4)}` : "—");
});
qual.sort((x, y) => y.wr - x.wr || y.n - x.n);
console.log("\nQUALIFIÉS :");
qual.forEach(c => console.log("  " + c.nom, `esp ${c.esp}% wr ${c.wr}% n ${c.n}`));
if (!qual.length) console.log("  (vide -> GEL de la formule étape C sans 2e filtre)");
