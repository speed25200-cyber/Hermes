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
