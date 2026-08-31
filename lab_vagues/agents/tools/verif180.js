// 2e TEST ACIDE — VÉRIF : rejoue les modules CHAMPIONS du REGISTRE, TELS QUELS
// (zéro paramètre touché), sur la fenêtre J-180 -> J-90 collectée par collecte180.js
// (data180/) : 90 jours 100 % vierges ET ANTÉRIEURS à toute la recherche (data/ = 30 j,
// data90/ = 90 j récents). Un AUTRE régime de marché — un champion qui survit ici
// a passé DEUX époques hors-échantillon distinctes.
// Règles : evaluer() du harness commun (coûts, pire-cas, blocage symbole), pas de
// coupure (toute la fenêtre est vierge), agrégat r.all — mêmes barres que verif90 :
// SURVIT si esp > 0 et n >= 25 ; HISTORIQUE_INSUFFISANT si < 15 000 bougies (crypto
// trop jeune pour cette fenêtre — on le DIT au lieu de conclure à tort).
// Usage : node tools/verif180.js   -> tableau + tools/rapports/verif180_resultats.json
const fs = require("fs");
const path = require("path");
const { evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));

const DATA180 = path.join(__dirname, "..", "..", "data180");
const RAPPORTS = path.join(__dirname, "rapports");
fs.mkdirSync(RAPPORTS, { recursive: true });
const MIN_BOUGIES = 15000; // même seuil que verif90_harness (≈52 j sur 90)

// crypto -> module(s) champions (REGISTRE + journal rondes 4/5 : GRASS et SOON ont
// chacune 2 prétendants, on rejoue les deux tels quels, étiquetés).
const CHAMPIONS = [
  { instId: "PIEVERSE-USDT-SWAP", module: "web_structure_1.js", ref60: 7.98, note: "double creux/sommet W144 (RECORD, EN_LIVE)" },
  { instId: "ENSO-USDT-SWAP",     module: "multiech_2.js",      ref60: 6.74, note: "RSI14-5m extrême + moitié de range 24h" },
  { instId: "O-USDT-SWAP",        module: "ti_arsenal_2.js",    ref60: 4.69, note: "reclaim Keltner EMA20±3ATR" },
  { instId: "GRASS-USDT-SWAP",    module: "champions_2.js",     ref60: 1.31, note: "z-score SMA48 ±2,5σ fade, cb 20 %" },
  { instId: "GRASS-USDT-SWAP",    module: "tf4h_1.js",          ref60: 4.51, note: "z5m ±2,5σ + z1h aligné (verif90 non vierge)" },
  { instId: "USELESS-USDT-SWAP",  module: "patterns_2.js",      ref60: 3.0,  note: "avalement après série de 4" },
  { instId: "GPS-USDT-SWAP",      module: "gen_regime_3.js",    ref60: 4.81, note: "mèche 60 %+vol2x + moitié de range 24h" },
  { instId: "SOON-USDT-SWAP",     module: "web_vwap_1.js",      ref60: 1.99, note: "reclaim bande VWAP 2σ (au REGISTRE)" },
  { instId: "SOON-USDT-SWAP",     module: "gen_keltner_2.js",   ref60: 3.64, note: "reclaim Keltner (survivant ronde 5)" },
  { instId: "ESP-USDT-SWAP",      module: "tv_ehlers_2.js",     ref60: 2.12, note: "Fisher L9 reclaim ±2,5 + ADX15m<25" }
];

const meta = JSON.parse(fs.readFileSync(path.join(DATA180, "_meta.json")));
const lignes = [];
for (const ch of CHAMPIONS) {
  const f = path.join(DATA180, ch.instId + ".json");
  const base = { instId: ch.instId, module: ch.module, esp60_ref: ch.ref60, note: ch.note };
  if (!fs.existsSync(f)) { lignes.push({ ...base, verdict: "HISTORIQUE_INSUFFISANT", bougies: 0 }); continue; }
  const c5 = JSON.parse(fs.readFileSync(f));
  if (c5.length < MIN_BOUGIES) {
    const l = { ...base, verdict: "HISTORIQUE_INSUFFISANT", bougies: c5.length, couverture_pct: +(100 * c5.length / 25920).toFixed(1) };
    // indicatif seulement si un bout d'histoire existe quand même (jamais un verdict)
    if (c5.length >= 5000) {
      const mod = require(path.join(__dirname, "..", "candidates", ch.module));
      const T = evaluer(mod, c5).all;
      if (T) Object.assign(l, { indicatif: { esp: T.esp, wr: T.wr, n: T.n, pf: T.pf } });
    }
    lignes.push(l); continue;
  }
  const mod = require(path.join(__dirname, "..", "candidates", ch.module));
  if (mod.instId !== ch.instId) { lignes.push({ ...base, verdict: "ERREUR_INSTID", bougies: c5.length }); continue; }
  const T = evaluer(mod, c5).all; // fenêtre entièrement vierge -> tout agrégé (comme verif90)
  lignes.push({
    ...base, bougies: c5.length,
    esp180: T ? T.esp : null, wr180: T ? T.wr : null, n180: T ? T.n : 0, pf180: T ? T.pf : null,
    verdict: (T && T.esp > 0 && T.n >= 25) ? "SURVIT" : "RECALE"
  });
}

const out = {
  _doc: "2e test acide : champions du REGISTRE rejoués tels quels sur J-180->J-90 (data180/, fenêtre 100 % vierge et antérieure). Barres identiques à verif90 : SURVIT = esp>0 & n>=25.",
  fenetre: { de: new Date(meta.t180).toISOString(), a: new Date(meta.t90).toISOString() },
  resultats: lignes
};
fs.writeFileSync(path.join(RAPPORTS, "verif180_resultats.json"), JSON.stringify(out, null, 1));

console.log("Fenêtre vierge :", out.fenetre.de.slice(0, 10), "->", out.fenetre.a.slice(0, 10));
console.log("MODULE".padEnd(20), "CRYPTO".padEnd(10), "esp180".padStart(7), "wr".padStart(6), "n".padStart(5), "pf".padStart(6), "ref60".padStart(6), " VERDICT");
for (const l of lignes) {
  const c = l.instId.replace("-USDT-SWAP", "");
  if (l.verdict === "HISTORIQUE_INSUFFISANT")
    console.log(l.module.padEnd(20), c.padEnd(10), "—".padStart(7), "—".padStart(6), String(l.bougies).padStart(5), "—".padStart(6), String(l.esp60_ref).padStart(6), " HISTORIQUE_INSUFFISANT" + (l.indicatif ? ` (indicatif ${l.couverture_pct}% : esp ${l.indicatif.esp}, n ${l.indicatif.n})` : ""));
  else
    console.log(l.module.padEnd(20), c.padEnd(10), String(l.esp180).padStart(7), String(l.wr180).padStart(6), String(l.n180).padStart(5), String(l.pf180).padStart(6), String(l.esp60_ref).padStart(6), " " + l.verdict);
}
