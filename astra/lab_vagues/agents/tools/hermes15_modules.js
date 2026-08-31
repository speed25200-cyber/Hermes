// Recréation des 9 stratégies HERMES 15 « survivantes » (STRATEGIES_GROS_TP_2026-08-30.md :
// ENSO, GRASS, SOON, LUNA, NES, MEGA, MANA, GPS, AXS) à partir de leurs configs retenues
// dans lab_vagues/profond2_resultats.json (champ retenue.sig + retenue.ex).
// La logique des signaux est la COPIE EXACTE de lab_vagues/profond2.js (générateur d'origine),
// pour que le banc 30 j reproduise les espérances publiées au centime (vérifié par tools/risque.js).
// hold profond2 en bougies 5 m (144 = 12 h, 288 = 24 h) -> holdH du harness (12 / 24).

// ---- primitives copiées de profond2.js ----
function aggreger(c5, mult) {
  const out = [];
  for (let i = 0; i + mult <= c5.length; i += mult) {
    let o = c5[i][1], h = -Infinity, l = Infinity, v = 0;
    for (let k = i; k < i + mult; k++) { h = Math.max(h, c5[k][2]); l = Math.min(l, c5[k][3]); v += c5[k][5]; }
    out.push([c5[i][0], o, h, l, c5[i + mult - 1][4], v, i + mult - 1]);
  }
  return out;
}
function frame5m(c5) { return c5.map((x, i) => [...x.slice(0, 6), i]); }
function rsi(closes, p = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, pr = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (i <= p) { if (d > 0) g += d; else pr -= d; if (i === p) out[i] = 100 - 100 / (1 + (g / p) / ((pr / p) || 1e-12)); continue; }
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    pr = (pr * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = 100 - 100 / (1 + g / (pr || 1e-12));
  }
  return out;
}
function smaStd(closes, p) {
  const sma = new Array(closes.length).fill(null), std = new Array(closes.length).fill(null);
  let s = 0, s2 = 0;
  for (let i = 0; i < closes.length; i++) {
    s += closes[i]; s2 += closes[i] * closes[i];
    if (i >= p) { const x = closes[i - p]; s -= x; s2 -= x * x; }
    if (i >= p - 1) { const m = s / p; sma[i] = m; std[i] = Math.sqrt(Math.max(0, s2 / p - m * m)); }
  }
  return { sma, std };
}

// ---- générateurs de signaux (identiques à profond2.js, frame passée en argument) ----
function sigRsi(F, seuil) {
  const closes = F.map(x => x[4]);
  const r = rsi(closes);
  return F.map((x, i) => r[i] == null ? null :
    (r[i] < seuil ? { i5: x[6], dir: 1 } : (r[i] > 100 - seuil ? { i5: x[6], dir: -1 } : null))).filter(Boolean);
}
function sigZscore(F, p, z) {
  const closes = F.map(x => x[4]);
  const { sma, std } = smaStd(closes, p);
  return F.map((x, i) => (sma[i] == null || !std[i]) ? null :
    ((closes[i] - sma[i]) / std[i] > z ? { i5: x[6], dir: -1 } :
      ((closes[i] - sma[i]) / std[i] < -z ? { i5: x[6], dir: 1 } : null))).filter(Boolean);
}
function sigRunFade(F, runN) {
  const list = [];
  let run = 0, sgn = 0;
  for (let i = 1; i < F.length; i++) {
    const d = Math.sign(F[i][4] - F[i - 1][4]);
    if (d !== 0 && d === sgn) run++; else { run = 1; sgn = d; }
    if (run >= runN && sgn !== 0) list.push({ i5: F[i][6], dir: -sgn });
  }
  return list;
}
function sigMeche(F) {
  const list = [];
  for (let i = 30; i < F.length; i++) {
    const [, o, h, l, cl, v] = F[i];
    const corps = Math.abs(cl - o), haut = h - Math.max(o, cl), bas = Math.min(o, cl) - l;
    let mv = 0; const from = Math.max(0, i - 30);
    for (let k = from; k < i; k++) mv += F[k][5];
    mv /= (i - from);
    if (v > 2 * mv && haut > 2 * corps && haut > 0.004 * cl) list.push({ i5: F[i][6], dir: -1 });
    if (v > 2 * mv && bas > 2 * corps && bas > 0.004 * cl) list.push({ i5: F[i][6], dir: 1 });
  }
  return list;
}

// ---- les 9 survivantes (retenue.sig + retenue.ex de profond2_resultats.json) ----
const CONFIGS = {
  ENSO: { instId: "ENSO-USDT-SWAP", sig: "RSI14-5m <25/>75", exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 }, detect: c5 => sigRsi(frame5m(c5), 25) },
  GRASS: { instId: "GRASS-USDT-SWAP", sig: "zScore-SMA48-5m |z|>2.5", exits: { tp: 0.60, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 }, detect: c5 => sigZscore(frame5m(c5), 48, 2.5) },
  SOON: { instId: "SOON-USDT-SWAP", sig: "zScore-SMA48-5m |z|>2.5", exits: { tp: 0.80, sl: 0.30, act: 0.20, cb: 0.05, holdH: 12 }, detect: c5 => sigZscore(frame5m(c5), 48, 2.5) },
  LUNA: { instId: "LUNA-USDT-SWAP", sig: "5 bougies 5m (fade)", exits: { tp: 0.40, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 }, detect: c5 => sigRunFade(frame5m(c5), 5) },
  NES: { instId: "NES-USDT-SWAP", sig: "mèche épuisement 15m + vol 2x", exits: { tp: 0.80, sl: 0.30, act: 0.20, cb: 0.05, holdH: 12 }, detect: c5 => sigMeche(aggreger(c5, 3)) },
  MEGA: { instId: "MEGA-USDT-SWAP", sig: "5 bougies 5m (fade)", exits: { tp: 0.40, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 }, detect: c5 => sigRunFade(frame5m(c5), 5) },
  MANA: { instId: "MANA-USDT-SWAP", sig: "5 bougies 5m (fade)", exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 12 }, detect: c5 => sigRunFade(frame5m(c5), 5) },
  GPS: { instId: "GPS-USDT-SWAP", sig: "mèche épuisement 5m + vol 2x", exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 }, detect: c5 => sigMeche(frame5m(c5)) },
  AXS: { instId: "AXS-USDT-SWAP", sig: "5 bougies 5m (fade)", exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 }, detect: c5 => sigRunFade(frame5m(c5), 5) }
};

// Référence à reproduire (profond2_resultats.json, retenue.A.esp / retenue.B.esp) pour contrôle.
const REFERENCE = {
  ENSO: { espIS: 7.64, espOOS: 7.95 }, GRASS: { espIS: 7.39, espOOS: 7.46 },
  SOON: { espIS: 6.68, espOOS: 7.6 }, LUNA: { espIS: 7.27, espOOS: 6.19 },
  NES: { espIS: 9.34, espOOS: 10.12 }, MEGA: { espIS: 5.69, espOOS: 7.88 },
  MANA: { espIS: 6.57, espOOS: 6.76 }, GPS: { espIS: 8.78, espOOS: 15.11 },
  AXS: { espIS: 6.79, espOOS: 10.68 }
};

const modules = {};
for (const [nom, cfg] of Object.entries(CONFIGS))
  modules[nom] = { instId: cfg.instId, exits: cfg.exits, detect: cfg.detect, _sig: cfg.sig };

module.exports = { modules, REFERENCE, CONFIGS, aggreger, frame5m, sigRsi, sigZscore, sigRunFade, sigMeche };
