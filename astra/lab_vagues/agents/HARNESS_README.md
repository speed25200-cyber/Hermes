# Contrat du banc d'essai — chasse aux records HERMES

## Le record à battre
**+6,1 % de marge par trade** (net) sur les 60 jours jamais vus — détenu par ENSO (RSI14-5m extrême, TP +80 %, trail 5 % act +30 %, 12 h). N°2 : GRASS +3,1 %.

## Données
- `../data/<INSTID>.json` : 250 instruments × 30 jours de bougies 5 m, format `[[ts,o,h,l,c,vol,volCcy],...]` ascendant. (~8 640 bougies chacun)
- `../univers.json` : volumes 24 h. Exclure les actions tokenisées (AAPL, SPX, TSLA, NVDA, MSTR, SKHYNIX, SKHY, SNDK, CRCL, HOOD, COIN, GOOG…, GOOGL, META, AMZN, MSFT, AMD, INTC, QQQ, GLD, XAUT, TRUMP — liste étendue vue en ronde : AXTI, MRVL, MU, NBIS, SOXL/SOXS, TQQQ, EWY, CXMT, SAMSUNG, XIAOMI, UNITREE, ZHIPU, MINIMAX, XAU/XAG/XCU, BEAT, BZ, CBRS, CL, CC, CHIP, DRAM, SLX, ROBO, SPCX, SPACE, LITE, OPG, BARD, SKDD, SNXX, AAOI, AVGO, TSM, SPY, BILL).
- `../profond2_resultats.json` / `../profond_tous_resultats.json` : ce qui a DÉJÀ été testé (RSI14 15/20/25 · z-score SMA48/96 ±2,5/3,5σ · séries de 5/7 bougies · mèches d'épuisement, sur 5m/15m/1h — inutile de les refaire à l'identique).

## Écrire un candidat
Un fichier `candidates/<ton_id>.js` :
```js
module.exports = {
  instId: "XXX-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 12 }, // % de MARGE (levier x15) ; sl <= 0.30 IMPOSÉ
  detect(c5) {           // c5 = bougies closes ascendantes
    const out = [];
    for (let i = 100; i < c5.length; i++) { /* ... */ if (signalLong) out.push({ i5: i, dir: 1 }); if (signalShort) out.push({ i5: i, dir: -1 }); }
    return out;          // {i5: index de la bougie de signal, dir: +1 long / -1 short}
  }
};
```
⚠️ `detect` ne doit JAMAIS regarder après `i` (pas de futur). Le harness gère coûts, pire-cas, blocage par symbole, IS/OOS.

## Évaluer
- `node test_harness.js candidates/<id>.js` → JSON avec `espIS/espOOS/worst/valide` (30 j, IS 20 j / OOS 10 j).
- Critères minimum : `valide:true` (esp > 0 des DEUX côtés, n ≥ 60, nOOS ≥ 15). Objectif : `worst ≥ +5 %`.
- Le test final (60 j jamais vus) sera exécuté par les vérificateurs avec `verif90_harness.js` — ne le lance pas toi-même sur des dizaines de candidats (quota API).

## Anti-triche
Pas de paramètres absurdes ni de sur-optimisation fine (pas de seuils à 3 décimales). Grilles GROSSIÈRES. Chaque candidat retenu doit avoir une LOGIQUE de marché racontable en une phrase.
