// Vérification de plateau autour de la formule candidate V2 (banc3, exécution honnête) :
//   INV + vol>=2.5 + accord range-24h (0.5) · entrée open bougie suivante · verrou 12h
//   exits tp0.8 sl0.3 act0.2 cb0.15 hold12 · levier 15 · coûts 0.12 %
// Chaque bloc fait varier UN axe, le reste figé. Usage : node tools_fable_ancienne_plateau3.js
const path = require("path");
const { chargerCorpus, evaluer, agg } = require(path.join(__dirname, "tools_fable_ancienne_banc3.js"));

const EX0 = { tp: 0.8, sl: 0.3, act: 0.2, cb: 0.15, holdH: 12 };
const mk = (nom, opts) => {
  const V = Math.abs(opts.vol ?? 2.5), lo = opts.lo ?? 0.5, hi = opts.hi ?? 0.5;
  const ex = { ...EX0, ...(opts.ex || {}) };
  const side = opts.side || 0;
  return {
    nom, ex, exKey: JSON.stringify(ex),
    ...(opts.lock === "cool3h" ? { cooldown: 36 } : { lockHold: true }),
    delay: opts.delay || 0,
    decide: (d, s, f) => {
      const nd = -d;
      if (side && nd !== side) return 0;
      return f.volSpike >= V && ((nd > 0 && f.rangePos < lo) || (nd < 0 && f.rangePos > hi)) ? nd : 0;
    }
  };
};

const variantes = [
  mk("CENTRE  vol2.5 r0.5 act.2 cb.15 tp.8 h12", {}),
  // axe volume
  mk("  vol 2.0", { vol: 2 }),
  mk("  vol 3.0", { vol: 3 }),
  // axe range
  mk("  range 0.4/0.6", { lo: 0.4, hi: 0.6 }),
  mk("  range 0.45/0.55", { lo: 0.45, hi: 0.55 }),
  // axe act
  mk("  act 0.15", { ex: { act: 0.15 } }),
  mk("  act 0.25", { ex: { act: 0.25 } }),
  mk("  act 0.30", { ex: { act: 0.3 } }),
  // axe cb
  mk("  cb 0.10", { ex: { cb: 0.10 } }),
  mk("  cb 0.20", { ex: { cb: 0.20 } }),
  // axe tp
  mk("  tp 0.6", { ex: { tp: 0.6 } }),
  mk("  tp 1.2", { ex: { tp: 1.2 } }),
  // axe sl
  mk("  sl 0.25", { ex: { sl: 0.25 } }),
  mk("  sl 0.20", { ex: { sl: 0.20 } }),
  // axe hold
  mk("  hold 6h", { ex: { holdH: 6 } }),
  mk("  hold 24h", { ex: { holdH: 24 } }),
  // verrou
  mk("  lock cool3h", { lock: "cool3h" }),
  // délai d'entrée (+1 bougie)
  mk("  delay +1 bougie", { delay: 1 }),
  mk("  delay +2 bougies", { delay: 2 }),
  // côtés
  mk("  LONGS seuls", { side: 1 }),
  mk("  SHORTS seuls", { side: -1 }),
];

const { corpus, midAout } = chargerCorpus();
const res = evaluer(corpus, midAout, variantes);
console.log("\nformat esp%/wr%/n");
console.log("variante".padEnd(44), "aout_IS".padStart(16), "aout_OOS".padStart(18), "epoque2".padStart(18));
variantes.forEach((V, k) => {
  const a = agg(res[k].aout_IS), b = agg(res[k].aout_OOS), c = agg(res[k].epoque2);
  const f = x => x.n ? `${x.esp}/${x.wr}/${x.n}` : "—";
  console.log(V.nom.padEnd(44), f(a).padStart(16), f(b).padStart(18), f(c).padStart(18));
});
