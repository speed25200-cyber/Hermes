# HERMES — Les 15 stratégies à haut winrate (80-90 %), une par crypto
**30 août 2026 · analyse approfondie demandée par le client · RIEN n'est déployé sans validation**

## Méthode (résumé)
- **232 cryptos scannées** (actions tokenisées exclues) sur 30 jours de bougies 5 min (2,1 M de bougies)
- Par crypto : **~40 signaux indicateurs** (RSI 14 extrême, z-score vs moyenne, séries de bougies consécutives, mèches d'épuisement + volume — sur 5 min/15 min/1 h, long ET short) × 6 structures de sortie orientées haut winrate
- Sorties : TP +10/20/30 % de marge, **SL plafonné à −30 %** (ton cap), sortie de secours 4 h/12 h, levier ×15, **coûts maker déduits**
- **Rétention stricte** : winrate ≥ 78 % ET espérance positive dans LES DEUX périodes (20 j de test + 10 j de validation jamais vus), minimum 60 trades, pire cas compté dans chaque bougie
- Résultat brut : **33 cryptos sur 232 passent l'examen** → voici les 15 meilleures (classées par leur PIRE période — pas leur meilleure)

## LES 15 STRATÉGIES
*(wr = winrate test/validation · esp = espérance nette par trade en % de la marge · n = nombre de trades sur 30 j)*

| # | Crypto | Indicateur spécifique | Sortie | Winrate | Espérance | n |
|---|---|---|---|---|---|---|
| 1 | **MANA** | z-score 5m : prix à >2,5σ de sa moyenne 8h → contre-pied | TP +10 %, max 12h | 79/86 % | +3,6/+2,7 % | 73 |
| 2 | **ENSO** | 5 bougies 15m consécutives → contre-pied | TP +10 %, max 4h | 83/83 % | +2,1/+2,4 % | 93 |
| 3 | **AEON** ⭐ | RSI(14) 5m : <25 → long, >75 → short | TP +10 %, max 4h | **84/95 %** | +2,0/+6,2 % | 97 |
| 4 | **BASED** | mèche d'épuisement 5m + volume ×2 → contre-pied | TP +10 %, max 12h | **89**/84 % | +3,7/+1,9 % | 100 |
| 5 | **RAVE** | mèche d'épuisement 15m + volume ×2 → contre-pied | TP +10 %, max 12h | 84/86 % | +1,9/+2,8 % | 60 |
| 6 | **BILL** | z-score 5m >2,5σ (moyenne 4h) → contre-pied | TP +10 %, max 4h | 83/82 % | +1,8/+2,0 % | 156 |
| 7 | **SOPH** | mèche d'épuisement 5m + volume ×2 → contre-pied | TP +10 %, max 12h | 81/86 % | +1,5/+2,8 % | 65 |
| 8 | **KSM** | z-score 5m >2,5σ (moyenne 4h) → contre-pied | TP +10 %, max 12h | 83/83 % | +1,7/+1,5 % | 138 |
| 9 | **PARTI** | z-score 15m >2,5σ → contre-pied | TP +10 %, max 12h | 83/83 % | +1,2/+1,5 % | 70 |
| 10 | **ONDO** | z-score 15m >2,5σ → contre-pied | TP +10 %, max 12h | 84/82 % | +1,9/+1,1 % | 60 |
| 11 | **OPG** | 5 bougies 15m consécutives → contre-pied | TP +10 %, max 12h | 82/**89 %** | +1,1/+3,8 % | 78 |
| 12 | **PENGU** | z-score 15m >2,5σ → contre-pied | TP +10 %, max 4h | 81/82 % | +2,5/+1,1 % | 77 |
| 13 | **HMSTR** | z-score 5m >2,5σ (moyenne 4h) → contre-pied | TP +10 %, max 12h | 81/83 % | +1,1/+1,5 % | 143 |
| 14 | **ZKP** | RSI(14) 5m : <25 → long, >75 → short | TP +10 %, max 4h | 80/83 % | +1,0/+1,5 % | 76 |
| 15 | **KAITO** | mèche d'épuisement 15m + volume ×2 → contre-pied | TP +10 %, max 4h | 83/79 % | +1,4/+0,9 % | 65 |

Toutes : **long ET short**, SL −30 % marge, levier ×15, entrées maker. **Portefeuille combiné ≈ 45 trades/jour** — de quoi remplir les 10 places en continu.

## L'ADN commun (ce que les données disent)
Les 15 gagnantes font toutes la même chose : **prendre le contre-pied des excès** (prix trop étiré, panique/euphorie de courte durée) sur des cryptos nerveuses, avec un objectif MODESTE (+10 % de marge) encaissé vite, et un filet à −30 %. Le haut winrate vient de là : on demande peu au marché, souvent. BTC/ETH/SOL sont absentes — les données le confirment : les grosses ne se retournent pas assez proprement.

## Les mises en garde du professionnel (à lire)
1. **Winrate ≠ invincibilité** : à TP +10 %/SL −30 %, une perte efface 3 gains. À 82 % de winrate ça gagne ; si le winrate réel glisse sous ~76 %, ça perd. La marge de sécurité existe mais elle n'est pas infinie.
2. **Biais de sélection** : choisir les 15 meilleures sur 232, c'est mécaniquement favoriser les chanceuses. Les chiffres réels seront probablement un cran SOUS les chiffres du tableau. C'est pour ça que je recommande la validation en ombre.
3. **30 jours de données** : un seul régime de marché. Re-calibrage hebdomadaire indispensable (je peux l'automatiser).

## Prochaine étape proposée
Construire le mode **« HERMES 15 »** : le bot ne surveille que ces 15 cryptos, chacune avec SON indicateur et SES sorties (au lieu du score générique sur 100). Puis :
- **Option prudente (recommandée)** : 1-2 semaines en ombre (papier) en parallèle du live actuel → on compare → bascule si confirmé
- **Option directe** : bascule immédiate du live sur les 15 stratégies

*Détails complets par crypto (y compris les 18 autres retenues et toutes les recalées) : `lab_vagues/profond_tous_resultats.json`.*
