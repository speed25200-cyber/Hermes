// fableD_ombre_inverse.js — MODE OMBRE de « l'ancienne stratégie » (signal du moteur à score INVERSÉ).
// Boucle Fable n°2 — angle 3 (déploiement). Trades PAPIER uniquement :
//   - aucun ordre, aucun appel privé OKX, aucune écriture dans AI.* / MARKET.* ;
//   - journal : data/ombre-inverse.jsonl (événements OMBRE_BOOT / OMBRE_OPEN / OMBRE_TRAIL /
//     OMBRE_CLOSE / OMBRE_STATS) ;
//   - état persistant : au restart, les positions papier ouvertes et les verrous 12 h sont
//     restaurés depuis le journal (les positions reprennent à la bougie suivante, flag reprise).
//
// FORMULE (sémantique IDENTIQUE au banc v3, zéro look-ahead — vérifiée par
// lab_vagues/fableD_replay_test.js qui rejoue le banc trade par trade) :
//   signal moteur à score |score| >= 2, dir non-null, INVERSÉ
//   + volume de la bougie 5 m du signal >= X × médiane 24 h (288 bougies closes), lu à sa clôture
//   + accord range-24h : achat (inversé) si close < 50 % du range 24 h, vente si > 50 %
//   [variante fablew : + ret1h CONTRE le trade]
//   ENTRÉE à l'OPEN de la bougie 5 m suivante (premier prix postérieur à toute l'info utilisée)
//   verrou : 1 entrée / instrument / 12 h (144 bougies depuis la bougie d'entrée, comme le banc)
//   sorties (% de marge, levier 15) : tp / sl 30 / trail act+cb sur CLOSES / hold 144 bougies
//   pire-cas intra-bougie : SL testé avant TP · coûts 0,12 % de prix aller-retour
//
// 3 variantes journalisées en parallèle (l'ombre ne coûte rien) — la synthèse de la boucle
// choisira SANS retoucher le code (HERMES_OMBRE_VARIANTES="v2" pour n'en garder qu'une) :
//   v2     : vol>=2.5 · tp80/sl30/act25/cb15 (FORMULE FINALE V2, tools_fable_ancienne_final2.js)
//   it1    : vol>=2   · tp80/sl30/act30/cb10 (itération 1)
//   fablew : vol>=2.5 · tp80/sl30/act20/cb20 + ret1h contre (angle winrate)
//
// Branchement (voir lab_vagues/fableD_patch_ombre.txt — NE PAS appliquer sans accord) :
//   BLOC B en fin de app/main.js : require + demarrer({ MARKET, DATADIR, log })
//   BLOC A dans le gate, après computeScore : __fableD_ombre.onSignal(instId, dir, score)
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");

const STEP = 300000;                 // 5 min
const HIST = 288;                    // fenêtre 24 h
const LEV = 15;                      // levier (spec client 30/08)
const COUT_PX = 0.0012;              // coûts aller-retour, fraction de prix
const LOCK_BARS = 144;               // verrou 12 h en bougies (sémantique banc : entrée si ts > dernière entrée + 144*STEP)
const HOLD_BARS = 144;               // sortie HOLD au close de la bougie entryBar + 144 (comme banc: end = k0+144)
const RING_MAX = 400;                // bougies closes conservées par instrument (>= 289 nécessaires)

const TABLE = {
  v2:     { volX: 2.5, tp: 0.80, sl: 0.30, act: 0.25, cb: 0.15, ret1h: false },
  it1:    { volX: 2.0, tp: 0.80, sl: 0.30, act: 0.30, cb: 0.10, ret1h: false },
  fablew: { volX: 2.5, tp: 0.80, sl: 0.30, act: 0.20, cb: 0.20, ret1h: true  }
};

const S = {
  cfg: null,        // { live, MARKET, log, fichier, variantes[], seuil, garde289 }
  bars: {},         // instId -> [{ts,o,h,l,c,v}] bougies CLOSES, ascendantes, dédupliquées
  vus: {},          // instId -> ts de la dernière bougie close intégrée depuis MARKET.bars5m
  sig: {},          // instId -> { barTs, dirs: [{dir,score,ts}] } signaux de la bougie 5m courante
  pos: {},          // "v|instId" -> position papier
  lastEntry: {},    // "v|instId" -> entryBarTs de la dernière entrée (verrou 12 h)
  stats: {},        // v -> { n, w, sum }
  bf: { attente: new Set(), fait: {} },
  timers: []
};

/* ---------- journal ---------- */
function ecrire(o) {
  try { fs.appendFileSync(S.cfg.fichier, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n"); } catch {}
}
function normDir(d) { return (d === "long" || d === 1 || d > 0) ? 1 : ((d === "short" || d === -1 || d < 0) ? -1 : 0); }
const conv = r => ({ ts: Number(r.t), o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v });

/* ---------- flux 1 : signaux du moteur à score (toutes les 15 s / instrument) ---------- */
function onSignal(instId, dir, score, tsOpt) {
  if (!S.cfg) return;
  const nd = normDir(dir);
  if (!nd || Math.abs(score) < S.cfg.seuil) return;
  const ts = tsOpt != null ? tsOpt : Date.now();
  const barTs = ts - (ts % STEP);
  let e = S.sig[instId];
  if (!e || e.barTs !== barTs) e = S.sig[instId] = { barTs, dirs: [] };
  // on garde la 1re occurrence de CHAQUE direction dans la bougie (ordre chronologique),
  // comme le banc qui prend la 1re ligne de signal qui passe les filtres.
  if (!e.dirs.some(x => x.dir === nd)) e.dirs.push({ dir: nd, score: +score, ts });
}

/* ---------- anneau de bougies closes ---------- */
function pushRing(instId, b) {
  const arr = S.bars[instId] = S.bars[instId] || [];
  const last = arr[arr.length - 1];
  if (last && b.ts <= last.ts) return arr;   // doublon / retard : ignoré
  arr.push(b);
  if (arr.length > RING_MAX) arr.shift();
  return arr;
}

/* ---------- clôture d'une bougie 5 m : gestion des positions puis entrée éventuelle ---------- */
function barClose(instId, b, nouvelle) {
  const arr = pushRing(instId, b);
  for (const v of S.cfg.variantes) gererPosition(v, instId, b);

  const e = S.sig[instId];
  if (!e || e.barTs !== b.ts || !e.dirs.length) return;          // pas de signal DANS la bougie qui vient de clore
  if (!nouvelle || nouvelle.ts !== b.ts + STEP || !(nouvelle.o > 0)) return; // bougie d'entrée non contiguë
  if (arr[arr.length - 1].ts !== b.ts) return;                    // anneau désaligné (backfill concurrent)

  const besoin = S.cfg.garde289 ? HIST + 1 : HIST;
  if (arr.length < besoin) { backfill(instId); return; }
  if (S.cfg.garde289 && arr[arr.length - 1 - HIST].ts !== b.ts - HIST * STEP) { backfill(instId); return; }
  if (arr[arr.length - HIST].ts !== b.ts - (HIST - 1) * STEP) { backfill(instId); return; }

  // features 24 h, connues à la clôture de b (jamais après)
  const fen = arr.slice(-HIST);
  const vols = fen.map(x => x.v).sort((a, z) => a - z);
  const med = (vols[HIST / 2 - 1] + vols[HIST / 2]) / 2;
  const volSpike = med > 0 ? b.v / med : 0;
  let hh = -Infinity, ll = Infinity;
  for (const x of fen) { if (x.h > hh) hh = x.h; if (x.l < ll) ll = x.l; }
  const rangePos = hh > ll ? (b.c - ll) / (hh - ll) : 0.5;
  const ret1h = fen[HIST - 13] ? b.c / fen[HIST - 13].c - 1 : 0;

  for (const v of S.cfg.variantes) {
    const t = TABLE[v], key = v + "|" + instId;
    if (S.pos[key]) continue;
    const le = S.lastEntry[key];
    if (le != null && nouvelle.ts <= le + LOCK_BARS * STEP) continue;  // verrou 12 h (banc : iE > busy)
    if (volSpike < t.volX) continue;
    let choix = null;
    for (const d of e.dirs) {
      const nd = -d.dir;                                               // INVERSION du signal
      if (!((nd > 0 && rangePos < 0.5) || (nd < 0 && rangePos > 0.5))) continue;
      if (t.ret1h && !((nd > 0 && ret1h <= 0) || (nd < 0 && ret1h >= 0))) continue;
      choix = { nd, score: d.score, sigTs: d.ts };
      break;
    }
    if (!choix) continue;
    ouvrir(v, instId, choix, nouvelle, { volSpike, rangePos, ret1h });
  }
}

function ouvrir(v, instId, choix, nouvelle, f) {
  const t = TABLE[v], key = v + "|" + instId, nd = choix.nd;
  const entry = nouvelle.o;                                            // OPEN de la bougie suivante
  S.pos[key] = {
    dir: nd, entry, best: entry, trailed: false,
    sl: nd > 0 ? entry * (1 - t.sl / LEV) : entry * (1 + t.sl / LEV),
    tp: nd > 0 ? entry * (1 + t.tp / LEV) : entry * (1 - t.tp / LEV),
    entryBarTs: nouvelle.ts, lastBarTs: null, lastClose: entry, reprise: false
  };
  S.lastEntry[key] = nouvelle.ts;
  let ouverts = 0;
  for (const k in S.pos) if (k.startsWith(v + "|")) ouverts++;
  ecrire({
    event: "OMBRE_OPEN", v, instId, dir: nd > 0 ? "long" : "short", px: entry,
    volX: +f.volSpike.toFixed(2), rangePos: +f.rangePos.toFixed(3), ret1h: +f.ret1h.toFixed(4),
    score: +(+choix.score).toFixed(2), sigTs: new Date(choix.sigTs).toISOString(),
    entryBarTs: nouvelle.ts, ouverts,
    latenceMs: S.cfg.live ? Math.max(0, Date.now() - nouvelle.ts) : null
  });
  if (S.cfg.live) S.cfg.log("[OMBRE_INV] OPEN", v, instId, nd > 0 ? "long" : "short", "@", entry);
  /* Ce laboratoire reste strictement papier. Le seul chemin autorise pour
     une entree reelle est app/main.js, avec roster/promesse/Top30 relus au
     moment du POST. Aucun callback injecte ne peut contourner ce contrat. */
}

/* ---------- gestion de la position papier, bougie close par bougie close ---------- */
function gererPosition(v, instId, b) {
  const key = v + "|" + instId, P = S.pos[key];
  if (!P) return;
  const t = TABLE[v], d = P.dir;

  // contiguïté (banc : un trou termine le trade au close précédent connu)
  if (P.lastBarTs == null) {
    if (P.reprise) {                                     // restart : on reprend à la 1re bougie observée
      if (b.ts < P.entryBarTs) return;
      P.reprise = false;
    } else if (b.ts !== P.entryBarTs) {
      return cloturer(v, instId, P, P.lastClose, "GAP", null);
    }
  } else if (b.ts !== P.lastBarTs + STEP) {
    return cloturer(v, instId, P, P.lastClose, "GAP", null);
  }

  let exitPx = null, raison = null, frac = null;
  if (d > 0 ? b.l <= P.sl : b.h >= P.sl) {               // pire-cas : SL avant TP
    exitPx = P.sl; raison = P.trailed ? "TRAIL" : "SL";
  } else if (d > 0 ? b.h >= P.tp : b.l <= P.tp) {
    exitPx = P.tp; raison = "TP"; frac = t.tp / LEV - COUT_PX;   // comme le banc : pnl TP = tpPx - coûts
  } else if (b.ts >= P.entryBarTs + HOLD_BARS * STEP) {
    exitPx = b.c; raison = "HOLD";
  } else {
    if (d > 0 ? b.c > P.best : b.c < P.best) P.best = b.c;
    if ((d > 0 ? P.best / P.entry - 1 : 1 - P.best / P.entry) >= t.act / LEV) {
      const s2 = d > 0 ? P.best * (1 - t.cb / LEV) : P.best * (1 + t.cb / LEV);
      if (d > 0 ? s2 > P.sl : s2 < P.sl) {
        P.sl = s2; P.trailed = true;
        ecrire({ event: "OMBRE_TRAIL", v, instId, sl: P.sl, best: P.best });
      }
    }
    P.lastBarTs = b.ts; P.lastClose = b.c;
    return;
  }
  cloturer(v, instId, P, exitPx, raison, b.ts, frac);
}

function cloturer(v, instId, P, exitPx, raison, bTs, fracOverride) {
  const d = P.dir;
  const frac = fracOverride != null ? fracOverride
    : ((d > 0 ? exitPx / P.entry - 1 : 1 - exitPx / P.entry) - COUT_PX);
  const pnl = frac * LEV * 100;                                        // % de marge
  delete S.pos[v + "|" + instId];
  const st = S.stats[v] = S.stats[v] || { n: 0, w: 0, sum: 0 };
  st.n++; if (pnl > 0) st.w++; st.sum += pnl;
  const duree = bTs != null ? Math.round((bTs - P.entryBarTs) / STEP) + 1
    : (P.lastBarTs != null ? Math.round((P.lastBarTs - P.entryBarTs) / STEP) + 1 : 0);
  ecrire({
    event: "OMBRE_CLOSE", v, instId, raison, entry: P.entry, exit: exitPx,
    pnlMargePct: +pnl.toFixed(2), pnlBrut: pnl, entryBarTs: P.entryBarTs, dureeBars: duree
  });
  ecrire({
    event: "OMBRE_STATS", v, n: st.n, wr: +(100 * st.w / st.n).toFixed(1),
    espPct: +(st.sum / st.n).toFixed(2), sumPct: +st.sum.toFixed(1)
  });
  if (S.cfg.live) S.cfg.log("[OMBRE_INV] CLOSE", v, instId, raison, pnl.toFixed(2) + "%");
}

/* ---------- restauration depuis le journal (restart) ---------- */
function restaurer() {
  let contenu = "";
  try {
    const stat = fs.statSync(S.cfg.fichier);
    const taille = Math.min(stat.size, 4 * 1024 * 1024);
    const fd = fs.openSync(S.cfg.fichier, "r");
    const buf = Buffer.alloc(taille);
    fs.readSync(fd, buf, 0, taille, stat.size - taille);
    fs.closeSync(fd);
    contenu = buf.toString("utf8");
    if (taille < stat.size) contenu = contenu.slice(contenu.indexOf("\n") + 1);
  } catch { return; }
  const ouverts = {};
  for (const ligne of contenu.split("\n")) {
    if (!ligne) continue;
    let j; try { j = JSON.parse(ligne); } catch { continue; }
    if (!j.v || !j.instId) continue;
    const key = j.v + "|" + j.instId;
    if (j.event === "OMBRE_OPEN") {
      ouverts[key] = j;
      if (!(S.lastEntry[key] >= j.entryBarTs)) S.lastEntry[key] = j.entryBarTs;
    } else if (j.event === "OMBRE_CLOSE") {
      delete ouverts[key];
      const st = S.stats[j.v] = S.stats[j.v] || { n: 0, w: 0, sum: 0 };
      st.n++; if (j.pnlMargePct > 0) st.w++; st.sum += (j.pnlBrut != null ? j.pnlBrut : j.pnlMargePct);
    } else if (j.event === "OMBRE_TRAIL" && ouverts[key]) {
      ouverts[key].__sl = j.sl; ouverts[key].__best = j.best;
    }
  }
  for (const [key, o] of Object.entries(ouverts)) {
    const sep = key.indexOf("|"), v = key.slice(0, sep), instId = key.slice(sep + 1);
    const t = TABLE[v];
    if (!t || !S.cfg.variantes.includes(v)) continue;
    const nd = o.dir === "long" ? 1 : -1, entry = o.px;
    S.pos[key] = {
      dir: nd, entry,
      best: o.__best != null ? o.__best : entry,
      trailed: o.__sl != null,
      sl: o.__sl != null ? o.__sl : (nd > 0 ? entry * (1 - t.sl / LEV) : entry * (1 + t.sl / LEV)),
      tp: nd > 0 ? entry * (1 + t.tp / LEV) : entry * (1 - t.tp / LEV),
      entryBarTs: o.entryBarTs, lastBarTs: null, lastClose: entry, reprise: true
    };
  }
}

/* ---------- flux 2 (live) : sonde MARKET.bars5m — la clôture = apparition d'un ts suivant ---------- */
function sonder() {
  const B = S.cfg.MARKET && S.cfg.MARKET.bars5m;
  if (!B) return;
  for (const instId of Object.keys(B)) {
    const rows = B[instId] && B[instId].rows;
    if (!Array.isArray(rows) || rows.length < 2) continue;
    if (S.vus[instId] == null) {
      // amorçage : intègre l'historique (préfill REST + WS accumulé) SANS traiter d'entrées
      for (let j = 0; j <= rows.length - 2; j++) pushRing(instId, conv(rows[j]));
      S.vus[instId] = Number(rows[rows.length - 2].t);
      continue;
    }
    for (let j = 0; j <= rows.length - 2; j++) {
      const t0 = Number(rows[j].t);
      if (t0 <= S.vus[instId]) continue;
      barClose(instId, conv(rows[j]), conv(rows[j + 1]));
      S.vus[instId] = t0;
    }
  }
}

/* ---------- backfill REST public (uniquement les instruments signalés à historique court) ---------- */
function backfill(instId) {
  if (!S.cfg.live) return;
  if (Date.now() - (S.bf.fait[instId] || 0) < 10 * 60 * 1000) return;
  if (S.bf.attente.size < 50) S.bf.attente.add(instId);
}
function backfillTick() {
  const it = S.bf.attente.values().next();
  if (it.done) return;
  const instId = it.value;
  S.bf.attente.delete(instId);
  S.bf.fait[instId] = Date.now();
  const chemin = "/api/v5/market/candles?instId=" + encodeURIComponent(instId) + "&bar=5m&limit=300";
  const req = https.get(
    { hostname: "www.okx.com", path: chemin, headers: { "User-Agent": "hermes-app" }, timeout: 8000 },
    r => {
      let d = "";
      r.on("data", x => d += x);
      r.on("end", () => {
        try {
          const j = JSON.parse(d);
          if (j.code !== "0" || !Array.isArray(j.data)) return;
          const slotCourant = Math.floor(Date.now() / STEP) * STEP;
          const arr = S.bars[instId] = S.bars[instId] || [];
          const parTs = new Map(arr.map(b => [b.ts, b]));
          for (const c of j.data) {
            const ts = +c[0];
            if (!Number.isFinite(ts) || ts >= slotCourant) continue;  // exclut la bougie en cours
            if (!parTs.has(ts)) parTs.set(ts, { ts, o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] });
          }
          S.bars[instId] = [...parTs.values()].sort((a, b2) => a.ts - b2.ts).slice(-RING_MAX);
        } catch {}
      });
    }
  );
  req.on("error", () => {});
  req.on("timeout", () => { try { req.destroy(); } catch {} });
}

/* ---------- démarrage live ---------- */
function demarrer(refs) {
  if (S.cfg && S.cfg.live) return;
  if (refs?.armer && refs.armer !== "off") {
    throw new Error("LEGACY_REAL_ENTRY_DISABLED_USE_APP_MAIN_GATED_EXECUTOR");
  }
  const env = process.env;
  const variantes = String(env.HERMES_OMBRE_VARIANTES || "v2,it1,fablew")
    .split(",").map(x => x.trim()).filter(x => TABLE[x]);
  S.cfg = {
    live: true,
    MARKET: refs.MARKET,
    log: refs.log || console.log,
    fichier: env.HERMES_OMBRE_FICHIER || path.join(refs.DATADIR, "ombre-inverse.jsonl"),
    variantes: variantes.length ? variantes : ["v2"],
    seuil: Math.abs(Number(env.HERMES_OMBRE_SCORE || 2)) || 2,
    garde289: true,
    armer: null,
    entrerReel: null,
  };
  try { fs.mkdirSync(path.dirname(S.cfg.fichier), { recursive: true }); } catch {}
  restaurer();
  ecrire({
    event: "OMBRE_BOOT", variantes: S.cfg.variantes, seuil: S.cfg.seuil,
    lev: LEV, coutPx: COUT_PX, lockBars: LOCK_BARS, holdBars: HOLD_BARS, params: TABLE,
    positionsRestaurees: Object.keys(S.pos).length
  });
  S.timers.push(setInterval(() => {
    try { sonder(); } catch (e) { try { S.cfg.log("[OMBRE_INV_ERR]", e.message); } catch {} }
  }, 4000));
  S.timers.push(setInterval(() => { try { backfillTick(); } catch {} }, 1500));
  S.cfg.log("[OMBRE_INV] démarré —", S.cfg.variantes.join("+"), "->", S.cfg.fichier,
    "· positions restaurées:", Object.keys(S.pos).length);
}

/* ---------- accès test / replay (fableD_replay_test.js) ---------- */
function _reset(opts = {}) {
  for (const t of S.timers) clearInterval(t);
  S.timers = [];
  S.cfg = {
    live: false, MARKET: null, log: () => {},
    fichier: opts.fichier || path.join(__dirname, "fableD_ombre_test.jsonl"),
    variantes: (opts.variantes || ["v2"]).filter(x => TABLE[x]),
    seuil: opts.seuil != null ? opts.seuil : 2,
    garde289: opts.garde289 !== false
  };
  S.bars = {}; S.vus = {}; S.sig = {}; S.pos = {}; S.lastEntry = {}; S.stats = {};
  S.bf = { attente: new Set(), fait: {} };
}
function _barClose(instId, b, nouvelle) { barClose(instId, b, nouvelle); }
function _seedRing(instId, bars) { for (const b of bars) pushRing(instId, b); }
function _flush(instId) {  // test uniquement : clôture au dernier close connu (raison FIN)
  for (const v of S.cfg.variantes) {
    const P = S.pos[v + "|" + instId];
    if (P) cloturer(v, instId, P, P.lastClose, "FIN", null);
  }
}
function _restaurer() { restaurer(); }
function _etat() { return S; }

module.exports = { demarrer, onSignal, _reset, _barClose, _seedRing, _flush, _restaurer, _etat, TABLE };
