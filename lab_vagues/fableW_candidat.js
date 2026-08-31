// fableW_candidat — plateaux autour des 2 candidats retenus par fableW_filtre :
//   C1 = it1 + EXB(act0.2 cb0.2) + vol>=2.5 (sévérité volume)
//   C2 = it1 + EXB + ret1h contre (filtre unique nouveau)
//   C3 = combo C1+C2 (sévérité volume + filtre unique) — jugé aux mêmes critères
// Axes de voisinage : seuil du filtre, act/cb/tp/sl/hold, volume. Tout voisin doit rester esp>0.
// Usage : node fableW_candidat.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const mk = (V, R, ex, exKey) => ({
  ex, exKey, lockHold: true,
  decide: (d, s, f) => {
    const nd = -d;
    if (!(f.volSpike >= V && acc(nd, f.rangePos))) return 0;
    if (R !== null && !((nd > 0 && f.ret1h <= -R) || (nd < 0 && f.ret1h >= R))) return 0;
    return nd;
  }
});
const EXB = { tp: 0.8, sl: 0.3, act: 0.2, cb: 0.2, holdH: 12 };
const ex = (o) => ({ ...EXB, ...o });

const variantes = [];
const add = (nom, v) => variantes.push({ nom, ...v });

// --- C1 : vol>=2.5, axe volume ---
for (const V of [2, 2.5, 3]) add(`C1 vol>=${V}`, mk(V, null, EXB, "EXB"));
// --- C2 : ret1h contre, axe seuil (0 / 0.5% / 1%) x vol 2 ---
for (const R of [0, 0.005, 0.01]) add(`C2 vol2 ret1h<=-${R * 100}%`, mk(2, R, EXB, "EXB"));
// --- C3 : combo, axe seuil x vol 2.5 ---
for (const R of [0, 0.005, 0.01]) add(`C3 vol2.5 ret1h<=-${R * 100}%`, mk(2.5, R, EXB, "EXB"));

// --- voisinage des sorties pour C2 (le plus prometteur) ---
for (const [n2, o] of [["act0.1", { act: 0.1 }], ["act0.3", { act: 0.3 }], ["cb0.1", { cb: 0.1 }], ["cb0.3", { cb: 0.3 }],
["tp0.6", { tp: 0.6 }], ["tp1.2", { tp: 1.2 }], ["sl0.2", { sl: 0.2 }], ["h6", { holdH: 6 }], ["h24", { holdH: 24 }]]) {
  const e = ex(o);
  add(`C2 ${n2}`, mk(2, 0, e, JSON.stringify(e)));
}
// --- voisinage des sorties pour C3 ---
for (const [n2, o] of [["act0.1", { act: 0.1 }], ["act0.3", { act: 0.3 }], ["cb0.1", { cb: 0.1 }], ["tp0.6", { tp: 0.6 }], ["sl0.2", { sl: 0.2 }], ["h6", { holdH: 6 }], ["h24", { holdH: 24 }]]) {
  const e = ex(o);
  add(`C3 ${n2}`, mk(2.5, 0, e, JSON.stringify(e)));
}

const { corpus, midAout } = chargerCorpus();
const res = evaluer(corpus, midAout, variantes);
const fmt = a => a.n ? `${String(a.esp).padStart(7)}% wr${String(a.wr).padStart(5)} n${String(a.n).padStart(4)}` : "        —             ";
console.log("\nvariante".padEnd(26), "aout_IS".padStart(18), "aout_OOS".padStart(24), "epoque2".padStart(24));
variantes.forEach((V, k) => {
  const a = agg(res[k].aout_IS), b = agg(res[k].aout_OOS), c = agg(res[k].epoque2);
  const ok = a.n && b.n && c.n && a.wr >= 55 && b.wr >= 55 && c.wr >= 55 && a.esp > 3 && b.esp > 3 && c.esp > 3 && (a.n + b.n) >= 100;
  console.log((ok ? "* " : "  ") + V.nom.padEnd(24), fmt(a), " |", fmt(b), " |", fmt(c));
});
console.log("\n(* = wr>=55 partout, esp>3 partout, n aout>=100)");
