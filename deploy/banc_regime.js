#!/usr/bin/env node
/* ============================================================================
   LE BANC DU RÉGIME — le filtre par état de marché vaut-il quelque chose ?

   Ce script ne branche rien. Il mesure, et il a le droit de conclure que
   non. C'est le préalable au câblage : une couche qui n'améliore pas les
   perles ACTUELLES sur des jours que le choix n'a pas regardés n'a rien à
   faire dans un moteur qui trade de l'argent réel.

   LE PROTOCOLE, et il est le même que celui du chercheur de perles parce
   que c'est le seul qui ne se ment pas à lui-même :

     1. On rejoue chaque perle du roster sur toute son histoire, avec le
        simulateur qui fait foi (modules/backtest.js).
     2. On calcule l'état du marché à l'instant de CHAQUE ENTRÉE — l'état
        à l'entrée, pas à la sortie : c'est la seule chose que le moteur
        vivant peut connaître au moment de décider.
     3. Le choix se refait à CHAQUE BLOC, en VALIDATION GLISSANTE :
        cinq blocs de trois jours, et pour chacun le choix ne voit que
        ce qui le précède. Trente jours d'histoire ne donnent qu'une
        vingtaine de trades hors échantillon par perle si l'on se
        contente d'une seule coupure ; la glissade en donne cinq fois
        plus, sur les mêmes données, sans jamais laisser le choix
        regarder la suite. C'est la seule façon honnête de tirer une
        conclusion d'un mois de bougies.
     3 bis. Dans chaque bloc, sur la fenêtre qui le précède, on ÉCARTE
        perle les états où elle perd de façon démontrée. Écarter les
        perdants n'est pas la même chose que garder les gagnants, et la
        différence est tout sauf cosmétique : avec cinq ou dix trades
        par état, « elle gagne ici » est du bruit, tandis que « elle
        perd ici, sur assez de trades » est une information. Garder les
        seuls gagnants transformerait le filtre en interrupteur d'arrêt
        — une perle validée par le chercheur serait éteinte par une
        anomalie d'échantillon. Le défaut est donc le statu quo : sans
        preuve contre un état, on y trade.
     4. On mesure le gain sur la FENÊTRE DE VALIDATION, jamais regardée.
     5. On compare à un TÉMOIN : un filtre qui retire le même nombre de
        trades, mais au hasard. Sans ce témoin, « filtrer améliore » ne
        veut rien dire — retirer des trades au hasard améliore aussi,
        une fois sur deux. Le filtre doit battre le hasard, pas
        seulement l'absence de filtre.

   Tourne sur le VPS, ne lit que des points publics et le cache du
   chercheur, n'écrit RIEN. Le verdict part dans le journal du run.
   ============================================================================ */
"use strict";
const https = require("https");
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");
const { serieSignaux, simuler, resumer } = require(path.join(RACINE, "modules", "backtest.js"));
const REGIME = require(path.join(RACINE, "modules", "regime.js"));

const ROSTER = path.join(RACINE, "config", "roster.json");
const CACHE_DIR = path.join(RACINE, "data", "cache-5m");
const CACHE_LONG = path.join(RACINE, "data", "cache-long");
/* La glissade s'adapte à ce qu'on a sous la main. Trente jours de cache
   ne donnent que cinq blocs de trois jours ; dix-huit mois d'archives en
   donnent douze de trente. Le second est le seul qui puisse contenir un
   retournement de marché, et donc le seul qui puisse répondre à la
   question posée. */
const LONG = fs.existsSync(CACHE_LONG);
const BLOCS = Number(process.env.REGIME_BLOCS || (LONG ? 12 : 5));
const JOURS_BLOC = Number(process.env.REGIME_JOURS_BLOC || (LONG ? 30 : 3));
const LEVIER = Number(process.env.HERMES_DEFAULT_LEVERAGE || 15);
const SL = 0.30, CB = 0.05;
const MIN_TRADES_ETAT = Number(process.env.REGIME_MIN_TRADES_ETAT || 5);
const TIRAGES_TEMOIN = Number(process.env.REGIME_TIRAGES || 400);

/* ---- les données : le cache du chercheur d'abord, OKX si besoin ---- */

function get(chemin) {
  return new Promise((ok, ko) => {
    https.get({ host: "www.okx.com", path: chemin, family: 4,
                headers: { "User-Agent": "hermes-banc-regime" }, timeout: 15000 }, (r) => {
      let d = ""; r.on("data", (c) => d += c);
      r.on("end", () => { try { ok(JSON.parse(d)); } catch (e) { ko(e); } });
    }).on("error", ko).on("timeout", function () { this.destroy(new Error("timeout")); });
  });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* L'histoire longue d'abord, le cache du chercheur ensuite. Les deux ont
   le même format ; seule la profondeur change, et avec elle la portée de
   ce que le banc peut conclure. */
function lireUn(dossier, instId) {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(dossier, instId + ".json"), "utf8"));
    return Array.isArray(rows) && rows.length > 288 * 3 ? rows : null;
  } catch { return null; }
}
function lireCache(instId) {
  return lireUn(CACHE_LONG, instId) || lireUn(CACHE_DIR, instId);
}

async function histoire(instId, jours) {
  const enCache = lireCache(instId);
  if (enCache) return enCache;
  // Le cache n'a pas cet instrument (BTC ou ETH hors univers, premier
  // démarrage) : on pagine, une seule fois, sans rien écrire.
  let rows = [];
  const r0 = await get(`/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=5m&limit=300`);
  if (!r0 || r0.code !== "0") throw new Error("OKX " + (r0 && r0.code));
  rows = r0.data.slice();
  while (rows.length < jours * 288 + 2) {
    const r = await get(`/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}&bar=5m&limit=100&after=${rows[rows.length - 1][0]}`);
    if (!r || !r.data || !r.data.length) break;
    rows.push(...r.data);
    await pause(250);
  }
  const asc = rows.slice(1).map((k) => [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]).reverse();
  const vus = new Set(); const propre = [];
  for (const k of asc) if (!vus.has(k[0])) { vus.add(k[0]); propre.push(k); }
  return propre;
}

/* ---- les mesures ---- */

/* Le pire creux de la courbe des gains cumulés, en fraction de marge.
   Les trades sont ordonnés par leur SORTIE : c'est là que le gain
   devient réel, et une courbe ordonnée par les entrées inventerait des
   creux qui n'ont jamais existé. */
function creuxMax(trades) {
  const ordre = [...trades].sort((a, b) => a.tsOut - b.tsOut);
  let cumul = 0, sommet = 0, pire = 0;
  for (const t of ordre) {
    cumul += t.pnlMarge;
    if (cumul > sommet) sommet = cumul;
    if (sommet - cumul > pire) pire = sommet - cumul;
  }
  return pire;
}

function bilan(trades) {
  const r = resumer(trades);
  return { trades: r.trades, winrate: r.winrate, net: r.netMarge, moyenne: r.moyenneMarge, creux: creuxMax(trades) };
}

/* Le témoin : on retire au hasard autant de trades que le filtre en a
   retirés, et on regarde combien de fois le hasard fait aussi bien. Le
   nombre rendu est la part des tirages que le filtre bat — au-dessus de
   0,95, le filtre a fait autre chose que réduire l'échantillon. */
function partBattue(trades, gardes, tirages) {
  if (!gardes.length || gardes.length === trades.length) return null;
  const cible = bilan(gardes).net;
  let rnd = 987654321;
  const suivant = () => { rnd ^= rnd << 13; rnd ^= rnd >>> 17; rnd ^= rnd << 5; rnd >>>= 0; return rnd / 4294967296; };
  let battus = 0;
  for (let k = 0; k < tirages; k++) {
    const copie = [...trades];
    for (let i = copie.length - 1; i > 0; i--) { const j = Math.floor(suivant() * (i + 1)); [copie[i], copie[j]] = [copie[j], copie[i]]; }
    const net = copie.slice(0, gardes.length).reduce((a, t) => a + t.pnlMarge, 0);
    if (cible > net) battus++;
  }
  return battus / tirages;
}

/* ---- la passe ---- */

async function main() {
  const seuils = REGIME.lireSeuils(path.join(RACINE, "config", "regime.json"));
  console.log(`[BANC-REGIME] seuils ${seuils.version} : choc ${seuils.choc} · tendance ${seuils.tendance} | levier ${LEVIER} | validation glissante ${BLOCS} blocs de ${JOURS_BLOC} j`);
  console.log(`[BANC-REGIME] source des bougies : ${LONG ? "archives longues (data/cache-long, Binance)" : "cache du chercheur (data/cache-5m, OKX, 30 j)"}`);
  if (LONG) console.log(`[BANC-REGIME] avertissement : les archives sont des perpetuels BINANCE. Pour l'ETAT du marche c'est sans consequence ; pour rejouer une perle c'est une approximation, proche mais pas identique a OKX.`);

  let roster;
  try { roster = JSON.parse(fs.readFileSync(ROSTER, "utf8")); }
  catch (e) { console.error("[BANC-REGIME] roster illisible :", e.message); process.exit(1); }
  const perles = roster.perles || {};
  const noms = Object.keys(perles);
  if (!noms.length) { console.error("[BANC-REGIME] roster vide, rien à mesurer"); process.exit(1); }

  console.log(`[BANC-REGIME] ${noms.length} perle(s) au roster, collecte de BTC et ETH…`);
  const btc = await histoire("BTC-USDT-SWAP", 30);
  const eth = await histoire("ETH-USDT-SWAP", 30).catch(() => null);
  const etats = REGIME.serieEtats(btc, eth, seuils);
  const index = REGIME.indexEtats(btc, etats);

  // Le temps passé dans chaque état : un filtre qui coupe 90 % du temps
  // n'est pas un filtre, c'est un arrêt du moteur.
  const compte = {};
  for (const e of index.etat) compte[e] = (compte[e] || 0) + 1;
  const total = index.etat.length || 1;
  console.log("[BANC-REGIME] temps passé par état : " +
    Object.entries(compte).sort((a, b) => b[1] - a[1])
      .map(([e, n]) => `${e} ${(100 * n / total).toFixed(1)} %`).join(" · "));

  const finTs = btc[btc.length - 1][0];
  console.log(`[BANC-REGIME] histoire de reference : ${btc.length} bougies, du ` +
    `${new Date(btc[0][0]).toISOString().slice(0, 10)} au ${new Date(finTs).toISOString().slice(0, 10)}`);
  const parEtatGlobal = {};

  console.log(`[BANC-REGIME] verdict par perle (choix sur le passe de chaque bloc, mesure sur le bloc) :`);
  const lignes = [];
  let mieux = 0, pires = 0, egaux = 0, muettes = 0;
  const agregatSans = [], agregatAvec = [];

  for (const instId of noms) {
    const nom = instId.replace("-USDT-SWAP", "");
    const p = perles[instId];
    const c5 = lireCache(instId);
    if (!c5) { lignes.push(`  ${nom.padEnd(10)} — pas d'histoire en cache, ignoree`); continue; }

    const signaux = serieSignaux(p.sig, c5);
    const sortie = { tpPctMargin: p.ov.tpPctMargin, trailActPctMargin: p.ov.trailActPctMargin,
                     slPctMargin: SL, trailCbPctMargin: CB, holdMs: p.ov.holdMs };
    const trades = simuler({ c5, signaux, sortie, lev: LEVIER });
    // L'état à l'entrée. L'état à la SORTIE serait plus flatteur et
    // parfaitement inutilisable : le moteur décide à l'entrée.
    for (const t of trades) t.etat = REGIME.etatA(index, t.tsIn);

    // La glissade : pour chaque bloc, le choix ne voit que l'avant.
    const perleSans = [], perleAvec = [];
    let dernierEcarte = null, dernierDetail = "", blocsUtiles = 0;
    for (let b = BLOCS - 1; b >= 0; b--) {
      const finBloc = finTs - b * JOURS_BLOC * 86400e3;
      const debutBloc = finBloc - JOURS_BLOC * 86400e3;
      const sel = trades.filter((t) => t.tsIn < debutBloc);
      const val = trades.filter((t) => t.tsIn >= debutBloc && t.tsIn < finBloc);
      if (sel.length < 8 || !val.length) continue;
      blocsUtiles++;

      const parEtat = {};
      for (const t of sel) (parEtat[t.etat] = parEtat[t.etat] || []).push(t);
      const ecartes = Object.entries(parEtat)
        .filter(([e, l]) => e !== "inconnu" && l.length >= MIN_TRADES_ETAT && l.reduce((a, t) => a + t.pnlMarge, 0) < 0)
        .map(([e]) => e);
      dernierEcarte = ecartes;
      dernierDetail = Object.entries(parEtat).sort((a, b2) => b2[1].length - a[1].length)
        .map(([e, l]) => `${e.slice(0, 4)} ${l.length}t ${l.reduce((a, t) => a + t.pnlMarge, 0).toFixed(2)}`).join(" · ");

      perleSans.push(...val);
      perleAvec.push(...val.filter((t) => !ecartes.includes(t.etat)));
    }
    if (!blocsUtiles) { lignes.push(`  ${nom.padEnd(10)} — pas assez d'histoire pour un seul bloc, ignoree`); continue; }

    // Le tableau descriptif par état, sur TOUS les trades. Il ne décide
    // rien — il montre où l'argent se gagne et où il se perd, ce qui est
    // la question que le propriétaire pose depuis le début.
    for (const t of trades) {
      const g = parEtatGlobal[t.etat] = parEtatGlobal[t.etat] || { trades: 0, gagnes: 0, net: 0 };
      g.trades++; g.net += t.pnlMarge; if (t.pnlMarge > 0) g.gagnes++;
    }

    const bSans = bilan(perleSans), bAvec = bilan(perleAvec);
    agregatSans.push(...perleSans); agregatAvec.push(...perleAvec);
    if (!bAvec.trades && bSans.trades) muettes++;

    const gain = bAvec.net - bSans.net;
    if (bAvec.trades === bSans.trades) egaux++;
    else if (gain > 1e-9) mieux++;
    else if (gain < -1e-9) pires++;
    else egaux++;

    lignes.push(`  ${nom.padEnd(10)} ecarte ${((dernierEcarte || []).join("+") || "rien").padEnd(36)} ` +
      `| ${blocsUtiles} blocs · sans ${String(bSans.trades).padStart(3)}t wr ${bSans.winrate.toFixed(0).padStart(3)}% net ${bSans.net.toFixed(2).padStart(6)} creux ${bSans.creux.toFixed(2)} ` +
      `| avec ${String(bAvec.trades).padStart(3)}t wr ${(bAvec.trades ? bAvec.winrate.toFixed(0) : "—").padStart(3)}% net ${bAvec.net.toFixed(2).padStart(6)} creux ${bAvec.creux.toFixed(2)}`);
    lignes.push(`  ${" ".repeat(10)} dernier choix par etat : ${dernierDetail}`);
  }

  for (const l of lignes) console.log(l);

  console.log(`[BANC-REGIME] ou l'argent se gagne (tous trades, description seulement) :`);
  for (const [e, g] of Object.entries(parEtatGlobal).sort((a, b) => b[1].trades - a[1].trades)) {
    console.log(`  ${e.padEnd(20)} ${String(g.trades).padStart(5)} trades · wr ${(100 * g.gagnes / g.trades).toFixed(1).padStart(5)} % · net ${g.net.toFixed(2).padStart(8)} · par trade ${(g.net / g.trades).toFixed(4).padStart(8)}`);
  }

  const gSans = bilan(agregatSans), gAvec = bilan(agregatAvec);
  const part = partBattue(agregatSans, agregatAvec, TIRAGES_TEMOIN);
  console.log(`[BANC-REGIME] ensemble, tous blocs hors echantillon confondus :`);
  console.log(`  sans filtre : ${gSans.trades} trades, wr ${gSans.winrate.toFixed(1)} %, net ${gSans.net.toFixed(2)}, creux max ${gSans.creux.toFixed(2)}`);
  console.log(`  avec filtre : ${gAvec.trades} trades, wr ${(gAvec.trades ? gAvec.winrate.toFixed(1) : "—")} %, net ${gAvec.net.toFixed(2)}, creux max ${gAvec.creux.toFixed(2)}`);
  console.log(`  trades gardes : ${gSans.trades ? (100 * gAvec.trades / gSans.trades).toFixed(0) : "—"} %`);
  console.log(`  perles ameliorees ${mieux} · degradees ${pires} · inchangees ${egaux} · reduites au silence ${muettes}`);
  console.log(`  temoin : le filtre bat ${part == null ? "—" : (100 * part).toFixed(1) + " %"} des retraits au hasard de meme taille (${TIRAGES_TEMOIN} tirages)`);
  console.log(`  le creux d'ensemble suppose une marge egale par trade et pas de limite de places :`);
  console.log(`  c'est faux du moteur, mais c'est la MEME approximation des deux cotes, donc la comparaison tient.`);
  console.log(`[BANC-REGIME] rappel : ce script ne branche rien. Le cablage attend un verdict qui le merite.`);
}

if (require.main === module) {
  main().catch((e) => { console.error("[BANC-REGIME] echec :", e.message); process.exit(1); });
}
