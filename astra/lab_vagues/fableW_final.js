// fableW_final — ÉVALUATION FINALE de la formule ANGLE 1 (winrate), figée après
// fableW_exits / fableW_filtre / fableW_candidat / fableW_voisinage (discipline fableW_NOTES.md).
//
// FORMULE fableW :
//   signal du moteur à score INVERSÉ (|score|>=2, dir non-null)
//   + volume 5m >= 2.5 x médiane 24h            (sévérité durcie, ancien 2)
//   + accord range-24h (achat si close < 50 % du range 24h, vente si > 50 %)
//   + filtre unique NOUVEAU "ret1h contre" : on n'achète que si la dernière heure est
//     déjà en baisse (close_i/close_{i-12} - 1 <= 0), on ne vend que si elle est en hausse
//   + verrou 12 h / instrument (depuis l'entrée)
//   sorties (% de marge, levier 15) : tp 80 / sl 30 / trail act 20 cb 20 / hold 12 h
//   (trail PLUS PRÉCOCE act 0.2 mais callback PLUS LARGE 0.2 : wr monte sans tuer l'esp)
//   coûts 0,12 % prix aller-retour · banc v3 (entrée à l'OPEN de la bougie suivante, zéro look-ahead)
// Usage : node fableW_final.js
const path = require("path");
const { chargerCorpus, evaluer, agg, LEV } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const contre = (nd, f) => (nd > 0 && f.ret1h <= 0) || (nd < 0 && f.ret1h >= 0);
const EXW = { tp: 0.8, sl: 0.3, act: 0.2, cb: 0.2, holdH: 12 };
const CAND = {
  nom: "FORMULE fableW", lockHold: true, ex: EXW, exKey: "EXW",
  decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f) ? nd : 0; }
};

function boot(l, it = 4000) {
  if (l.length < 10) return null;
  const n = l.length, means = [];
  for (let b = 0; b < it; b++) { let s = 0; for (let j = 0; j < n; j++) s += l[(Math.random() * n) | 0]; means.push(s / n); }
  means.sort((a, b) => a - b);
  return `IC90 [${(means[(it * 0.05) | 0] * LEV * 100).toFixed(2)}% ; ${(means[(it * 0.95) | 0] * LEV * 100).toFixed(2)}%]`;
}
const fmt = a => a && a.n ? `esp ${String(a.esp).padStart(7)}% · wr ${String(a.wr).padStart(5)}% · n ${String(a.n).padStart(4)}` : "—";

const { corpus, midAout } = chargerCorpus();

const variantes = [
  CAND,
  { ...CAND, nom: "longs seuls", decide: (d, s, f) => { const nd = -d; return nd > 0 && CAND.decide(d, s, f) ? nd : 0; } },
  { ...CAND, nom: "shorts seuls", decide: (d, s, f) => { const nd = -d; return nd < 0 && CAND.decide(d, s, f) ? nd : 0; } },
];
const res = evaluer(corpus, midAout, variantes);
console.log("\n=========== FORMULE fableW (tp80/sl30/act20/cb20/hold12 · levier 15 · coûts 0,12 % · banc v3 sans look-ahead) ===========");
console.log("INV s>=2 · vol5m >= 2.5x méd24h · accord range-24h · ret1h CONTRE le trade · 1 entrée/instrument/12h\n");
const IS = res[0].aout_IS, OOS = res[0].aout_OOS, EP2 = res[0].epoque2;
console.log("aout_IS  (29/08 -> 30/08 12:34)   ", fmt(agg(IS)), " ", boot(IS));
console.log("aout_OOS (30/08 12:34 -> 31/08)   ", fmt(agg(OOS)), " ", boot(OOS));
const AOUT = IS.concat(OOS);
console.log("AOUT total                        ", fmt(agg(AOUT)), " ", boot(AOUT));
console.log("EPOQUE 2 (sept-oct 25 + fev 26)   ", fmt(agg(EP2)), " ", boot(EP2));
const TOUT = AOUT.concat(EP2);
console.log("TOUT (3 epoques)                  ", fmt(agg(TOUT)), " ", boot(TOUT));
console.log("\ncotes :");
for (const k of [1, 2]) console.log("  " + variantes[k].nom.padEnd(13), ["aout_IS", "aout_OOS", "epoque2"].map(e => e + " " + fmt(agg(res[k][e]))).join(" | "));

// reference it1 sur le meme banc (comparaison directe)
{
  const EXF = { tp: 0.8, sl: 0.3, act: 0.3, cb: 0.1, holdH: 12 };
  const it1 = { nom: "it1", lockHold: true, ex: EXF, exKey: "EXF", decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2 && acc(nd, f.rangePos) ? nd : 0; } };
  const r = evaluer(corpus, midAout, [it1]);
  console.log("\nreference it1 (meme banc v3)      ", ["aout_IS", "aout_OOS", "epoque2"].map(e => e + " " + fmt(agg(r[0][e]))).join(" | "));
}

// concentration par instrument
{
  const resT = {};
  for (const [instId, inst] of Object.entries(corpus)) {
    const one = evaluer({ [instId]: inst }, midAout, [CAND]);
    const l = one[0].aout_IS.concat(one[0].aout_OOS, one[0].epoque2);
    if (l.length) resT[instId] = { n: l.length, tot: l.reduce((a, b) => a + b, 0) * LEV * 100 };
  }
  const rows = Object.entries(resT).sort((a, b) => Math.abs(b[1].tot) - Math.abs(a[1].tot));
  const totAll = rows.reduce((a, r) => a + r[1].tot, 0);
  console.log("\nconcentration (pnl total = " + totAll.toFixed(0) + " points de marge, " + rows.length + " instruments) — top 8 :");
  for (const [id, v] of rows.slice(0, 8)) console.log("  " + id.padEnd(22), (v.tot > 0 ? "+" : "") + v.tot.toFixed(1) + " pts", "n" + v.n);
}

// equite par tranche 12h (aout)
{
  const r = evaluer(corpus, midAout, [CAND]);
  if (r[0]._ts) {
    const tr = {};
    for (const [ts, pnl] of r[0]._ts) {
      const d = new Date(ts).toISOString();
      const b = d.slice(0, 10) + (+d.slice(11, 13) < 12 ? "a" : "b");
      (tr[b] = tr[b] || []).push(pnl);
    }
    console.log("\nequite par tranche 12h :");
    let cum = 0;
    for (const b of Object.keys(tr).sort()) {
      const s = tr[b].reduce((a, x) => a + x, 0) * LEV * 100;
      cum += s;
      console.log("  " + b, ("D" + s.toFixed(1) + "%").padStart(9), ("cum " + cum.toFixed(1) + "%").padStart(12), "n" + tr[b].length);
    }
  }
}

// sensibilite couts x1,5
if (!process.env.COUT) {
  const { execFileSync } = require("child_process");
  console.log("\n--- sensibilite couts x1,5 (0,18 %) ---");
  const out = execFileSync(process.execPath, [__filename], { env: { ...process.env, COUT: "0.0018" }, encoding: "utf8" });
  console.log(out.split("\n").filter(l => l.includes("aout_") || l.includes("AOUT") || l.includes("EPOQUE") || l.includes("TOUT")).join("\n"));
}
