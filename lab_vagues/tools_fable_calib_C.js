// tools_fable_calib_C — Étape C : géométrie de sorties sur les entrées INCHANGÉES du combo
// retenu en étape B : INV s>=2 + vol>=2.5 + accord range moitiés + ret1h CONTRE + verrou 12 h.
// AFFICHAGE aout_IS SEULEMENT. Grille pré-enregistrée : tp{0.6,0.8} x sl{0.25,0.3} x
// act{0.2,0.25} x cb{0.1,0.15,0.2}, hold 12 figé.
// Adoption : wr_IS >= 60 (combo 59.0 + 1) ET esp_IS >= 4 ET voisins ±1 cran esp_IS > 0.
// Usage : node tools_fable_calib_C.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const contre = (nd, f) => (nd > 0 && f.ret1h <= 0) || (nd < 0 && f.ret1h >= 0);
const decide = (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f) ? nd : 0; };

const TPS = [0.6, 0.8], SLS = [0.25, 0.3], ACTS = [0.2, 0.25], CBS = [0.1, 0.15, 0.2];
const variantes = [], cells = [];
for (let ti = 0; ti < TPS.length; ti++)
  for (let si = 0; si < SLS.length; si++)
    for (let ai = 0; ai < ACTS.length; ai++)
      for (let ci = 0; ci < CBS.length; ci++) {
        const ex = { tp: TPS[ti], sl: SLS[si], act: ACTS[ai], cb: CBS[ci], holdH: 12 };
        cells.push({ ti, si, ai, ci, nom: `tp${ex.tp} sl${ex.sl} act${ex.act} cb${ex.cb}` });
        variantes.push({ nom: cells[cells.length - 1].nom, lockHold: true, ex, exKey: JSON.stringify(ex), decide });
      }

const { corpus, midAout } = chargerCorpus();
const res = evaluer(corpus, midAout, variantes);
const A = res.map(r => agg(r.aout_IS));
const at = (t, s, a, c) => A[((t * SLS.length + s) * ACTS.length + a) * CBS.length + c];
function voisinsOK(c) {
  const dims = [[1, 0, 0, 0], [-1, 0, 0, 0], [0, 1, 0, 0], [0, -1, 0, 0], [0, 0, 1, 0], [0, 0, -1, 0], [0, 0, 0, 1], [0, 0, 0, -1]];
  for (const [dt, ds, da, dc] of dims) {
    const t = c.ti + dt, s = c.si + ds, a = c.ai + da, x = c.ci + dc;
    if (t < 0 || t >= TPS.length || s < 0 || s >= SLS.length || a < 0 || a >= ACTS.length || x < 0 || x >= CBS.length) continue;
    const v = at(t, s, a, x);
    if (!v.n || v.esp <= 0) return false;
  }
  return true;
}

console.log("\n=== ÉTAPE C — sorties (entrées figées : INV s>=2 vol>=2.5 range moitiés ret1h contre), aout_IS SEULEMENT ===\n");
const qual = [];
cells.forEach((c, k) => {
  const a = A[k], vok = a.n ? voisinsOK(c) : false;
  const ok = a.n && a.wr >= 60 && a.esp >= 4 && vok;
  if (ok) qual.push({ ...c, ...a });
  console.log((ok ? "* " : "  ") + c.nom.padEnd(28), a.n ? `${String(a.esp).padStart(7)}% wr${String(a.wr).padStart(5)} n${String(a.n).padStart(4)} ${vok ? "vois+" : "vois-"}` : "—");
});
qual.sort((x, y) => y.wr - x.wr || y.esp - x.esp);
console.log("\nQUALIFIÉES (wr_IS>=60, esp_IS>=4, voisins esp>0) triées wr puis esp :");
qual.forEach(c => console.log("  " + c.nom, `esp ${c.esp}% wr ${c.wr}% n ${c.n}`));
if (!qual.length) console.log("  (vide -> on garde EXF tp0.8 sl0.3 act0.25 cb0.15)");
