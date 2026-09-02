# L'avantage d'Hermes-Astra, mesuré

Ce document rapporte ce que quatre bancs d'essai ont mesuré sur le
système en place, en septembre 2026. Il est écrit pour être lu seul. Il
contient un résultat désagréable ; il est écrit quand même, parce qu'un
système qui trade de l'argent réel mérite d'être jugé sur des chiffres
plutôt que sur l'impression du dernier mois.

## La question

Le propriétaire décrit un symptôme précis : « j'ai des stratégies qui
fonctionnent assez bien, mais dès qu'il y a un retournement de marché,
ça ne fonctionne plus ». La mission confiée était d'ajouter une couche
qui connaîtrait l'état du marché et se tairait quand cet état ne convient
pas aux perles.

Avant de câbler cette couche, il fallait mesurer si elle aide. En la
mesurant, une question plus fondamentale est apparue, et c'est elle que
ce document traite : **le procédé de sélection produit-il un avantage sur
des données qu'il n'a pas vues ?**

## La méthode

Quatre bancs, tous fondés sur le simulateur qui fait foi
(`modules/backtest.js`) et sur le juge réel du chercheur
(`chercherPourInstrument`, importé et non recopié).

| Banc | Ce qu'il mesure |
|---|---|
| `banc/epreuve_regime.js` | le module d'état, hors ligne : sens, causalité, parité vivant/banc |
| `deploy/banc_regime.js` | le filtre par état appliqué au roster en place |
| `deploy/banc_chercheur.js` | le procédé de sélection lui-même, rejoué en glissade |
| mode « mélange de blocs » | ce que le hasard rapporte, comme étalon |

Trois disciplines gouvernent tout :

1. **Le choix ne voit jamais ce sur quoi il sera jugé.** À chaque point
   de la glissade, le juge travaille sur les trente jours qui précèdent,
   et l'on mesure sur les semaines qui suivent.
2. **Un témoin accompagne chaque filtre.** On retire au hasard autant de
   trades, et l'on regarde combien de tirages le filtre bat. Sans lui,
   « filtrer améliore » ne veut rien dire : quand l'espérance est
   négative, retirer des trades au hasard améliore aussi.
3. **Un étalon de hasard.** Les vrais rendements de cinq minutes sont
   redécoupés en journées et remélangés : même distribution, mêmes
   queues, mêmes grappes de volatilité, mais plus rien qui relie une
   journée à la suivante. Ce que le chercheur gagne là est le prix du
   hasard.

## Les données

Archives mensuelles publiques de Binance Futures USDT-M, cinq minutes,
du 1er septembre 2025 au 31 août 2026 — 105 120 bougies par instrument.
La période contient le retournement dont parle le propriétaire.

Deux biais sont assumés et signalés partout : l'univers de douze
instruments majeurs est fixe et choisi aujourd'hui, ce qui **favorise**
le système ; et rejouer une perle pendant trois semaines la garde bien
plus longtemps que le moteur vivant, qui rejuge toutes les trente
minutes, ce qui **défavorise** le système.

## Les résultats

### Le procédé de sélection, rejoué sur un an

Deux pas de reselection ont été essayés. Le pas de sept jours est le plus
proche du moteur vivant, qui rejuge toutes les trente minutes.

| | pas de 21 jours | pas de 7 jours |
|---|---|---|
| trades hors échantillon | 1 642 | 1 697 |
| winrate | 61,0 % | 60,4 % |
| net | −21,57 | −27,57 |
| par trade | −0,0131 | −0,0162 |
| creux maximal | 24,06 | 28,07 |
| frais payés | 24,63 | 25,45 |
| **net brut de frais** | **+3,06** | **−2,11** |
| **par trade brut** | **+0,0019** | **−0,0012** |
| **t de Student, brut** | — | **−0,22** |
| t de Student, net | — | −2,93 |

La dernière ligne est celle qui compte. Un |t| inférieur à 2 signifie
« indistinguable de zéro avec ces données ». L'avantage brut du procédé
vaut −0,0012 ± 0,0056 de marge par trade : **zéro**. La perte après
frais, elle, est significative.

Autrement dit : le chercheur ne trouve pas d'avantage que les frais
viendraient manger. Il ne trouve pas d'avantage du tout, et les frais
transforment ce zéro en perte certaine.

Reselectionner plus souvent n'y change rien — c'est même légèrement pire,
ce qui est le contraire de ce qu'on attendrait d'un procédé qui capte
quelque chose de réel et de fugace.

### Le filtre par état de marché

| | pas de 21 jours | pas de 7 jours |
|---|---|---|
| A, chercheur seul | −21,57 | −27,57 |
| B, chercheur + régime | −22,55 | −27,38 |
| témoin : part des retraits au hasard que B bat | 14,2 % | 35,0 % |

Un témoin autour de cinquante pour cent signifie que le filtre fait
exactement ce que ferait le hasard : il retire des trades d'un ensemble
qui perd. Sous cinquante, il fait moins bien que le hasard. **La couche
de régime n'apporte rien**, et ce n'est pas une question de réglage :
les trente-six réglages essayés donnent tous le même verdict au témoin.

La raison se lit dans le tableau par état du roster figé : les pertes ne
sont pas concentrées dans les tendances, elles sont **partout**
(−0,0096 en fourchette, −0,0095 en choc, −0,0181 en tendance baissière,
−0,0025 en tendance haussière). Il n'y a pas d'état où le système gagne
et dont il faudrait le protéger.

### Le contrôle par le hasard, et ce qu'il révèle

Le même procédé a été rejoué sur les mêmes instruments, après avoir
mélangé l'ordre des journées. La distribution des rendements est
identique — mêmes queues, mêmes journées agitées — et il ne reste rien
qui relie une journée à la suivante. Par construction, il n'y a **rien à
trouver** dans ces données.

| | vrai marché | journées mélangées |
|---|---|---|
| perles trouvées | 53 sur 15 points | 53 sur 15 points |
| trades | 1 642 | 1 890 |
| avantage brut par trade | −0,0012 | **+0,0128** |
| t de Student, brut | −0,22 | **+2,39** |

Le chercheur réussit **mieux sur des données sans structure que sur le
vrai marché**, et l'écart n'est pas dans le bruit. C'est le résultat le
plus instructif de toute l'étude, et il a deux lectures qui se
complètent.

La première : le procédé fabrique de l'avantage apparent à partir de
rien. Le bon étalon pour juger le vrai marché n'est donc pas zéro mais
+0,0128 ; mesuré contre son propre étalon de hasard, le système fait
nettement **moins bien** que le hasard.

La seconde explique le symptôme du propriétaire mieux que n'importe
quelle couche de régime. Mélanger les journées détruit une chose
précise : la **continuation des tendances**. Les stratégies de retour à
la moyenne prospèrent dans un monde sans tendances, et c'est exactement
le monde qu'on obtient en mélangeant. Le vrai marché, lui, en a. « Ça
marche, puis au retournement ça ne marche plus » est la façon dont on
ressent, de l'intérieur, une famille de stratégies construite pour un
monde qui n'existe pas.

### L'horizon long, cibles plus grandes et plus rares

Même procédé, mais la grille des sorties vise 1,2 à 2,5 de marge sur 48
à 168 heures au lieu de 0,3 à 0,8 sur 8 à 24 heures. Le nombre de trades
tombe de 1 642 à 275, et la facture de frais de 24,63 à 4,13.

| | horizon court | horizon long |
|---|---|---|
| trades | 1 642 | 275 |
| net | −21,57 | −4,36 |
| frais payés | 24,63 | 4,13 |
| **net brut de frais** | +3,06 | −0,24 |
| **par trade brut** | +0,0019 | −0,0009 |
| **t de Student, brut** | ≈ +0,4 | **−0,04** |

Encore zéro. Réduire les frais d'un facteur six ne révèle aucun avantage
caché, parce qu'il n'y en a pas à révéler. Cette expérience ferme la
dernière porte à l'intérieur de la famille de signaux actuelle.

### Le filtre par état de l'instrument

Une objection légitime au filtre par état du marché : une perle sur un
altcoin se moque peut-être de ce que fait BTC, et ne casse que lorsque
cet altcoin part en tendance. Le bras C applique donc la même formule à
la série de l'instrument lui-même.

| bras | net | par trade | témoin |
|---|---|---|---|
| A, chercheur seul | −4,36 | −0,0159 | — |
| B, état du marché | −4,87 | −0,0181 | 26,5 % |
| C, état de l'instrument | −5,64 | −0,0208 | 4,3 % |

Les deux variantes dégradent le résultat et perdent contre leur témoin.
L'objection était bonne, la réponse est non.

## Ce que cela veut dire

Le symptôme décrit par le propriétaire — « ça marche, puis au
retournement ça ne marche plus » — a une explication plus simple que le
régime de marché : **ce qui marche est la fenêtre sur laquelle le choix
a été fait.** Le chercheur désigne la meilleure de cent cinquante-six
combinaisons sur vingt-trois jours. La meilleure de cent cinquante-six
tirages a toujours l'air bonne sur les données qui l'ont désignée, et
elle redevient moyenne ensuite. Le « retournement » n'est pas la cause,
c'est le moment où l'illusion cesse.

Et le contrôle par mélange va plus loin que « le juge laisse passer du
bruit » : il montre que le juge préfère le bruit. Les trois gardes du juge — positif dans deux sous-fenêtres, winrate
minimum, gain moyen minimum — ont été réglées pour que des marches
aléatoires ne passent presque jamais. Le contrôle montre qu'elles n'y
suffisent pas : le taux de découverte et la performance ultérieure sont
les mêmes sur du bruit que sur le vrai marché.

## Ce qui n'a pas été câblé, et pourquoi

Rien n'a été branché dans le moteur ni dans le chercheur. La couche de
régime existe, elle est testée, elle est documentée, et elle **reste
débranchée** parce qu'aucune mesure ne l'a méritée. Le moteur tourne
exactement comme avant cette mission.

Construire par-dessus les couches prévues par le dossier — un modèle
Kronos affiné, un plongement JEPA, un méta-modèle de confiance — n'a pas
de sens tant que la base n'a pas d'avantage : aucune couche ne crée un
avantage qui n'existe pas en dessous d'elle.

## Ce qui reste à essayer, par ordre d'intérêt

L'horizon a été essayé et il ne donne rien (ci-dessus). Restent :

1. **Un juge qui se compare au hasard.** Plutôt que des seuils fixes, le
   chercheur devrait mesurer la performance de sa candidate contre la
   distribution obtenue sur des versions mélangées du MÊME instrument,
   et n'accepter qu'un percentile élevé. C'est la correction la plus
   utile à l'architecture existante, et elle est implémentable dans le
   juge actuel.
2. **L'exécution maker sur les deux jambes.** Elle divise les frais par
   deux au mieux. Elle ne rend pas rentable un système sans avantage,
   mais elle réduit la perte, et elle est sans risque de modèle.
3. **Une autre famille de stratégies.** Classement transversal entre
   instruments plutôt que signal par instrument ; données que le prix ne
   contient pas déjà (financement, intérêt ouvert, liquidations) ;
   horizons de quelques heures à quelques jours.

## Ce que le propriétaire doit décider

Le compte est réel et le moteur tourne. La mesure dit qu'il perd environ
1,6 % de marge par trade sur douze mois de données. Le dernier mois a
été favorable, et l'impression de bon fonctionnement est réelle ; elle
ne survit pas à un an d'histoire.

Mettre le moteur en pause, réduire la mise, ou continuer, est une
décision qui appartient au propriétaire seul. Rien n'a été changé dans
ses réglages de risque, et aucune position n'a été touchée.
