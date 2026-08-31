// ÉVALUATION FINALE CALIBRAGE — ITÉRATION 2 (directeur calibrage) — FORMULE FIGÉE avant
// toute lecture OOS/epoque2 (discipline : tools_fable_calib_NOTES.md, gel A5).
//
// FORMULE "CALIB-2" :
//   signal du moteur à score INVERSÉ, fenêtre de score 2 <= |score| < 2.5 (sévérité de base)
//   + filtre base 1 : volume bougie 5m du signal >= 2,5 x médiane 24h (lu à sa clôture)
//   + filtre base 2 : accord range-24h (achat si close < 50 % du range 24h, vente si > 50 %)
//   + filtre 3 : ret1h CONTRE le trade (achat si close_i/close_{i-12}-1 <= 0, vente si >= 0)
//   + filtre 4 : volume per-crypto — rang causal du volSpike parmi les signaux PRÉCÉDENTS
//     du même instrument >= p70 (fenêtre expansive ; inactif tant que < 20 obs)
//   ENTRÉE à l'OPEN de la bougie 5m SUIVANTE (zéro look-ahead) · verrou 12 h/instrument
//   sorties (% marge, levier 15) : tp 80 / sl 30 / trail act 20 cb 15 / hold 12 h · coûts 0,12 %
//
// Une commande : node tools_fable_calib_final2.js
const path = require("path");
const { chargerCorpus, evaluer, agg, LEV } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const EXC = { tp: 0.8, sl: 0.3, act: 0.2, cb: 0.15, holdH: 12 };
const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const contre = (nd, f) => (nd > 0 && f.ret1h <= 0) || (nd < 0 && f.ret1h >= 0);
const volOK = f => f.volSpike >= 2.5 && (f.volRankPrev < 0 || f.volRankPrev >= 0.7);
const dec = (d, s, f) => {
  const nd = -d;
  return s < 2.5 && volOK(f) && acc(nd, f.rangePos) && contre(nd, f) ? nd : 0;
};
const CANDIDAT = { nom: "FORMULE CALIB-2", lockHold: true, ex: EXC, exKey: "EXC", decide: dec };

function boot(l, it = 4000) {
  if (l.length < 10) return null;
  const n = l.length, means = [];
  for (let b = 0; b < it; b++) { let s = 0; for (let j = 0; j < n; j++) s += l[(Math.random() * n) | 0]; means.push(s / n); }
  means.sort((a, b) => a - b);
  return `IC90 [${(means[(it * 0.05) | 0] * LEV * 100).toFixed(2)}% ; ${(means[(it * 0.95) | 0] * LEV * 100).toFixed(2)}%]`;
}
const fmt = a => a && a.n ? `esp ${String(a.esp).padStart(7)}% · wr ${String(a.wr).padStart(5)}% · n ${String(a.n).padStart(4)}` : "—";

const { corpus, midAout } = chargerCorpus();
// rang volume per-crypto, causal (fenêtre expansive sur les signaux évaluables, ts croissant)
for (const inst of Object.values(corpus)) {
  const prev = [];
  for (const s of inst.sigs) {
    if (prev.length >= 20) { let lt = 0; for (const v of prev) if (v < s.f.volSpike) lt++; s.f.volRankPrev = lt / prev.length; }
    else s.f.volRankPrev = -1;
    prev.push(s.f.volSpike);
  }
}

const variantes = [
  CANDIDAT,
  { ...CANDIDAT, nom: "longs seuls", decide: (d, s, f) => { const nd = dec(d, s, f); return nd > 0 ? nd : 0; } },
  { ...CANDIDAT, nom: "shorts seuls", decide: (d, s, f) => { const nd = dec(d, s, f); return nd < 0 ? nd : 0; } },
  // lignes de CONSTAT (référence, non sélectionnées — décomposition marginale pour l'it3) :
  { nom: "réf CALIB-1 (it1, sans cap)", lockHold: true, ex: EXC, exKey: "EXC", decide: (d, s, f) => { const nd = -d; return volOK(f) && acc(nd, f.rangePos) && contre(nd, f) ? nd : 0; } },
  { nom: "réf ret1h seul (sans volRank/cap)", lockHold: true, ex: EXC, exKey: "EXC", decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) && contre(nd, f) ? nd : 0; } },
  { nom: "réf base V2 (boucle 2)", lockHold: true, ex: { tp: 0.8, sl: 0.3, act: 0.25, cb: 0.15, holdH: 12 }, exKey: "EXF", decide: (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) ? nd : 0; } },
];
const res = evaluer(corpus, midAout, variantes);
console.log("\n========== FORMULE CALIB-2 (tp80/sl30/act20/cb15/hold12 · verrou 12h · levier 15 · coûts 0,12 % · banc3 sans look-ahead) ==========");
console.log("INV 2<=s<2.5 · vol >= 2,5x méd24h ET rang per-crypto >= p70 (causal) · accord range moitiés · ret1h CONTRE · entrée open suivante\n");
const IS = res[0].aout_IS, OOS = res[0].aout_OOS, EP2 = res[0].epoque2;
console.log("aout_IS  (29/08 15:59 -> 30/08 12:34)   ", fmt(agg(IS)), " ", boot(IS));
console.log("aout_OOS (30/08 12:34 -> 31/08 10:54)   ", fmt(agg(OOS)), " ", boot(OOS));
const AOUT = IS.concat(OOS);
console.log("AOUT total                              ", fmt(agg(AOUT)), " ", boot(AOUT));
console.log("EPOQUE 2 (sept-oct 25 + fév 26)         ", fmt(agg(EP2)), " ", boot(EP2));
const TOUT = AOUT.concat(EP2);
console.log("TOUT (3 époques)                        ", fmt(agg(TOUT)), " ", boot(TOUT));
console.log("\ncôtés + constats de référence (non sélectionnés) :");
for (const k of [1, 2, 3, 4, 5])
  console.log("  " + variantes[k].nom.padEnd(34), ["aout_IS", "aout_OOS", "epoque2"].map(e => fmt(agg(res[k][e]))).join(" | "));

// cibles du mandat
{
  const a = agg(IS), b = agg(OOS), c = agg(EP2), n = a.n + b.n;
  const ok = a.wr >= 65 && b.wr >= 65 && a.esp >= 4 && b.esp >= 4 && n >= 120 && c.esp > 8 && c.n >= 60;
  console.log(`\nCIBLES : wrIS ${a.wr} (>=65 ${a.wr >= 65 ? "OK" : "RATE"}) · wrOOS ${b.wr} (>=65 ${b.wr >= 65 ? "OK" : "RATE"}) · espIS ${a.esp} espOOS ${b.esp} (>=4 ${a.esp >= 4 && b.esp >= 4 ? "OK" : "RATE"}) · n août ${n} (>=120 ${n >= 120 ? "OK" : "RATE"}) · ep2 esp ${c.esp} n ${c.n} (>8 & >=60 ${c.esp > 8 && c.n >= 60 ? "OK" : "RATE"}) => ${ok ? "TOUT OK" : "INCOMPLET"}`);
}

// sous-époques de l'époque 2
if (res[0]._ts) {
  const sub = { "sept-oct25": [], "fev26": [] };
  for (const [ts, pnl] of res[0]._ts) {
    if (ts >= Date.parse("2026-08-01")) continue;
    sub[ts >= Date.parse("2026-01-01") ? "fev26" : "sept-oct25"].push(pnl);
  }
  console.log("\nsous-époques :");
  for (const k in sub) console.log("  " + k.padEnd(12), fmt(agg(sub[k])), " ", boot(sub[k]) || "");
}

// concentration par instrument
{
  const resT = {};
  for (const [instId, inst] of Object.entries(corpus)) {
    const one = evaluer({ [instId]: inst }, midAout, [CANDIDAT]);
    const l = one[0].aout_IS.concat(one[0].aout_OOS, one[0].epoque2);
    if (l.length) resT[instId] = { n: l.length, tot: l.reduce((a, b) => a + b, 0) * LEV * 100 };
  }
  const rows = Object.entries(resT).sort((a, b) => Math.abs(b[1].tot) - Math.abs(a[1].tot));
  const totAll = rows.reduce((a, r) => a + r[1].tot, 0);
  console.log("\nconcentration (pnl total = " + totAll.toFixed(0) + " pts de marge, " + rows.length + " instruments) — top 8 :");
  for (const [id, v] of rows.slice(0, 8)) console.log("  " + id.padEnd(22), (v.tot > 0 ? "+" : "") + v.tot.toFixed(1) + " pts", "n" + v.n);
}

// sensibilité coûts x1,5
if (!process.env.COUT) {
  const { execFileSync } = require("child_process");
  console.log("\n--- sensibilité coûts x1,5 (0,18 %) ---");
  const out = execFileSync(process.execPath, [__filename], { env: { ...process.env, COUT: "0.0018" }, encoding: "utf8" });
  console.log(out.split("\n").filter(l => l.includes("aout_") || l.includes("AOUT") || l.includes("EPOQUE") || l.includes("TOUT")).join("\n"));
}
