# HERMES — 15 cryptos, stratégies sur mesure par crypto
**30 août 2026 · sélection + recherche sur les 2,1 M de bougies collectées · RIEN n'est déployé sans ton OK**

## Méthode
- **Sélection des 15** : score volatilité × volume sur les 250 collectées (il faut que ça bouge ET que ce soit liquide). Actions tokenisées exclues.
- **Par crypto** : 24 familles de stratégies testées — mouvement de ±2/4/7 % en 30 min/1 h/3 h, avec/sans volume, en **fade** (contre le mouvement) ou **follow** (avec le mouvement), **long ET short** (le déclencheur est symétrique : baisse violente → long en fade / short en follow).
- **Sorties = ta nouvelle spec** : levier ×15, TP +80 % / SL −30 % / trail 5 % activé à +20 %, coûts maker comptés.
- **Anti-illusion** : une stratégie n'est retenue QUE si elle est positive nette sur les 20 premiers jours ET les 10 derniers, pire cas compté. Sinon la crypto est déclarée « sans edge robuste » — pas de forçage.

## Les 15 sélectionnées
BEAT · ZEC · ETH · PUMP · BTC · SOL · BICO · GIGGLE · HYPE · ENA · AEON · XRP · SNDK · O · GRVT

## Résultat : 8 stratégies retenues / 15
*(esp. = espérance nette par trade en % de la marge ; IS = 20 premiers jours, OOS = 10 derniers)*

| Crypto | Stratégie | esp. IS | esp. OOS | Winrate OOS | Trades/j | Confiance |
|---|---|---|---|---|---|---|
| **BICO** | fade ±7 % en 1 h | +0,7 % | +14,8 % | 57 % | 6,8 | ★★★ (203 trades) |
| **ENA** | follow ±4 % en 3 h vol≥2× | +8,6 % | +2,6 % | 63 % | 3,4 | ★★★ (102 trades) |
| **PUMP** | fade ±4 % en 30 min vol≥2× | +16,5 % | +7,4 % | 70 % | 1,0 | ★★ (30 trades) |
| **XRP** | follow ±4 % en 3 h vol≥2× | +26,2 % | +9,0 % | 65 % | 0,9 | ★★ (26 trades) |
| **O** | fade ±7 % en 3 h vol≥2× | +16,8 % | +22,3 % | 85 % | 0,6 | ★★ (19 trades) |
| **ZEC** | follow ±7 % en 3 h vol≥2× | +29,3 % | +4,3 % | 67 % | 0,6 | ★ (17 trades) |
| **BTC** | follow ±2 % en 3 h | +24,0 % | +1,6 % | 55 % | 0,5 | ★ (16 trades) |
| **GIGGLE** | follow ±2 % en 3 h | +0,2 % | +0,1 % | 56 % | 11,4 | ~0, à écarter |

**Sans edge robuste (déclaré honnêtement)** : BEAT, ETH, SOL, HYPE, AEON, SNDK, GRVT — aucune des 24 familles n'y est positive dans les deux périodes. Forcer une stratégie dessus serait du surajustement.

## Lecture honnête
- **Le portefeuille des 7 retenues** (hors GIGGLE) donne ~**14 trades/jour** cumulés — de quoi occuper les 10 places — avec une espérance positive dans les DEUX périodes pour chacune.
- **Confiance à 3 étoiles seulement pour BICO et ENA** : les autres ont peu de trades (16-30), leurs beaux chiffres peuvent dégonfler. C'est le lot des stratégies par crypto : moins de données par symbole.
- Enseignement intéressant : les **grosses cryptos (BTC, XRP, ZEC) préfèrent le follow** (suivre le mouvement 3 h) tandis que les **petites (BICO, PUMP, O) préfèrent le fade** (prendre le contre-pied) — cohérent avec la théorie (momentum sur les liquides, sur-réaction sur les petites).

## Prochaine étape possible (à valider)
1. **Mode « HERMES 15 »** : le bot ne trade que ces 7-8 cryptos, chacune avec SA stratégie (au lieu du score général sur 100 symboles). Même mécanique : 10 places, protections OKX, maker, ×15.
2. **D'abord 1-2 semaines en ombre** (papier, en parallèle du live actuel) pour vérifier que les chiffres tiennent — fortement recommandé vu les petits échantillons.
3. **Re-calibrage hebdomadaire** : je relance la collecte + la recherche chaque semaine, les stratégies suivent le marché.

*Détails complets : `lab_vagues/quinze_resultats.json` (toutes les configs testées par crypto, y compris les recalées).*
