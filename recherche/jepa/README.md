# Hermes-Astra × JEPA

`hermes_jepa_colab.ipynb` entraîne un JEPA (Joint-Embedding Predictive
Architecture) sur des bougies de 5 minutes de perpétuels crypto, puis mesure
si la représentation apprise contient de quoi trader aux règles d'Hermes.

## Ouvrir dans Colab

1. https://colab.research.google.com → *Fichier → Importer le notebook* →
   onglet *Importer*, déposer `hermes_jepa_colab.ipynb`.
   (Le dépôt est privé : l'onglet GitHub de Colab demande d'autoriser
   l'accès aux dépôts privés ; l'import direct du fichier évite cela.)
2. *Exécution → Modifier le type d'exécution → GPU (T4)*.
3. *Exécution → Tout exécuter*. Mode rapide : 15 à 20 min. Mode complet
   (`RAPIDE = False` dans la cellule 1) : 1 à 2 h.

## Données

Archives mensuelles publiques de Binance Futures USDT-M
(`data.binance.vision`, sans compte ni clé), 5 minutes, depuis 2023-01 en
mode complet, douze mois en mode rapide. Repli automatique sur l'API
publique OKX si le seau est inaccessible.

## Ce que le carnet produit

`hermes-jepa-sortie.zip` :

- `hermes_jepa.onnx` : fenêtre `(1, 288, 11)` → `(1, 2)` probabilités
  (baisse, hausse) ; vérifié contre PyTorch dans le carnet ;
- `normalisation.json` : médianes, écarts interquartiles, ordre des onze
  caractéristiques, seuil et sortie retenus ;
- `rapport.json` : données, journal d'entraînement, sonde, banc d'essai ;
- `jepa.pt` : poids PyTorch.

## Règles de lecture

Le banc d'essai de la cellule 7 est une réécriture de `modules/backtest.js`
(vérifiée trade par trade contre le JavaScript). La combinaison seuil /
sortie / durée est choisie sur la validation, le test est lu une seule fois.
Le JEPA doit battre le témoin sur caractéristiques brutes et passer les
portes du chercheur (winrate ≥ 55 %, gain moyen ≥ 0,02 de marge par trade,
au moins 12 trades), sinon il n'apporte rien à Hermes.

Brancher le modèle revient à ajouter un signal `jepa` dans
`modules/signaux.js` (via `onnxruntime-node`) et à laisser le chercheur de
perles le juger comme les treize autres. « Pas de perle = pas de trade »
reste la règle.
