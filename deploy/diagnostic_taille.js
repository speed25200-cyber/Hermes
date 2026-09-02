#!/usr/bin/env node
/* ============================================================================
   POURQUOI L'ENTREE MAKER EST REFUSEE — mesure, pas hypothese.

   Le journal montre trois tentatives d'entree en limite post-only, sur
   trois instruments differents, toutes refusees par OKX avec le meme
   code :

     sCode 51121 « Order quantity must be a multiple of the lot size »

   Ce n'est pas un refus legitime. Une limite post-only qui croiserait le
   carnet serait rejetee avec un autre code, et ce serait normal. 51121
   dit que la TAILLE envoyee est malformee — et la taille est calculee
   par le moteur avant d'etre envoyee, la meme pour la limite et pour
   l'ordre marche de repli.

   Deux causes possibles et il faut trancher entre elles, parce qu'elles
   ne se reparent pas au meme endroit :

     LA META MANQUE. roundQtyToLot() substitue silencieusement un pas de
     0,001 quand MARKET.meta n'a pas l'instrument. Sur un contrat dont le
     lot vaut 1, cela fabrique « 17.892 » la ou OKX veut « 17 ».

     LA VIRGULE FLOTTANTE. Math.floor(q/pas)*pas ne rend pas toujours un
     multiple exact du pas, et String() envoie la salissure telle quelle.

   Ce script demande a OKX les vraies caracteristiques des instruments du
   roster — point PUBLIC, aucune cle — refait le calcul du moteur, et
   imprime la chaine exacte qui partirait sur le reseau. Si elle n'est
   pas un multiple du lot, on voit laquelle des deux causes l'a produite.

   Ne lit que des donnees publiques. N'ecrit rien. Ne place aucun ordre.
   ============================================================================ */
"use strict";
const https = require("https");
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");
const HOTE = process.env.OKX_HOST || "www.okx.com";
const LEVIER = Number(process.env.HERMES_DEFAULT_LEVERAGE || 15);

function getJSON(chemin) {
  return new Promise((ok, ko) => {
    https.get({ host: HOTE, path: chemin, family: 4, timeout: 20000,
                headers: { "User-Agent": "hermes-diagnostic" } }, (r) => {
      const m = [];
      r.on("data", (c) => m.push(c));
      r.on("end", () => { try { ok(JSON.parse(Buffer.concat(m).toString("utf8"))); } catch (e) { ko(e); } });
    }).on("error", ko).on("timeout", function () { this.destroy(new Error("timeout")); });
  });
}

const num = (x) => Number(x) || 0;

/* La fonction du moteur, recopiee a l'identique — y compris son repli
   silencieux a 0,001, qui est precisement ce qu'on soupconne. */
function roundQtyToLotMoteur(meta, qty) {
  const m = meta || { lotSz: 0.001, minSz: 0.001 };
  const step = num(m.lotSz || 0.001);
  const minSz = num(m.minSz || step);
  const rounded = Math.floor(qty / step) * step;
  return Math.max(rounded, minSz);
}

/* Un multiple exact, teste sur la CHAINE envoyee et non sur le nombre :
   c'est la chaine qu'OKX lit. */
/* Le nombre de decimales doit venir de la TAILLE autant que du pas. La
   premiere version ne prenait que celles du pas : sur un lot de 1, elle
   arrondissait « 17.892 » a 18 et le declarait multiple de 1 — elle
   effacait exactement la salissure qu'elle devait attraper. Son propre
   banc l'a prise en flagrant delit. */
function estMultiple(sz, lotSz) {
  const dec = (v) => (String(v).split(".")[1] || "").length;
  const d = Math.max(dec(sz), dec(lotSz));
  const ech = Math.round(Number(sz) * 10 ** d);
  const pas = Math.round(Number(lotSz) * 10 ** d);
  return pas > 0 && ech % pas === 0;
}

async function main() {
  let roster = [];
  try {
    const r = JSON.parse(fs.readFileSync(path.join(RACINE, "config", "roster.json"), "utf8"));
    roster = Object.keys(r.perles || {});
  } catch {}
  const cibles = roster.length ? roster
    : ["STX-USDT-SWAP", "SHIB-USDT-SWAP", "AVAX-USDT-SWAP", "FIL-USDT-SWAP", "LTC-USDT-SWAP"];
  console.log(`[TAILLE] instruments examines : ${cibles.join(", ")}`);
  console.log(`[TAILLE] levier ${LEVIER}. Aucun ordre n'est place.`);

  const inst = await getJSON("/api/v5/public/instruments?instType=SWAP");
  const parId = new Map();
  for (const x of (inst.data || [])) parId.set(x.instId, x);
  console.log(`[TAILLE] OKX declare ${parId.size} contrats perpetuels.`);

  const marges = [2, 3, 5, 8];
  let malformes = 0, absents = 0;

  for (const instId of cibles) {
    const x = parId.get(instId);
    if (!x) { absents++; console.log(`  ${instId.padEnd(20)} ABSENT du catalogue OKX`); continue; }
    const tk = await getJSON("/api/v5/market/ticker?instId=" + instId);
    const px = num(tk.data?.[0]?.last);
    const meta = { ctVal: num(x.ctVal || 1), lotSz: num(x.lotSz || 0.001), minSz: num(x.minSz || 0.001) };
    if (!(px > 0)) { console.log(`  ${instId.padEnd(20)} pas de prix`); continue; }

    console.log(`  ${instId.padEnd(20)} px ${px} · ctVal ${meta.ctVal} · lotSz ${meta.lotSz} · minSz ${meta.minSz}`);
    for (const marge of marges) {
      const contrats = (marge * LEVIER) / (px * meta.ctVal);
      const avec = roundQtyToLotMoteur(meta, contrats);
      const sans = roundQtyToLotMoteur(null, contrats);          // meta manquante : repli 0,001
      const okAvec = estMultiple(String(avec), meta.lotSz);
      const okSans = estMultiple(String(sans), meta.lotSz);
      if (!okAvec) malformes++;
      console.log(`      marge ${String(marge).padStart(2)} USDT → ${contrats.toFixed(4)} contrats · ` +
        `avec meta sz="${String(avec)}" ${okAvec ? "ok" : "REFUSE 51121"} · ` +
        `sans meta sz="${String(sans)}" ${okSans ? "ok" : "REFUSE 51121"}`);
    }
  }

  console.log(`[TAILLE] conclusion :`);
  console.log(`  tailles malformees AVEC la meta correcte : ${malformes}`);
  console.log(`  ${malformes === 0
    ? "la meta corrige tout : le refus 51121 vient donc d'une meta ABSENTE au moment de l'ordre, pas de la virgule flottante."
    : "la meta ne suffit pas : l'arrondi lui-meme produit des tailles invalides."}`);
  console.log(`  instruments absents du catalogue : ${absents}`);
}

if (require.main === module) main().catch((e) => { console.error("[TAILLE] echec :", e.message); process.exit(1); });
module.exports = { roundQtyToLotMoteur, estMultiple };
