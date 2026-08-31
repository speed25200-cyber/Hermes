// MUR — ÉLASTICITÉ PRIX-VOLUME (invention) — BICO (Biconomy), lecture MUR MANGÉ (percée).
// CR (Collapse Ratio) = élasticité de la fenêtre (Σ|Δclose| / Σvol sur W=3 bougies)
// rapportée à l'élasticité des 288 bougies AVANT la fenêtre. Zéro look-ahead.
// Lecture (2 phrases) : sur BICO, quand le CR se RÉVEILLE (repasse au-dessus de 0,5 après une
// bougie effondrée à volume chargé) alors qu'un mouvement fort (>= 2 x bruit x sqrt(12)) poussait
// dessus, le mur vient d'être MANGÉ -> on SUIT la percée (continuation du mouvement).
const W = 3;        // fenêtre du mur (15 min)
const R = 0.5;      // seuil d'effondrement de l'élasticité
const Q = 1.0;      // charge mini en volume de la fenêtre effondrée (x moyenne 24 h)
const A = 2;        // approche mini en unités de bruit (x mean|d5m| x sqrt(L))
const L = 4 * W;    // fenêtre du mouvement d'approche
const N_BASE = 288; // référence : 24 h avant la fenêtre
const WARM = 500;

function series(c5) {
  const n = c5.length;
  const PD = new Float64Array(n + 1), PV = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    PD[i + 1] = PD[i] + (i > 0 ? Math.abs(c5[i][4] - c5[i - 1][4]) : 0);
    PV[i + 1] = PV[i] + (+c5[i][5] || 0);
  }
  const CR = new Float64Array(n).fill(NaN), VC = new Float64Array(n).fill(NaN), NOISE = new Float64Array(n).fill(NaN);
  for (let i = N_BASE + W + 1; i < n; i++) {
    const dispW = PD[i + 1] - PD[i + 1 - W], volW = PV[i + 1] - PV[i + 1 - W];
    const dispB = PD[i + 1 - W] - PD[i + 1 - W - N_BASE], volB = PV[i + 1 - W] - PV[i + 1 - W - N_BASE];
    if (volW > 0 && volB > 0 && dispB > 0) {
      CR[i] = (dispW / volW) / (dispB / volB);
      VC[i] = (volW / W) / (volB / N_BASE);
      NOISE[i] = dispB / N_BASE;
    }
  }
  return { CR, VC, NOISE };
}

module.exports = {
  instId: "BICO-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  detect(c5) {
    const { CR, VC, NOISE } = series(c5);
    const sqL = Math.sqrt(L), out = [];
    for (let i = WARM; i < c5.length - 2; i++) {
      const cr = CR[i], crp = CR[i - 1], vc = VC[i - 1];
      if (Number.isNaN(cr) || Number.isNaN(crp) || Number.isNaN(vc)) continue;
      if (!(cr > R && crp <= R && vc >= Q)) continue;   // le CR se réveille après effondrement chargé
      const app = c5[i][4] - c5[i - L][4];
      const th = A * NOISE[i] * sqL;
      if (!(Math.abs(app) >= th) || th <= 0) continue;  // un mouvement fort poussait sur le mur
      out.push({ i5: i, dir: app > 0 ? 1 : -1 });       // le mur est mangé : continuation
    }
    return out;
  }
};
