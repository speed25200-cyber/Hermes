// MODULE OMBRE V2 — "ancienne stratégie, meilleure version" (itération 2, look-ahead corrigé).
// Trade PAPIER uniquement : aucun ordre, aucun appel privé. Journalise dans data/ombre-ancienne-v2.jsonl.
//
// FORMULE FIGÉE V2 (banc : tools_fable_ancienne_final2.js — août IS +6,23 %/57,1 % n161,
// août OOS +7,35 %/65,2 % n132, époque 2 +17,22 %/80,6 % n134, plateau 26/27) :
//   signal du moteur à score INVERSÉ (|score|>=2, dir non-null)
//   + volume de la bougie 5m du signal >= 2,5 x médiane 24h (288 bougies), lu à sa clôture
//   + accord range-24h : achat (inverse) seulement si close < 50 % du range 24h, vente si > 50 %
//   ENTRÉE : à l'OPEN de la bougie 5m SUIVANTE — en live : dès le premier update de la nouvelle
//     bougie (données de décision = bougie close uniquement, prix d'entrée = open de la nouvelle).
//   verrou : 1 entrée max par instrument par 12 h (depuis l'entrée)
//   sorties (% de marge, levier 15) : tp 80 / sl 30 / trail act 25 cb 15 / hold 12 h · coûts 0,12 %
//
// Branchement dans app/main.js (2 lignes, seulement avec accord client) :
//   const ombre2 = require("../lab_vagues/tools_fable_ancienne_ombre2.js");
//   1) dans onCandleClose, juste après computeScore :   ombre2.onSignal(instId, dir, score);
//   2) dans le handler WS candle5m (MARKET.bars5m...) : ombre2.onBar5m(m.arg.instId, m.data[0]);
const fs = require("fs");
const path = require("path");

const LEV = 15, COUT_PX = 0.0012, STEP = 300000;
const EX = { tp: 0.80, sl: 0.30, act: 0.25, cb: 0.15, holdMs: 12 * 3600e3 };
const VOL_X = 2.5, RANGE_MID = 0.5, LOCK_MS = 12 * 3600e3, HIST = 288;
const FICHIER = path.join(__dirname, "..", "data", "ombre-ancienne-v2.jsonl");

const S = { bars: {}, cur: {}, lastSig: {}, lockUntil: {}, pos: {}, stats: { n: 0, w: 0, sum: 0 } };

function ecrire(o) { try { fs.appendFileSync(FICHIER, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n"); } catch {} }

/* --- flux 1 : signaux du moteur à score (toutes les 15 s par instrument) --- */
function onSignal(instId, dir, score) {
  if (!dir || Math.abs(score) < 2) return;
  S.lastSig[instId] = { dir: dir === "long" || dir > 0 ? 1 : -1, ts: Date.now() };
}

/* --- flux 2 : bougies 5m OKX (updates partiels ; la clôture = changement de ts) --- */
function onBar5m(instId, row) {
  const ts = +row[0];
  if (!Number.isFinite(ts)) return;
  const b = { ts, o: +row[1], h: +row[2], l: +row[3], c: +row[4], vol: +row[5] };
  const cur = S.cur[instId];
  if (cur && cur.ts !== ts) barClose(instId, cur, b); // cur vient de clore ; b = nouvelle bougie (b.o = prix d'entrée)
  S.cur[instId] = b;
}

function barClose(instId, b, nouvelle) {
  const arr = S.bars[instId] = S.bars[instId] || [];
  if (arr.length && b.ts <= arr[arr.length - 1].ts) return;
  arr.push(b);
  if (arr.length > HIST + 1) arr.shift();

  gererPosition(instId, b);

  // entrée ombre : signal tombé PENDANT la bougie qui vient de clore + filtres + verrou
  const sig = S.lastSig[instId];
  if (!sig || sig.ts < b.ts || sig.ts >= b.ts + STEP) return;
  if (arr.length < HIST || S.pos[instId] || Date.now() < (S.lockUntil[instId] || 0)) return;
  if (arr[arr.length - HIST].ts !== b.ts - (HIST - 1) * STEP) return; // historique troué
  if (!nouvelle || nouvelle.ts !== b.ts + STEP) return;               // pas de bougie d'entrée contiguë
  const fen = arr.slice(-HIST);
  const vols = fen.map(x => x.vol).sort((a, z) => a - z);
  const med = (vols[HIST / 2 - 1] + vols[HIST / 2]) / 2;
  if (!(med > 0) || b.vol / med < VOL_X) return;
  let hh = -Infinity, ll = Infinity;
  for (const x of fen) { if (x.h > hh) hh = x.h; if (x.l < ll) ll = x.l; }
  const p = hh > ll ? (b.c - ll) / (hh - ll) : 0.5;
  const nd = -sig.dir;
  if (!((nd > 0 && p < RANGE_MID) || (nd < 0 && p > RANGE_MID))) return;

  const entry = nouvelle.o; // OPEN de la bougie suivante = premier prix postérieur à l'info de décision
  S.lockUntil[instId] = Date.now() + LOCK_MS;
  S.pos[instId] = {
    dir: nd, entry, best: entry, t0: Date.now(),
    sl: nd > 0 ? entry * (1 - EX.sl / LEV) : entry * (1 + EX.sl / LEV),
    tp: nd > 0 ? entry * (1 + EX.tp / LEV) : entry * (1 - EX.tp / LEV)
  };
  ecrire({ event: "SHADOW_OPEN", instId, dir: nd > 0 ? "long" : "short", px: entry, volX: +(b.vol / med).toFixed(2), rangePos: +p.toFixed(3) });
}

/* --- gestion de la position papier sur chaque bougie 5m close (pire-cas : SL avant TP) --- */
function gererPosition(instId, b) {
  const P = S.pos[instId];
  if (!P) return;
  const d = P.dir;
  let exitPx = null, raison = null;
  if (d > 0 ? b.l <= P.sl : b.h >= P.sl) { exitPx = P.sl; raison = "SL/TRAIL"; }
  else if (d > 0 ? b.h >= P.tp : b.l <= P.tp) { exitPx = P.tp; raison = "TP"; }
  else {
    if (d > 0 ? b.c > P.best : b.c < P.best) P.best = b.c;
    if ((d > 0 ? P.best / P.entry - 1 : 1 - P.best / P.entry) >= EX.act / LEV) {
      const t = d > 0 ? P.best * (1 - EX.cb / LEV) : P.best * (1 + EX.cb / LEV);
      if (d > 0 ? t > P.sl : t < P.sl) P.sl = t;
    }
    if (Date.now() - P.t0 >= EX.holdMs) { exitPx = b.c; raison = "HOLD"; }
  }
  if (exitPx == null) return;
  const pnl = ((d > 0 ? exitPx / P.entry - 1 : 1 - exitPx / P.entry) - COUT_PX) * LEV * 100; // % de marge
  delete S.pos[instId];
  S.stats.n++; if (pnl > 0) S.stats.w++; S.stats.sum += pnl;
  ecrire({ event: "SHADOW_CLOSE", instId, raison, entry: P.entry, exit: exitPx, pnlMargePct: +pnl.toFixed(2) });
  ecrire({ event: "SHADOW_STATS", n: S.stats.n, wr: +(100 * S.stats.w / S.stats.n).toFixed(1), espPct: +(S.stats.sum / S.stats.n).toFixed(2) });
}

module.exports = { onSignal, onBar5m };
