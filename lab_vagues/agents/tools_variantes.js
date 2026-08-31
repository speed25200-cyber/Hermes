// Optimisation des SORTIES des 51 modules candidats : signal inchangé, 24 variantes
// d'enveloppe (tp × activation trail × durée) + la version d'origine, banc 30 j IS/OOS.
// ⚠️ Une variante qui bat l'origine devra REPASSER le test 60 j vierges (sélection = biais).
const fs = require("fs");
const path = require("path");
const { chargerCandles, sim, agg } = require("./harness_lib.js");

const CAND = path.join(__dirname, "candidates");
const OOS_JOURS = 10;

const GRID = [];
for (const tp of [0.40, 0.60, 0.80])
  for (const act of [0.10, 0.20, 0.30])
    for (const holdH of [12, 24])
      GRID.push({ tp, sl: 0.30, act, cb: 0.05, holdH });

function evalSignals(c5, sigs, ex) {
  const tOOS = c5[c5.length - 1][0] - OOS_JOURS * 86400 * 1000;
  const is = [], oos = [];
  let busy = -1;
  for (const s of sigs) {
    if (s.i5 <= busy || s.i5 >= c5.length - 2 || !s.dir) continue;
    const t = sim(c5, s.i5, s.dir, ex);
    busy = s.i5 + t.dur;
    (c5[s.i5][0] >= tOOS ? oos : is).push(t);
  }
  return { A: agg(is), B: agg(oos) };
}

const rows = [];
for (const f of fs.readdirSync(CAND).filter(x => x.endsWith(".js"))) {
  try {
    const mod = require(path.join(CAND, f));
    if (!mod.instId || typeof mod.detect !== "function") continue;
    const c5 = chargerCandles("data", mod.instId);
    const sigs = (mod.detect(c5) || []).sort((a, b) => a.i5 - b.i5);
    if (sigs.length < 20) continue;

    const evalue = (ex) => {
      const r = evalSignals(c5, sigs, ex);
      if (!r.A || !r.B || r.A.n + r.B.n < 60 || r.B.n < 15) return null;
      return { ex, espIS: r.A.esp, espOOS: r.B.esp, worst: Math.min(r.A.esp, r.B.esp),
               wrIS: r.A.wr, wrOOS: r.B.wr, n: r.A.n + r.B.n, pfOOS: r.B.pf };
    };
    const base = evalue(mod.exits);
    let best = base;
    for (const ex of GRID) {
      const v = evalue(ex);
      if (v && (!best || v.worst > best.worst)) best = v;
    }
    if (!best) continue;
    rows.push({
      module: f, instId: mod.instId.replace("-USDT-SWAP", ""),
      origine: base ? { worst: base.worst, espIS: base.espIS, espOOS: base.espOOS } : null,
      optim: best,
      gain: (base && best) ? +(best.worst - base.worst).toFixed(2) : null,
      change: base && best && best.ex !== base.ex
    });
  } catch (e) { rows.push({ module: f, erreur: e.message.slice(0, 60) }); }
}

const ok = rows.filter(r => r.optim).sort((a, b) => b.optim.worst - a.optim.worst);
fs.writeFileSync(path.join(__dirname, "variantes_resultats.json"), JSON.stringify(rows, null, 1));
console.log("modules évalués:", rows.length, "· exploitables:", ok.length, "· erreurs:", rows.filter(r => r.erreur).length);
console.log("\n=== TOP 20 APRÈS OPTIMISATION DES SORTIES (classé par le PIRE des 2 périodes) ===");
for (const r of ok.slice(0, 20)) {
  const o = r.optim;
  console.log(
    r.instId.padEnd(8),
    ("worst " + o.worst).padEnd(13),
    ("IS/OOS " + o.espIS + "/" + o.espOOS + "%").padEnd(20),
    ("wr " + o.wrOOS + "%").padEnd(9),
    ("n=" + o.n).padEnd(7),
    ("TP+" + o.ex.tp * 100 + " act+" + (o.ex.act * 100) + " " + o.ex.holdH + "h").padEnd(20),
    (r.origine ? "origine " + r.origine.worst + (r.gain > 0.005 ? " (+" + r.gain + ")" : " (=)") : "origine invalide"),
    "·", r.module
  );
}
