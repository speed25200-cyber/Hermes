// ÉVALUATION FINALE — formule figée "ancienne stratégie, meilleure version" (itération 1) :
//   signal du moteur à score INVERSÉ (|score|>=2, dir non-null)
//   + filtre 1 : volume 5m >= 2 x médiane 24h (bougie du signal, close)
//   + filtre 2 : accord range-24h (on n'achète que sous la moitié du range 24h, on ne vend qu'au-dessus)
//   + verrou : UNE entrée max par instrument par 12 h (depuis l'entrée, même si sortie avant)
//   sorties tp80/sl30/act30/cb5/hold12 (% marge), levier 15, coûts 0,12 % prix (aller-retour)
// Une commande : node tools_fable_ancienne_final.js
const path = require("path");
const { chargerCorpus, evaluer, agg, E1, LEV } = require(path.join(__dirname, "tools_fable_ancienne_banc.js"));

const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const EXF = { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.10, holdH: 12 }; // = E1 sauf callback 0,10 (plateau cb 0,05-0,15)
const CANDIDAT = { nom: "FORMULE FINALE", lockHold: true, ex: EXF, exKey: "EXF", decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2 && acc(nd, f.rangePos) ? nd : 0; } };

function boot(l, it = 4000) {
  if (l.length < 10) return null;
  const n = l.length, means = [];
  for (let b = 0; b < it; b++) { let s = 0; for (let j = 0; j < n; j++) s += l[(Math.random() * n) | 0]; means.push(s / n); }
  means.sort((a, b) => a - b);
  return `IC90 [${(means[(it * 0.05) | 0] * LEV * 100).toFixed(2)}% ; ${(means[(it * 0.95) | 0] * LEV * 100).toFixed(2)}%]`;
}
const fmt = a => a && a.n ? `esp ${String(a.esp).padStart(7)}% · wr ${String(a.wr).padStart(5)}% · n ${String(a.n).padStart(4)}` : "—";

const { corpus, midAout } = chargerCorpus();

// ---- chiffres officiels + côtés + traçage instruments
const parInstPnl = {};
const variantes = [
  CANDIDAT,
  { nom: "longs seuls", lockHold: true, ex: EXF, exKey: "EXF", decide: (d, s, f) => { const nd = -d; return nd > 0 && f.volSpike >= 2 && acc(nd, f.rangePos) ? nd : 0; } },
  { nom: "shorts seuls", lockHold: true, ex: EXF, exKey: "EXF", decide: (d, s, f) => { const nd = -d; return nd < 0 && f.volSpike >= 2 && acc(nd, f.rangePos) ? nd : 0; } },
];
const res = evaluer(corpus, midAout, variantes);
console.log("\n================ FORMULE FINALE (exits tp80/sl30/act30/cb5/hold12 · levier 15 · coûts 0,12 %) ================");
console.log("signal INVERSÉ · vol5m >= 2x méd24h · accord range-24h (achat<0,5 / vente>0,5) · 1 entrée/instrument/12h\n");
const IS = res[0].aout_IS, OOS = res[0].aout_OOS, EP2 = res[0].epoque2;
console.log("aout_IS  (29/08 15:59 -> 30/08 12:34)   ", fmt(agg(IS)), " ", boot(IS));
console.log("aout_OOS (30/08 12:34 -> 31/08 10:54)   ", fmt(agg(OOS)), " ", boot(OOS));
const AOUT = IS.concat(OOS);
console.log("AOUT total                              ", fmt(agg(AOUT)), " ", boot(AOUT));
console.log("EPOQUE 2 (sept-oct 25 + fév 26)         ", fmt(agg(EP2)), " ", boot(EP2));
const TOUT = AOUT.concat(EP2);
console.log("TOUT (3 époques)                        ", fmt(agg(TOUT)), " ", boot(TOUT));
console.log("\ncôtés :");
for (const k of [1, 2]) console.log("  " + variantes[k].nom.padEnd(13), ["aout_IS", "aout_OOS", "epoque2"].map(e => e + " " + fmt(agg(res[k][e]))).join(" | "));

// ---- concentration par instrument (formule centrale, toutes époques)
{
  // ré-évaluation avec traçage manuel : on refait un passage en notant l'instrument
  const resT = {};
  for (const [instId, inst] of Object.entries(corpus)) {
    const one = evaluer({ [instId]: inst }, midAout, [CANDIDAT]);
    const l = one[0].aout_IS.concat(one[0].aout_OOS, one[0].epoque2);
    if (l.length) resT[instId] = { n: l.length, tot: l.reduce((a, b) => a + b, 0) * LEV * 100 };
  }
  const rows = Object.entries(resT).sort((a, b) => Math.abs(b[1].tot) - Math.abs(a[1].tot));
  const totAll = rows.reduce((a, r) => a + r[1].tot, 0);
  console.log("\nconcentration (pnl total = " + totAll.toFixed(0) + " points de marge, " + rows.length + " instruments) — top 8 :");
  for (const [id, v] of rows.slice(0, 8)) console.log("  " + id.padEnd(22), (v.tot > 0 ? "+" : "") + v.tot.toFixed(1) + " pts", "n" + v.n);
}

// ---- sensibilité aux coûts : relancer avec COUT=0.0018 (voir note en bas)
if (!process.env.COUT) {
  const { execFileSync } = require("child_process");
  console.log("\n--- sensibilité coûts x1,5 (0,18 %) ---");
  const out = execFileSync(process.execPath, [__filename, "resume"], { env: { ...process.env, COUT: "0.0018" }, encoding: "utf8" });
  console.log(out.split("\n").filter(l => l.includes("aout_") || l.includes("AOUT") || l.includes("EPOQUE") || l.includes("TOUT")).join("\n"));
}

// ---- plateau officiel
if (!process.argv.includes("resume")) {
  console.log("\n--- plateau (esp% IS | OOS | ep2) ---");
  const vs = [];
  for (const V of [1.5, 2, 2.5]) for (const [rn, lo, hi] of [["0.5", 0.5, 0.5], ["0.4/0.6", 0.4, 0.6]])
    for (const [ln, lk] of [["hold12h", { lockHold: true }], ["cool3h", { cooldown: 36 }]])
      vs.push({ nom: `vol>=${V} range ${rn} ${ln}`, ...lk, ex: EXF, exKey: "EXF", decide: (d, s, f) => { const nd = -d; return f.volSpike >= V && ((nd > 0 && f.rangePos < lo) || (nd < 0 && f.rangePos > hi)) ? nd : 0; } });
  const rp = evaluer(corpus, midAout, vs);
  vs.forEach((V, k) => {
    const a = agg(rp[k].aout_IS), b = agg(rp[k].aout_OOS), c = agg(rp[k].epoque2);
    console.log("  " + V.nom.padEnd(28), `${String(a.esp).padStart(6)} | ${String(b.esp).padStart(6)} | ${String(c.esp).padStart(6)}`);
  });

  // ---- équité par tranche 12h
  const resEq = evaluer(corpus, midAout, [CANDIDAT]);
  if (resEq[0]._ts) {
    const tr = {};
    for (const [ts, pnl] of resEq[0]._ts) {
      const d = new Date(ts).toISOString();
      const b = d.slice(0, 10) + (+d.slice(11, 13) < 12 ? "a" : "b");
      (tr[b] = tr[b] || []).push(pnl);
    }
    console.log("\néquité par tranche 12h :");
    let cum = 0;
    for (const b of Object.keys(tr).sort()) {
      const s = tr[b].reduce((a, x) => a + x, 0) * LEV * 100;
      cum += s;
      console.log("  " + b, ("Δ" + s.toFixed(1) + "%").padStart(9), ("cum " + cum.toFixed(1) + "%").padStart(12), "n" + tr[b].length);
    }
  }
}
