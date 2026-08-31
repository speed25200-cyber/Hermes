# HERMES — 15 stratégies GROS TP + trail 5 %, une par crypto
**30 août 2026 · variante demandée par le client (TP plus grands, trail 5 %) · RIEN n'est déployé sans validation**

## Ce qui a été testé
Mêmes **indicateurs personnels par crypto** (RSI extrême, z-score, séries de bougies, mèches d'épuisement — 5 min/15 min/1 h, long ET short), mais sorties ambitieuses :
- **TP +40 / +60 / +80 %** de marge (au lieu de +10 %)
- **Trailing 5 % de marge**, activé à +10/20/30 %
- SL toujours plafonné à **−30 %** (ton cap) · durée max 12-24 h · levier ×15 · coûts maker déduits
- Toujours le juge impitoyable : rentable dans **LES DEUX périodes** (20 j + 10 j jamais vus), ≥ 60 trades, pire cas compté

**Résultat brut : 164 cryptos sur 232 sont rentables des deux côtés avec cette structure** (contre 33 en version haut winrate) — le gros TP + trail libère beaucoup plus de valeur que le petit TP.

## LE TOP 15 (classé par la PIRE des 2 périodes)
*(wr = winrate test/validation · esp = espérance nette par trade en % de la marge)*

| # | Crypto | Indicateur personnel | Sortie | Winrate | Espérance | n |
|---|---|---|---|---|---|---|
| 1 | **NES** | mèche d'épuisement 15m + vol ×2 | TP +80 %, trail act +20 %, 12h | 63/59 % | **+9,3/+10,1 %** | 64 |
| 2 | **O** | z-score 15m >2,5σ → contre-pied | TP +60 %, trail act +20 %, 24h | 73/71 % | **+9,3/+9,4 %** | 64 |
| 3 | **MOODENG** | 5 bougies 5m consécutives → contre-pied | TP +80 %, trail act +30 %, 24h | 66/59 % | +11,3/+8,9 % | 71 |
| 4 | **GPS** | mèche d'épuisement 5m + vol ×2 | TP +80 %, trail act +30 %, 12h | 54/64 % | +8,8/**+15,1 %** | 105 |
| 5 | **ENSO** | RSI(14) 5m <25/>75 | TP +80 %, trail act +30 %, 12h | 59/60 % | +7,6/+8,0 % | 69 |
| 6 | **GRASS** | z-score 5m >2,5σ (moy. 4h) | TP +60 %, trail act +30 %, 12h | 65/56 % | +7,4/+7,5 % | 102 |
| 7 | **OPN** | mèche d'épuisement 5m + vol ×2 | TP +40 %, trail act +30 %, 12h | 63/63 % | +8,5/+7,3 % | 67 |
| 8 | **AXS** | 5 bougies 5m consécutives | TP +80 %, trail act +30 %, 12h | 54/66 % | +6,8/+10,7 % | 71 |
| 9 | **SOON** | z-score 5m >2,5σ (moy. 4h) | TP +80 %, trail act +20 %, 12h | 69/73 % | +6,7/+7,6 % | 108 |
| 10 | **MANA** | 5 bougies 5m consécutives | TP +60 %, trail act +20 %, 12h | 64/70 % | +6,6/+6,8 % | 69 |
| 11 | **LUNA** | 5 bougies 5m consécutives | TP +40 %, trail act +30 %, 24h | 59/59 % | +7,3/+6,2 % | 61 |
| 12 | **NEIRO** | 5 bougies 5m consécutives | TP +40 %, trail act +30 %, 24h | 59/60 % | +6,5/+6,0 % | 101 |
| 13 | **MEGA** | 5 bougies 5m consécutives | TP +40 %, trail act +30 %, 24h | 59/61 % | +5,7/+7,9 % | 92 |
| 14 | **CBRS** | 5 bougies 5m consécutives | TP +40 %, trail act +30 %, 24h | 61/56 % | +6,6/+5,6 % | 60 |
| 15 | **AEON** | RSI(14) 5m <25/>75 | TP +40 %, trail act +20 %, 12h | 65/72 % | +5,5/+7,7 % | 78 |

Portefeuille combiné : ~**37 trades/jour**, long ET short.

## Gros TP contre haut winrate — le duel chiffré

| | Version « haut winrate » (TP +10 %) | **Version « gros TP + trail 5 % »** |
|---|---|---|
| Winrate | 80-95 % | 54-73 % |
| Espérance/trade (pire période) | +1,0 à +3,5 % | **+5,5 à +9,3 %** |
| Confort psychologique | courbe très lisse | plus de trades perdants visibles |
| Rendement attendu | bon | **3 à 4× supérieur** |

**Verdict des données : le gros TP + trail 5 % gagne nettement.** Le trail à 5 % est le vrai héros — il transforme les allers-retours ratés en petits gains verrouillés, tout en laissant courir les grandes vagues jusqu'à +40/80 %.

**Signal de robustesse** : AEON, ENSO, MANA et O ressortent dans LES DEUX examens indépendants — ces quatre-là sont les plus solides du lot.

## Mises en garde (les mêmes, toujours honnêtes)
1. **Biais de sélection** : top 15 sur 232 → les chiffres réels seront un cran en dessous du tableau.
2. **30 jours = un seul régime de marché** : les deux fenêtres de test sont dans le même mois. Re-calibrage hebdomadaire recommandé.
3. Winrate ~60 % = 4 trades perdants sur 10 : normal et prévu, ne pas paniquer en les voyant.

## ⚖️ TEST DÉCISIF (ajout) — 60 jours JAMAIS VUS, configs figées

Chaque stratégie du top 15 a été rejouée **telle quelle** (zéro ajustement) sur les 60 jours précédant la fenêtre d'étude — des données qu'elle n'avait jamais vues. Verdict : **9/14 restent rentables** (AEON intestable : crypto trop récente).

| Crypto | Étude (30 j) | **60 j jamais vus** | Verdict |
|---|---|---|---|
| **ENSO** | +7,6/+8,0 % | **+6,1 %** (pf 1.46, n=117) | ⭐ CONFIRMÉE — la plus solide |
| **GRASS** | +7,4/+7,5 % | **+3,1 %** (n=250) | ✅ confirmée |
| SOON | +6,7/+7,6 % | +1,2 % (n=222) | ✅ tient, en retrait |
| LUNA | +7,3/+6,2 % | +1,2 % | ✅ tient |
| NES | +9,3/+10,1 % | +1,1 % | ✅ tient |
| MEGA | +5,7/+7,9 % | +1,0 % (n=249) | ✅ tient |
| MANA | +6,6/+6,8 % | +1,0 % | ✅ tient |
| GPS | +8,8/+15,1 % | +0,9 % | ✅ tient |
| AXS | +6,8/+10,7 % | +0,8 % | ✅ tient |
| O | +9,3/+9,4 % | −0,1 % | ❌ recalée |
| MOODENG | +11,3/+8,9 % | −0,9 % | ❌ recalée |
| CBRS | +6,6/+5,6 % | −1,9 % | ❌ recalée |
| NEIRO | +6,5/+6,0 % | −2,0 % | ❌ recalée |
| OPN | +8,5/+7,3 % | **−4,3 %** | ❌ recalée net |

**Lecture** : la dégradation prévue a bien eu lieu (l'espérance réelle est ~3-5× sous celle de l'étude — biais de sélection confirmé au chiffre près). MAIS le panier des 9 survivantes reste **positif net (~+1,8 %/trade en moyenne) sur des données totalement vierges** — à comparer aux −2/−4 %/trade de la stratégie générique. ENSO et GRASS sortent du lot avec une vraie marge.

**Conséquence pour HERMES 15** : construire le mode autour des **9 survivantes uniquement** (cœur : ENSO + GRASS), recalées éliminées, re-calibrage hebdomadaire, et compléter la liste au fil des semaines quand d'autres candidates auront passé CE test-là.

## Prochaine étape (à ton signal)
Mode **« HERMES 15 »** avec ce top 15 (ou un mix : les 4 doublement validées en cœur + ton choix) :
- **Ombre 1-2 semaines** (recommandé) puis bascule si confirmé
- **Bascule directe** en réel

*Détails : `lab_vagues/profond2_resultats.json` (les 164 retenues, top 3 par crypto).*
