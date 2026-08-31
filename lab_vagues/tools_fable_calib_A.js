// tools_fable_calib_A — Étape A : grille de sévérités de la BASE (score x volume x range).
// AFFICHAGE aout_IS SEULEMENT (discipline tools_fable_calib_NOTES.md : OOS/epoque2 non regardés ici).
// Exits figés EXF (tp80/sl30/act25/cb15/hold12), verrou 12 h, entrée open bougie suivante (banc3).
// Usage : node tools_fable_calib_A.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const EXF = { tp: 0.80, sl: 0.30, act: 0.25, cb: 0.15, holdH: 12 };
const RANGES = [["moities 0.5/0.5", 0.5, 0.5], ["quartiles 0.25/0.75", 0.25, 0.75], ["deciles 0.1/0.9", 0.1, 0.9]];
const SS = [2.0, 2.1, 2.2], VS = [2.5, 3, 4];

const variantes = [];
const cells = [];
for (let si = 0; si < SS.length; si++)
  for (let vi = 0; vi < VS.length; vi++)
    for (let ri = 0; ri < RANGES.length; ri++) {
      const S = SS[si], V = VS[vi], [rn, lo, hi] = RANGES[ri];
      cells.push({ si, vi, ri, nom: `s>=${S} vol>=${V} ${rn}` });
      variantes.push({
        nom: `s>=${S} vol>=${V} ${rn}`, lockHold: true, ex: EXF, exKey: "EXF",
        decide: (d, s, f) => {
          const nd = -d;
          return s >= S && f.volSpike >= V && ((nd > 0 && f.rangePos < lo) || (nd < 0 && f.rangePos > hi)) ? nd : 0;
        }
      });
    }

const { corpus, midAout } = chargerCorpus();
const res = evaluer(corpus, midAout, variantes);
const A = res.map(r => agg(r.aout_IS));

// voisinage ±1 cran axe par axe (esp_IS > 0 exigé pour tous les voisins existants)
const at = (si, vi, ri) => A[(si * VS.length + vi) * RANGES.length + ri];
function voisinsOK(c) {
  const deltas = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
  for (const [ds, dv, dr] of deltas) {
    const s = c.si + ds, v = c.vi + dv, r = c.ri + dr;
    if (s < 0 || s >= SS.length || v < 0 || v >= VS.length || r < 0 || r >= RANGES.length) continue;
    const a = at(s, v, r);
    if (!a.n || a.esp <= 0) return false;
  }
  return true;
}

console.log("\n=== ÉTAPE A — grille de base, aout_IS SEULEMENT (esp% | wr% | n | voisinage) ===");
const short = [];
cells.forEach((c, k) => {
  const a = A[k];
  const vok = a.n ? voisinsOK(c) : false;
  const pass = a.n && a.esp >= 4 && a.n >= 65 && vok;
  if (pass) short.push({ ...c, ...a });
  console.log((pass ? "* " : "  ") + c.nom.padEnd(34),
    a.n ? `${String(a.esp).padStart(7)}% wr${String(a.wr).padStart(5)} n${String(a.n).padStart(4)} ${vok ? "vois+" : "vois-"}` : "        —");
});
short.sort((x, y) => y.wr - x.wr || y.n - x.n);
console.log("\nSHORTLIST (esp_IS>=4, n_IS>=65, voisins esp>0) triée par wr_IS — top 3 :");
short.slice(0, 3).forEach(c => console.log("  " + c.nom, `esp ${c.esp}% wr ${c.wr}% n ${c.n}`));
if (!short.length) console.log("  (vide — assouplir ? NON : constat, retour au protocole)");
