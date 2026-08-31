# Hermes

Robot de trading sur les perpétuels OKX. Il ouvre en long comme en
short, avec levier et taille dynamique, et se pilote depuis une page
web.

Ce dépôt repart de la version **Hermes Astra v4.2.5**, qui apporte les
stratégies validées. L'état antérieur, un moteur Python distinct, reste
récupérable au commit `ccb34a6`.

## Les stratégies

Le classement du 31 août 2026 a soumis chaque candidate à quatre
épreuves : trois fenêtres temporelles disjointes sur OKX (60 j récents,
90–180 j, 180–365 j) et une contre-validation sur Binance Futures. Deux
seulement passent les quatre — et c'est le résultat le plus important
du document, bien plus que les scores eux-mêmes.

| Stratégie | 60 j | 180 j | 365 j | Binance |
|---|---:|---:|---:|---:|
| **GPS** — signal simple + moitié favorable du range 24 h | +4,81 | +3,25 | +1,54 | **+7,33** |
| **SOON** — Keltner reclaim (EMA20 ± 3 ATR) | +3,64 | +0,55 | +0,69 | +2,61 |

Les chiffres sont en pourcentage de marge par trade, net.

Une deuxième ligne existe — ENSO v1 et v2, SOON-VWAP, ACT, POPCAT, LIT,
O-Keltner — validée sur deux fenêtres, à conviction réduite.

Trois leçons du travail qui a produit ce classement, et elles valent
d'être lues avant de toucher au moteur :

1. Les avantages **durables** sont rarissimes : deux sur environ cent
   quarante modules testés, deux millions de bougies, cent cinq mille
   paires d'indicateurs.
2. Un score de banc supérieur à +8 est presque toujours un mirage. Les
   deux élites font +1,5 à +5 par fenêtre, pas +10.
3. Ce qui brille sur une époque meurt souvent sur l'autre. D'où la
   règle des trois fenêtres, désormais obligatoire.

## Comment c'est fait

    app/          la page et le processus principal
    modules/      le moteur : signaux, exécution, risque, simulation
    services/     les connexions OKX, REST et WebSocket
    config/       stratégie courante, politique de sortie, risque, univers
    lab_vagues/   le laboratoire de recherche qui a produit le classement
    deploy/       le rapatriement et la préparation d'import

## Les clés d'API

Elles vivent dans un fichier `.env` **sur la machine**, jamais dans le
dépôt. `.gitignore` les refuse, et le script d'import les refuse deux
fois : par le nom du fichier, puis par son contenu.

Ce n'est pas une précaution théorique. L'archive d'origine contenait
trois fichiers d'environnement portant de vraies clés OKX de
production, et ils sont partis dans un commit poussé sur ce dépôt —
qui est public — avant d'être retirés. Les clés concernées ont dû être
changées. Un secret dans un dépôt ne se répare pas en le supprimant.

## Réglages qui décident du comportement

`config/strategy.current.json` porte le levier (20), la marge par trade
(20 USDT), le nombre de positions simultanées (10) et les échelles de
take-profit, stop-loss, break-even et trail.

`config/policy.json` porte les seuils de sortie exprimés en pourcentage
de la marge : stop initial à −40 %, passage au point mort à +25 %,
armement du trail à +40 %.

## L'univers

Hermes trade les **vingt perpétuels USDT au plus gros volume sur OKX**,
classés en dollars et rafraîchis toutes les heures.

Le classement se faisait auparavant sur le champ `volCcy24h` seul. C'est
un volume exprimé dans la monnaie de base de chaque instrument : trier
dessus revient à comparer des BTC à des DOGE, donc à classer par nombre
de pièces et non par argent échangé. SHIB et PEPE écrasaient
mécaniquement BTC — le classement obtenu n'était pas « les plus gros
volumes » mais « les moins chers ». Il est désormais multiplié par le
dernier prix.

La rotation est imprimée au journal, entrées et sorties nommées : un
univers qui change en silence est un univers dont on ne peut pas
expliquer les trades après coup. Un instrument sur lequel une position
est ouverte ne quitte jamais l'univers, sinon le moteur cesserait de
recevoir son prix et ne pourrait plus ni la surveiller ni la fermer.

Réglages :

| variable | défaut | effet |
|---|---|---|
| `HERMES_UNIVERSE_SIZE` | 20 | combien d'instruments |
| `HERMES_UNIVERSE_REFRESH_MS` | 3 600 000 | à quelle fréquence rejouer le classement |
| `HERMES_MARKETS` | vide | liste imposée à la main, qui court-circuite tout le reste |

### Le critère 24/7

J'avais d'abord écrit que les actions tokenisées cotées par OKX
n'apparaîtraient pas au niveau du top 20, et qu'aucun filtre n'était donc
nécessaire. La première mesure a démenti cela en trois minutes : **sept
des vingt places** étaient occupées par SNDK, XAU, SKHYNIX, SPCX, MU,
SOXL et CL.

Elles ne s'échangent pas le week-end. Une stratégie calibrée sur un
marché continu y rencontre des trous : des prix figés, des stops
traversés à la réouverture, des signaux qui se déclenchent sur des
bougies mortes.

J'ai alors compté les heures qui ont vu un échange sur sept jours, en
supposant qu'une action tokenisée en ferait trente-cinq contre cent
soixante-huit pour une crypto. **La mesure m'a démenti une seconde
fois : tous affichent 168/168**, SNDK et SPCX comme BTC.

L'explication est que je regardais le mauvais objet. Ce sont des
*perpétuels OKX* sur ces actions, pas les actions : le perpétuel
s'échange bien vingt-quatre heures sur vingt-quatre même bourse fermée.
Le critère était bien formé et ne répondait pas à la question posée.

Ce qui les distingue réellement est que leur activité s'effondre le
week-end pendant que celle d'une crypto ne bouge guère. Ce rapport est
donc **mesuré et imprimé** pour chaque candidat — mais ce n'est pas
encore un seuil. Poser un seuil sur un nombre vu une seule fois est
exactement l'erreur commise deux fois de suite ici. Il le deviendra
quand plusieurs relevés auront montré où passe la séparation.

En attendant, les sept actions tokenisées **sont dans l'univers**, et
il faut le savoir plutôt que de le découvrir.

Le résultat est imprimé pour **tous** les candidats, admis compris. Un
critère qui ne s'explique que lorsqu'il dit non est à moitié aveugle :
on ne peut alors pas savoir s'il laisse passer ce qu'il devrait refuser.

Une mesure ratée — un timeout — ne compte pas comme une discontinuité :
l'instrument passe, et le rafraîchissement suivant retentera. Refuser
sur un timeout viderait l'univers à la première minute difficile.
