# HERMES — Propositions d'amélioration de la stratégie
**30 août 2026 · document d'aide à la décision — RIEN n'est appliqué sans ton OK**

---

## Méthode (pour que tu saches ce que valent ces chiffres)

- **Données** : 250 cryptos les plus tradées d'OKX × 30 jours × bougies 5 min = **2,1 millions de bougies** (collectées cette nuit, données publiques)
- **Testé** : 72 définitions de vague (hausse de +3/5/8/12 % en 30 min/1 h/2 h, avec/sans volume) × 2 sens (surfer / shorter) × 60 structures de sortie (TP/SL/trailing)
- **Anti-illusion** : chaque config jugée séparément sur les 20 premiers jours (IS) ET les 10 derniers (OOS) ; en cas de doute dans une bougie, le **pire cas** est compté (stop avant TP) ; coûts réels déduits (0,20 % prix aller-retour en ordres marché = **4 % de la marge** à levier ×20)
- Les chiffres = **espérance nette par trade en % de la MARGE** (ta langue : TP +50 %, SL −20 %)

---

## Verdict 1 — l'entrée n'est pas le levier (6e confirmation)

**Les 72 variantes d'entrée perdent toutes, net de coûts, dans les deux périodes.**
Meilleure : −3 % de marge/trade. C'est cohérent avec les 5 campagnes de recherche précédentes.

MAIS deux enseignements fermes :

| Enseignement | Preuve |
|---|---|
| **Shorter les vagues (ton style) est le bon sens** | Surfer en long les pompes de +12 % : **−12 %/trade** (pire config de tout le test). Le short est systématiquement moins mauvais que le long, sur toutes les tailles de vague |
| **Le brut est quasi à l'équilibre — ce sont les COÛTS qui coulent la stratégie** | Espérance brute ≈ −1/+1 % de marge ; coûts = 4 %/trade. L'ennemi est la caisse enregistreuse, pas le signal |

---

## Verdict 2 — ta structure de sortie actuelle coupe les gagnants trop tôt

Ta spec actuelle : TP +50 % marge · SL −20 % · trailing 10 % activé à +10 %.
Le problème mesuré : **le trailing s'active si tôt (+10 % de marge) qu'il fauche les trades avant qu'ils n'atteignent le TP**. Résultat : plein de mini-gains, pertes pleines. Winrate 45 % mais perte nette.

Comparaison sur les mêmes vagues, mêmes entrées (net, % marge/trade, IS / OOS) :

| Structure de sortie | Ordres marché (actuel) | Ordres limite (maker) |
|---|---|---|
| **Actuelle** (TP +50 / SL −20 / trail 10 @ +10) | −3,9 / −1,9 | −1,9 / +0,1 |
| **Meilleure** (TP +80 / SL −30 / **sans trail précoce**) | −2,2 / −0,5 | **−0,2 / +1,5** |
| Variante trail tardif (SL −20 / trail 10 @ **+20**) | −2,9 / −1,7 | −0,9 / +0,3 |

Lecture honnête : **aucune** structure n'est franchement gagnante en ordres marché. La combinaison « sorties élargies + ordres limite » est la seule qui approche/dépasse l'équilibre.

---

## Les 4 propositions (à valider une par une)

### P1 — Élargir les sorties : TP +80 % marge · SL −30 % · trailing activé à +20 % (au lieu de +10 %)
Laisse respirer les vagues au lieu de les faucher à +10 %. Gain mesuré : **+1,4 à +1,7 % de marge par trade** vs la structure actuelle. Même fréquence, même style — on sort juste moins tôt.
*(Variante conservatrice si tu veux garder SL −20 % : trail 10 % activé à +20 % → gain ~+1 %/trade.)*

### P2 — Entrées en ordre limite (maker) avec bascule marché après 5 s
Même vague, même moment, mais l'ordre se pose au prix au lieu de traverser le carnet : les coûts passent de ~4 % à ~2 % de marge par trade. Gain mécanique : **~+2 %/trade**, aucune intelligence ajoutée, fréquence préservée par la bascule automatique en ordre marché si non exécuté en 5 s.

### P3 — Priorité aux grosses vagues quand plusieurs signaux se présentent
Les vagues **+8 % en 1 h avec volume ≥ 2×** donnent les meilleurs chiffres par trade (encore ~38 occasions/jour sur l'univers — largement assez pour 10 places). Simple tri de priorité, ne supprime aucun trade.

### P4 — Shorts uniquement
Le bot peut actuellement générer des entrées long (vu dans les logs : ZK, SIGN…). Les données montrent que les longs sur pompes sont catastrophiques dans TOUTES les configurations. Couper les longs = éviter le pire compartiment prouvé.

**Effet cumulé estimé (P1+P2+P4)** : de **−3,9/−1,9** actuellement à **≈ 0 / +1,5 %** de marge par trade. Pas un jackpot — un passage de « saignée lente » à « équilibre avec une vraie chance d'être vert ».

---

## Ma recommandation

1. **Valider P1 + P2 + P4** (P3 en bonus, gratuit)
2. Les faire tourner **2-3 semaines en OMBRE** (simulation papier en parallèle du bot réel, mêmes signaux) pour vérifier les chiffres en conditions réelles
3. Décision finale sur les vrais résultats comparés

Alternative si tu veux aller plus vite : appliquer directement P1/P2/P4 au bot réel — c'est ton capital, ta décision. Les changements sont réversibles en 5 minutes.

## Ce qui ne change dans AUCUN cas
Ton style (vague → surf → sortie), 10 positions, levier ×20, budget 90 % du capital, protections sur OKX, fréquence de trades. Pas de funding, pas d'arbitrage, pas d'usine à gaz.

---
*Fichiers de travail : `lab_vagues/` (collecte, anatomie, sorties — reproductible). Le bot live n'a pas été modifié.*
