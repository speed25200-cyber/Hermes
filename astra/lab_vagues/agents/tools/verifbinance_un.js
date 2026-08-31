// TEST ACIDE Binance — VERSION UNITAIRE : rejoue UN module candidat TEL QUEL sur 90 j de
// klines Binance (../databinance/<SYMBOL>USDT.json, format [[ts,o,h,l,c,vol],...] identique
// à celui attendu par harness_lib). Source de marché totalement distincte d'OKX (jamais vue
// pendant la recherche) : pas de coupureTs nécessaire, on évalue toute la fenêtre disponible.
// Mêmes règles harness_lib que verif90_harness.js : levier x15, coûts 0,12 % A/R, SL cap
// -30 % marge, pire cas dans la bougie (exits/coûts identiques, aucun paramètre modifié).
// SYMBOL dérivé de mod.instId en retirant le suffixe "-USDT-SWAP"
// (ex: ENSO-USDT-SWAP -> databinance/ENSOUSDT.json).
// NON_LISTE_BINANCE si le fichier databinance/<SYMBOL>USDT.json est absent ou vide (token
// non listé sur Binance ou non collecté).
// Usage : node tools/verifbinance_un.js candidates/mon_module.js
const fs = require("fs");
const path = require("path");
const { evaluer } = require(path.join(__dirname, "..", "harness_lib.js"));

const DATABINANCE = path.join(__dirname, "..", "..", "databinance");

(async () => {
  const modPath = process.argv[2];
  if (!modPath) { console.error("usage: node tools/verifbinance_un.js <candidates/module.js>"); process.exit(1); }
  const mod = require(path.resolve(__dirname, "..", modPath));

  const symbol = mod.instId.replace(/-USDT-SWAP$/, "");
  const symbolBinance = symbol + "USDT";
  const f = path.join(DATABINANCE, symbolBinance + ".json");
  if (!fs.existsSync(f)) {
    console.log(JSON.stringify({ instId: mod.instId, symbolBinance, verdict: "NON_LISTE_BINANCE" }, null, 1));
    return;
  }
  const c5 = JSON.parse(fs.readFileSync(f));
  if (!c5.length) {
    console.log(JSON.stringify({ instId: mod.instId, symbolBinance, verdict: "NON_LISTE_BINANCE", bougies: 0 }, null, 1));
    return;
  }

  const r = evaluer(mod, c5);   // pas de coupureTs : fenêtre Binance 100 % vierge
  const T = r.all;
  const out = {
    instId: mod.instId, symbolBinance, bougies: c5.length,
    fenetre: { de: new Date(c5[0][0]).toISOString(), a: new Date(c5[c5.length - 1][0]).toISOString() },
    espBinance: T?.esp ?? null, wrBinance: T?.wr ?? null, nBinance: T?.n ?? 0, pfBinance: T?.pf ?? null,
    verdict: (T && T.esp > 0 && T.n >= 25) ? "SURVIT" : "RECALE"
  };
  console.log(JSON.stringify(out, null, 1));
})();
