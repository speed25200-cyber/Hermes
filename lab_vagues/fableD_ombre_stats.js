// fableD_ombre_stats.js — lecture du journal ombre (data/ombre-inverse.jsonl).
// Usage : node fableD_ombre_stats.js [chemin.jsonl]
// Affiche par variante : n / winrate / espérance / cumul, répartition des sorties,
// positions papier encore ouvertes, et les 10 derniers trades.
"use strict";
const fs = require("fs");
const path = require("path");
const FICHIER = process.argv[2] || path.join(__dirname, "..", "data", "ombre-inverse.jsonl");

if (!fs.existsSync(FICHIER)) { console.log("journal introuvable :", FICHIER); process.exit(1); }
const st = {}, ouverts = {}, derniers = [];
let boots = 0;
for (const l of fs.readFileSync(FICHIER, "utf8").split("\n")) {
  if (!l) continue;
  let j; try { j = JSON.parse(l); } catch { continue; }
  if (j.event === "OMBRE_BOOT") { boots++; continue; }
  if (!j.v) continue;
  const key = j.v + "|" + j.instId;
  if (j.event === "OMBRE_OPEN") ouverts[key] = j;
  if (j.event === "OMBRE_CLOSE") {
    delete ouverts[key];
    const s = st[j.v] = st[j.v] || { n: 0, w: 0, sum: 0, raisons: {}, latSum: 0, latN: 0 };
    s.n++; if (j.pnlMargePct > 0) s.w++;
    s.sum += (j.pnlBrut != null ? j.pnlBrut : j.pnlMargePct);
    s.raisons[j.raison] = (s.raisons[j.raison] || 0) + 1;
    derniers.push(j);
    if (derniers.length > 10) derniers.shift();
  }
}
console.log("journal :", FICHIER, "· démarrages :", boots);
console.log("\n===== PAR VARIANTE (pnl en % de marge, levier 15, coûts 0,12 % inclus) =====");
for (const [v, s] of Object.entries(st)) {
  console.log(`${v.padEnd(8)} n ${String(s.n).padStart(4)} · wr ${(100 * s.w / s.n).toFixed(1)}% · esp ${(s.sum / s.n).toFixed(2)}% · cumul ${s.sum.toFixed(1)}%` +
    " · sorties " + Object.entries(s.raisons).map(([r, n]) => r + ":" + n).join(" "));
}
const o = Object.values(ouverts);
console.log("\npositions papier ouvertes :", o.length);
for (const p of o) console.log(`  ${p.v} ${p.instId} ${p.dir} @ ${p.px} depuis ${p.ts}`);
console.log("\n10 derniers trades :");
for (const d of derniers) console.log(`  ${d.ts} ${d.v.padEnd(7)} ${d.instId.padEnd(20)} ${d.raison.padEnd(5)} ${d.pnlMargePct > 0 ? "+" : ""}${d.pnlMargePct}%`);
