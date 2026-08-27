# Hermes — audit complet

État au 25 août 2026, 07:00 UTC. Chaque chiffre de ce document a été
mesuré, jamais estimé. Quand une mesure manque, c'est écrit.

---

## 1. Ce que fait Hermes, en une page

Hermes prédit la **prochaine bougie** et trade dans le sens prédit, long
ou court, sur les perpétuels USDT les plus échangés d'OKX.

La chaîne complète, de la bougie à la position :

```
bougies OKX (1m, 3m, 5m, 15m, 1H)
   │
   ├─ feat_matrix : 31 colonnes causales par actif
   │    prix, forme de bougie, volatilité relative, volume, funding,
   │    flux taker, open interest, base mark/index, heure, séquence
   │    des 8 derniers retours, proximité du règlement, week-end
   │
   ├─ croise() : 3 colonnes transversales
   │    retour BTC, résidu contre le panel, décalage BTC → alts
   │
   ├─ CandleModel.fit_panel() : la RECHERCHE
   │    4 860 cellules = 5 échelles × 3 familles × 9 seuils
   │                     × 3 horizons × 6 stops × 2 variantes
   │    validation glissante, 6 plis, purgés et embargoés
   │
   ├─ la PORTE : sr du portefeuille > barre déflatée
   │    la barre paie la prime de sélection sur 4 860 essais
   │
   ├─ ScaleDesk.fuse() : les 5 échelles votent
   │
   └─ ScalpEngine : taille, levier, bracket, exécution
        Kelly déflaté × parité de risque × frein × rodage,
        plafonné par la ruine (2,5 % par stop touché)
```

Le principe qui gouverne tout : **une seule horloge parle pour tout le
panel au même instant**. Ce n'est pas un modèle par actif, c'est un
modèle par échelle, entraîné sur tous les actifs mis en commun après
division par leur volatilité propre — pour que BTC et DOGE puissent
nourrir la même matrice.

---

## 2. Où en est l'argent

Le courtier tient un livre de vie entière dont l'identité boucle au
centime :

```
depart            +10 000,00 USD
avant le livre       -661,23 USD   (non décomposé)
brut réalisé           +6,10 USD
frais                  -3,02 USD   (3,53 bps sur 8 565 traités)
financement            -0,00 USD
latent                 -0,13 USD
                   ─────────────
equite              +9 341,71 USD   (-6,58 %)
```

**Le poste qui compte est « avant le livre » : -661 USD.** Il date d'un
mode antérieur qui ouvrait des micro-positions sur devinette de flux
toutes les deux minutes et payait des frais pour rien. Ce mode est
supprimé.

Depuis que le livre existe, le brut réalisé est **positif** (+6,10) et
couvre les frais (-3,02). C'est récent — le brut était encore à -3,13 à
03:27 — et cela ne prouve rien à ce stade. Cela indique seulement que
le compte ne saigne plus.

---

## 3. L'économie, et pourquoi c'est difficile

Ce qui décide qu'une échelle est tradable, c'est le rapport entre le
mouvement DISPONIBLE et le coût de l'aller-retour. Le coût est plat —
environ 7 bps, entrée postée plus sortie traversée — pendant que le
mouvement croît comme la racine du temps.

Sur un actif à 10 bps de sigma la minute :

| échelle × horizon | mouvement | coût | rapport |
|---|---|---|---|
| 1m × 1 | 10 bps | 7 bps | **1,4** |
| 1m × 6 | 24 bps | 7 bps | 3,5 |
| 15m × 6 (90 min) | 95 bps | 7 bps | 13,6 |
| 1H × 6 (6 h) | 190 bps | 7 bps | **27** |

À la minute, le coût mange la moitié de ce qui bouge : il faut une
précision de prédiction que la littérature ne rapporte nulle part. À
l'heure, il en mange 4 %.

Ce n'est pas que la minute soit impossible — c'est qu'elle exige un
avantage dix fois plus grand pour le même résultat. Les cinq échelles
sont cherchées ensemble et la porte tranche.

---

## 4. La porte, et pourquoi elle refuse si souvent

Une règle est retenue quand le Sharpe de son portefeuille dépasse la
**barre déflatée** — le Sharpe qu'on obtiendrait par pur hasard en
cherchant 4 860 cellules.

```
barre ≈ 3,63 / racine(instants non chevauchants)
```

Ce facteur 3,63 a été vérifié contre une hypothèse nulle dure — queues
de Student, volatilité auto-entretenue, séries dérivées persistantes.
La formule reproduit le 95e centile du maximum du hasard à 3 % près.
**Il n'y a pas d'avantage à libérer en assouplissant la porte.**

Conséquence directe : la barre ne dépend QUE du nombre d'instants. D'où
l'importance du panel.

Les deux relevés ci-dessous sont ceux du journal, chacun avec la grille
de son moment (2 592 cellules le 24, 4 860 le 25) — d'où un léger écart
avec la formule appliquée à la grille d'aujourd'hui.

| | 24 août 20:00 | 25 août 03:27 |
|---|---|---|
| jambes au panel | 6 | élargi |
| instants mesurés | 290 | **1 408** |
| barre | 0,207 | **0,097** |
| marge (sr − barre) | +0,035 | **~0,29** |
| net qui dimensionne | +1,1 bps | **+14,6 bps** |
| taille pleine justifiée | 1 429 USD | **15 330 USD** |

Le net annoncé brut (+23 bps) n'est jamais celui qui dimensionne : c'est
le maximum d'une recherche, il porte une prime de chance. Le net
**déflaté** la retire, et c'est lui qui entre dans Kelly.

---

## 5. Pourquoi les positions sont petites

La taille traverse six étages, dans cet ordre :

| étage | effet mesuré au 25/08 |
|---|---|
| net déflaté | +14,6 bps (et non +23) |
| Kelly quart | — |
| parité de risque | part ∝ 1/volatilité |
| plafond de ruine | 2,5 % des fonds propres par stop touché |
| frein du jour | ×1,00 (remonté à minuit UTC) |
| **rodage** | **×0,10** |

Le rodage est le seul étage encore mordant. Il maintient la taille au
dixième tant que le résultat EN DIRECT n'est pas prouvé positif
(actuellement −2,21 bps sur 66 instants de portefeuille). Il se lève
tout seul, jusqu'à ×1,00 sur 130 mesures, dès que la moyenne passe
positive.

C'est délibéré et je ne l'ai pas débridé : c'est l'étage qui a empêché
le compte de perdre bien plus que 6 %.

---

## 6. Les défauts trouvés et corrigés

Chacun était silencieux. Aucun n'apparaissait dans les journaux.

| défaut | effet réel | preuve |
|---|---|---|
| `leverage=(lev if lev >= 2 else None)` comparait un POIDS (0,02) à un levier | x1 sur toutes les positions, exposition brute plafonnée par les fonds propres | « LEVIER x1,0 · MARGE 153,51 » pour 153,15 de notionnel |
| tailles identiques sur toutes les jambes | DOGE, 3× plus agité que BTC, dominait la variance sans apporter d'avantage | 191/192/193 USDT identiques |
| historique complet rechargé à chaque tour de 5 s | moteur muet plusieurs minutes | « moteur muet depuis 5 min » à l'écran |
| reliquat plus petit qu'un LOT d'échange | position impossible à fermer par AUCUN ordre | −9,999999999883585 DOGE, 89 centimes, 4 h |
| l'horloge s'ajustait sur les 6 noms de la config à chaque démarrage | le panel élargi n'a jamais servi | 26 instruments avec l'historique, `panel[6]` |
| file de rattrapage bornée au rang 20 | les éligibles au-delà n'étaient jamais rattrapés | `desk panel vise 1` |
| noms sans assez d'historique poursuivis sans fin | quota d'appels consommé pour rien | — |
| le direct comptait 3 jambes simultanées comme 3 résultats | écart-type 44 bps au lieu de 25 ; des mois au lieu de semaines pour trancher | — |
| actions tokenisées (SNDK, XAU, SKHYNIX) dans le panel crypto | elles publient des bougies plates 24/7, le compte de barres ne les distingue pas | filtre sur l'amplitude du week-end |
| le même défaut, deux fois de suite : sept actions tokenisées sur vingt places (SNDK, XAU, SKHYNIX, SPCX, SOXL, MU, CRCL) | les deux critères de PRIX lisent la cotation, qu'un teneur de marché produit seul | zéro ligne `scalp recale` en six heures, panel visé 20 le 27/08 |
| le critère ne parlait que pour refuser | le défaut a vécu six heures sans laisser trace de POURQUOI les noms passaient | ligne `scalp juge` désormais émise pour tout nom jugé, admis compris |

---

## 7. Résultats négatifs, gardés pour ne pas les refaire

| idée | mesure | verdict |
|---|---|---|
| semi-variance signée (saut signé) | fixture dédiée **déjà** 4/4, ic +0,44 sans la colonne — `z20`/`z60` la portent | inutile |
| colonne jour de la semaine (sin/cos) | fixture dédiée ic +0,232 → +0,575 ; le binaire fait mieux pour un degré de liberté | remplacée par le binaire |
| sortie postée au take | mesurée à −3,4 bps, 13 remplissages sur 31 | rejetée |
| 7 colonnes croisées BTC | lead-lag inchangé 3/3 **avec comme sans** — aucun bénéfice | réduites à 1 |

### Deux choses que le journal ne disait pas, et une qu'il disait faux

**L'ic rapporté n'était pas celui de la cellule choisie.** Il était
calculé une fois sur la prédiction brute, avant la boucle des variantes,
puis journalisé tel quel — le verdict du 27 août affichait
`[ridge/h6/neu] ic=0,010` pour un ic décrivant la série `abs`, pas la
série `neu` qui avait été retenue. Deux conséquences : la porte teste
`ic > 2/√n` et le testait sur une autre série que celle qu'elle
sélectionne ; et comparer l'ic entre deux ajustements dont la variante a
changé comparait deux choses différentes — or c'est avec cet ic-là que
je jugeais si les colonnes `vers_reglement` et `weekend` payaient. Ce
n'est un assouplissement dans aucun sens : c'est le même seuil appliqué à
la bonne quantité.

**Une cellule que le moteur ne peut pas dimensionner ne le disait pas.**
`shrink = max(0 ; 1 + (pente − 1)·crédit)`. Le verdict 1H portait
`pente = −0,70` sur 1 142 instants, donc un crédit de 1, donc un shrink
de **exactement zéro**. Si cette cellule franchissait la barre, elle
serait déclarée `live`, bloquerait toutes les autres cellules du
classement, et ne produirait jamais une prédiction tradable. En silence.
Le verdict porte désormais `INERTE(shrink=0)`.

Ce qui n'a **pas** été changé, et pourquoi : le classement continue de
pouvoir couronner une telle cellule. On ne sait pas encore si le cas est
fréquent ou marginal, et modifier le classement sans mesure serait
exactement l'erreur déjà commise sur le filtre 24/7 — un seuil posé sur
une intuition. Le journal le dira ; on décidera après.

À noter pour lire le reste : `pente` et `ic` peuvent être de signes
opposés sans qu'il y ait contradiction. L'ic porte sur **toutes** les
lignes du holdout ; la pente sur le **sous-ensemble déclenché**
(`|pred| ≥ k·σ`). Une pente négative sur les seules lignes extrêmes est
la signature classique d'une sur-extrapolation dans les queues : les plus
grosses prédictions du modèle sont les moins fiables.

---

### La mesure décrivait un livre que personne ne tient — dans le TEMPS

`_portfolio` pondère les jambes par `1/sigma` puis divise par la **somme
des poids**. Son numérateur vaut déjà `somme(net_i/sigma_i)` ; c'est le
dénominateur qui pose problème — en croissant quand la volatilité
baisse, il écrase les instants calmes et gonfle les instants agités. La
série obtenue est celle d'un livre à **notionnel constant**.

Or le moteur ne tient pas ce livre-là. Le plafond de ruine
`0,025/(sl_bps·1e-4)` donne une taille proportionnelle à `1/sigma` : il
tient un livre à **risque constant**. Et le seuil d'entrée étant
lui-même exprimé en sigma, un signal de 3 σ rapporte mécaniquement plus
de points de base une heure agitée qu'une heure calme — `net` est
hétéroscédastique par construction, et le Sharpe d'une série
hétéroscédastique est mécaniquement rabaissé.

C'est exactement l'argument qui avait imposé la parité de risque **entre
jambes**, et il n'avait été appliqué qu'à une moitié du problème.

**Mesure**, panel synthétique à régimes de volatilité (×3 entre calme et
tempête). Vérité terrain calculée indépendamment des deux formules : le
Sharpe du P&L en dollars d'un livre à risque constant, `somme(r_i/σ_i)`.

| avantage | régimes | actuel | en risque | vérité |
|---|---|---|---|---|
| ∝ σ | non | 0,0833 | 0,0859 | 0,1065 |
| ∝ σ | oui | 0,0697 | **0,0863** | 0,1054 |
| constant en bps | non | 0,0870 | 0,0908 | 0,1085 |
| constant en bps | oui | 0,0659 | **0,1192** | 0,1451 |

Sur les douze cellules essayées, la mesure en risque tombe **toujours**
entre l'ancienne et la vérité, et ne la dépasse **jamais**. Elle retire
un biais vers le bas sans en créer un vers le haut. Le second bloc est
le contre-test qui décide s'il y a triche : un avantage constant en bps
n'est pas proportionnel à σ, et si la nouvelle formule fabriquait du
Sharpe elle dépasserait la vérité là. Elle reste en dessous.

La moyenne — et non la somme — sur les jambes reste la convention
prudente : sommer supposerait les jambes indépendantes, ce qu'elles ne
sont pas à 0,8 de corrélation. C'est pourquoi les deux estimateurs
restent sous la vérité, et c'est voulu.

**Et la barre ne bouge pas.** Changer la série mesurée sans revérifier
la barre serait abaisser la porte en silence. Sous nul dur — queues de
Student à 3 degrés de liberté et sigma en régimes — le max de Sharpe sur
4 860 cellules à 1 143 instants :

| | max du hasard | barre théorique |
|---|---|---|
| ancienne agrégation | 0,1045 | 0,1089 |
| en unités de risque | 0,1056 | 0,1089 |

Les deux voient le même hasard, à 1 % de la barre. Le changement ne
touche donc pas la porte : il ne change que l'estimation du **signal**.
Les deux résultats sont verrouillés par
`test_the_bar_does_not_move_when_the_aggregation_changes` et
`test_measuring_in_risk_units_never_overshoots_the_book_actually_held`.

Ce que cela coûte, et qu'il faut dire : un `sr` plus haut donne un
`net_defl` plus haut, donc des tailles plus grandes. Le système était
sous-dimensionné parce qu'il se sous-mesurait, mais la conséquence est
bien une prise de risque supérieure. Le rodage à 0,10 et le plafond de
ruine, eux, n'ont pas bougé.

Détail d'implémentation qui compte : `net_sd` reste en **points de
base**, parce que c'est lui qui nourrit Kelly côté moteur
(`f* = defl/sd²`). Seul le `sr` de sélection passe en unités de risque.

---

### La cellule de plus grande marge est-elle la meilleure payeuse ?

Le code posait la question et refusait d'y répondre avant d'avoir publié
`par_jour` et `gain_jour_bps`. Voici la publication, relevé du 27 août,
un tour complet des cinq échelles :

| échelle | cellule | net/trade | sr | barre | marge | par jour | net×jour |
|---|---|---|---|---|---|---|---|
| 1m  | mlp/h6/abs 2,5σ | +2,14 bps | +0,017 | 0,074 | −0,057 | 19,8 | +42 bps |
| 3m  | ens/h3/abs 4,0σ | +0,82 bps | +0,017 | 0,142 | −0,125 | 2,6 | +2 bps |
| 5m  | mlp/h6/neu 3,0σ | +0,59 bps | −0,002 | 0,131 | −0,133 | 3,2 | +2 bps |
| 15m | mlp/h3/abs 2,0σ | −3,54 bps | −0,005 | 0,059 | −0,064 | 1,9 | — |
| 1H  | ridge/h6/neu 4,0σ | **+43,13 bps** | **+0,094** | 0,109 | **−0,015** | 2,1 | **+91 bps** |

La réponse est **non, il n'y a pas de conflit** : l'échelle de plus
grande marge (1H, à 0,015 de la barre) est aussi, et de loin, la
meilleure payeuse — deux fois le 1m en bps par jour, vingt fois en bps
par trade. Le classement par marge n'a donc pas besoin d'être changé.
C'est un résultat négatif sur ma propre suspicion, et il vaut d'être
écrit : le soupçon portait sur le classement, la mesure le disculpe.

Ce que la mesure dit vraiment, c'est **où porter l'effort**. Le 1H est
la seule échelle où le coût ne mange que 4 % du mouvement, et c'est la
seule qui approche la barre. Il lui manque `sr ≥ barre`, soit
0,094 ≥ 0,109 : la barre valant `3,63/√instants`, il faudrait
`instants ≥ (3,63/0,094)² = 1 491` contre 1 143 aujourd'hui, soit
**+31 % d'instants**.

Trois leviers, un seul utile :

- **rétrécir la recherche** ne sert à rien. La barre croît comme
  `√(2 ln n_cellules)` : passer de 4 860 cellules à 486 ne ferait
  descendre la barre que de 0,107 à 0,104. Un logarithme ne se plie pas.
- **allonger l'histoire** est déjà au maximum : `DAYS["1H"] = 730` est
  ce que l'échange donne.
- **élargir le panel** est le seul levier réel — et c'est celui que le
  filtre du volume vient de rendre honnête.

Avertissement à la mesure suivante : écarter sept actions tokenisées
fera probablement **baisser** les instants du 1H avant de les faire
monter. Une action qui ouvre en séance produit des mouvements de 4 σ
sur une barre horaire ; elle déclenche donc beaucoup, et ses
déclenchements sont un artefact de calendrier, pas un avantage. Si le
1H s'éloigne de la barre au prochain relevé, ce n'est pas une
régression : c'est le prix de mesurer sur des cryptos.

---

### Ce qu'un teneur de marché peut fabriquer, et ce qu'il ne peut pas

Le filtre 24/7 a été franchi deux fois, et les deux échecs ont la même
racine. Le premier critère comptait les barres présentes ; le deuxième
mesurait l'amplitude du prix ; le troisième la part de barres plates.
Les trois lisent la **cotation** — or une cotation est exactement ce
qu'un teneur de marché produit tout seul. Rien ne l'empêche de la faire
bouger le dimanche à chaque minute, aussi finement qu'il veut, sans
qu'une seule action change de main.

Le **volume** demande une contrepartie. C'est la seule des quantités
disponibles qu'un teneur seul ne peut pas simuler, et c'est pour cela
qu'elle sépare les deux populations là où le prix échoue. Le seuil est
à 0,15 du volume des jours ouvrés — choisi loin des deux populations et
non entre elles : une crypto respire plus calmement le week-end sans
jamais s'arrêter, une action dont le sous-jacent est fermé n'a personne
en face.

Un seuil posé sans mesure reste un pari tant que la mesure ne l'a pas
confirmé. Les trois quantités sont donc journalisées pour **tout** nom
jugé, admis compris : si une vraie crypto tombe sous 0,15, son chiffre
sera au journal et le seuil sera faux. C'est précisément ce qui manquait
— un critère qui ne s'explique que lorsqu'il dit non est à moitié
aveugle, et c'est ce qui a laissé le défaut vivre.

Conséquence attendue et non garantie : le panel se rétrécit avant de se
réélargir, le temps que le rattrapage donne assez d'histoire aux vraies
cryptos qui attendent (ADA, AVAX, LINK, XLM). Moins de jambes, c'est
moins d'instants, donc une **barre plus haute** — la sélection devient
plus difficile à court terme, pas plus facile. Le gain n'est pas dans le
chiffre, il est dans le fait que le chiffre porte enfin sur ce qu'on
prétend mesurer.

---

### Une erreur de méthode, et sa correction

La colonne **week-end** a d'abord été rejetée, à tort. Le coût mesuré sur
la fixture de référence — 2 400 barres de 5 min — faisait tomber le
compte de succès de 12/12 à 9/12, et cela semblait trancher.

La même mesure, en faisant **grandir** la fixture :

| taille | succès |
|---|---|
| 2 400 barres (8 jours) | 6/8 |
| 6 000 barres (21 jours) | **8/8** |
| 14 000 barres (49 jours) | **8/8** |

Le coût était entièrement un **artefact de petit échantillon** : avec peu
de lignes, le réseau n'a pas de quoi apprendre qu'une colonne est
inutile, il la prend pour du signal et se disperse. En production il en
voit des centaines de milliers — l'horloge 5 min s'entraîne sur 120
jours, la 1 min sur 60.

Mesurer un coût sur une fixture trop courte pour le mesurer, c'est
rejeter de bonnes idées pour du bruit. Les deux colonnes de calendrier
sont donc en place, et un test verrouille le plancher au-delà duquel une
mesure de coût veut dire quelque chose.

La même erreur portait sur un second rejet. Le code affirmait que
« quatre colonnes de bruit suffisent à faire échouer une règle par
ailleurs vraie » (5/6 → 2/6). Mesuré proprement, en ajoutant k colonnes
de **pur bruit** à la matrice :

| taille | k=0 | k=2 | k=4 | k=8 |
|---|---|---|---|---|
| 2 400 barres | 5/6 | 4/6 | 5/6 | 5/6 |
| **6 000 barres** | **6/6** | **6/6** | **6/6** | **6/6** |

À 2 400 barres le compte oscille **sans tendance en k** — c'était du bruit
d'échantillonnage lu comme un coût. À 6 000, la matrice absorbe **huit**
colonnes inutiles sans rien perdre.

Conséquence pratique : le budget de colonnes est large. Une idée
prometteuse ne doit pas être écartée sur un coût mesuré trop court — elle
doit l'être quand elle n'apporte rien.

La leçon qui tient toujours : le coût d'une colonne ne se voit pas sur
l'ic — il se voit sur la précision **des barres qui déclenchent**, donc
sur l'économie.

---

## 8. Ce qui reste ouvert

1. **La rentabilité n'est pas acquise.** Le direct est à −2,21 bps sur
   66 instants, avec une erreur type d'environ 6 bps. Ce n'est pas
   distinguable de zéro — c'est trop court pour trancher, pas une
   preuve d'échec.
2. **Le panel doit atteindre 20 jambes tenues.** L'historique est là
   pour 26 noms ; les positions simultanées restent peu nombreuses.
3. **Deux colonnes neuves attendent leur verdict en production.** La
   proximité du règlement de funding (période 8 h, là où la matrice ne
   portait qu'un cycle de 24 h : 0/4 → 4/4 en fixture, ic −0,011 →
   +0,520) et le week-end.
4. **Le 1H n'a pas encore rendu de verdict.** C'est l'échelle où
   l'économie est franchement favorable, et son rattrapage d'historique
   (deux ans par instrument) est en cours.
5. **Le profil chronologique du Sharpe** doit dire si l'avantage est
   régulier ou concentré dans la fenêtre récente. Les premiers relevés
   sont croissants, ce qui suggère de la non-stationnarité.

---

## 9. Comment lire l'écran

**Le bandeau d'anomalies**, en haut, avant tout le reste. La machine y
nomme ce qui cloche : levier sous le plancher, taille bridée *avec la
cause*, position sans règle, frais qui dépassent les gains, panel
incomplet, poussière. S'il n'affiche rien, il n'y a rien à signaler.

**« Où part l'argent »** décompose l'équité en postes dont la somme
boucle. Si les frais dépassent le brut, c'est le nombre de trades qui
coûte, pas le signal — et le bloc le dit en toutes lettres.

**Chaque position** porte sa taille en coins et en USDT, sa marge, son
levier, sa source et son horizon, le temps restant avant la sortie, et
un rail perte → gain où figurent le stop, l'entrée, le prix courant,
l'objectif, et le suiveur quand il y en a un.

**Le relevé de taille** (`deploy/releve_taille.py`, via « VPS status »)
donne la même chose en texte, plus la colonne `defl` — celle qui
dimensionne — et `USD plein`, la taille que l'avantage seul justifierait
sans le frein ni le rodage.

---

## 10. Règles de conduite

Elles ne se négocient pas, et elles ont toutes été écrites après avoir
été tentées :

- ne jamais remettre la mesure du direct à zéro pour faire disparaître
  un mauvais chiffre ;
- ne jamais toucher au barème du rodage pendant qu'on le mesure ;
- n'abaisser aucune porte, jamais — un carnet vide est un résultat
  honnête ;
- ne pas raccourcir l'historique pour retrouver un meilleur chiffre :
  choisir la fenêtre qui flatte est exactement le biais que la barre
  déflatée existe pour empêcher ;
- ne redéployer que pour un défaut identifié et nommé — chaque
  redémarrage interrompt la mesure, et c'est elle qui manque.
