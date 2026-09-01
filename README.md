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
production, et ils sont partis dans un commit poussé sur ce dépôt
avant d'être retirés.

Une correction s'impose ici, parce que la première version de ce
paragraphe disait le dépôt public et en tirait des conséquences plus
graves qu'elles ne le sont. Vérification faite par l'API, il est
**privé** (`visibility: private`) : ces clés n'ont donc pas été
exposées au monde, seulement à qui a accès au dépôt. Cela réduit
l'urgence, cela ne l'annule pas — l'historique garde ce qu'on y a
écrit, et un secret dans un dépôt ne se répare pas en le supprimant.

## Réglages qui décident du comportement

**Correction.** Ce paragraphe renvoyait à `config/strategy.current.json`
et `config/policy.json`. Vérification faite, le moteur ne lit ni l'un
ni l'autre : `strategy.current.json` n'est référencé que par
`modules/engine.js`, qu'`app/main.js` ne charge jamais, et les seuils
de sortie sont écrits en dur dans `app/main.js`. Régler ces fichiers ne
change donc rien — et c'est le genre d'erreur qui coûte une soirée.

Ce qui décide réellement :

| réglage | où | défaut |
|---|---|---|
| levier | `HERMES_DEFAULT_LEVERAGE` | 15 |
| positions simultanées | `HERMES_MAX_POSITIONS` | 10, **réduit à ce que le capital finance** |
| part du capital engageable | `HERMES_MAX_RISK_PCT` | 0,90 (coussin de 10 %) |
| équité sous laquelle rien n'est tenté | `HERMES_MIN_EQUITY_USDT` | 5 |
| plancher / plafond de marge par trade | `HERMES_MARGIN_MIN` / `HERMES_MARGIN_MAX` | 1 / 200 |

Les seuils de sortie sont la constante `SPEC` d'`app/main.js` :
take-profit à +80 % de la marge, stop à −30 %, armement du trail à
+10 %, rappel de 5 %.

### La taille des positions

Elle se recalcule **à chaque décision**, à partir de l'équité que le
compte affiche sur le moment — jamais d'un montant écrit à l'avance.

    usable        = équité × 0,90
    marge / trade = min(usable ÷ 2, plafond), plancher si franchi
    places        = usable ÷ marge, borné par HERMES_MAX_POSITIONS

Ce que cela donne :

| équité | marge / trade | notionnel (×15) | places |
|---:|---:|---:|---:|
| 10 USDT | 4,50 | 68 | 2 |
| 20 USDT | 9,00 | 135 | 2 |
| 334 USDT | 150,30 | 2 255 | 2 |
| 1 000 USDT | 200,00 | 3 000 | 4 |

Le nombre de places était auparavant fixé à 10 quel que soit le
capital. Le plan annonçait donc 1 503 USDT de marge pour 300
disponibles, et 90 pour 9 — une garde budgétaire séparée rattrapait
l'affaire sans rien dire, ce qui déplaçait la décision là où elle était
illisible. Le plancher de marge, lui, valait 50 USDT : sur un compte de
10, il écrasait la règle de la moitié et faisait partir **tout** le
capital dans un seul trade.

Un capital petit peut ne financer aucun lot : à 68 USDT de notionnel,
le pas minimal de BTC (0,1 contrat, soit ~110 USDT) est hors d'atteinte.
Le moteur imprime alors, et à chaque changement de taille, une ligne
`[TAILLE]` qui nomme les instruments accessibles et ceux qui ne le sont
pas. Sans elle, l'échec est muet : le moteur tourne, reçoit les
signaux, et n'ouvre rien.

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
week-end pendant que celle d'une crypto ne bouge guère. Ce rapport a
donc été mesuré et imprimé pour chaque candidat, **sans en faire un
seuil**, le temps de voir les nombres. Les voici, relevé du 31 août :

| sous 0,26 | au-dessus de 0,42 |
|---|---|
| SPCX 0,05 · SNDK 0,07 · SNXX 0,07 · SOXL 0,08 · MU 0,09 · SKHY 0,16 · SKHYNIX 0,21 · XAU 0,25 · CL 0,25 · XAG 0,26 | BTC 0,42 · HYPE 0,48 · XRP 0,50 · PEPE 0,53 · ETH 0,54 · SOL 0,56 · DOGE 0,58 · PUMP 0,65 · SUI 0,69 · ZEC 0,87 · TRUMP 1,25 · UNI 2,29 |

Dix d'un côté, douze de l'autre, et rien entre les deux. Le groupe bas
est exactement celui des actions tokenisées — plus l'or, l'argent et le
pétrole, auxquels je n'avais pas pensé. Le seuil est donc posé **dans ce
vide**, à 0,34 : il n'est pas choisi, il est lu.

**Deux exceptions, écrites ici pour qu'elles ne se perdent pas.** ZORA
(0,22) et 0G (0,08) sont des cryptos et tombent dans la bande basse.
Elles sont écartées à tort. C'est le prix assumé d'un seuil unique, et
il est réversible : `HERMES_MARKETS` les réimpose, `HERMES_WEEKEND_MIN=0`
désactive le critère.

Et une réserve qui compte : ce seuil repose sur **une** lecture. Un vide
observé une fois n'est pas une loi. Un jeton qui vient d'être listé, ou
un pic d'actualité en semaine, produisent le même chiffre qu'une bourse
fermée — les deux exceptions sont peut-être cela. Un second relevé, un
autre jour, dira s'il tient.

Le résultat est imprimé pour **tous** les candidats, admis compris. Un
critère qui ne s'explique que lorsqu'il dit non est à moitié aveugle :
on ne peut alors pas savoir s'il laisse passer ce qu'il devrait refuser.

Une mesure ratée — un timeout — ne compte pas comme une discontinuité :
l'instrument passe, et le rafraîchissement suivant retentera. Refuser
sur un timeout viderait l'univers à la première minute difficile.
