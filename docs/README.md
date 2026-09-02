# Les documents d'Hermes-Astra

Quatre documents, dans l'ordre où il faut les lire si l'on découvre le
projet.

| Document | Ce qu'il contient |
|---|---|
| [`avantage.md`](avantage.md) | **Le rapport de mesure.** Ce que le système gagne ou perd, établi sur douze mois d'archives avec témoins et contrôles. À lire en premier : tout le reste en découle. |
| [`juge.md`](juge.md) | **Le juge honnête.** La procédure qui décide ce que le moteur a le droit de trader, et la porte du hasard qui a retiré huit perles sur onze. |
| [`regime.md`](regime.md) | **L'état du marché.** La couche de régime, ce qu'elle mesure, et pourquoi elle n'est pas câblée. |
| [`../recherche/jepa/README.md`](../recherche/jepa/README.md) | Le carnet Colab d'entraînement d'un JEPA sur les bougies, livré et non branché. |

## Ce que le 2 septembre 2026 a changé

Une seule chose, mais elle gouverne tout le reste : **le juge se compare
désormais au hasard plutôt qu'à des seuils devinés.**

Avant, une perle était la meilleure de cent cinquante-six combinaisons
sur vingt-trois jours, retenue si elle dépassait trois constantes. Douze
mois de mesures ont montré que cette procédure trouvait autant de perles
sur des données mélangées — donc sans rien à trouver — que sur le vrai
marché, et qu'elles y rapportaient davantage.

Maintenant, une perle doit battre ce que la même recherche produit sur
le même instrument privé de sa mémoire. Trois perles sur onze ont
survécu au premier passage.

Cette correction a une limite qu'aucune quantité de calcul ne franchit :
elle punit d'avoir trop cherché, elle ne remplace pas le fait de n'avoir
pas cherché du tout. Le seul remède connu à cela est d'écrire
l'hypothèse avant que les données n'existent, puis d'attendre. C'est ce
qui a été fait le 2 septembre, et `deploy/hors_echantillon.js` en tient
le relevé — y compris le calcul, peu réjouissant, du temps qu'il faudra
avant que la réponse soit lisible : environ deux ans.

## Les bancs

| Banc | Ce qu'il juge | Comment le lancer |
|---|---|---|
| `banc/epreuve_juge.js` | le mélange par blocs et la distribution nulle | `node banc/epreuve_juge.js` |
| `banc/epreuve_regime.js` | le module d'état : sens, causalité, parité vivant/banc | `node banc/epreuve_regime.js` |
| `banc/epreuve_langues.js` | la parité FR/EN/SQ et les clés demandées par le code | `node banc/epreuve_langues.js` |
| `banc/scene-details.js` | la console rejouée sur fixtures, avec Chromium | `node banc/scene-details.js` |
| `banc/epreuve_hors_echantillon.js` | l'hypothèse pré-inscrite : gelée, conforme au document, correctement coupée | `node banc/epreuve_hors_echantillon.js` |
| `deploy/banc_regime.js` | le filtre par état sur le roster en place | entrée `banc_regime` du workflow |
| `deploy/banc_chercheur.js` | le procédé de sélection, en glissade sur un an | entrée `banc_chercheur` |
| `deploy/banc_transversal.js` | le classement entre instruments | entrée `transversal` |
| `deploy/hors_echantillon.js` | l'hypothèse du 2 septembre, sur les seules données postérieures | entrée `hors_echantillon` |

Les cinq premiers tournent hors ligne, sans réseau et sans clé. Les
quatre derniers tournent sur le VPS et ne lisent que des archives
publiques ; seul le relevé hors échantillon écrit quelque chose, et
c'est son propre journal.

## La règle qui n'a pas bougé

Pas de perle, pas de trade. Aucun des travaux de cette journée n'a
touché aux réglages de risque, n'a fermé de position, ni n'a branché
quoi que ce soit qui n'ait d'abord battu le hasard.
