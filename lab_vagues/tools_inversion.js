// HYPOTHÈSE CLIENT : « la stratégie d'origine choisissait bien les cryptos et les moments,
// mais se trompait de SENS ». Test : rejouer ses 86 793 signaux réels journalisés
// (sim-logs.jsonl, |score|>=2) en 8 variantes, avec la structure de sortie validée
// (tp80/sl30/act30/cb5/hold12, levier 15, coûts 0,12 %, pire-cas dans la bougie).
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const LEV = 15, COUT_PX = 0.0012;
const EX = { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 };
const LAB = __dirname;

function chargerCandles(instId) {
  for (const d of ["data365", "data90", "data"]) {
    const f = path.join(LAB, d, instId + ".json");
    if (fs.existsSync(f)) { try { const c = JSON.parse(fs.readFileSync(f)); if (c.length > 500) return c; } catch {} }
  }
  return null;
}

function sim(c5, i5, dir) {
  const entry = c5[i5][4];
  const tpPx = EX.tp / LEV, slPx0 = EX.sl / LEV, actPx = EX.act / LEV, cbPx = EX.cb / LEV;
  const hold = EX.holdH * 12;
  const tp = dir > 0 ? entry * (1 + tpPx) : entry * (1 - tpPx);
  let sl = dir > 0 ? entry * (1 - slPx0) : entry * (1 + slPx0);
  let best = entry;
  const end = Math.min(c5.length - 1, i5 + hold);
  for (let k = i5 + 1; k <= end; k++) {
    const hi = c5[k][2], lo = c5[k][3];
    if (dir > 0 ? lo <= sl : hi >= sl) return { pnl: (dir > 0 ? sl / entry - 1 : 1 - sl / entry) - COUT_PX, dur: k - i5 };
    if (dir > 0 ? hi >= tp : lo <= tp) return { pnl: tpPx - COUT_PX, dur: k - i5 };
    const close = c5[k][4];
    if (dir > 0 ? close > best : close < best) best = close;
    if ((dir > 0 ? best / entry - 1 : 1 - best / entry) >= actPx) {
      const t = dir > 0 ? best * (1 - cbPx) : best * (1 + cbPx);
      if (dir > 0 ? t > sl : t < sl) sl = t;
    }
  }
  return { pnl: (dir > 0 ? c5[end][4] / entry - 1 : 1 - c5[end][4] / entry) - COUT_PX, dur: end - i5 };
}

function rangePosAt(c5, i) {
  if (i < 288) return null;
  let hh = -Infinity, ll = Infinity;
  for (let k = i - 287; k <= i; k++) { if (c5[k][2] > hh) hh = c5[k][2]; if (c5[k][3] < ll) ll = c5[k][3]; }
  return hh > ll ? (c5[i][4] - ll) / (hh - ll) : 0.5;
}

/* Variantes : fonction (sigDir, score, c5, i) -> dir à trader (0 = passer) */
const VARIANTES = {
  ORIGINAL:      (d, s) => d,
  INVERSE:       (d, s) => -d,
  INV_LONGS:     (d, s) => d > 0 ? -1 : d,        // inverse seulement les achats
  INV_SHORTS:    (d, s) => d < 0 ? 1 : d,         // inverse seulement les ventes
  ORIG_SEUIL3:   (d, s) => Math.abs(s) >= 3 ? d : 0,
  INV_SEUIL3:    (d, s) => Math.abs(s) >= 3 ? -d : 0,
  INV_RANGE:     (d, s, c5, i) => { const p = rangePosAt(c5, i); if (p == null) return 0; const nd = -d; return (nd > 0 && p < 0.5) || (nd < 0 && p > 0.5) ? nd : 0; },
  INV_RETARD2:   (d, s) => -d   // même sens inversé mais entrée 2 bougies plus tard (géré au sim)
};

(async () => {
  // 1) extraire les signaux
  const signaux = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(LAB, "..", "data", "sim-logs.jsonl")) });
  for await (const l of rl) {
    try { const j = JSON.parse(l); if (j.dir && Math.abs(j.score) >= 2) signaux.push({ ts: Date.parse(j.ts), instId: j.instId, dir: j.dir === "long" || j.dir === 1 || j.dir > 0 ? 1 : -1, score: j.score }); } catch {}
  }
  signaux.sort((a, b) => a.ts - b.ts);
  console.log("signaux chargés:", signaux.length);

  // 2) index par crypto + résolution des bougies
  const parInst = {};
  for (const s of signaux) (parInst[s.instId] = parInst[s.instId] || []).push(s);

  const res = {}; // variante -> era -> {trades:[]}
  const eras = ts => { const m = new Date(ts).toISOString().slice(0, 7); return m >= "2026-08" ? "aout26" : (m >= "2026-01" ? "fev26" : "sept-oct25"); };
  for (const v in VARIANTES) res[v] = { "sept-oct25": [], "fev26": [], "aout26": [], _long: [], _short: [] };

  let couvertes = 0, sansData = 0;
  for (const [instId, sigs] of Object.entries(parInst)) {
    const c5 = chargerCandles(instId);
    if (!c5) { sansData += sigs.length; continue; }
    const t0 = c5[0][0], t1 = c5[c5.length - 1][0], step = 300000;
    const busy = {}; for (const v in VARIANTES) busy[v] = -1;
    for (const s of sigs) {
      if (s.ts < t0 + 290 * step || s.ts > t1 - 20 * step) continue;
      const i = Math.min(c5.length - 2, Math.floor((s.ts - t0) / step));
      if (!(c5[i] && Math.abs(c5[i][0] - (s.ts - (s.ts % step))) < step * 2)) continue;   // trou de données
      couvertes++;
      const era = eras(s.ts);
      for (const v in VARIANTES) {
        const dir = VARIANTES[v](s.dir, s.score, c5, i);
        if (!dir) continue;
        const iEntre = v === "INV_RETARD2" ? i + 2 : i;
        if (iEntre <= busy[v] || iEntre >= c5.length - 2) continue;
        const t = sim(c5, iEntre, dir);
        busy[v] = iEntre + t.dur;
        res[v][era].push(t.pnl);
        if (v === "ORIGINAL" || v === "INVERSE") res[v][dir > 0 ? "_long" : "_short"].push(t.pnl);
      }
    }
  }
  console.log("signaux couverts par des bougies:", couvertes, "· sans données:", sansData);

  const agg = l => { if (l.length < 30) return null; const n = l.length, w = l.filter(p => p > 0).length, s = l.reduce((a, b) => a + b, 0); return { n, wr: +(100 * w / n).toFixed(1), esp: +(100 * s / n * LEV).toFixed(2) }; };
  console.log("\n=== VERDICT PAR VARIANTE (esp % MARGE/trade net · par époque) ===");
  console.log("variante".padEnd(13), "sept-oct25".padStart(22), "fev26".padStart(20), "aout26".padStart(22));
  for (const v in VARIANTES) {
    const line = [v.padEnd(13)];
    for (const e of ["sept-oct25", "fev26", "aout26"]) {
      const a = agg(res[v][e]);
      line.push((a ? `${a.esp}% wr${a.wr} n${a.n}` : "—").padStart(e === "fev26" ? 20 : 22));
    }
    console.log(line.join(""));
  }
  console.log("\n=== décomposition long/short (époques confondues) ===");
  for (const v of ["ORIGINAL", "INVERSE"])
    console.log(v.padEnd(9), "longs:", JSON.stringify(agg(res[v]._long)), "shorts:", JSON.stringify(agg(res[v]._short)));
  fs.writeFileSync(path.join(LAB, "inversion_resultats.json"), JSON.stringify(res, (k, val) => Array.isArray(val) && val.length > 50 ? { n: val.length, esp: val.reduce((a, b) => a + b, 0) / val.length * LEV * 100 } : val, 1));
})();
