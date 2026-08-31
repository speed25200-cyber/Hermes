// ÉVALUATION FINALE V2 — "ancienne stratégie, meilleure version" (itération 2, look-ahead corrigé).
//
// FORMULE FIGÉE :
//   signal du moteur à score INVERSÉ (|score|>=2, dir non-null)
//   + filtre 1 : volume de la bougie 5m du signal >= 2,5 x médiane 24h (288 bougies), lu à sa CLÔTURE
//   + filtre 2 : accord range-24h : achat (inverse) seulement si close < 50 % du range 24h, vente si > 50 %
//   ENTRÉE : à l'OPEN de la bougie 5m SUIVANTE (premier prix strictement postérieur à toute l'info utilisée)
//   verrou : 1 entrée max par instrument par 12 h (depuis l'entrée)
//   sorties (% de marge, levier 15) : tp 80 / sl 30 / trail act 25 cb 15 / hold 12 h · coûts 0,12 %
//
// Une commande : node tools_fable_ancienne_final2.js
const path = require("path");
const { chargerCorpus, evaluer, agg, LEV } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const acc = (nd, p) => (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5);
const EXF = { tp: 0.80, sl: 0.30, act: 0.25, cb: 0.15, holdH: 12 };
const dec = (d, s, f) => { const nd = -d; return f.volSpike >= 2.5 && acc(nd, f.rangePos) ? nd : 0; };
const CANDIDAT = { nom: "FORMULE FINALE V2", lockHold: true, ex: EXF, exKey: "EXF", decide: dec };

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
  CANDIDAT,
  { nom: "longs seuls", lockHold: true, ex: EXF, exKey: "EXF", decide: (d, s, f) => { const nd = dec(d, s, f); return nd > 0 ? nd : 0; } },
  { nom: "shorts seuls", lockHold: true, ex: EXF, exKey: "EXF", decide: (d, s, f) => { const nd = dec(d, s, f); return nd < 0 ? nd : 0; } },
  // contrôles de direction sur les MÊMES entrées (vol>=2.5)
  { nom: "ctrl: dir = pure range (ignore signal)", lockHold: true, ex: EXF, exKey: "EXF", decide: (d, s, f) => f.volSpike >= 2.5 ? (f.rangePos < 0.5 ? 1 : -1) : 0 },
  { nom: "ctrl: dir = +signal si accord (anti)", lockHold: true, ex: EXF, exKey: "EXF", decide: (d, s, f) => f.volSpike >= 2.5 && acc(d, f.rangePos) ? d : 0 },
];
const res = evaluer(corpus, midAout, variantes);
console.log("\n============== FORMULE FINALE V2 (tp80/sl30/act25/cb15/hold12 · verrou 12h · levier 15 · coûts 0,12 %) ==============");
console.log("signal INVERSÉ · vol5m >= 2,5x méd24h · accord range-24h · ENTRÉE À L'OPEN DE LA BOUGIE SUIVANTE (sans look-ahead)\n");
const IS = res[0].aout_IS, OOS = res[0].aout_OOS, EP2 = res[0].epoque2;
console.log("aout_IS  (29/08 15:59 -> 30/08 12:34)   ", fmt(agg(IS)), " ", boot(IS));
console.log("aout_OOS (30/08 12:34 -> 31/08 10:54)   ", fmt(agg(OOS)), " ", boot(OOS));
const AOUT = IS.concat(OOS);
console.log("AOUT total                              ", fmt(agg(AOUT)), " ", boot(AOUT));
console.log("EPOQUE 2 (sept-oct 25 + fév 26)         ", fmt(agg(EP2)), " ", boot(EP2));
const TOUT = AOUT.concat(EP2);
console.log("TOUT (3 époques)                        ", fmt(agg(TOUT)), " ", boot(TOUT));
console.log("\ncôtés + contrôles de direction :");
for (const k of [1, 2, 3, 4])
  console.log("  " + variantes[k].nom.padEnd(38), ["aout_IS", "aout_OOS", "epoque2"].map(e => fmt(agg(res[k][e]))).join(" | "));

// ---- sous-époques de l'époque 2 (sept-oct 25 vs fév 26) via _ts
if (res[0]._ts) {
  const sub = { "sept-oct25": [], "fev26": [] };
  for (const [ts, pnl] of res[0]._ts) {
    if (ts >= Date.parse("2026-08-01")) continue;
    sub[ts >= Date.parse("2026-01-01") ? "fev26" : "sept-oct25"].push(pnl);
  }
  console.log("\nsous-époques :");
  for (const k in sub) console.log("  " + k.padEnd(12), fmt(agg(sub[k])), " ", boot(sub[k]) || "");
}

// ---- concentration par instrument
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

// ---- sensibilité coûts x1,5
if (!process.env.COUT) {
  const { execFileSync } = require("child_process");
  console.log("\n--- sensibilité coûts x1,5 (0,18 %) ---");
  const out = execFileSync(process.execPath, [__filename, "resume"], { env: { ...process.env, COUT: "0.0018" }, encoding: "utf8" });
  console.log(out.split("\n").filter(l => l.includes("aout_") || l.includes("AOUT") || l.includes("EPOQUE") || l.includes("TOUT")).join("\n"));
}

// ---- plateau officiel (résumé)
if (!process.argv.includes("resume")) {
  console.log("\n--- plateau (esp% IS | OOS | ep2) ---");
  const vs = [];
  for (const V of [2, 2.5, 3])
    for (const act of [0.2, 0.25, 0.3])
      for (const cb of [0.1, 0.15, 0.2]) {
        const ex = { ...EXF, act, cb };
        vs.push({ nom: `vol>=${V} act${act} cb${cb}`, lockHold: true, ex, exKey: JSON.stringify(ex), decide: (d, s, f) => { const nd = -d; return f.volSpike >= V && acc(nd, f.rangePos) ? nd : 0; } });
      }
  const rp = evaluer(corpus, midAout, vs);
  let pos = 0;
  vs.forEach((V, k) => {
    const a = agg(rp[k].aout_IS), b = agg(rp[k].aout_OOS), c = agg(rp[k].epoque2);
    if (a.esp > 0 && b.esp > 0 && c.esp > 0) pos++;
    console.log("  " + V.nom.padEnd(26), `${String(a.esp).padStart(6)} | ${String(b.esp).padStart(6)} | ${String(c.esp).padStart(6)}`);
  });
  console.log(`  -> ${pos}/${vs.length} cellules positives sur les 3 splits`);

  // ---- équité par tranche 12h (formule centrale)
  if (res[0]._ts) {
    const tr = {};
    for (const [ts, pnl] of res[0]._ts) {
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
