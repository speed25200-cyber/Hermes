// TEMPO-RUPTURE (asymétrie de tempo sur zigzag adaptatif, lecture inversée) — MUBARAK (memecoin BNB)
// L'indicateur : un zigzag CAUSAL dont le seuil de retournement s'adapte à la crypto
// (X_i = 3 × SMA288(|rendement 5m|), borné [0,2 %, 6 %]) découpe le prix en « jambes » ;
// sur les 6 dernières jambes finies on compare le TEMPS passé à monter au temps passé à descendre.
// Lecture (rupture) : si le marché a passé >= 2× plus de temps à monter qu'à descendre et qu'une
// jambe de baisse ÉCLAIR vient d'être confirmée -> SHORT sur le rebond réflexe : la chute rapide a
// cassé le tempo du grind haussier (les memecoins ne purgent pas, elles basculent) ; miroir en long.
// Signal à la bougie de CONFIRMATION du pivot (retrace X sur clôture) — zéro look-ahead.
const K = 3;        // seuil zigzag en unités de vol propre
const R = 2;        // asymétrie de tempo requise (2:1)
const V = 288;      // fenêtre vol 24 h
const NLEGS = 6;    // jambes comparées
const MODE = -1;     // +1 = lecture continuation (std), -1 = lecture rupture (inv)

function zigzagAdapt(c5, k) {
  const evts = []; const legs = [];
  let sum = 0; const rets = [];
  let dir = 0, extP = c5[0][4], extI = 0, pivP = c5[0][4], pivI = 0;
  for (let i = 1; i < c5.length; i++) {
    const cl = c5[i][4], pv = c5[i - 1][4];
    const r = Math.abs(pv > 0 ? cl / pv - 1 : 0);
    rets.push(r); sum += r; if (rets.length > V) sum -= rets[rets.length - 1 - V];
    const nV = Math.min(rets.length, V);
    const X = Math.min(0.06, Math.max(0.002, k * (sum / nV)));
    if (i < V) { // warm-up : on suit seulement les extrêmes
      if (dir >= 0 && cl > extP) { extP = cl; extI = i; }
      if (dir < 0 && cl < extP) { extP = cl; extI = i; }
      continue;
    }
    if (dir >= 0) {
      if (cl > extP) { extP = cl; extI = i; }
      if (cl <= extP * (1 - X)) {
        if (dir > 0) {
          const dur = Math.max(1, extI - pivI); const ampl = extP / pivP - 1;
          legs.push({ dir: 1, ampl, dur, slope: ampl / dur, endI: extI });
          evts.push({ i, legsLen: legs.length });
        }
        pivP = extP; pivI = extI; dir = -1; extP = cl; extI = i;
        for (let j = pivI + 1; j <= i; j++) { if (c5[j][4] < extP) { extP = c5[j][4]; extI = j; } }
        continue;
      }
      if (dir === 0 && cl >= extP * (1 + X)) { dir = 1; }
    }
    if (dir < 0) {
      if (cl < extP) { extP = cl; extI = i; }
      if (cl >= extP * (1 + X)) {
        const dur = Math.max(1, extI - pivI); const ampl = pivP > 0 ? extP / pivP - 1 : 0;
        legs.push({ dir: -1, ampl, dur, slope: Math.abs(ampl) / dur, endI: extI });
        evts.push({ i, legsLen: legs.length });
        pivP = extP; pivI = extI; dir = 1; extP = cl; extI = i;
        for (let j = pivI + 1; j <= i; j++) { if (c5[j][4] > extP) { extP = c5[j][4]; extI = j; } }
      }
    }
    if (dir === 0) { dir = 1; }
  }
  return { evts, legs };
}

module.exports = {
  instId: "MUBARAK-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const { evts, legs } = zigzagAdapt(c5, K);
    const out = [];
    for (const e of evts) {
      const n = e.legsLen; if (n < 9) continue;
      const i = e.i; if (i < 300 || i >= c5.length - 2) continue;
      const six = legs.slice(n - NLEGS, n); const L0 = legs[n - 1];
      let du = 0, dd = 0; for (const l of six) { if (l.dir > 0) du += l.dur; else dd += l.dur; }
      if (!(du > 0 && dd > 0)) continue;
      const rat = du / dd;
      let d = 0;
      if (rat >= R && L0.dir === -1) d = 1;
      else if (rat <= 1 / R && L0.dir === 1) d = -1;
      d *= MODE;
      if (d) out.push({ i5: i, dir: d });
    }
    return out;
  }
};
