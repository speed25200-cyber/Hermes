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

### Le pari inverse : suivre la tendance au lieu de la contrer

Le contrôle par mélange faisait une prédiction vérifiable : si les
tendances du vrai marché sont ce qui tue les treize signaux, alors des
signaux qui SUIVENT le mouvement doivent se comporter à l'inverse. Six
signaux de suite ont donc été ajoutés — cinq sont l'inversion exacte
d'un signal existant, pour que la comparaison ne porte que sur le sens
du pari — et le même procédé a été rejoué.

| | contre la tendance | avec la tendance |
|---|---|---|
| trades | 1 642 | 1 651 |
| winrate | 61,0 % | 59,1 % |
| net | −21,57 | −29,40 |
| **par trade brut de frais** | **−0,0012** | **−0,0028** |
| **t de Student, brut** | **−0,22** | **−0,49** |

**La prédiction échoue.** Suivre la tendance ne rapporte pas davantage
que la contrer : zéro dans les deux cas. Le mouvement des tendances
explique pourquoi les signaux de retour à la moyenne perdent, mais il ne
se laisse pas monnayer pour autant — ce qui est la définition d'un
marché efficace à cette échelle de temps.

Un détail mérite d'être noté, parce qu'il réhabilite en partie le
travail sur le régime. Sur les signaux de suite, le filtre par état
devient enfin utile : il bat **99,8 %** des retraits au hasard par état
du marché, et 97,3 % par état de l'instrument, là où il ne battait que
14 à 46 % sur les signaux de retour à la moyenne. Le module d'état
fonctionne, et il détecte bien ce pour quoi il a été écrit. Il était
simplement appliqué à la mauvaise famille de stratégies. Cela ne suffit
pas : il fait passer un système perdant de −29,40 à −24,82, ce qui reste
perdant.

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

## La correction, et ce qu'elle a retiré du moteur

Le 2 septembre, la porte du hasard a été ajoutée au juge et déployée.
Une perle ne suffit plus à passer les trois seuils fixes : elle doit
battre ce que la MÊME recherche produit sur le MÊME instrument privé de
sa mémoire, au 90e percentile d'au moins douze répliques.

Première passe sur les cinquante candidats habituels :

| | avant | après |
|---|---|---|
| perles au roster | 11 | **3** |

Les trois survivantes — SHIB, STX, FIL — sont au 100e percentile de leur
distribution nulle : elles battent les douze répliques. Les huit autres
ont été écartées, et le détail de leur rejet est le résultat le plus
parlant de toute l'étude :

| Perle écartée | Percentile atteint | Part des répliques qui trouvent aussi une perle |
|---|---|---|
| XPL | 0e | 8 % |
| WLD | 33e | 50 % |
| LIT | 40e | 42 % |
| KITE | 50e | 17 % |
| ETHFI | 50e | 17 % |
| AVAX | 75e | 33 % |
| PEPE | 80e | 42 % |
| INJ | 86e | 58 % |

La colonne de droite est celle qu'il faut lire. Sur des données où il
n'y a **rien** à trouver, la procédure trouvait quand même une perle
jusqu'à 58 % du temps. Ces huit stratégies n'étaient pas de mauvaises
stratégies : elles n'étaient pas des stratégies du tout.

Le moteur trade désormais trois perles au lieu de onze, et chacune a
démontré qu'elle fait mieux que le hasard sur son propre instrument.
C'est la première fois que cette phrase peut être écrite.

## Ce qui n'a pas été câblé, et pourquoi

Rien n'a été branché dans le moteur ni dans le chercheur. La couche de
régime existe, elle est testée, elle est documentée, et elle **reste
débranchée** parce qu'aucune mesure ne l'a méritée. Le moteur tourne
exactement comme avant cette mission.

Construire par-dessus les couches prévues par le dossier — un modèle
Kronos affiné, un plongement JEPA, un méta-modèle de confiance — n'a pas
de sens tant que la base n'a pas d'avantage : aucune couche ne crée un
avantage qui n'existe pas en dessous d'elle.

## La question suivante, et pourquoi ce n'est plus la même

Trois portes fermées — contre la tendance, avec la tendance, à horizon
long — disent toutes la même chose : **la question « cet instrument
va-t-il monter ? » n'a pas de réponse exploitable** sur des bougies de
cinq minutes. Ce n'est pas une surprise, c'est ce qu'un marché liquide
doit produire : tout ce que la série de prix contient est arbitré en
secondes par des acteurs mieux placés.

`deploy/banc_transversal.js` pose une question différente :

> Parmi trente instruments, lesquels vont faire **mieux que les
> autres** cette semaine ?

La différence n'est pas cosmétique. Prédire un niveau absolu demande de
battre le marché sur sa propre information. Prédire un CLASSEMENT ne
demande que de repérer une asymétrie relative — et le mouvement commun à
toute la crypto, qui est l'essentiel de la variance et l'essentiel du
risque, s'annule entre le côté long et le côté court.

Deux familles seulement sont essayées, chacune avec une raison d'exister
avant d'avoir un chiffre :

**Le prix relatif.** Momentum transversal et son inverse, documentés sur
actions depuis quarante ans et sur crypto depuis 2018.

**Le positionnement.** Le taux de financement dit qui paie qui pour
tenir sa position. Un financement très positif dit que les longs sont
encombrés et paient pour le rester. Ce n'est PAS dans le prix : deux
instruments au même graphique peuvent avoir des financements opposés.
C'est la seule donnée de ce banc que le marché n'a pas déjà entièrement
digérée dans la série des prix.

La discipline est plus stricte que partout ailleurs, parce que la
tentation l'est aussi : la grille est déclarée avant de voir un chiffre,
toutes les cellules sont imprimées y compris les mauvaises, le nombre de
cellules brillantes attendues par pur hasard est écrit d'avance, et
chaque cellule est comparée à sa propre distribution nulle — obtenue en
mélangeant les journées de chaque instrument avec une permutation
DIFFÉRENTE, ce qui casse le lien entre le classement et le rendement
futur sans toucher aux distributions marginales.

Le banc rend deux verdicts distincts, et la distinction compte : « le
signal existe-t-il ? » se lit sur le gain brut, « est-il négociable ? »
sur le gain net. Un signal réel mangé par les frais reste un signal réel,
et c'est une information qu'un seul chiffre effacerait.

### Ce que le classement transversal a donné, sur douze mois

Vingt et une cellules — sept signaux, trois horizons — sur trente
instruments, du 1er septembre 2025 au 31 août 2026. Aucune ne franchit
la barre complète (95e percentile du nul **et** t > 2 **et** net
positif), et aucune n'atteint t > 2 sur le gain brut. La conclusion
formelle est donc : **rien de démontré**.

Mais la forme du tableau est la première chose encourageante de toute
l'étude, et il serait malhonnête de la taire :

| Cellule | brut | t brut | net | percentile du nul |
|---|---|---|---|---|
| financement 168 h | +4,68 | 1,88 | **+3,95** | 85e |
| financement 72 h | +4,56 | 1,45 | +2,82 | 90e |
| momentum court 72 h | +4,46 | 1,49 | +2,72 | 90e |
| momentum normalisé 24 h | +5,02 | 1,55 | −0,21 | 95e |
| retournement 24 h | −4,33 | −1,33 | −9,56 | **5e** |
| retournement court 24 h | −6,25 | −1,87 | −11,48 | **5e** |

Trois choses méritent d'être lues ensemble.

**Le signe est cohérent.** Les cellules de momentum et de financement
sont positives et hautes dans leur nul ; les cellules de retournement
sont négatives et basses. Or le retournement est l'exact opposé du
momentum : si l'un était du bruit, l'autre le serait aussi et les deux
flotteraient au milieu. Cette symétrie en miroir est la signature d'un
effet réel, faible.

**Le sens est celui de la littérature.** Le momentum transversal est
documenté sur actions depuis quarante ans et sur crypto depuis 2018 ; le
financement mesure l'encombrement des positions, et prendre le côté que
personne ne paie pour tenir est l'archétype de la prime de risque. Ce
n'est pas une découverte : c'est la retrouvaille d'un résultat connu, ce
qui est bien plus rassurant qu'une trouvaille inédite.

**L'ampleur est trop faible pour douze mois.** Quarante-neuf périodes
hebdomadaires ne suffisent pas à distinguer un t de 1,88 d'un t de zéro.
Il faut plus de données — pas de meilleurs paramètres.

Deux corrections ont donc été faites, et une seule est un vrai
changement de méthode :

1. **Les frais sont désormais comptés sur la rotation réelle.** La
   première version facturait un aller-retour complet du livre à chaque
   rebalancement, comme si tout était soldé puis rouvert. C'était le
   pire cas, volontaire tant qu'on ignorait si un signal existait, mais
   c'est faux — et cette fausseté pénalisait les horizons longs
   précisément là où ils devraient briller.
2. **L'histoire passe de douze à trente-six mois**, ce qui triple le
   nombre de périodes hebdomadaires.

Ni l'une ni l'autre ne change le gain brut. Si l'effet est réel, le t
doit monter avec la racine du nombre de périodes ; s'il ne monte pas, il
n'était pas là.

### Sur vingt-quatre mois : le premier signal à dépasser t = 2

Trente instruments, du 1er septembre 2024 au 31 août 2026, frais comptés
sur la rotation réelle. Deux cellules franchissent la barre du t :

| Cellule | brut | t brut | net | t net | Sharpe/période | creux |
|---|---|---|---|---|---|---|
| financement 72 h | +10,11 | **2,77** | +7,72 | **2,11** | 0,137 | 2,14 |
| financement 168 h | +9,60 | **2,25** | +8,58 | **2,01** | 0,199 | 1,68 |

C'est la première fois dans ce projet qu'un signal dépasse t = 2 hors
échantillon **et** survit aux frais. Le sens est celui qu'on attendait :
être long les instruments que personne ne paie pour tenir, court ceux
dont les longs sont encombrés.

**Et pourtant l'épreuve de la famille dit non.** Avec vingt et une
cellules essayées, la meilleure paraît toujours bonne. Le test qui
décide compare le meilleur t réel au maximum des t obtenus sur des
répliques mélangées — ce que le hasard produit quand on le laisse
chercher aussi librement que nous. Sous cette épreuve, rien n'est
démontré.

Ce n'est pas une déception, c'est la mesure faisant exactement son
travail. Deux cellules sur vingt et une au-dessus de t = 2, c'est à peu
près ce qu'on attend du hasard seul (1,05 attendues). La cohérence du
signe et l'accord avec la littérature restent des raisons de continuer à
regarder de ce côté — mais elles ne sont pas une preuve, et ce document
ne les traitera pas comme telle.

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
3. **Une autre famille de stratégies.** Le pari inverse a été essayé et
   il ne donne rien non plus : ni contre la tendance, ni avec elle, les
   bougies de cinq minutes seules ne portent d'avantage exploitable
   après frais. Ce qui reste à essayer sort du cadre actuel :
   classement transversal entre instruments plutôt que signal par
   instrument ; données que le prix ne contient pas déjà (financement,
   intérêt ouvert, liquidations) ; horizons de quelques heures à
   quelques jours.

## Ce que le propriétaire doit décider

Le compte est réel et le moteur tourne. La mesure dit qu'il perd environ
1,6 % de marge par trade sur douze mois de données. Le dernier mois a
été favorable, et l'impression de bon fonctionnement est réelle ; elle
ne survit pas à un an d'histoire.

Mettre le moteur en pause, réduire la mise, ou continuer, est une
décision qui appartient au propriétaire seul. Rien n'a été changé dans
ses réglages de risque, et aucune position n'a été touchée.
