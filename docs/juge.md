# Le juge honnête

Ce document décrit la pièce centrale d'Hermes-Astra depuis le
2 septembre 2026 : la procédure qui décide ce que le moteur a le droit
de trader. Tout le reste — signaux, sorties, capital, interface — est
subordonné à elle, parce qu'aucune de ces pièces ne peut créer un
avantage que la sélection n'a pas su distinguer du hasard.

## Le problème qu'il résout

L'ancien juge décidait avec trois seuils fixes : positif dans deux
sous-fenêtres disjointes, winrate ≥ 55 %, gain moyen ≥ 0,02 de marge par
trade. Ces seuils avaient été réglés pour que des marches aléatoires
gaussiennes ne passent presque jamais, et ils y parvenaient.

Douze mois de mesures ont montré que cela ne suffisait pas. Rejoué sur
des archives réelles dont on avait mélangé l'ordre des journées — même
distribution des rendements, mêmes queues épaisses, mêmes grappes de
volatilité, mais plus rien qui relie un jour au suivant — le juge
trouvait **autant** de perles que sur le vrai marché, et elles y
rapportaient **davantage** :

| | vrai marché | journées mélangées |
|---|---|---|
| perles trouvées | 53 sur 15 points | 53 sur 15 points |
| avantage brut par trade | −0,0012 | +0,0128 |
| t de Student | −0,22 | +2,39 |

Un seuil fixe ne peut pas faire mieux, et la raison est structurelle :
il ne sait pas ce que vaut « 0,02 de gain moyen ». Cela dépend de la
volatilité de l'instrument, du nombre de combinaisons essayées, de la
longueur de la fenêtre, de la forme des sorties. Une constante devinée
ne peut pas contenir tout cela.

## Le principe

La seule référence qui contient toutes ces dépendances est **la même
recherche, sur les mêmes données, privées de leur mémoire**.

Le juge ne demande donc plus « ce nombre dépasse-t-il 0,02 ? » mais :

> Ce nombre dépasse-t-il ce que cette recherche produit sur cet
> instrument quand il n'y a rien à trouver ?

Une perle doit atteindre le 90e percentile d'au moins douze répliques
mélangées. Sous ce seuil, elle est écartée — quels que soient son
winrate et son gain.

## Le mélange par blocs

`modules/juge.js` construit chaque réplique en découpant les
log-rendements de cinq minutes en **journées**, en mélangeant l'ordre
des journées, et en reconstruisant le prix.

Le choix du bloc d'une journée n'est pas arbitraire. Il conserve la
structure intra-journalière — l'heure de la session américaine, les
grappes de volatilité, l'alternance calme/agité — et ne détruit que la
mémoire d'un jour sur l'autre. Un bloc plus court détruirait aussi la
structure intra-journalière et rendrait le faux marché trop facile à
battre ; un bloc plus long garderait trop de mémoire et rendrait
l'épreuve trop sévère.

Les mèches sont transposées **en fraction de prix**. La première version
les reconstruisait au prorata de l'amplitude et les rétrécissait d'un
tiers : cinq des treize signaux ne lisent que des mèches, ils se
déclenchaient moins souvent sur la réplique que sur le vrai marché, et
leur épreuve devenait trop indulgente — précisément les signaux qu'il
faut le plus sévèrement tester. `banc/epreuve_juge.js` vérifie
aujourd'hui que la proportion de mèches survit au mélange.

## Ce que l'épreuve vérifie

`banc/epreuve_juge.js` teste ce que le mélange **conserve** autant que ce
qu'il détruit :

- l'écart-type des rendements, à 2 % près ;
- les queues épaisses (kurtosis), à 25 % près ;
- la proportion de mèches, à 10 points près ;
- la cohérence des bougies et la croissance des horodatages ;
- qu'aucun signal actif sur le vrai marché ne devient muet sur la
  réplique ;
- que l'enchaînement des journées est bien cassé (l'autocorrélation de
  la volatilité journalière s'effondre) ;
- **qu'une série déjà mélangée paraît ordinaire au milieu de ses propres
  répliques.** C'est le test décisif : s'il échouait, le mélange
  introduirait un biais et chaque perle serait jugée contre un étalon
  faussé.

## Le coût, et comment il est payé

Une distribution nulle coûte douze recherches complètes. Impensable
toutes les trente minutes, banal une fois par jour : ce qu'elle mesure —
combien d'avantage apparent cette procédure fabrique sur un instrument
de cette volatilité — ne bouge pas d'une demi-heure à l'autre. Le
résultat est donc mis en cache vingt heures, et **signé par la
procédure** : liste des signaux, grille des sorties, durées, seuils,
levier. Changer l'un de ces éléments invalide le cache, sans quoi le nul
d'hier servirait à juger la recherche d'aujourd'hui.

Le nul n'est calculé que pour les instruments qui ont déjà une perle —
trois à onze sur cinquante — ce qui met la première passe autour de
quatre minutes et les suivantes au niveau d'avant.

## Ce que cela a changé, en chiffres

Première passe avec la porte, sur les cinquante candidats habituels :
**trois perles sur onze survivent** (SHIB, STX, FIL), toutes au 100e
percentile de leur distribution nulle. Les huit autres sont écartées,
et le détail de leur rejet est le résultat le plus parlant de toute
l'étude :

| Perle écartée | Percentile atteint | Répliques mélangées livrant aussi une perle |
|---|---|---|
| XPL | 0e | 8 % |
| WLD | 33e | 50 % |
| LIT | 40e | 42 % |
| KITE | 50e | 17 % |
| ETHFI | 50e | 17 % |
| AVAX | 75e | 33 % |
| PEPE | 80e | 42 % |
| INJ | 86e | 58 % |

La colonne de droite est celle qu'il faut lire : sur des données où il
n'y a **rien** à trouver, l'ancienne procédure livrait quand même une
perle jusqu'à 58 % du temps sur ces instruments.

## Les réglages

| Variable | Défaut | Effet |
|---|---|---|
| `PERLES_NULL_TIRAGES` | 12 | nombre de répliques ; `0` désactive la porte et rend le comportement d'avant le 2 septembre |
| `PERLES_NULL_PERCENTILE` | 0,90 | percentile exigé |
| `PERLES_NULL_AGE_H` | 20 | durée de vie du cache, en heures |

## La règle qui n'a pas changé

Pas de perle, pas de trade. La porte du hasard ne fait que rendre cette
règle vraie : avant elle, « perle » voulait dire « meilleure de cent
cinquante-six tentatives sur les données qui l'ont désignée ». Elle veut
maintenant dire « a fait mieux que le hasard sur son propre
instrument ».
