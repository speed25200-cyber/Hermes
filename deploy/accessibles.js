#!/usr/bin/env node
// Quels perpetuels OKX un capital donne peut-il REELLEMENT ouvrir ?
//
// La question se pose des qu'un compte est petit, et elle ne se devine
// pas : un perpetuel s'achete par contrats entiers, et la valeur d'un
// contrat varie d'un facteur mille d'un instrument a l'autre. Le
// minimum n'est donc pas une somme en dollars mais
//
//     minSz x ctVal x prix / levier
//
// c'est-a-dire la marge qu'exige UN contrat. En dessous, l'ordre est
// refuse par la place, ou l'arrondi au lot le fait exploser au-dela du
// budget — et Hermes prefere alors ne rien ouvrir.
//
// Tourne sur le VPS, sur les points publics d'OKX : aucune cle n'est
// necessaire, rien n'est ecrit, rien n'est envoye.
"use strict";
const https = require("https");

const EQUITE  = Number(process.argv[2] || 11.46);
const RISQUE  = 0.90;
const LEVIERS = [15, 20, 30, 50];

function get(chemin) {
  return new Promise((ok, ko) => {
    https.get({ host: "www.okx.com", path: chemin, family: 4,
                headers: { "User-Agent": "hermes-diag" } }, (r) => {
      let d = ""; r.on("data", (c) => d += c);
      r.on("end", () => { try { ok(JSON.parse(d)); } catch (e) { ko(e); } });
    }).on("error", ko);
  });
}

(async () => {
  const [inst, tick] = await Promise.all([
    get("/api/v5/public/instruments?instType=SWAP"),
    get("/api/v5/market/tickers?instType=SWAP"),
  ]);
  if (inst.code !== "0" || tick.code !== "0") {
    console.log("OKX a refuse :", inst.msg || tick.msg); process.exit(1);
  }
  const prix = new Map(tick.data.map((t) => [t.instId, Number(t.last)]));
  const vol  = new Map(tick.data.map((t) => [t.instId, Number(t.volCcy24h) * Number(t.last)]));

  const rangee = [];
  for (const i of inst.data) {
    if (!/-USDT-SWAP$/.test(i.instId)) continue;
    const px = prix.get(i.instId) || 0;
    const ct = Number(i.ctVal || 0), mn = Number(i.minSz || 0);
    if (px <= 0 || ct <= 0 || mn <= 0) continue;
    rangee.push({
      nom: i.instId.replace("-USDT-SWAP", ""),
      notionnelMin: mn * ct * px,
      levierMax: Number(i.lever || 0),
      dollars: vol.get(i.instId) || 0,
    });
  }
  rangee.sort((a, b) => b.dollars - a.dollars);

  console.log(`equite ${EQUITE.toFixed(2)} USDT | engageable ${(EQUITE * RISQUE).toFixed(2)}`);
  console.log(`${rangee.length} perpetuels USDT cotes\n`);

  for (const lev of LEVIERS) {
    // Une seule place : toute la part engageable sur un trade. C'est le
    // cas le plus favorable, donc celui qui dit si QUELQUE CHOSE est
    // possible ; la tolerance d'arrondi de 10 % du moteur est reprise.
    const budget = EQUITE * RISQUE * 1.10;
    const ok = rangee.filter((r) => r.levierMax >= lev && r.notionnelMin / lev <= budget);
    const tete = ok.slice(0, 12)
      .map((r) => `${r.nom} ${(r.notionnelMin / lev).toFixed(2)}`)
      .join(", ");
    console.log(`levier x${String(lev).padStart(3)} : ${String(ok.length).padStart(3)} accessibles`
      + (ok.length ? `\n             les plus echanges (nom + marge d'un contrat) : ${tete}` : "")
      + (ok.length ? "" : "  — aucun"));
  }

  // Et le classement par volume, celui que l'univers utilise vraiment.
  console.log("\nsur les 20 plus gros volumes, marge exigee par UN contrat :");
  for (const lev of LEVIERS) {
    const vingt = rangee.slice(0, 20);
    const ok = vingt.filter((r) => r.levierMax >= lev && r.notionnelMin / lev <= EQUITE * RISQUE * 1.10);
    console.log(`  x${String(lev).padStart(3)} : ${ok.length}/20`
      + (ok.length ? ` — ${ok.map((r) => r.nom).join(", ")}` : ""));
  }
  const vingt = rangee.slice(0, 20);
  console.log("\n  detail des 20 (marge d'un contrat au levier 15 / 50) :");
  for (const r of vingt) {
    console.log(`    ${r.nom.padEnd(10)} notionnel min ${r.notionnelMin.toFixed(2).padStart(9)} USDT`
      + ` -> marge ${(r.notionnelMin / 15).toFixed(2).padStart(8)} a x15`
      + ` , ${(r.notionnelMin / 50).toFixed(2).padStart(8)} a x50`
      + ` (levier max ${r.levierMax})`);
  }
})().catch((e) => { console.log("echec :", e.message); process.exit(1); });
