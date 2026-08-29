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
| le critère 24/7 mesurait trois quantités et n'en branchait qu'une, dix fois trop bas | sept actions tokenisées sur vingt places, zéro ligne de recalage | seuil 0,15 quand la mesure donne 0,59–0,72 pour les tokenisées |
| `retard_s` mesurait l'intervalle cible → ordre (0,3 s) et **rien** ne mesurait clôture de barre → décision | l'écran affirmait une exécution immédiate ; le vrai délai vaut 26 s sur la 1m et 152 s sur la 15m, quand la porte simule zéro | `desk 1m @ 1787842860000` journalisé à 15:02:26 pour une barre fermée à 15:02:00 |
| le critère ne parlait que pour refuser | le défaut a vécu six heures sans laisser trace de POURQUOI les noms passaient | ligne `scalp juge` désormais émise pour tout nom jugé, admis compris |

---

## 7. Résultats négatifs, gardés pour ne pas les refaire

| idée | mesure | verdict |
|---|---|---|
| semi-variance signée (saut signé) | fixture dédiée **déjà** 4/4, ic +0,44 sans la colonne — `z20`/`z60` la portent | inutile |
| colonne jour de la semaine (sin/cos) | fixture dédiée ic +0,232 → +0,575 ; le binaire fait mieux pour un degré de liberté | remplacée par le binaire |
| sortie postée au take | mesurée à −3,4 bps, 13 remplissages sur 31 | rejetée |
| 7 colonnes croisées BTC | lead-lag inchangé 3/3 **avec comme sans** — aucun bénéfice | réduites à 1 |

### Un embargo que j'ai voulu « corriger » à tort

Ayant trouvé une vraie fuite dans `pas`, j'ai regardé l'embargo voisin
et cru y voir la même chose. Avec `lag = 0`, l'étiquette de l'indice *i*
va de l'ouverture de la barre i+1 à la clôture de la barre i+h : elle se
termine à `ts[i] + (h+1)·pas`. Le code exige `ts[i] < t0 − h·pas`, ce
qui semble court d'une barre.

Ça ne l'est pas. **L'inégalité est stricte et les horodatages sont sur
une grille de pas constant** : `< t0 − h·pas` admet au plus
`ts[i] = t0 − (h+1)·pas`, dont l'étiquette se termine à `t0` pile — à
l'ouverture de la première barre de test, sans jamais la traverser.
L'embargo était exactement ajusté ; mon durcissement retirait une barre
d'entraînement de plus sans retirer la moindre fuite.

C'est le test que j'avais écrit pour prouver le défaut qui m'a arrêté.
La correction est annulée, et un test ancre désormais l'ajustement dans
les **deux** sens : durcir à `(h+1)` perd des données pour rien,
assouplir à `(h−1)` fait fuir. Personne ne le « réparera » à nouveau —
moi compris.

---

### « Long ET short » — une exigence qu'on ne pouvait pas vérifier

Le relevé du 27 août montrait **dix-huit jambes toutes longues**. Le but
demande explicitement de trader les mouvements *long et short*, et rien
dans le journal ne permettait de dire si c'était un moment ou un biais.

**Ma première lecture était trop alarmiste**, et la corriger vaut d'être
écrit : j'ai d'abord pensé à du bêta de marché déguisé — un livre
toujours long en marché haussier a un Sharpe positif sans la moindre
compétence, et le calibrage de la barre ne contrôle pas cela. C'est
faux ici. La cellule retenue déclenche sur 1 364 instants pour environ
53 000 barres de holdout, soit **2,6 % du temps**. Elle choisit ses
moments ; elle n'est pas « toujours longue ». Le bêta n'est pas le
sujet.

Ce qui reste vrai : une règle qui ne prendrait **jamais** le sens court
ne répondrait qu'à la moitié de ce qu'on lui demande. Et cela se compte.

Le verdict porte donc `court=NN%` — la part de trades courts du holdout
mesuré. **Aucune contrainte n'est imposée** : la recherche reste libre de
retenir une cellule à 100 % longue si c'est elle qui a la marge, et un
test vérifie qu'aucun seuil n'a été posé sur cet équilibre. Imposer une
parité long/court serait contraindre la recherche sans l'avoir mesurée —
la même erreur que le seuil de 0,15.

---

### L'écran ne disait pas ce qui bloque, et la donnée était là

*« Je peux savoir ce qu'il se passe, ce que tu fais et ce qui bloque, car
je comprends rien. »* La réponse demandait de lire des journaux en SSH,
alors que le moteur publiait déjà tout dans `_echelles` — Sharpe, barre,
marge, seuil, rythme, par échelle. Le tableau de bord ne lisait ce champ
que dans un onglet secondaire.

Une carte **Ce qui bloque** est désormais sur la page principale. Gagner
de l'argent demande cinq choses dans l'ordre, et il suffit qu'une seule
manque :

1. **une horloge bat le hasard** — Sharpe hors échantillon contre la
   barre déflatée, et de combien il manque quand ça ne passe pas ;
2. **le modèle annonce assez fort** — le seuil en bps, et surtout le
   *rythme* : combien de fois par heure une occasion se présente ;
3. **une position s'ouvre** ;
4. **le direct se mesure** — combien de fermetures sur les trente
   exigées, et combien d'heures cela représente au rythme mesuré ;
5. **la taille se libère** — et pourquoi elle reste au dixième, avec la
   mesure qui l'a imposé (une règle à +9 bps hors échantillon avait rendu
   −609 USD en quatre heures).

Chaque maillon dit **combien il manque**, pas seulement qu'il bloque, et
une phrase en tête nomme celui qui arrête la chaîne.

#### Et le même défaut que `BAR_MS`, à l'écran

La carte des preuves écrivait `const ordre = ["1m", "3m", "5m", "15m"]`
— une liste faite à la main quand il n'y avait que quatre échelles, et
jamais mise à jour quand le 1H a rejoint `BARS`. **L'horloge horaire
était invisible depuis sa création.** Deux listes qui doivent rester
synchrones finissent toujours par diverger.

Le correctif ne se contente donc pas d'ajouter « 1H » : il prend l'ordre
voulu **puis tout ce que le moteur envoie**, pour qu'une échelle neuve
apparaisse même si personne ne pense à la déclarer ici.

#### Ce que la position SERA, avant qu'elle existe

La carte des positions porte déjà tout ce que le but demande — sens,
taille, marge, levier, TP, SL, trail, et un rail perte→gain qui montre
où le prix se tient entre les deux. Des tests l'ancrent depuis
longtemps (`b.lev`, `b.margin`, `b.trail`, et le fait qu'en mode suiveur
le trail **remplace** le stop fixe au lieu de s'afficher à côté).

Mais elle ne porte tout cela **que lorsqu'une position existe**, et il
ne s'en est ouvert aucune de la journée. Une page qui ne montre ces
chiffres qu'en présence d'une position ne les montre jamais au moment où
on en a le plus besoin : avant.

Le panneau des prédictions porte donc désormais, pour chaque signal non
plat, ce que la position **sera** si elle part — levier d'échange,
marge, TP, et SL ou trail selon le mode.

Les quatre valeurs existaient déjà dans `preds`. La dernière était
perdue en chemin : l'instantané réutilisait la clé `lev` pour le POIDS
notionnel — deux grandeurs sans rapport sous le même nom — et écrasait
le levier d'échange, alors que la `margin` exposée juste à côté avait
été calculée avec lui. Les deux ne se répondaient plus. Le levier
d'échange a maintenant son propre nom, et un test vérifie qu'il est lu
**avant** d'être écrasé.

Un troisième défaut a été introduit puis corrigé dans la même passe :
une variable locale `bps` masquait le formateur global du même nom, ce
qui aurait planté la page entière au premier rendu — un écran blanc, pas
un chiffre faux. Un test l'interdit, avec une contre-épreuve qui vérifie
que la forme fautive est bien reconnue.

---

### Le rodage suppose une règle stable ; la recherche n'en produit pas

Ce n'est pas un défaut localisé — c'est une contradiction entre deux
parties du système, et elle met la rentabilité hors d'atteinte par
construction.

Compté sur les douze derniers verdicts 1m du 27 août, le mot `gardee`
— qui dit que l'hystérésis a retenu la cellule précédente — apparaît
**quatre fois sur douze**. La cellule change donc d'identité deux fois
sur trois d'un ajustement à l'autre.

| | |
|---|---|
| survie d'une cellule à un ajustement | 1/3 |
| durée de vie moyenne | 1,5 ajustement ≈ **1,2 h** |
| fermetures exigées par le rodage | 30 |
| à 1,53 déclenchement par heure | **20 h** |
| changements de règle d'ici là | **~16** |

Deux conséquences — et une troisième que j'avais écrite et qui était
fausse.

1. `live_rule` ne mesure **jamais une règle**. Ses 68 mesures sont un
   mélange d'une quinzaine de règles différentes ; son −1,56 bps ne dit
   rien de la cellule actuelle, ni pour ni contre.
2. Le rodage demande trente fermetures, soit **vingt heures** de trading
   en direct, quoi qu'il arrive. C'est un délai incompressible.

**Ce que j'avais écrit et qui était faux** : « le système est
structurellement bloqué au dixième de taille — même une règle réellement
rentable ne pourrait pas grandir ». Non. `confiance` mesure ce que la
**machine** produit en direct, c'est-à-dire la succession de règles — et
c'est exactement ce que le compte encaisse. Si cette succession est
rentable, `live_rule` monte et la taille suit. Le pooling n'est pas un
défaut : c'est la mesure du bon objet.

Ce qui reste vrai, et seulement cela : une règle **individuelle** ne peut
pas gagner sa taille sur ses propres mérites, parce qu'elle ne vit pas
assez longtemps pour être jugée seule. C'est une conséquence assumée du
choix conservateur — on prend la taille de la pire des deux mesures tant
qu'elles ne se réconcilient pas — et non une contradiction du système.

Surestimer un défaut structurel coûte autant que d'en manquer un : cela
justifierait de toucher à un barème qui n'a rien à se reprocher.

Ce qui n'est PAS la réponse : toucher au barème du rodage. Il a été posé
sur une mesure — une règle à +9/+11 bps hors échantillon avait rendu
−609 USD en quatre heures de direct — et l'assouplir reviendrait à
effacer cette leçon.

Les options réelles, aucune mesurée, donc aucune retenue :

- **Ajuster moins souvent.** La cellule vit 1,5 ajustement quoi qu'il
  arrive ; espacer les ajustements de cinquante minutes à quatre heures
  la ferait vivre six heures au lieu d'une, et accumuler neuf fermetures
  au lieu de deux. Ce n'est pas un assouplissement de porte, c'est une
  cadence — mais le modèle vieillit d'autant.
- **Élargir la bande d'hystérésis** — et c'est la piste la plus sérieuse,
  parce que la bande compare deux quantités différentes. Elle vaut
  `1/√n_per`, l'erreur type d'un Sharpe **au sein d'un** ajustement. Ce
  qu'il faudrait lui opposer, c'est la dispersion des marges **entre**
  ajustements, qui inclut en plus le bruit de sélection du maximum sur
  4 860 cellules — une quantité forcément plus grande.
  La question n'était pas décidable : le journal publiait la marge de la
  cellule **gagnante** et jamais celle de la **sortante**. L'écart est
  désormais journalisé à côté de la bande (`ecart=±x.xxx/bande=0.0xx`),
  et la bande, elle, n'a pas bougé d'un iota. On mesure d'abord.
- **Mesurer le direct par identité de cellule.** Plus honnête, mais
  chaque identité n'aurait que deux fermetures — inutilisable.

Le fait mesuré est écrit ; le choix attendra d'être mesuré lui aussi.

---

### Le défaut le plus coûteux de la journée : une clé manquante

`BARS` contient cinq échelles ; `BAR_MS` n'en contenait que quatre.
« 1H » manquait, et le code lisait `BAR_MS.get(bar, 300_000)` — donc
**cinq minutes** pour l'échelle horaire. Ce n'est pas un défaut
d'affichage. `pas` gouverne trois choses :

```python
brut = sum((ts < t0 - h * pas).sum() ...)   # embargo
tr   = idx[ts[idx] < t0 - h * pas][::saut]  # embargo
te   = te[(ts[te] // pas) % h == 0]         # etiquettes disjointes
```

**L'embargo** valait `h × 5 min` au lieu de `h × 60 min` : trente minutes
là où les étiquettes couvrent six heures. De la fuite pure.

**Le sous-échantillonnage du holdout devenait un no-op.** Les horodatages
horaires sont des multiples de 3 600 000 ; divisés par 300 000 ils
donnent `12k`, et `12k % 6` vaut toujours zéro. Le 1H gardait donc ses
**six étiquettes chevauchantes** au lieu d'une sur six.

| à h = 6 | rapporté | réel |
|---|---|---|
| holdout gardé | 60/60 | **10/60** |
| instants du 1H | 1 257 | ~209 |
| barre déflatée | 0,102 | **0,251** |
| embargo | 30 min | **6 h** |

Le 1H n'était pas « à 0,007 de la porte ». **Il en est à un facteur
2,5.** Et c'est sur ce chiffre que j'ai fondé, toute la journée, le
raisonnement « le 1H est la meilleure payeuse et la plus proche, portons
l'effort là ». La cellule la plus prometteuse du système était un
artefact d'étiquettes chevauchantes.

Second défaut trouvé au même endroit : `par_jour`. Il lui manquait
**deux** facteurs, et il a fallu deux passes pour les trouver tous les
deux.

Le **panel** d'abord : `n_hold` compte les lignes du holdout de tout le
panel, et vingt actifs qui partagent une horloge donnent vingt lignes
par barre, pas vingt barres.

L'**amincissement** ensuite : le holdout ne garde qu'une barre sur `h`
— les lignes gardées ne sont pas les barres écoulées.

La première correction seule donnait **348 déclenchements par jour** au
1m. C'est impossible : à six minutes d'écart il n'en tient que 240 dans
une journée. Ce plafond arithmétique a révélé le second facteur, et un
test le garde désormais — une formule qui franchit le plafond est fausse
quoi qu'elle rende par ailleurs.

Le chiffre juste au 1m est **57,8 par jour**, contre 17,3 annoncés.

Et le recoupement qui donne confiance dans la formule — le seul moyen
d'en avoir : `DEBUT_TEST = 0,40`, donc la durée du holdout doit valoir
60 % de l'histoire chargée.

| | holdout | histoire impliquée | histoire réelle |
|---|---|---|---|
| 1m | 37,3 j | 62,1 j | 62 j |
| 3m | 38,1 j | 63,6 j | 60 j |
| 15m | 309,9 j | 516,5 j | **365 j** |

Les deux premiers tombent au dixième près. **Le troisième non**, et la
raison n'est pas établie. Un test l'ancre tel quel plutôt que d'ajuster
la formule pour qu'elle tombe bien : c'est un écart connu, pas un écart
caché.

Ce que cela dit de la méthode, et qui vaut plus que le correctif :
`dict.get(clé, défaut)` sur une table de constantes est un piège, parce
qu'une clé absente ne fait pas de bruit — elle rend une valeur
plausible. Un test exige désormais que `BAR_MS` couvre `BARS`, et qu'à
chaque échelle le sous-échantillonnage garde bien une barre sur `h`. Une
contre-épreuve vérifie que l'ancien pas reproduisait bien le no-op :
sans elle, le test passerait aussi sur le bug.

---

### Une correction juste, déployée d'une façon qui l'a rendue muette

La mesure en unités de risque était vérifiée en fixture et sous nul dur.
Elle a quand même produit un incident, et il vient de deux erreurs qui
sont les miennes.

**La première est un coût de calcul invisible en test.** `_portfolio` et
`_en_risque` mesurent le même portefeuille dans deux unités, et chacune
faisait son propre `np.unique` sur les mêmes horodatages. Le balayage en
appelle une par cellule — 4 860 par échelle, cinq échelles. Ajouter la
seconde mesure a donc **doublé le nombre de tris de la boucle la plus
interne**. Une suite de tests qui passe ne dit rien du temps de calcul
en production.

**La seconde est une erreur de conduite.** J'ai déployé trois fois en
soixante-seize minutes — 10:51, 11:29, 12:07 — dans un système dont le
cycle complet prend cinquante minutes, et qui venait de passer à cent.

Le résultat est net : **aucun verdict d'horloge entre 10:41 et 12:13**,
alors que deux fenêtres de trente-sept minutes auraient dû en produire
quatre chacune. J'ai réclamé une mesure tout en supprimant les
conditions de son apparition.

Le coût, **mesuré** plutôt que supposé — j'avais d'abord écrit « de
cinquante minutes à cent », et c'était exagéré :

| n_tr | 1 tri | 2 tris | tri partagé | part de la cellule |
|---|---|---|---|---|
| 2 000 | 0,12 ms | 0,15 ms | 0,10 ms | 70 % |
| 20 000 | 0,93 ms | 1,79 ms | 0,98 ms | 75 % |
| 90 000 | 2,36 ms | 4,34 ms | 2,87 ms | 56 % |
| 180 000 | 4,43 ms | 9,03 ms | 6,07 ms | 58 % |

L'agrégation pèse 56 à 75 % du travail d'une cellule et mon changement
l'a bien doublée — ce qui porte le coût de la cellule à **+55 à +70 %**,
soit un cycle passé d'environ cinquante minutes à environ quatre-vingts.
Suffisant pour qu'aucun verdict ne sorte entre deux déploiements espacés
de trente-sept minutes.

Et le tri partagé ne revient **pas tout à fait** au coût d'origine
(6,07 ms contre 4,43 à 180 000 lignes) : produire une seconde série
coûte deux `bincount` de plus, et ce résidu est le prix honnête de la
mesure ajoutée.

| | après 07:22 | après 09:41 | après 10:51 | après 11:29 |
|---|---|---|---|---|
| premier verdict | 4 min | 4 min | **aucun en 37 min** | **aucun en 37 min** |

Le correctif rend le coût d'origine : un tri partagé entre les deux
séries (`_agreger`). Les deux fonctions séparées restent — les tests les
appellent directement, et c'est par elles que la barre a été vérifiée
sous nul dur ; un test exige que la version partagée leur soit
identique, et qu'elle ne trie qu'une fois.

La règle qui manquait, et qui vaut pour la suite : **ne pas redéployer
avant qu'un cycle complet d'horloges ait produit ses verdicts.** Un
déploiement qui interrompt la mesure coûte plus que le défaut qu'il
corrige.

---

### Le même défaut de catégorie, du côté du direct

Le relevé du 27 août porte deux chiffres sur les **mêmes** 29
fermetures : **−4,7 bps par trade** et **+0,94 USD**. Négatif en points
de base, positif en dollars.

Ce n'est pas une incohérence comptable. `_solder_paquet` prenait la
moyenne **équipondérée** des points de base des jambes fermées, et s'en
justifiait ainsi : *« la parité de risque a déjà rendu les jambes
équivalentes en risque à l'ouverture »*. C'est faux. Le moteur
dimensionne chaque jambe par l'**inverse** de son garde-fou
(`inv = 1/sl_bps` dans la parité de risque), donc le P&L en dollars d'un
instant vaut `somme(net_i / sl_i)`, pas `moyenne(net_i)`. Une jambe
calme porte un notionnel plus gros et pèse davantage en dollars ;
l'équipondération en bps l'ignore.

C'est **exactement** le défaut corrigé dans `_portfolio` — mesurer un
livre à notionnel constant quand on en tient un à risque constant — mais
du côté du direct. Et c'est cette mesure-là qui commande le rodage :
`confiance` reste à 0,10 tant que la moyenne est négative.

**Rien n'est remplacé et rien n'est remis à zéro.** La série historique
garde son compte (n = 68) et sa moyenne, parce qu'elle commande encore
le barème et qu'on ne change pas un barème en cours de mesure. Une série
en unités de risque part de zéro **à côté**, et on comparera quand elle
aura de quoi parler.

L'échelle est choisie pour que la comparaison soit lisible : on ramène
au garde-fou **moyen** du paquet, de sorte qu'un instant à une seule
jambe donne exactement le même chiffre que la mesure historique. Les
deux séries ne divergent donc que là où elles doivent — sur les instants
à plusieurs jambes. Un test l'ancre, et un second vérifie qu'une jambe
sans garde-fou mesuré fait sauter l'instant à la série en risque plutôt
que d'y injecter un infini.

---

### Ce qui bloque vraiment : pas la porte, ce qui vient juste après

Le 1H nette **+40,95 bps par trade** et son Sharpe est à **0,007** de la
barre. Mais sa pente vaut −1,53, donc `shrink = max(0 ; 1 + (pente−1)·crédit) = 0`,
donc `r_bps = raw × shrink = 0`, donc aucune direction, aucune espérance,
aucun trade. Deux statistiques calculées **sur les mêmes lignes** se
contredisent : la porte dit « cette cellule trade avec profit », le
shrink dit « réduis-la à zéro ».

La pente est mesurée sur le sous-ensemble **déclenché**, `|pred| ≥ k·σ`.
Conditionner sur la variable explicative atténue la pente vers zéro, et
c'est mécanique : en sélectionnant les prédictions extrêmes on
sélectionne aussi les lignes où la part de **bruit** de la prédiction est
extrême, et le réalisé ne suit pas ce bruit. Avec un ic de 0,010 la part
de signal est minuscule ; l'atténuation peut faire passer la pente sous
zéro sans la moindre anti-prédiction.

Le point neutre de la formule est 1 — faire confiance à l'échelle du
modèle — et `crédit` était censé s'en écarter « à proportion des
preuves ». Mais `crédit = n_periods/200` compte des **instants**, pas la
précision de la pente : à 1 142 instants il vaut 1, et la formule accorde
une confiance totale à une pente dont l'erreur n'était pas mesurée.

Or `1 + (b − 1)·crédit` est **exactement** la moyenne a posteriori d'un
`b` bruité autour d'un a priori centré en 1, avec
`crédit = τ²/(τ² + se²)`. La forme était juste ; c'est le poids qui était
faux. Reste la question qui décide entre deux correctifs très
différents : sur données réelles, une pente de −1,53 est-elle **établie**
ou non ?

- Si elle l'est (écart à 1 de plusieurs erreurs types), le modèle
  sur-annonce vraiment sur ses lignes extrêmes, et le bon correctif est
  de **remplacer** la magnitude annoncée par une magnitude mesurée — le
  `net` et le `sd` de la cellule, que la porte vient de valider — plutôt
  que d'annuler une cellule dont le signe et le net sont établis.
- Si elle ne l'est pas, le bon correctif est le poids bayésien
  ci-dessus, qui ramène `shrink` vers 1 quand la pente est mal mesurée.

#### Ni l'un ni l'autre : la pente portait sur un rendement jamais encaissé

Les deux hypothèses ci-dessus ont été essayées en fixture, et **aucune
ne reproduit −1,53** — zéro tirage sur 200 :

| mécanisme, même ic et même taux de déclenchement | pente obtenue |
|---|---|
| atténuation de sélection, vérité linéaire calibrée | +0,93 |
| modèle qui sur-annonce (pente pleine 0,3) | +0,31 |
| sur-extrapolation, signal mort au-delà de 2 σ | **+0,06** |
| sur-extrapolation, signal mort au-delà de 1,5 σ | −0,06 |

La sur-extrapolation — le mécanisme que j'avais invoqué — pousse la
pente vers **zéro**, pas vers −1,5. Mon explication était fausse.

La vraie raison est plus simple, et elle était sous les yeux : `pente`
régressait `yho`, la cible **brute** du holdout, alors que `net` vient
de `gains`, l'issue **après simulation du stop**. Ce ne sont pas les
mêmes rendements. Une pente OLS sur des queues épaisses est dominée par
une poignée de points extrêmes — et ce sont précisément ceux que le stop
coupe. La stratégie ne réalise **jamais** `yho`.

Mesure à l'échelle de la production, 60 tirages par ligne, vérité
calibrée à 1 :

| queues | pente BRUTE | min | < 0 | pente RÉELLE | min | < 0 |
|---|---|---|---|---|---|---|
| df = 2,5 | +0,96 | −1,21 | 13 % | **+1,50** | −0,29 | 3 % |
| df = 3 | +0,91 | −0,21 | 7 % | +1,23 | +0,02 | 0 % |
| df = 4 | +0,91 | −0,08 | 3 % | +1,07 | +0,03 | 0 % |
| df = 8 | +1,06 | +0,13 | 0 % | +1,11 | +0,16 | 0 % |

L'écart se creuse avec l'épaisseur des queues et **disparaît** quand
elles s'amincissent : c'est la signature du mécanisme. Avec une autre
graine, le minimum de la pente brute descendait à −5,56 — la statistique
brute est elle-même instable, et c'est le reproche.

Ce qui est vrai et ce qui ne l'est pas : la pente réelle n'est **pas**
garantie positive. Elle l'est simplement bien plus souvent, et son pire
cas est bien moins extrême. Le correctif ne fabrique donc pas un shrink
positif — il mesure la calibration contre le rendement que la stratégie
encaisse réellement, ce qu'elle aurait toujours dû faire.

Ce n'est pas un assouplissement de porte : `pente` ne franchit rien,
elle dimensionne. Et la pente brute reste journalisée à côté
(`pente=X+-Y(brut Z)`) pour que l'écart soit lisible en production
plutôt que supposé.

---

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

> **⚠ CE TABLEAU EST FAUX, ET LA SECTION SUIVANTE DIT POURQUOI.**
> `BAR_MS` ne contenait pas « 1H ». Les colonnes `par jour` sont toutes
> sous-estimées d'un facteur égal à la taille du panel, et la ligne 1H
> est doublement fausse : sa barre vaut 0,251 et non 0,104. Le 1H
> n'était pas « à 0,015 de la porte ». Le tableau est conservé tel quel
> parce qu'effacer une erreur publiée est pire que la corriger.

La conclusion que j'en avais tirée — « l'échelle de plus grande marge
est aussi la meilleure payeuse, c'est le 1H, portons-y l'effort » — a
gouverné toute la journée du 27 août. Elle reposait sur une barre
gonflée d'un facteur 2,5.

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
jugé, admis compris. C'est précisément ce qui manquait — un critère qui
ne s'explique que lorsqu'il dit non est à moitié aveugle, et c'est ce
qui a laissé le défaut vivre.

#### La mesure a démenti le seuil, trois heures plus tard

| vraies cryptos | volume WE | | actions tokenisées | volume WE |
|---|---|---|---|---|
| BTC | 0,86 | | SNDK | 0,60 |
| ETH | 0,82 | | XAU | 0,62 |
| SOL | 0,93 | | SKHYNIX | 0,58 |
| XRP | 1,18 | | SPCX | 0,61 |
| DOGE | 1,07 | | SOXL | 0,61 |
| ZEC | 1,06 | | MU | 0,62 |
| TAO | 1,90 | | CRCL | 0,72 |

Les actions tokenisées échangent **58 à 72 %** de leur volume de semaine
le week-end, pas 2 %. Le seuil de 0,15 n'écarte personne, et le panel
porte toujours les sept.

Le mécanisme invoqué était juste — un teneur de marché fabrique une
cotation, pas un volume — mais **l'ampleur était fausse**. Le perpétuel
se trade en continu : on spécule sur SPCX le dimanche, on ne peut
simplement pas se couvrir sur le sous-jacent. Un volume qui se réduit
d'un tiers n'est pas un marché mort.

Les deux populations *sont* séparées — toutes les cryptos ≥ 0,82, toutes
les actions ≤ 0,72 — et je ne place **pas** un seuil dans ce trou. ETH
est à 0,82 ; un seuil à 0,80 l'emporterait un week-end calme. Vingt
points ne justifient pas un seuil à 0,08 près, et c'est exactement le
raisonnement « loin des deux populations » qui vient d'échouer.

Ce qui devrait séparer d'un **ordre de grandeur** plutôt que de 30 %,
c'est le profil horaire : une action tokenisée suit sa séance, une
crypto n'en a pas. Cette quantité a été mesurée et journalisée
(`seance/nuit`), délibérément branchée à **rien**.

#### Elle a parlé, et elle était mal construite

| actions tokenisées | | vraies cryptos | |
|---|---|---|---|
| SPCX | **4,35** | BTC | 1,67 |
| CRCL | **4,22** | ETH | 1,60 |
| SOXL | **3,02** | XRP | 1,58 |
| SNDK | **2,95** | ZEC | 1,52 |
| MU | **2,62** | … | … |
| XAU | 1,29 | ENA | 1,08 |
| SKHYNIX | **0,79** | | |

Cinq sur sept se séparent nettement. **Deux échouent**, et l'explication
vaut mieux que le résultat : XAU est de l'or, qui se traite presque 24 h
sur les marchés à terme ; SKHYNIX est une action **coréenne**, dont la
séance est asiatique — la fenêtre 13h30–20h UTC mesure sa **nuit**, d'où
0,79, sous *toutes* les cryptos.

L'instrument présupposait *quelle* séance. La **concentration horaire**
ne présuppose rien : elle demande seulement si le volume se masse
quelque part dans la journée, où qu'il soit — moyenne des six heures les
plus actives sur la moyenne générale, six parce que c'est la durée d'une
séance boursière.

| profil | seance/nuit | concentration |
|---|---|---|
| crypto 24/7 | 1,00 | 1,01 |
| séance New York | 7,51 | **2,60** |
| séance Corée | **0,27** | **2,59** |
| or (quasi 24 h) | 1,75 | 1,44 |

La mesure directionnelle place la séance coréenne **sous** la crypto —
l'anomalie SKHYNIX reproduite en fixture. La concentration lui donne le
même chiffre qu'à New York. L'or reste intermédiaire dans les deux,
parce qu'il *est* réellement quasi-24 h : aucun critère de séance ne le
tranchera, et c'est une limite à connaître.

Elle est **mesurée et branchée à rien**, elle aussi. Poser un seuil
dessus avant de l'avoir lue en production serait la troisième fois de la
journée, après le 0,15 du volume et la fenêtre new-yorkaise.

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

### Le retard qui n'était pas mesuré, et ce qu'il explique

Le glissement d'entrée mesuré est passé de **+1,21 bps sur 14 ouvertures**
à **+21,32 sur 28** en une heure et demie. À trente ouvertures il devient
facturable, et vingt et un points de base fermeraient à eux seuls toutes
les portes — les seuils de la 1m valent 6,5 à 7,6 bps.

La première explication qui vient est fausse, et il faut la dire parce
qu'elle est séduisante : `sig_px` est la **clôture** de la barre, un
*print* qui tombe au bid ou à l'ask selon le rebond, tandis que le
remplissage est un prix **coté** ; l'écart vaudrait donc un rebond que
`_targets` retire déjà en simulant l'entrée à l'ouverture suivante, et le
facturer compterait deux fois. Le journal réfute cette lecture :

| horloge | barre fermée à | décision journalisée à | retard |
|---|---|---|---|
| 1m | 15:02:00 | 15:02:26 | **26 s** |
| 3m | 15:09:00 | 15:09:49 | 49 s |
| 5m | 15:05:00 | 15:06:00 | 60 s |
| 15m | 15:00:00 | 15:02:32 | **152 s** |

Le moteur ne décide pas à l'ouverture de la barre suivante ; il décide un
tiers à une demi-barre plus tard. Le glissement mesure donc un **vrai
retard**, que la porte ne modélise pas — il doit être facturé, et rien de
ce qui est chargé n'a été touché.

Deux conséquences, et aucune n'est un ajustement de seuil :

1. `ENTREE_DECALEE = 0` est justifié dans le code par une mesure de
   **6 s sur la 1m et 43 s sur la 15m**. Le retard a quadruplé depuis,
   sans que rien ne le dise : `retard_s` mesure l'intervalle entre la
   cible produite et l'ordre parti (0,3 s sur 4 381 ordres) et affichait
   donc « exécution immédiate » pendant tout ce temps. Le retard sur la
   clôture est désormais mesuré par échelle, affiché au relevé et au
   bandeau d'anomalies.
2. Ce qui prend ces secondes doit être séparé au chronomètre avant d'y
   toucher. Le suspect est nommé : à chaque barre nouvelle, les vingt
   historiques sont **rechargés en entier** — quatre-vingt-dix mille
   barres par nom, plus quatre tables auxiliaires reprojetées. La ligne
   `desk` porte donc `charge=Xs calcul=Ys`. Réduire ce retard est le seul
   geste qui rende à la porte l'hypothèse qu'elle fait déjà.

Une **médiane** est posée à côté de la moyenne du glissement, branchée
sur rien : les huit ouvertures de 14:53 viennent toutes de l'horloge 15m,
celle qui décide avec 152 s de retard, et une moyenne ne peut pas dire si
+21 bps décrit l'ouverture typique ou cette poignée-là.

### Le critère 24/7, enfin tranché — par une conjonction

Deux relevés de production du 27 août (15h30 et 16h56), panel entier,
vingt noms jugés :

| quantité | cryptos | actions tokenisées |
|---|---|---|
| volume du week-end | 0,78 (TAO) à 1,89 | **0,59 à 0,72** |
| séance/nuit | ≤ 1,68 | 2,63 à 4,36 — **sauf XAU 1,29 et SKHYNIX 0,79** |
| concentration horaire | ≤ 1,73 (BTC) | 1,75 (XAU) à 2,49 (SPCX) |

Aucune des trois ne suffit seule, et chacune échoue pour une raison
différente :

- Le **volume du week-end** sépare les deux populations avec un écart
  franc (0,72 contre 0,78) — mais le seuil posé la veille valait **0,15**,
  dix fois trop bas. Le mécanisme était juste (un teneur de marché
  fabrique une cotation, pas un volume) ; l'ampleur supposée était fausse.
  Le perpétuel se trade le dimanche ; c'est le **sous-jacent** qui dort.
- La **séance/nuit** présuppose New York. Elle rate l'or, qui se traite
  presque 24 h, et elle rate SKHYNIX : la séance de Séoul tombe dans la
  fenêtre que ce critère appelle « nuit », d'où un 0,79 sous toutes les
  cryptos.
- La **concentration horaire** ne présuppose aucune heure et sépare tout
  le monde — mais de **0,02**. Un seuil à 1,75 pris seul serait un réglage
  fin entre deux populations qui se touchent : exactement ce que la barre
  déflatée existe pour interdire.

Le critère retenu est donc une **conjonction** : un week-end sans
contrepartie (**volume < 0,75**) **et** une journée qui a une séance
(séance/nuit ≥ 2,0 **ou** concentration ≥ 1,75). Le seuil fragile ne peut
mordre que sur un nom déjà sous 0,75, et aucune crypto mesurée n'y
descend. Une crypto devrait échouer aux **deux** pour être écartée ; les
sept noms tokenisés du panel échouent aux deux.

Trois tests, contre-épreuves vérifiées : transformer la conjonction en
disjonction fait échouer le cas « week-end calme sans séance » (et un
test antérieur, dont la fixture crypto est à 0,65) ; retirer la clause de
concentration laisse repasser la séance coréenne.

### Ce que la mesure a répondu, le soir même

Les trois changements sont partis en production à 17h52. Voici ce qu'ils
ont dit.

**Le retard par échelle, première lecture** (24 décisions depuis le
redémarrage — les longues horloges sont donc gonflées par le démarrage) :

| horloge | retard mesuré | durée de barre |
|---|---|---|
| 1m | **23 s** | 60 s |
| 3m | 45 s | 180 s |
| 5m | **345 s** | 300 s |
| 15m | **731 s** | 900 s |
| 1H | **4 209 s** | 3 600 s |

La porte simule **zéro**. Sur la 1m le chiffre confirme l'estimation
tirée des horodatages (26 s). Sur la 5m et la 1H il **dépasse une barre
entière** : la fenêtre que l'étiquette prédit est déjà écoulée quand
l'ordre part.

**Seconde lecture, 18h43, 61 décisions** — le démarrage s'est lavé, et
ce qui reste est le régime permanent :

| horloge | 1re lecture (24) | **2e lecture (61)** | part d'une barre |
|---|---|---|---|
| 1m | 23 s | **21 s** | 35 % |
| 3m | 45 s | **56 s** | 31 % |
| 5m | 345 s | **197 s** | 66 % |
| 15m | 731 s | **559 s** | 62 % |
| 1H | 4 209 s | **2 818 s** | 78 % |

Les longues horloges décident donc **au-delà de la moitié d'une barre**
après la clôture qui décide, et la porte suppose zéro. Deux lectures
concordantes : ce n'est plus une observation, c'est un défaut. La 1m,
elle, est stable à 21-23 s — un tiers de barre, sur un horizon de six
barres, soit 6 % de la durée de détention.

**Où passe ce temps, décomposé au chronomètre** (journal du 27 août,
horloge 1m) :

| poste | mesure |
|---|---|
| tournée de rafraîchissement | **≈ 14 s** |
| chargement des historiques (`charge`) | **0,6–0,8 s** |
| décision (`calcul`) | **6,3–6,6 s** |

Le recollage de série a fait son travail : vingt historiques de
quatre-vingt-dix mille barres se chargent en **moins d'une seconde**, là
où la relecture complète en coûtait cinq à six sur une machine plus
rapide. Ce n'est donc plus la base qui coûte — c'est la **tournée
d'appels** avant elle.

Et pour les échelles lentes le mécanisme était ailleurs, plus bête et
plus coûteux : la boucle rafraîchissait **une échelle lente par tour, à
la ronde** — `("3m", "5m", "15m")[rr % 3]`. Un tour dure une
cinquantaine de secondes, donc chaque échelle n'était relue que toutes
les deux minutes et demie. **Et le 1H ne figurait pas dans la ronde du
tout** : il n'était rafraîchi que par la passe de recherche, d'où ses
2 818 s.

On demande désormais l'échelle **due** — celle dont une barre a fermé
depuis qu'on l'a vue. Le retard baisse et le compte d'appels baisse avec
lui : la 3m est due un tour sur trois et demi, la 15m un sur dix-huit, la
1H un sur soixante-douze, là où la ronde en demandait une à chaque tour.
Un test compte les appels sur une heure simulée plutôt que de le
supposer.

### Troisième lecture, 20h13 — la règle « échelle due » a payé

Déployée à 19h05. Le journal porte maintenant les trois nombres par
ligne de décision, et c'est le **régime permanent** qu'ils montrent, là
où la moyenne cumulée traîne encore le rattrapage du démarrage :

| horloge | `retard` par ligne | `charge` | `calcul` | avant (2e lecture) |
|---|---|---|---|---|
| 1m | **5 à 20 s** (typique 6-10) | 0,3 s | 6,0-6,4 s | 21 s |
| 3m | **33 à 47 s** | 0,1 s | 2,2 s | 56 s |
| 5m | **43 s** | 0,2 s | 2,6 s | **197 s** |

La 5m est passée de près de deux cents secondes à une quarantaine —
l'ordre de grandeur d'un tour, ce qui était exactement l'attendu. Les
moyennes cumulées (1m 19 s, 3m 53 s, 5m 111 s, 15m 318 s, 1H 1 786 s)
restent au-dessus parce qu'elles incluent la première décision de chaque
échelle après le redémarrage, et que la 1H n'en a eu qu'une ou deux en
une heure.

Le `charge` confirme le recollage de série : **0,1 à 0,4 s** pour vingt
historiques de quatre-vingt-dix mille barres. Ce n'est plus la base qui
coûte, ni la tournée d'appels — **c'est le calcul**, 6 s sur la 1m, qui
domine désormais. Le total clôture → ordre vaut donc environ 14 s sur la
1m, contre 21 à 26 s avant.

Le glissement facturé suit : **+0,78 bps sur 82 ouvertures** (médiane
−0,52), contre +21,32 sur 28 à 15h30.

**L'hystérésis, troisième lecture — et la bande n'est pas trop étroite.**
`ecart=+0,000/bande=0,020`, `+0,044/bande=0,028`, `+0,012/bande=0,025` :
deux fois sur trois l'écart est SOUS la bande, et `gardee` apparaît sur
deux des trois derniers verdicts, contre quatre sur douze la veille. La
piste la plus sérieuse pour débloquer le rodage se referme donc d'
elle-même : ce n'était pas la largeur de la bande. Rien n'a été changé.

### Ce qui va mal, et il faut le dire sans l'adoucir

L'écart entre le holdout et le direct **s'aggrave** pendant que le
holdout, lui, s'améliore :

| | holdout de la cellule | direct |
|---|---|---|
| 18h43 | +4,6 bps/trade après coûts | −8,5 bps sur 44 fermetures |
| **20h13** | **+6,1 à +9,1** | **−21,0 bps sur 42 fermetures** |

À 42 fermetures et un écart-type de 51,6 bps par trade, l'erreur type
vaut 8,0 : **−21 bps est à 2,6 σ de zéro**. Au niveau des JAMBES, ce
n'est plus indistinguable du bruit — contrairement à la mesure par
instants de portefeuille (`live_rule` n=95, −4,2 bps, erreur type ~5),
qui elle reste muette. Les deux mesurent des objets différents et c'est
la seconde que la porte valide ; il reste que le compte perd 15 USD en
quatre-vingt-dix minutes, brut réalisé −8,40 contre 15,89 de frais, et
que le bandeau dit `les frais dominent le brut`.

Le rodage fait exactement ce pour quoi il a été construit : `confiance`
est à son plancher de 0,10, la taille est au dixième de ce que l'avantage
justifierait, et la perte est lente et bornée. **Aucune porte n'a été
touchée, `live_rule` n'a pas été remise à zéro, le barème du rodage est
intact.** Mais l'écart holdout/direct est désormais LE défaut ouvert, et
il ne s'explique plus par le retard d'entrée, qui a été divisé par deux
sans que le direct s'améliore.

**Et le moteur prend enfin des positions courtes.** Le 27 août à 18h25,
pour la première fois au journal : `ouverture UNI −58 @ 4,568750 x5
(candle −7,6 bps)`, puis XRP −258 (−18,8 bps), BNB −1,05 (−9,9 bps), XRP
−722 (−8,9 bps). L'exigence « long ET short » du but n'était pas
vérifiable jusqu'ici ; elle l'est, et la réponse est oui. Le holdout de
la cellule retenue annonçait `court=13 %`.

Compté sur les vingt ouvertures de 18h50 à 20h12 : **douze courtes**
(UNI ×3, XRP ×5, SOL ×4) contre huit longues, soit **60 %** — bien
au-delà des 12 à 16 % que les verdicts d'horloge annoncent sur leur
holdout. Ce n'est pas une contradiction : le `court=NN %` porte sur
des mois, l'échantillon vivant sur quatre-vingt-dix minutes d'un
marché qui descendait. À noter et à relire, pas à corriger.

**Le glissement d'entrée s'est effondré** à mesure que le panel devenait
crypto :

| | moyenne | n | médiane |
|---|---|---|---|
| 15h30 | +21,32 | 28 | — |
| 17h49 | +16,79 | 35 | — |
| 18h05 | +16,20 | 36 | +0,00 |
| **18h21** | **+2,10** | **52** | **−4,68** |
| **18h43** | **+1,02** | **60** | **−4,21** |
| **20h13** | **+0,78** | **82** | **−0,52** |
| **22h12** | **+0,72** | **103** | **−0,52** |
| **00h40** | **+0,36** | **123** | **−0,52** |
| **03h42** | **+0,28** | **200** | **−0,58** |
| **07h22** | **+0,20** | **229** | **−0,52** |
| **09h39** | **−0,01** | **240** | **−0,58** |
| **12h17** | **+0,20** | **265** | **−0,19** |

La médiane est **négative** : l'ouverture typique se remplit *mieux* que
le prix du signal, et la moyenne était portée par une poignée de jambes —
celles de l'horloge 15m, qui décide avec douze minutes de retard, sur des
actions tokenisées. Les deux lectures que j'avais opposées étaient donc
vraies **chacune sur son horloge** : l'artefact print/cotation domine sur
la 1m, le vrai retard domine sur les longues. Ce qui suit de là, et qui
n'est pas encore fait : mesurer le glissement **par horloge** au lieu de
tout verser dans une seule moyenne.

**Le critère 24/7 a écarté sept noms** — SNDK, XAU, SKHYNIX, SOXL, SPCX,
MU, CRCL — chacun avec ses trois chiffres au journal. XAU (1,75) et
SKHYNIX (1,80) n'ont été pris que par la **concentration** ; la fenêtre
new-yorkaise les avait ratés tous les deux.

Et la conjonction s'est justifiée dès la première heure : **LIT échange
0,73 de son volume de semaine le week-end**, sous le seuil de 0,75 — mais
sa concentration vaut 1,25 et sa séance/nuit 1,28. Le critère l'a
**admise**. Le seuil de volume pris seul aurait écarté une vraie crypto
dès le premier tour.

**Ce qui va mal, et le moteur le dit lui-même** : `les frais dominent le
brut : c'est un moulin, pas un pari`. La cellule 1m retenue tourne à
60-65 trades par jour ; en une demi-heure le compte est passé de 72 à 101
remplissages, pour +0,39 USD de brut réalisé contre 7,53 de frais. Le
holdout annonce +4,6 bps par trade *après* coûts ; le direct rend −6,0.
L'écart de dix points de base est exactement de l'ordre de ce que le
retard d'entrée peut manger — c'est la prochaine chose à instruire.

### Quatrième lecture, 22h12 — l'écart se referme, et une jambe reprise apparaît

La question posée était : l'écart holdout / direct se creuse-t-il ? La
réponse est **non**, et le détail de l'attribution explique pourquoi elle
semblait dire l'inverse.

| | holdout | direct, tous motifs | dont time-stop |
|---|---|---|---|
| 20h13 | +6,1 à +9,1 bps | −21,0 sur 42 | −21,0 (42, seul motif) |
| **22h12** | **+5,9 à +6,0** | **−10,0 sur 40** | **−8,1 (39)** |

Sur le motif qui porte tout — la sortie au temps — l'écart passe de
**27 bps à 14 bps**. Il se referme. Ce qui a changé entre les deux, c'est
le retard d'entrée, divisé encore par deux.

Ce qui l'avait masqué est un motif **neuf** : `TRAIL`, une seule
fermeture, **−84,6 bps pour 11,11 USD** — un tiers de la perte de la
fenêtre sur une jambe. Le stop suiveur a fait son travail ; à n=1 on ne
peut rien en conclure d'autre que : le compter.

**Le retard, quatrième lecture** — cumul 60 s sur 374 décisions (contre
93 s sur 182) ; par échelle 1m 17 s, 3m 49 s, 5m 80 s, 15m 209 s, 1H
1 216 s, tous en baisse continue. Par ligne, en régime permanent : 1m
`retard=2 à 7 s`, `charge=0,3 s`, `calcul=5,7 à 6,0 s`, soit **≈ 10 s**
entre la clôture et l'ordre, contre 21 à 26 s ce matin.

**L'hystérésis, lectures 4 et 5** : `+0,005/bande=0,028` et
`+0,000/bande=0,025`, toutes deux `gardee`. **Quatre lectures sur cinq
sous la bande**, et `gardee` sur les trois derniers verdicts consécutifs.
La question est tranchée : la bande n'était pas le problème.

### La cause nommée : une jambe reprise dans la barre qui vient de la fermer

Le journal de 20h à 22h montre, en clair :

```
21:39:45  time-stop 6m XRP -900        21:39:45  ouverture XRP -902
22:09:12  time-stop 6m SOL -4,56       22:09:12  ouverture SOL -4,15
22:07:43  time-stop 6m XRP -532        22:08:09  ouverture XRP -570
21:58:13  time-stop 6m SOL -12,04      21:59:17  ouverture SOL -12,00
```

Même nom, même sens, même taille, **dans la seconde ou la minute**.
Chacun paie un aller-retour complet — 3,48 bps de frais mesurés — pour
une position qui n'a pas changé. La sortie au temps ne dit rien du
signal : elle dit que l'horizon validé est atteint. Si le signal tient
encore, le moteur reprend la même jambe et repaie.

Le compte est désormais tenu : nombre d'ouvertures qui reprennent une
jambe soldée **au temps**, du même sens, **dans la durée de barre de
l'horloge qui l'avait ouverte** — la seule fenêtre défendable, puisqu'une
horloge d'une minute ne peut rien apprendre de neuf en moins d'une
minute. Un stop touché ou un take atteint n'arment pas le compteur : y
revenir est un trade neuf, qui a le droit de coûter.

**MESURÉ, BRANCHÉ À RIEN.** Combien cela coûte réellement n'est pas
établi — « un tiers de la perte » serait une estimation tirée d'un
partage grossier des 26,70 USD de frais, pas une mesure. On compte
d'abord, on décidera ensuite. C'est exactement la discipline qui a évité
le seuil de 0,15 et la bande d'hystérésis.

### Cinquième lecture, 00h40 — le compteur répond, et il me contredit

**Les reprises sont fréquentes et coûtent peu.**

```
jambes reprises dans la barre 7 sur 18 ouvertures   2 959 USD de notionnel
```

| | |
|---|---|
| part des ouvertures | **39 %** — bien au-delà du quart |
| notionnel repris | 2 959 USD sur 13 981 traités dans la fenêtre, soit 21 % |
| coût à 3,48 bps | **1,03 USD** |
| frais de la fenêtre | 4,87 USD — les reprises en font 21 % |
| résultat de la fenêtre | **+7,16 USD** |

Le critère que j'avais posé demandait les DEUX : plus d'un quart des
ouvertures **et** un coût comparable à une part sérieuse des frais. Le
premier est franchement dépassé, le second vaut **un dollar**. Sur une
fenêtre où le compte a *gagné* 7,16 USD, supprimer les reprises en aurait
ajouté un. **C'est marginal, et on ne corrige pas.** Le compteur reste,
il ne coûte rien et il répondra si la cadence change.

### Et l'écart holdout / direct s'est refermé tout seul

| | holdout | direct, time-stop |
|---|---|---|
| 20h13 | +6,1 à +9,1 bps | **−21,0** sur 42 |
| 22h12 | +5,9 à +6,0 | **−8,1** sur 39 |
| **00h40** | **+5,2** | **+0,5** sur 38 |

27 bps, puis 14, puis **4,7**. Le direct sur la sortie au temps est
maintenant **positif**.

**J'AI CONCLU TROP VITE À 20h13, et il faut l'écrire.** J'y avais noté :
« le retard d'entrée a été divisé par deux SANS que le direct s'améliore :
ce n'était donc pas lui, ou pas seulement lui ». C'était faux, et la
raison de l'erreur est instructive : l'attribution est une **fenêtre
glissante d'une quarantaine de fermetures**. Quand le retard tombe à
l'instant *t*, les fermetures d'avant *t* restent dans la fenêtre pendant
une heure ou deux et continuent de la tirer vers le bas. Lire une fenêtre
glissante comme une mesure instantanée, c'est conclure sur un chiffre qui
décrit surtout le passé. **C'était bien le retard.**

Ce qui reste au passif : `TRAIL`, toujours la même unique fermeture à
−84,6 bps pour 11,11 USD, qui porte à elle seule les trois quarts du
−15,26 de la fenêtre. À n=1, on compte, on ne conclut pas.

Les deux mesures du direct suivent : `live_rule` n=125 à **−3,0** bps
(contre 114 à −4,0), `en risque` n=57 à **−5,7** (contre 46 à −8,0). Le
brut réalisé du livre remonte de −17,72 à **−7,85**, soit près de dix
dollars gagnés en deux heures et demie — le premier signe positif du
compte depuis le matin. L'équité, elle, reste à 9 302,70 (−6,97 %) : les
frais du moulin mangent encore ce que le brut regagne.

**Le retard, cinquième lecture** : cumul 50 s sur 576 décisions ; 1m 16 s,
3m 46 s, 5m 69 s, 15m 175 s, 1H 978 s. Tout continue de descendre.

**Mémoire : 3 981 Mo**, contre 3 445 deux heures et demie plus tôt. La
tendance monte, mais le chiffre reste dans la plage que le moteur
occupait AVANT le recollage de série (pics de 3,6 à 4 Go relevés à 15h18
et 17h51). Le cache n'est donc pas manifestement le moteur de cette
croissance, et poser un plafond maintenant serait agir sur une cause
supposée. On continue de lire.

### Sixième lecture, 03h42 — le direct dit maintenant que la règle perd

**Et je me suis trompé une seconde fois, de la même façon.** À 00h40
j'écrivais que le direct sur la sortie au temps était « repassé positif »
(+0,5 bps sur 38) et j'y voyais la fin de l'histoire. Trois heures plus
tard la même fenêtre glissante donne **−25,9 bps sur 44**. Je venais
d'expliquer, dans le paragraphe précédent, qu'une fenêtre glissante ne
se lit pas comme une mesure instantanée — et je l'ai relue ainsi dès
qu'elle m'était favorable. La règle vaut dans les deux sens ou elle ne
vaut rien.

Ce qui, lui, ne glisse pas, c'est le compteur cumulé du direct :

| | n | bps | erreur type | écart à zéro |
|---|---|---|---|---|
| 22h12 | 114 | −4,0 | 4,7 | 0,9 σ |
| 00h40 | 125 | −3,0 | 4,5 | 0,7 σ |
| **03h42** | **179** | **−11,4** | **3,7** | **3,0 σ** |

`en risque` suit : n=111 à **−18,2** bps, contre 57 à −5,7. **À trois
sigma, ce n'est plus du bruit : la règle jouée perd de l'argent, et la
mesure le dit maintenant avec assez de matière pour être crue.** C'est le
résultat de la nuit, et il est négatif.

Le livre sur la fenêtre 00h40 → 03h42 : équité 9 302,70 → **9 279,69**
(−23,01), brut réalisé −7,85 → **−20,35** (−12,50), frais −31,57 →
−38,59 (−7,02), et **158 remplissages en trois heures** — 53 par heure.

### Le compteur de reprises franchit son critère

```
jambes reprises dans la barre 51 sur 95 ouvertures   8 873 USD de notionnel
```

| | 00h40 | **03h42** |
|---|---|---|
| part des ouvertures | 39 % (7/18) | **54 % (51/95)** |
| coût à 3,50 bps | 1,03 USD | **3,11 USD** |
| part des frais de la fenêtre | 21 % | **44 %** |

Le critère posé la veille demandait les deux — plus d'un quart des
ouvertures **et** une part sérieuse des frais. À n=95, les deux sont
franchis. Ce n'est plus marginal : 3,11 USD sur 7,02 de frais, soit 13 %
d'une perte de 23 USD.

**Et pourtant la correction évidente n'est pas disponible.** Supprimer
l'aller-retour demande de *ne pas solder* une jambe que le signal veut
garder — donc de la tenir **au-delà de l'horizon de h barres que la porte
a validé**. Ce n'est pas exécuter moins cher : c'est jouer une autre
règle. La porte a mesuré « entrer, tenir six barres, sortir » ; « tenir
tant que le signal dépasse le seuil » est une **règle différente**, dont
personne n'a mesuré l'économie.

Il y aurait une variante comptable — enregistrer la fermeture au prix
marqué sans passer l'ordre — mais elle remplacerait un prix *rempli* par
un prix *coté* dans la mesure du direct, soit un demi-spread de flatterie
à chaque trade. Exactement le genre de chiffre plus beau que la réalité
que tout le reste de ce document existe pour empêcher.

**Donc : rien n'est corrigé.** Ce qui est nommé ici n'est pas un défaut
d'exécution mais **une famille de sortie que la recherche ne cherche
pas** : la grille contient `fixe` et `suiv` comme gardes-fous, et un
horizon `h` fixe, mais aucune sortie conditionnée au maintien du signal.
L'ajouter est un travail de recherche — une dimension de plus dans la
grille, donc une barre déflatée plus haute — pas un correctif de nuit.

### Deux questions se ferment

**La mémoire n'est pas une fuite.** 4 001 Mo à 03h42 contre 3 981 à
00h40 : **+20 Mo en trois heures**, après +536 sur les deux heures
précédentes. La croissance s'est arrêtée d'elle-même, dans la plage que
le moteur occupait déjà avant le recollage de série. Le plafond du cache
n'a pas lieu d'être posé — et ne pas l'avoir posé sur la foi d'une
tendance de deux points était la bonne décision.

**Le retard continue de descendre** : cumul 43 s sur 868 décisions ; 1m
16 s, 3m 45 s, 5m 62 s, 15m 144 s, 1H 737 s. Le glissement facturé vaut
+0,28 bps sur 200 ouvertures, médiane −0,58.

### Septième lecture, 07h22 — la conclusion est établie

`live_rule` **n=203, −11,7 bps**, erreur type 3,51 : **3,3 σ sous zéro**,
sur plus de deux cents instants. La condition que je m'étais fixée — plus
de 3 σ sur n > 200 — est remplie. **La règle jouée perd de l'argent, et
ce n'est plus une question de bruit.** `en risque` : n=135 à −17,1.

Le livre sur la fenêtre 03h42 → 07h22 (3 h 40) :

| | |
|---|---|
| équité | 9 279,69 → **9 273,94** (−5,75, soit −1,57 USD/h) |
| brut réalisé | −20,35 → −19,66 — **+0,69, positif sur la fenêtre** |
| frais | −38,59 → **−45,03** (−6,44) |
| remplissages | 401 → 459 (+58, contre +158 sur la fenêtre précédente) |

**Toute la perte de la fenêtre vient des frais.** Le brut est positif ;
c'est littéralement ce que le bandeau répète depuis six heures.

Gardes-fous intacts : `halted_today` faux, `killed` faux, recul depuis le
pic de 10 308,48 = **10,04 %** ; le coupe-circuit agit à 25 %, soit
7 731,36 — **1 543 USD de marge**.

### Le compteur de reprises : troisième lecture, et le coût explose

| | 00h40 | 03h42 | **07h22** |
|---|---|---|---|
| part des ouvertures | 39 % (7/18) | 54 % (51/95) | **51 % (63/124)** |
| notionnel repris | 2 959 USD | 8 873 | **12 231** |
| coût à 3,50 bps | 1,03 USD | 3,11 | **4,28** |
| part des frais de la fenêtre | 21 % | 44 % | **66 %** |
| part de la perte de la fenêtre | — | 13 % | **74 %** |

Trois lectures, une part stable autour de la moitié. Sur la dernière
fenêtre, **les allers-retours de reprise coûtent 4,28 USD sur une perte
de 5,75** — les trois quarts. Sans eux, la perte serait de 1,47.

### La sonde : la porte voit-elle la même chose ?

C'est la question qui décide si c'est un **défaut** ou une **règle qui
fait ce qu'on a validé**, et elle est enfin posable.

Le holdout est aminci à `(ts // pas) % h == 0` : deux instants de test
consécutifs d'un même nom sont donc **exactement h barres l'un de
l'autre** — précisément le motif « solder au temps puis rouvrir ». La
comparaison est donc licite, et elle ne coûte rien.

Le verdict d'horloge porte désormais `suite=NN%`, la part des
déclenchements qui prolongent le précédent : même nom, exactement h
barres plus tard, même sens. Calculée **pour la seule cellule retenue** —
la porter sur les 4 860 coûterait le balayage. Elle exige une étiquette
d'instrument sur chaque instant du holdout, qui n'existait pas : sans
elle, deux noms différents qui se suivent dans le temps passeraient pour
une reprise.

- Si `suite` vaut aussi la moitié, la porte facture déjà ces
  allers-retours et le direct ne fait que ce qu'elle a mesuré. La cause
  de la perte est ailleurs.
- Si `suite` est nettement plus basse, le moteur rouvre bien plus souvent
  que la règle validée, et l'écart est un vrai défaut.

**MESURÉE, BRANCHÉE À RIEN.** On la journalise ; on ne décide rien avec
avant de l'avoir lue.

**Le retard continue de descendre** : cumul 39 s sur 1 226 décisions ; 1m
16 s, 3m 45 s, 5m 57 s, 15m 123 s, 1H 562 s. Glissement +0,20 bps sur 229
ouvertures, médiane −0,52.

**La mémoire remonte** : 4 357 Mo contre 4 001, soit +97 Mo/h après trois
heures de plateau. Toujours sous les 5 Go, et toujours dans la plage
historique du moteur — mais la question se rouvre.

### La sonde a répondu : la porte voit l'essentiel du motif

Deux verdicts d'horloge portent le champ neuf :

```
live [mlp/h6/abs] net=+4.36bps ... court=13% suite=36% parjour=45.6
live [mlp/h6/abs] net=+4.76bps ... court=20% suite=34% parjour=38.6
```

| | |
|---|---|
| holdout, `suite` | **34 à 36 %** |
| direct, reprises de jambe | **51 %** (69/135) |
| écart | 16 points, rapport 1,46 |

J'avais posé deux bornes avant de lire : ≈50 % signifierait que la porte
facture déjà ces allers-retours, moins de 25 % qu'elle ne les voit pas.
La réponse tombe **entre les deux, nettement plus près de la première** :
la porte facture **69 %** du motif que le direct paie.

Et les deux quantités ne sont pas rigoureusement le même objet, ce qui
explique une part de l'écart sans qu'on ait besoin d'un défaut : `suite`
compte les *déclenchements* du holdout, le compteur direct compte les
*ouvertures effectives*, qui doivent en plus passer les plafonds,
l'arrondi de lot et le plancher de poussière.

Le surplus non modélisé vaut environ 16 points sur 135 ouvertures, soit
une vingtaine d'allers-retours — **moins d'un dollar** sur une perte
cumulée de 65. **Marginal. La cause de la perte est ailleurs**, et cette
piste-là est close.

### La piste suivante, et son chiffre de départ

Ce que la porte valide et ce que le moteur joue ne sont pas le même
livre :

| | la porte | le direct |
|---|---|---|
| portefeuille | `panel[20]`, 3 792 trades sur 174 024 barres-instrument | **1 à 2 jambes tenues** |
| notionnel brut | plafond 20,0 des fonds propres | `utilise 0,029` — **0,15 % du plafond** |

Les huit ouvertures de 08h46 à 09h35 sont **toutes SOL**, toutes longues,
toutes refermées au temps à six minutes, sur un prix qui oscille entre
105,97 et 106,55. Le moteur rejoue une seule jambe en boucle là où la
porte a mesuré un portefeuille de vingt noms dont les erreurs se
compensent.

L'espérance d'une jambe isolée est celle du portefeuille, mais sa
variance est bien plus grande — et surtout, **si seules les jambes assez
grosses franchissent le plancher de poussière, ce ne sont pas un
échantillon au hasard du portefeuille**. Le rodage à 0,10 réduit la
taille au dixième ; à ce niveau, une bonne part des jambes que la cible
propose ne peut plus être ouverte du tout.

C'est **testable** : compter les jambes que la cible propose contre
celles qui sont réellement ouvertes, et la raison des refus. Le moteur a
déjà `poussiere_usd` et `_tient()` ; il ne lui manque que le compte.

### Le compte, lui, s'est presque arrêté de perdre

| | 07h22 → 09h39 (2 h 17) |
|---|---|
| équité | 9 273,94 → **9 272,48** (−1,46, soit **−0,64 USD/h** contre −1,57) |
| brut réalisé | −19,66 → −18,94 — **+0,72, positif** |
| frais | −45,03 → −46,67 (−1,64) |
| remplissages | +22, contre +58 sur la fenêtre précédente et +158 avant |

La cadence s'effondre — de 53 remplissages par heure à 10 — et avec elle
la perte. `live_rule` reste à **n=212, −11,6 bps, 3,4 σ** : la conclusion
tient, mais le saignement s'est presque arrêté.

Le glissement d'entrée est tombé à **−0,01 bps sur 240 ouvertures** :
facturé zéro. Le retard tient à 40 s de cumul sur 1 412 décisions. La
mémoire est retombée à 3 424 Mo après le redémarrage de 08h15.

**Une cellule à h=1 est apparue** : `net=+15,47 bps/trade`, `sr=+0,196`,
`pente=1,45 ± 0,03` — soit quinze erreurs types au-dessus de 1, la
première pente franchement supérieure à l'unité de toute la campagne —
`parjour=85,7`, `gainjour=+878 bps`. À surveiller : une horloge d'une
minute avec un horizon d'une barre est aussi celle où le retard de 16 s
pèse le plus lourd.

### Huitième lecture, 12h17 — deux hypothèses tombent, une piste neuve

**Mon hypothèse « une seule jambe en boucle » est infirmée.** Les vingt
ouvertures de 10h02 à 11h29 portent **huit noms distincts** :

| SOL | BCH | TRUMP | DOGE | ENA | LTC | SUI | XRP |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 3 | 3 | 1 | 1 | 1 | 1 |

L'épisode « huit SOL d'affilée » de 08h46-09h35 était un **moment**, pas
un régime. Ce qui reste vrai : le livre tient **zéro à deux jambes
simultanées** — `pos: {}` et `utilise 0,000` à l'instant du relevé —
contre les vingt que la porte met en commun. Mais la cause n'est pas la
concentration sur un nom.

**Et j'ai commenté une fenêtre courte pour la troisième fois.** À 09h39
j'écrivais que le compte « s'était presque arrêté de perdre ». Sur
09h39 → 12h17 : équité 9 272,48 → **9 263,24**, soit **−3,51 USD/h**
contre −0,64, et un brut réalisé de **−7,22**. La perte a réaccéléré.
Trois fois maintenant — une fois dans chaque sens, puis encore — j'ai
tiré une conclusion d'une fenêtre de deux heures. **Règle : ne plus
commenter les fenêtres courtes du tout.** Seul le cumulé compte.

Le cumulé, justement : `live_rule` **n=238 à −12,7 bps**, erreur type
3,24, soit **3,9 σ**. `en risque` n=170 à −17,3. Le gouverneur commence à
freiner de lui-même (`frein 0,99`).

### La piste neuve : le suiveur

```
attribution sur les 39 dernieres fermetures mesurees
  TRAIL           1     -295,5     -6,09
  time-stop      38      -11,0     -6,14
  TOTAL          39      -18,3    -12,24
```

**Une seule fermeture fait la moitié de la perte de sa fenêtre.** C'est
le deuxième `TRAIL` de la campagne, après −84,6 bps hier soir. Deux
occurrences, toutes deux dévastatrices, dans un flot de sorties au temps
à −11 bps.

**Et ce motif était invisible au relevé.** La fenêtre « éclaireurs et
sorties » grepe `TP`, `SL`, `time-stop`, `explore`, `orpheline` — **mais
pas `TRAIL`**. Or la ligne du journal porte la largeur armée : `scalp
TRAIL 120bps SOL-USDT-SWAP +2.410000 @ 105.980000`. Le motif le plus
coûteux du relevé était précisément celui qu'on ne montrait pas. Corrigé
— changement de workflow seulement, effet immédiat, sans déploiement et
sans redémarrer le moteur.

**L'ambiguïté à trancher, et elle est nette.** Le suiveur sort à
`sommet × (1 − largeur)`. Pour un long dont le sommet vaut au moins
l'entrée, la perte rapportée à l'entrée **ne peut pas dépasser la
largeur** — sauf si le prix a sauté par-dessus le suiveur entre deux
tours. Donc :

- si la largeur armée vaut ≈ 295 bps, **le stop a parfaitement tenu**, et
  −295,5 est simplement ce que coûte un stop à 4 σ sur un nom agité
  quand il est touché. Rien à corriger ;
- si elle vaut 120 ou 150, **le prix a traversé** et le suiveur ne
  protège pas ce qu'il prétend protéger.

La ligne du journal donne la réponse dès la prochaine occurrence, sans
attendre d'en avoir cinq. C'est pour cela que le grep valait la peine.

**Le reste tient.** `suite` = 32, 34, 36, 36, 40 % sur cinq verdicts —
stable autour de 36 %, la lecture de 09h39 est confirmée. Reprises 78/160
= 49 %. Retard : cumul 38 s sur 1 673 décisions ; 1m 16 s, 15m 116 s, 1H
535 s. Mémoire 3 380 Mo, plate. La cellule à h=1 aperçue à 09h39 n'est
plus dans les verdicts : elle n'a pas tenu.

### Neuvième lecture, 13h33 — le suiveur répond, et les deux branches sont vraies

La question posée à 12h17 était binaire : la largeur armée tient-elle,
ou le prix passe-t-il au travers ? Il a fallu élargir la fenêtre pour le
savoir — le relevé de 13h25 ne montrait **aucune** ligne `TRAIL`, non
pas parce que le grep la ratait encore, mais parce que la fenêtre des
sorties couvre **deux heures** et que la fermeture était plus vieille
que cela. La preuve était dans le même relevé : la table d'attribution
portait toujours `TRAIL n=1 −295,5 bps`. L'événement était là, hors de
la fenêtre censée le montrer.

Deux corrections de portée, workflow seul, sans déploiement : une
fenêtre dédiée sur **vingt-quatre heures**, puis un `awk` qui apparie
chaque sortie avec **l'ouverture du même titre** — le contexte de deux
lignes remontait les deux ouvertures qui précèdent, donc ENA et LTC pour
un `TRAIL` de TRUMP. L'instrument est lu **au motif**
`[A-Z0-9]+-USDT-SWAP`, jamais par la position du champ : c'est la leçon
du 26 août, appliquée.

Les deux occurrences de la campagne, entrée et sortie en face :

| jambe | entrée | sortie | perte brute | largeur armée | dépassement |
|---|---|---|---|---|---|
| SOL court, 27/08 22h02 | 108,6375 | 109,4800 | **77,6 bps** | **75** | **+2,6 bps (+3,4 %)** |
| TRUMP long, 28/08 10h04 | 2,712250 | 2,634000 | **288,5 bps** | **227** | **+61,5 bps (+27,1 %)** |

**Les deux branches sont vraies, une chacune.** Sur SOL le suiveur a
tenu : 2,6 points de base de dépassement, l'ordre de grandeur d'un tour
d'horloge, rien à corriger. Sur TRUMP **le prix est passé au travers**,
de 61,5 bps, soit **27 % au-delà de la largeur armée**. Le mécanisme
n'est plus une hypothèse : il est mesuré. Le sommet ne se met à jour
qu'aux fermetures du moteur, et TRUMP a perdu 288 bps en six minutes ;
entre deux tours, le suiveur ne protège pas ce qu'il annonce.

**Et le recoupement tombe à la décimale.** 288,5 bps de brut calculés
depuis les deux prix **remplis**, plus 7,0 bps de frais aller-retour
(3,5 × 2), font **295,5** — exactement ce qu'annonce la table
d'attribution. La chaîne de mesure est vérifiée de bout en bout : les
bps de la table sont nets de frais et partent bien des prix remplis.
C'était le premier recoupement indépendant de cette table.

**Ce que pèsent ces deux fermetures, en cumulé et non en fenêtre
glissante.** SOL portait 1 303,65 USD de notionnel, TRUMP 212,37 :

```
SOL    -10,11 USD de brut
TRUMP   -6,13 USD de brut
somme  -16,24 USD  sur un brut realise de -26,17 USD sur la vie du compte
```

**Deux remplissages sur 541, soit 0,37 %, portent 62 % de toute la
perte brute réalisée du compte.** Cet énoncé-là est cumulé, il ne
dépend d'aucune fenêtre, et il survivra au prochain relevé.

**Ce que je ne fais pas, et pourquoi.** La largeur de 227 bps sur un
signal dont l'avantage attendu vaut 8,5 bps n'est pas une bévue : le
stop est à `4σ` par construction, et sur TRUMP à six barres 4σ vaut bien
227 bps. Un stop à 4σ n'est touché que par un mouvement à 4σ, donc
rarement et cher. **Je ne touche à aucune largeur : j'ai deux
occurrences.** Poser un seuil sur deux lectures est exactement l'erreur
que le paragraphe 10 interdit. La mesure est faite, elle est écrite,
elle attend la troisième.

**Et il faut le dire dans l'autre sens aussi** : avec 49,46 USD de frais
contre 26,17 de brut, le suiveur n'est pas *la* cause de la
non-rentabilité — le moulin l'est. Il est la plus grosse concentration
de perte brute identifiée à ce jour, ce qui n'est pas la même chose.

**Le cumulé au moment du relevé** : `live_rule` **n=241 à −12,62 bps**,
`en risque` n=173 à −17,1, équité **9 263,75**, 541 remplissages,
`halted_today` faux, `killed` faux, frein 0,99, confiance 0,10. Retard
37 s sur 1 790 décisions. Reprises 79/165. Glissement +0,22 bps sur 270
ouvertures, médiane +0,16. Le livre tient deux jambes, BCH court et SOL
long, pour 0,019 % du plafond.

### Dixième lecture, 14h35 — pas de troisième suiveur, et les refus deviennent visibles

**Première question : non.** La fenêtre de vingt-quatre heures porte
toujours **exactement deux** sorties au suiveur, les mêmes qu'à 13h33 —
SOL le 27 à 22h02 (75 bps armés) et TRUMP le 28 à 10h04 (227 bps). Rien
à ajouter au tableau. Le compte reste à deux, et deux ne suffisent
toujours pas pour toucher à une largeur.

**Le cumulé** : `live_rule` **n=244 à −12,01 bps**, `en risque` n=176 à
−16,2, équité **9 264,29** en 551 remplissages, `halted_today` faux,
`killed` faux, frein 0,99, confiance 0,10. Le brut réalisé passe de
−26,17 à **−24,42**, les frais de 49,44 à 49,92.

### Deuxième question : le relevé ne pouvait pas y répondre

Compter les jambes que la règle **propose** contre celles que le moteur
**ouvre** ne demandait pas une fenêtre de journal de plus : il n'y a
rien à greper. Tous les refus d'`execute_pending` sont des `continue`
muets. Un `continue` ne laisse aucune trace — ni au journal, ni à
l'écran, ni au relevé. C'est pour cela que « la règle ne propose rien »
et « le moteur refuse tout » sont restés indiscernables depuis le début,
et c'est le dernier écart non instruit entre le livre validé et le livre
joué.

Chaque motif est compté **séparément**, parce qu'ils ne se corrigent pas
du tout de la même façon :

| compteur | ce qu'il dit |
|---|---|
| `n_vise` | vœux non nuls de la règle, comptés **avant** l'arrondi |
| `n_ordre` | vœux honorés par un ordre d'ouverture ou de redimensionnement |
| `n_deja` | jambe **déjà tenue** à la taille voulue — pas un refus, rien à faire |
| `refus_plancher` | le vœu entier vaut moins que le plancher d'ordre |
| `refus_arrondi` | le lot minimal de l'échange ramène le vœu à zéro |
| `refus_prix` | pas de prix pour l'instrument |
| `refus_rejet` | l'échange a refusé l'ordre |

Trois décisions de conception valaient chacune une contre-épreuve, et
chacune l'a passée.

**Le compte se fait avant l'arrondi.** Le mesurer après ferait
disparaître la jambe du dénominateur en même temps que le lot minimal la
refuse : le taux d'ouverture paraîtrait parfait précisément quand il est
le pire.

**« Déjà tenue » n'est pas un refus.** Le même `continue` couvrait deux
situations sans rapport — un vœu trop petit pour ouvrir, et une position
stable qu'il n'y a rien à faire. Les confondre aurait fait de chaque
tour d'une position tranquille un refus, et le taux d'ouverture aurait
été un pur artefact du nombre de tours.

**Et surtout : aucun `continue` après le refus d'arrondi.** C'est la
contre-épreuve la plus utile de la série. Un vœu que le lot ramène à
zéro doit être *compté*, mais la cible nulle qui en résulte est aussi ce
qui **ferme** une position existante. Poser un `continue` là aurait
condamné toute position dont la règle ne sait plus exprimer la taille à
vivre indéfiniment. La contre-épreuve D le montre : avec le `continue`,
la position n'est jamais soldée et le test tombe. **Un compteur ne doit
rien changer au comportement**, et c'est un test qui le garantit, pas
une intention.

### Ce que le relevé laisse déjà deviner, et qu'il ne faut pas conclure

Le plancher d'ordre vaut `max(10 USD ; 0,2 % des fonds propres)`, donc
**18,53 USD** aux fonds propres actuels. Or la table du relevé du 13h30
portait, en toutes lettres :

```
BCH    candle  short  6    -8.1    +3.8   60.1  1551    +0.3  -0.0096       -89       +899
BCH    candle  short  6    -6.3    +3.8   60.1  1551    +0.3  -0.0019       -17       +177
```

**−17 USD contre un plancher de 18,53.** Cette jambe-là ne pouvait pas
ouvrir. C'est une lecture ponctuelle sur une ligne, pas une mesure : je
l'écris comme hypothèse et le compteur la tranchera au prochain relevé.
Si la majorité des vingt vœux meurent sous le plancher, alors le livre
de deux noms n'est pas un choix de la règle — c'est un seuil d'exécution
qui décide à sa place.

### Une cellule à regarder sans y toucher

À 14h04 l'horloge 1H a retenu `[mlp/h1/abs]` avec `ic=0.471`,
`net=+226,45 bps/trade`, `sr=+1,241`, contre un seuil de 171,5 bps à
4 σ — sur 317 instants, `parjour=0,8`, `suite=6 %`. Un IC de 0,47 sur
une horloge horaire n'a aucun précédent dans cette campagne. Je le note
et **je n'en fais rien** : une cellule qui franchit une barre à 4 σ une
fois est exactement ce que la barre déflatée existe pour ne pas croire
sur parole. Le prochain verdict dira si elle est encore là.

**Le reste** : retard 37 s sur 1 889 décisions (1m 16 s, 3m 45 s,
5m 55 s, 15m 112 s, 1H 496 s). Reprises 80/166. Glissement +0,24 bps sur
271 ouvertures, médiane +0,16. Les éclaireurs sont de retour — trois en
deux heures — ce qui est leur rôle prévu : jouer à taille minimale une
règle validée dont le frein a ramené la taille à zéro, pour qu'elle
continue d'accumuler de la preuve.

### Onzième lecture, 16h09 — l'hypothèse est confirmée, et la boucle est vicieuse

Le compteur déployé à 15h02 a parlé au premier relevé :

```
jambes visees par la regle 79   ouvertes ou redimensionnees 23   deja tenues 0
  refusees: plancher 50  arrondi 6  rejet 6
  dont 50 jambes sous le plancher dordre : 484 USD de notionnel jamais ouvert
```

**Soixante-trois pour cent des vœux de la règle meurent sous le plancher
d'ordre.** Vingt-neuf pour cent seulement deviennent un ordre.
L'hypothèse écrite à 14h35 n'était pas seulement juste : elle était en
dessous de la vérité.

Et le même relevé porte la démonstration dans son propre tableau, au
même instant, sur les six jambes proposées :

| nom | USD joué | USD plein | plancher 18,52 |
|---|---|---|---|
| BTC | 50 | 508 | ouvre |
| DOGE | 32 | 326 | ouvre |
| SOL | 28 | 282 | ouvre |
| ENA | **12** | 120 | **refusé** |
| TRUMP | **11** | 109 | **refusé** |
| PUMP | **10** | 100 | **refusé** |

Trois sur six, sur cette ligne-là. Et la colonne « USD plein » multipliée
par le rodage (0,10) redonne la colonne jouée **à l'unité près** :
508 × 0,10 = 51, 120 × 0,10 = 12, 100 × 0,10 = 10. La chaîne est
complète, sans trou.

### La boucle, et c'est elle qui compte

1. l'avantage seul justifie des jambes de **100 à 508 USD** ;
2. le **rodage** les divise par dix → 10 à 51 USD ;
3. le **plancher d'ordre**, à `max(10 USD ; 0,2 % des fonds propres)` =
   18,52 USD, **supprime** toutes celles dont la taille pleine valait
   moins de ~185 USD.

Et le rodage attend **trente fermetures mesurées** pour se lever. Le
plancher supprime 63 % des jambes qui les produiraient. **Le rodage
rapetisse les jambes, le plancher efface les jambes rapetissées, et les
jambes effacées sont exactement celles qui produiraient les mesures que
le rodage attend.** Ce n'est pas une inefficacité : c'est un verrou qui
se tient tout seul.

**Le second effet est pire que le premier.** Le plancher ne coupe pas au
hasard : il garde les jambes de plus fort poids. La porte valide un
`panel[20]` — un portefeuille mis en commun, dont la variance suppose la
diversification. Le moteur joue les **trois plus gros noms** de six
proposés, sur vingt mis en commun. Ce n'est pas le portefeuille validé
en plus petit : c'est un **autre** portefeuille, plus concentré, donc de
variance plus élevée à avantage égal. Voilà, enfin mesuré, le « livre
joué n'est pas le livre validé » qui traîne depuis le début.

**Ce que je ne fais pas.** Je ne touche pas au plancher. C'est une
première lecture, et la règle du paragraphe 10 vaut ici comme ailleurs.
Le plancher existe pour une raison écrite dans le code — économiser les
frais d'un ajustement qui ne vaut pas son aller-retour — et cette raison
est bonne **pour un redimensionnement**. La question qui reste ouverte,
et qu'il faudra instruire avec plus d'une lecture, est de savoir si elle
vaut aussi pour une **ouverture**, où la bonne question n'est pas « cet
ajustement paie-t-il son aller-retour » mais « cette jambe paie-t-elle
le sien ». Une jambe de 11 USD à +12,7 bps rapporte 0,014 USD brut
contre 0,008 de frais : positive, mais d'une marge dérisoire. Ce n'est
pas le gain de la jambe qui est en jeu, c'est la diversification qu'elle
apporte au portefeuille que la porte a validé.

**Une honnêteté sur les compteurs eux-mêmes** : `deja tenues 0`. La
branche que la contre-épreuve B protège ne se déclenche jamais en
production — chaque tour reconstruit un vœu neuf. La distinction reste
juste, mais elle n'a rien porté ici, et je préfère l'écrire que laisser
croire qu'elle a servi.

### Les deux questions secondaires

**Pas de troisième sortie au suiveur.** Toujours exactement deux sur
vingt-quatre heures, les mêmes.

**La cellule 1H à `ic=0,471` a disparu.** Les trois verdicts 1H de 15h07,
15h26 et 15h57 portent tous `[ridge/h3/neu]` à `ic=0,014` et
`+9,09 bps/trade`. Elle n'a pas tenu — exactement comme la cellule à
h=1 aperçue à 09h39. Deux fois maintenant qu'une cellule spectaculaire
s'évapore au verdict suivant : la barre déflatée fait son travail, et
c'est une raison de plus de ne jamais commenter un verdict isolé.

**Le cumulé** : `live_rule` **n=259 à −13,6 bps**, `en risque` n=191 à
−17,7, équité **9 260,91** en 612 remplissages, `halted_today` faux,
`killed` faux. Brut réalisé −26,83, frais −51,15. Retard 38 s sur 2 007
décisions. Reprises 95/198. Glissement : moyenne +0,65, **médiane
−0,69** — les deux ont divergé depuis 14h35 (+0,24 / +0,16), ce qui
désigne une poignée de remplissages très défavorables plutôt qu'une
dégradation d'ensemble. À suivre, pas à conclure.

### Douzième lecture, 17h11 — la mesure est établie, et un troisième suiveur tranche le motif

**Le plancher : les proportions ne s'effondrent pas, elles montent.**

| | vœux | ouverts | refusés au plancher | notionnel refusé |
|---|---|---|---|---|
| 16h09 | 79 | 23 (29,1 %) | 50 (**63,3 %**) | 484 USD |
| 17h11 | 164 | 35 (21,3 %) | 122 (**74,4 %**) | 978 USD |
| **tranche seule** | **85** | **12 (14,1 %)** | **72 (84,7 %)** | **494 USD** |

L'échantillon a doublé et la part refusée a *augmenté*. Sur les
quatre-vingt-cinq vœux formés entre les deux lectures, **quatre-vingt-cinq
pour cent** meurent sous le plancher et quatorze pour cent seulement
deviennent un ordre. Ce n'est plus une lecture unique : c'est une mesure.

**Le troisième suiveur, et le recoupement tombe encore à la décimale.**

```
Aug 28 16:22:21  ouverture   BTC-USDT-SWAP +0.001000 @ 77558.025000
Aug 28 16:25:45  scalp TRAIL 85bps BTC-USDT-SWAP +0.001000 @ 76868.900000
```

Perte brute **88,9 bps** contre une largeur armée de **85** :
dépassement +3,9 bps, soit **+5 %**. Et 88,9 + 7,0 de frais aller-retour
= **95,9**, exactement ce qu'annonce l'attribution. Deuxième recoupement
exact de la chaîne de mesure, sur une jambe et un nom entièrement
différents.

| jambe | largeur armée | perte brute | dépassement |
|---|---|---|---|
| SOL court, 27/08 | 75 | 77,6 | +2,6 (**+3 %**) |
| TRUMP long, 28/08 | 227 | 288,5 | +61,5 (**+27 %**) |
| BTC long, 28/08 | 85 | 88,9 | +3,9 (**+5 %**) |

**Deux sur trois tiennent à 3-5 % près ; TRUMP est l'exception.** Le
suiveur fait donc son travail dans le cas ordinaire, et cède sur un
mouvement violent. Trois occurrences ne permettent toujours pas de
toucher à une largeur — mais elles permettent de dire que le
dépassement typique est de l'ordre de quelques pour cent, et que le
+27 % de TRUMP n'est pas la norme. Une remarque en passant : le TRAIL de
BTC n'a coûté que **0,74 USD**, contre 10,11 pour SOL, parce que le
rodage avait ramené la jambe à 77 USD de notionnel. Le même mécanisme
qui empêche de gagner limite aussi ce qu'on perd.

### La correction candidate — écrite, pas codée

Le plancher vaut `max(10 USD ; 0,2 % des fonds propres)` et s'applique à
`|delta| × prix`, **sans distinguer le cas**. Or les deux cas ne posent
pas la même question.

**Pour un redimensionnement, la raison écrite dans le code est bonne et
elle tient.** Ajuster une position de 100 USD de 10 USD ne change
presque rien à l'exposition et paie deux fois 3,5 bps sur le delta. La
question « cet ajustement paie-t-il son aller-retour » est la bonne, et
la réponse est non. Rien à changer.

**Pour une ouverture, le cadre lui-même est faux.** Là `delta` vaut la
jambe entière, et la question devient « cette jambe paie-t-elle son
aller-retour ». Formulée ainsi, elle donne : une jambe de 11 USD à
+12,7 bps rapporte 0,014 USD brut contre 0,008 de frais — positive, mais
dérisoire, donc « autant ne pas la prendre ». **Ce raisonnement
jambe-par-jambe est exactement le mauvais.** La porte ne valide pas des
jambes indépendantes : elle valide un `panel[20]`, un portefeuille mis
en commun dont la variance suppose la diversification. Une jambe de
11 USD n'est pas là pour son espérance propre, elle est là pour
décorréler. La refuser laisse l'espérance par unité inchangée et
augmente la variance — donc dégrade précisément le Sharpe que la porte a
validé.

L'ordre de grandeur, et je le donne comme tel : passer de six jambes
proposées à trois jouées multiplie l'écart-type relatif par environ
√2 ; face aux vingt mises en commun, le facteur est bien plus grand. Un
Sharpe validé à +0,10-0,14 devient mécaniquement plus faible sur le
livre joué à espérance égale — et c'est le genre d'écart qui transforme
un +4 bps annoncé en un négatif réalisé.

La forme que prendrait la correction, si une troisième lecture la
confirme : le critère d'**ouverture** ne devrait pas porter sur un
montant absolu. Écrire « l'avantage de la jambe couvre ses frais avec
une marge » donne
`|tgt| × prix × edge > k × |tgt| × prix × frais`, qui se simplifie en
**`edge_bps > k × frais_bps`** — une condition **indépendante de la
taille**. C'est-à-dire : si la règle a un avantage suffisant, la taille
de la jambe ne doit pas décider seule de son ouverture ; c'est le rôle
du dimensionnement, pas d'un seuil d'exécution. Il resterait un plancher
absolu, mais dicté par l'échange — lot minimal, notionnel minimum —
c'est-à-dire `refus_arrondi`, qui n'a compté que **7 fois sur 164**.

**La tension qu'il faut dire, et ne pas cacher.** Lever le plancher
augmenterait le nombre de trades, et le bandeau répète que « les frais
dominent le brut : c'est un moulin, pas un pari ». Les deux diagnostics
tirent en sens opposé. Ils ne s'excluent pas — le plancher explique la
concentration du livre, les frais expliquent le moulin — mais on ne peut
pas les traiter comme s'ils étaient indépendants. Je ne saurai jamais
directement si les jambes refusées auraient été profitables. **Aucun
code sur cette lecture.**

**Le cumulé, et il faut le regarder en face** : `live_rule` **n=272 à
−15,1 bps**, contre 259 à −13,6 à 16h09 et 244 à −12,01 à 14h35. Trois
lectures, dégradation monotone. **Ce n'est pas une fenêtre glissante,
c'est le compteur cumulé** — donc c'est le seul chiffre qui a le droit
de conclure, et il conclut que ça empire. `en risque` n=204 à −19,5,
équité **9 258,29** en 641 remplissages, brut −28,75, frais −51,59,
frein 0,98, `halted_today` faux, `killed` faux.

Glissement : moyenne +0,54 contre médiane −0,70 sur 315 ouvertures
(c'était +0,65 / −0,69 sur 303). L'écart entre les deux passe de 1,34 à
1,24 : il ne se creuse pas. Deux signes opposés qui se maintiennent
désignent toujours une poignée de remplissages très défavorables, pas
une dégradation d'ensemble. Rien à conclure.

### Treizième lecture, 18h14 — je n'implémente pas, et ce n'est pas la mesure qui a échoué

J'avais écrit à 17h11 que la troisième lecture concordante autoriserait
à coder la correction du plancher. Elle concorde. **Je ne code pas.**
Deux raisons, et la seconde annule la première.

**Un : la troisième tranche ne pèse rien.** L'heure a été calme — neuf
vœux seulement contre quatre-vingt-cinq à la tranche précédente :

| | vœux | ouverts | plancher | notionnel |
|---|---|---|---|---|
| cumul 16h09 | 79 | 29,1 % | **63,3 %** | 484 USD |
| cumul 17h11 | 164 | 21,3 % | **74,4 %** | 978 USD |
| cumul 18h14 | 173 | 23,7 % | **72,3 %** | 996 USD |
| tranche 16h→17h | 85 | 14,1 % | 84,7 % | 494 USD |
| **tranche 17h→18h** | **9** | 66,7 % | 33,3 % | 18 USD |

Le cumulé est stable à 72-74 %, rien ne contredit la mesure. Mais la
tranche neuve vaut **neuf** observations : elle ne constitue pas une
troisième confirmation indépendante, elle relit surtout le même
échantillon. Si j'avais lu « 33 % au plancher » comme un démenti,
j'aurais commis pour la quatrième fois l'erreur de la fenêtre trop
courte — dans l'autre sens. Le mesure tient donc sur **deux**
échantillons indépendants (79 vœux à 63 %, 85 vœux à 85 %) plus la
démonstration arithmétique de la chaîne. C'est solide, et c'est moins
que ce que j'avais annoncé exiger.

**Deux, et c'est décisif : la règle en direct est maintenant à 5,1 σ
sous zéro, et elle s'y enfonce de façon monotone.**

| lecture | n | bps | σ |
|---|---|---|---|
| 12h17 | 238 | −12,70 | −3,90 |
| 14h35 | 244 | −12,01 | −3,73 |
| 16h09 | 259 | −13,60 | −4,36 |
| 17h11 | 272 | −15,10 | −4,96 |
| **18h14** | **275** | **−15,50** | **−5,12** |

(σ calculé avec la dispersion de 50,2 bps par instant déduite de la
lecture de 12h17 ; je la suppose inchangée et je le dis, faute d'une
mesure fraîche de l'écart type.)

**Or la correction que j'avais analysée fait ouvrir PLUS de jambes.**
Son argument est celui de la diversification : la porte valide un
`panel[20]` dont la variance suppose plusieurs jambes, donc en refuser
les deux tiers dégrade le Sharpe à espérance égale. L'argument est juste
**à condition que l'avantage validé existe en production**. Le compteur
cumulé dit qu'il n'existe pas : cinq écarts types sous zéro, sur 275
instants, ce n'est plus du bruit qu'on attend de dissiper.

Le calcul le dit sans détour : **996 USD de notionnel refusé, à −15,5 bps
mesurés, valent environ 1,54 USD de perte évitée.** Sur ce livre-ci, tel
qu'il se comporte, **le plancher d'ordre est en train de protéger le
compte.** Lever un frein sur un livre qui perd à 5 σ n'est pas corriger
un biais, c'est augmenter la cadence d'une perte mesurée.

**Ce que cela ne veut pas dire.** Le plancher reste mal placé
conceptuellement : il décide d'une ouverture par un montant absolu, là
où le dimensionnement devrait décider. La concentration du livre — trois
plus gros noms sur vingt mis en commun — reste réelle, mesurée, et reste
une explication candidate de l'écart holdout/direct. Rien de tout cela
n'est rétracté. Ce qui change est **l'ordre des opérations** : on ne
corrige pas la composition d'un livre qui perd à 5 σ, on cherche d'abord
pourquoi il perd. Corriger la diversification d'un portefeuille dont
l'espérance est négative revient à mieux répartir une perte.

**Et il faut se dire la chose désagréable.** L'écart n'est plus « le
direct n'a pas encore convergé vers le holdout ». Le holdout annonce
+4 à +7 bps par trade, le direct rend −15,5, et l'écart **se creuse**
lecture après lecture. Aucun des mécanismes instruits jusqu'ici — le
retard sur la clôture (divisé par trois), les reprises dans la barre
(69 % facturées par la porte), le glissement (+0,55 bps), le suiveur
(trois occurrences, deux conformes) — n'a l'ampleur nécessaire pour
expliquer dix-neuf points de base. La prochaine question n'est pas un
réglage : c'est de savoir si la porte mesure bien ce que le moteur joue.

**Quatrième sortie au suiveur : non.** Toujours exactement trois sur
vingt-quatre heures, les mêmes.

**Le reste** : `en risque` n=207 à −20,0, équité **9 254,85** en 651
remplissages, brut −31,10, frais −52,54, frein 0,98, `halted_today`
faux, `killed` faux. Glissement +0,55 / médiane −0,70 sur 321
ouvertures — inchangé depuis 17h11, l'écart ne se creuse pas. Retard
37 s sur 2 208 décisions. Reprises 102/216.

### Quatorzième lecture, 19h15 — la porte facture une sortie que la cellule jouée ne peut pas prendre

Instruction du code, sans rien modifier. Trois pistes examinées, deux
écartées par la mesure, **une qui tient**.

**Écartée : la latence d'entrée.** `features.py:17` pose
`px = float(c.c[-1])` — la CLÔTURE de la dernière barre complète. Et
`engine.py:2423` compare `fill.price` à ce même `plan["px"]`. Donc le
glissement mesuré **capture déjà** la dérive clôture → remplissage, les
dix-sept secondes comprises. Il vaut **+0,62 bps** de moyenne (médiane
−0,70) sur 327 ouvertures. Ce n'est pas là que se trouvent dix-neuf
points de base, et la question posée à 18h14 a sa réponse : mesurée, pas
supposée.

**Écartée : le take-profit absent.** `engine.py:1913` garde tout le bloc
SL/TP derrière `br.get("stop_mode") != "suiv"` : une cellule à stop
suiveur ne consulte **jamais** son take. J'ai cru tenir un défaut. Non :
`_suiveur` (`clock.py:610-665`) ne simule pas de take non plus — il sort
au suiveur touché, sinon à la clôture de la barre h. **La convention est
la même des deux côtés**, et le commentaire du moteur qui l'affirme dit
vrai. Ce qui explique `tp_maker: 0` et une attribution qui ne porte que
`time-stop` et `TRAIL` : c'est voulu.

### Ce qui tient : le coût facturé à la sortie à l'horizon

`clock.py:934` définit `cost_win = 4.0`, et le commentaire dit
exactement ce que c'est : **« entrée postée + take posé au carnet »**.
`clock.py:1088` en fait `c_win = 0,75 × 4,0 + 0,25 × 7,0 = **4,75 bps**`
après la décote de file d'attente. Puis, pour le mode suiveur,
`clock.py:1396-1398` :

```python
net = gains - np.where(
    touche, self.fee,
    np.where(gains > 0, c_win, self.fee))
```

**Un chemin qui finit gagnant à l'horizon se voit facturer 4,75 bps —
le prix d'un take posé au carnet.** Or une cellule suiveuse n'a pas de
take posé : elle vient d'être établie ci-dessus qu'elle n'en consulte
jamais. En production ce chemin-là sort au **time-stop**, et
`engine.py:1942` passe `force_taker=maker_at is None`, donc `True` :
elle paie **7,0 bps**.

**La porte facture, sur chaque jambe suiveuse gagnante à l'horizon, le
prix d'une modalité de sortie que cette variante ne peut pas utiliser.**
L'écart vaut **2,25 bps** par jambe concernée. Le même `np.where` à
`clock.py:1460` sert au mode fixe, où le take existe bel et bien
(`engine.py:1913` le consulte) : là, `c_win` est légitime. **Le défaut
est spécifique au mode `suiv`** — et toutes les cellules retenues de la
journée portent `stop=3sig/suiv` ou `4sig/suiv`.

**L'ampleur, honnêtement.** 2,25 bps est le maximum, atteint seulement
si toutes les sorties à l'horizon sont gagnantes ; à une part gagnante
de la moitié, l'effet moyen vaut ~1,1 bps. **Cela explique un à deux
points de base sur dix-neuf.** C'est le premier biais identifié dans la
comptabilité de la porte elle-même, il va dans le sens de l'erreur
observée — la porte est trop optimiste — et il ne suffit pas.

**La mesure qui manque pour le chiffrer** : la part des fermetures au
temps qui finissent gagnantes. Elle est à portée — `deploy/releve_taille.py`
lit déjà `net_bps` par fermeture dans `_attribution` — mais c'est du
code, et cette lecture-ci est de l'instruction. **Je ne corrige rien.**
Le corriger reviendrait d'ailleurs à *durcir* la porte, pas à
l'abaisser : c'est le bon sens du changement, ce qui est une raison de
plus de le faire proprement plutôt que vite.

**Une note sur les unités, vérifiée et sans écart.** La porte annonce
`net bps/trade` — par jambe — et `live_rule` compte des **instants** de
portefeuille. Pour un portefeuille équipondéré, le rendement de
l'instant est la moyenne des jambes : les deux grandeurs sont donc
comparables en unité, et il n'y a pas là de biais de moyenne. La
différence est ailleurs, dans la **variance** — vingt jambes mises en
commun contre une à trois jouées — et c'est le point de la douzième
lecture, inchangé.

**Le cumulé** : `live_rule` **n=282 à −15,1 bps**, soit **−5,05 σ**
contre −5,12 à 18h14. La dégradation monotone **s'est arrêtée cette
heure-ci** — elle n'est pas inversée, le niveau reste à cinq écarts
types. `en risque` n=214 à −19,3, équité **9 255,90** en 665
remplissages, brut −29,85 (contre −31,10), frais −52,88, frein 0,98,
`halted_today` faux, `killed` faux.

**Pas de quatrième sortie au suiveur** : toujours exactement trois.

Plancher : 181 vœux, 47 ouverts, 127 au plancher = **70,2 %**, 1 025 USD
jamais ouverts. La tranche neuve ne vaut que huit vœux — encore une
heure calme, et encore une tranche dont on ne peut rien tirer. Le cumulé
tient à 70-74 % depuis quatre lectures.

### Quinzième lecture, 20h16 — la porte est durcie, et je corrige ce que j'ai écrit hier soir

**D'abord une rectification, parce qu'elle change le diagnostic.** À
19h15 j'ai écrit : « le défaut est spécifique au mode `suiv` ». **C'est
faux, et il faut le dire avant tout le reste.** En relisant la branche
du stop fixe (`clock.py:1478-1484`) : `gains = np.where(touche,
-0,5×(stop+adverse), sens×yho)`. Il n'y a **aucun take-profit** dans
cette simulation-là non plus — le chemin non stoppé est simplement le
rendement à l'horizon. Les deux branches facturent donc `c_win`, « le
prix d'un take posé au carnet », à un chemin que la simulation elle-même
sort à l'horizon.

Ce qui distingue vraiment les deux modes n'est pas la simulation, c'est
**l'exécution** : pour une cellule fixe le moteur consulte bien son take
(`engine.py:1913-1929`) et peut sortir maker quand le prix traverse le
niveau — `c_win` y est une approximation grossière d'une sortie qui
**existe**. Pour une cellule suiveuse elle est **structurellement
impossible**. C'est cette distinction-là qui justifie de durcir l'une et
pas l'autre, et ce n'est pas celle que j'avais écrite.

**Le chiffre, lui, est exact et vérifié à la source.**
`exchange/broker.py:54-55` : `maker_fee_bps = 2.0`, `fee_bps = 5.0`.
Une jambe suiveuse paie donc 2,0 à l'entrée postée et 5,0 à la sortie
traversée — **exactement les 7,0 de `FEE`**. Et `cost_win = 4,0` vaut
2,0 + 2,0, ce qui exige un take posé. La porte facturait
`c_win = 0,75 × 4,0 + 0,25 × 7,0 = 4,75`. **L'écart est de 2,25 bps, ni
estimé ni arrondi.** Le « 3,50 bps sur 151 113 traités » du relevé n'est
que la moyenne (2,0 + 5,0)/2, et il concorde.

### Ce qui a été fait

Un seul point d'entrée, `CandleModel._cout_sortie(mode, touche, gains,
c_win)`, appelé par les deux branches. Le mode `suiv` paie `self.fee`
sur **tous** les chemins ; le mode fixe garde l'expression d'origine.
La distinction vit désormais dans le code, nommée, au lieu d'être
dupliquée dans deux `np.where` identiques.

Quatre tests neufs, trois contre-épreuves vérifiées une à une :

- **A** — remettre l'ancien coût au suiveur : trois tests tombent ;
- **B** — durcir *aussi* le mode fixe : le test qui protège le mode fixe
  tombe. C'est la contre-épreuve qui compte : elle prouve que la
  correction est bien ciblée et non un durcissement au jugé ;
- **C** — facturer `c_win` partout au suiveur (donc moins cher
  qu'avant) : trois tests tombent.

Un quatrième test vérifie la propriété qui définit un durcissement :
sur cinq cents chemins tirés au hasard, le nouveau coût est **supérieur
ou égal à l'ancien chemin par chemin**, et strictement supérieur sur au
moins un. Un « durcissement » qui rendrait une seule cellule plus belle
n'en serait pas un.

**453 tests verts** (449 + 4), 22 minutes.

**La conséquence, écrite d'avance.** Chaque cellule suiveuse perd
jusqu'à 2,25 bps par jambe gagnante à l'horizon dans son net annoncé.
Les seuils récents tournent autour de 8 à 12 bps pour un net de 3 à
7 bps : **des cellules vont cesser de passer la barre, et le carnet peut
se vider. Un carnet vide est un résultat honnête**, pas une régression —
c'est précisément ce que cette correction est censée produire si la
porte était trop généreuse.

**La part gagnante est maintenant au relevé**, par motif, dans
`_attribution`. C'est un compteur d'affichage : il ne touche aucun seuil
et ne change aucun comportement. Le biais moyen vaut
`part_gagnante × 2,25 bps`, et le prochain relevé le donnera enfin en
clair au lieu d'un encadrement.

**Le cumulé** : `live_rule` **n=283 à −15,1 bps**, soit **−5,06 σ**
contre −5,05 à 19h15. La dégradation reste **arrêtée** — deux lectures
de suite — sans s'inverser. `en risque` n=215 à −19,3, équité
**9 255,81** en 667 remplissages, brut −29,91, frais −52,91, frein 0,98,
`halted_today` faux, `killed` faux. L'heure a été très calme : deux
remplissages seulement, un vœu neuf.

**Pas de quatrième sortie au suiveur** : toujours exactement trois.

### Seizième lecture, 21h43 — le durcissement a changé la FAMILLE retenue, pas seulement le compte

**L'effet est total et il tombe exactement à la frontière du
déploiement.** Les verdicts, dans l'ordre, avec le mode du stop :

| heure | horloge | | mode |
|---|---|---|---|
| 19h53 | 1H | veto | `3sig/suiv` |
| 20h31 | 1m | **live** | `4sig/suiv` |
| 20h36 | 3m | veto | `3sig/suiv` |
| 20h42 | 5m | **live** | `4sig/suiv` |
| — | | | **déploiement 20h42** |
| 20h47 | 1m | **live** | `4sig/fixe` |
| 20h51 | 3m | veto | `4sig/fixe` |
| 20h58 | 5m | veto | `4sig/fixe` |
| 21h05 | 15m | veto | `4sig/fixe` |
| 21h11 | 1H | veto | `4sig/fixe` |
| 21h17 | 1m | veto | `4sig/fixe` |
| 21h24 | 3m | veto | `4sig/fixe` |
| 21h35 | 5m | veto | `4sig/fixe` |

**Quatre verdicts avant, quatre en `suiv`. Huit verdicts après, huit en
`fixe`. Zéro exception des deux côtés.** Le marché n'a pas changé, les
données non plus : la seule chose qui a bougé est ce que coûte une
sortie de cellule suiveuse. C'est une expérience naturelle aussi propre
qu'on peut l'espérer en production.

Et c'est **plus intéressant que ce que j'attendais**. J'avais écrit que
des cellules cesseraient de passer la barre. Ce qui s'est produit est
autre chose : la surcharge a fait **perdre au suiveur la comparaison
contre le stop fixe** dans la sélection. La porte ne retient plus la
même *famille de sortie*. Elle préférait les suiveurs en partie parce
qu'elle les sous-facturait.

**Le carnet s'est vidé, et c'est le résultat honnête annoncé
d'avance** : `hz=[]` — aucune horloge validée —, `live=0/20`, l'équité
figée à **9 255,81** depuis 20h15, un seul verdict `live` sur les huit
qui ont suivi. Je ne défais rien. Un carnet vide est un résultat.

### Le biais chiffré, et mon encadrement était trop large

La colonne neuve donne la part gagnante :

```
  motif           n  bps/trade       USD   gagnantes
  TRAIL           1      -95,9     -0,74    0/1     0%
  time-stop      41      -40,6     -7,13    6/41   15%
  TOTAL          42      -41,9     -7,86    6/42   14%
```

À 15 % de part gagnante, le biais moyen vaut **0,34 bps**, pas les « un
à deux » que j'avais écrits : j'avais supposé une part gagnante de
moitié, la réalité en donne le tiers. **Mon encadrement était trois à
six fois trop grand.**

**Mais il faut être précis sur ce que ce chiffre mesure**, et je ne
l'avais pas vu en écrivant la consigne : 15 % est la part gagnante
**réalisée par le moteur**, pas celle que la porte simule sur son
holdout. Le biais de la comptabilité de la porte dépend de **sa** part
gagnante à elle, qui est forcément plus haute puisque ses cellules
annoncent un net positif. Le 0,34 bps est donc le biais *tel que
l'expérience du moteur l'implique*, pas l'erreur de la porte. La mesure
que j'ai ajoutée répond à une question voisine de celle qu'il fallait
poser.

**Et pourtant la correction était décisive.** Une surcharge de 2,25 bps
dont l'effet moyen se compte en dixièmes de point de base a **retourné
la totalité** des cellules retenues d'une famille de stop à l'autre.
C'est la leçon de cette lecture, et elle vaut au-delà d'ici : *sur une
grille de plusieurs milliers de cellules, un biais minuscule mais
systématique ne déplace pas le résultat, il déplace l'argmax.* Le
comparer à la taille de l'avantage recherché ne dit rien de son effet.

### Ce qui devient la question la plus vive

**Quatorze pour cent de fermetures gagnantes.** Une règle sans
take-profit, coupée au suiveur et sinon rendue à l'horizon, aurait
besoin de gagnantes six fois plus grosses que les perdantes pour
seulement rentrer dans ses frais. Ce n'est pas la forme d'un avantage de
momentum à +8 bps sur six barres. C'est une fenêtre glissante de
quarante-deux fermetures et **je n'en conclus rien** — mais c'est
désormais la mesure que je veux voir se répéter, devant toutes les
autres.

**Un coût que j'ai introduit et que je signale.** Le `calcul` du desk 1m
passe de ~6,9 s à **10,3-10,8 s**, en même temps que le déploiement.
`_cout_sortie` alloue un tableau par cellule suiveuse, ce qui est la
cause la plus probable. Cela reste très à l'intérieur de la barre de
soixante secondes, et le retard total ne bouge pas — mais c'est une
dépense que j'ai créée, elle doit être dite, et elle doit être
surveillée.

**Le cumulé, inchangé au chiffre près** : `live_rule` n=283 à
−15,1 bps, **−5,06 σ**, `en risque` n=215 à −19,3, équité 9 255,81, 667
remplissages, `halted_today` faux, `killed` faux. Rien n'a bougé de
l'heure : le moteur n'a pas ouvert une seule jambe depuis 20h15. La
dégradation est arrêtée, mais elle l'est parce que le livre est vide, ce
qui n'est pas la même chose que d'être arrêtée parce que la règle gagne.

**Pas de quatrième sortie au suiveur** : toujours exactement trois.

### Dix-septième lecture, 22h44 — trois faits, dont un qui me contredit

**La bascule vers le stop fixe tient : treize verdicts sur treize.**
De 20h47 à 22h37, sans une seule exception, `stop=4sig/fixe`. Ce
n'était donc pas l'effet d'une heure : le durcissement a durablement
retiré au suiveur la préférence que la sous-facturation lui donnait.

**Une horloge est redevenue validée, et elle est meilleure que celles
qu'elle remplace.** À 22h19, la 1m repasse `live` :

```
clock 1m panel[20] live [mlp/h6/abs] ic=0.088 net=+4.83bps/trade
  sr=+0.114 seuil=7.8bps/2.5sig stop=4sig/fixe pente=0.82+-0.09
  profil=+0.12/+0.12/+0.10 gardee parjour=47.1
```

Le `profil` — le Sharpe par tiers chronologique du holdout — vaut
**+0,12 / +0,12 / +0,10**. Plat et positif sur les trois tiers. C'est
exactement la question que le paragraphe 8 posait depuis le début sur
la non-stationnarité, et cette cellule-ci y répond bien. La pente
0,82 ± 0,09 est la plus proche de l'unité de toute la campagne.

**Mais le carnet reste vide, et pas pour la raison que je croyais.**
`live=0/20`, aucune position, l'équité figée à **9 255,81 depuis
20h15** — trois heures sans un seul remplissage. Or `jambes visées`
reste bloqué à **182**, exactement comme à 21h43 : **la règle n'a pas
proposé une seule jambe**. Ce n'est donc pas le plancher d'ordre qui
refuse, c'est le seuil qui n'est pas franchi. Deux causes très
différentes d'un même carnet vide, et je serais passé à côté sans le
compteur.

### Ce qui me contredit : le coût de calcul

Hier soir j'ai écrit que `_cout_sortie` avait fait passer le `calcul`
du desk 1m de ~6,9 s à 10,3-10,8 s, et que c'était « une dépense que
j'ai créée ». **La mesure suivante l'infirme : le calcul est
redescendu à 7,5-7,8 s.**

Le pic de 10,5 s était un **transitoire de redémarrage** — modèles à
réajuster, caches froids — et non le coût de mon changement. Le coût
durable est de l'ordre de **+0,8 s**, pas +3,5 : je l'ai surestimé
d'un facteur quatre et j'ai attribué à mon code ce qui appartenait au
redéploiement. La leçon est la même que pour les fenêtres glissantes,
sous un autre déguisement : **une mesure prise juste après un
redémarrage ne mesure pas le régime, elle mesure le redémarrage.**

### Ce qui n'est PAS une confirmation

La part gagnante affiche encore `6/41 = 15 %`. **Ce n'est pas une
deuxième lecture.** Le bloc d'attribution est identique au caractère
près — mêmes 42 fermetures, mêmes −41,9 bps, mêmes −7,86 USD — parce
qu'aucune fermeture nouvelle n'a eu lieu. Relire deux fois le même
échantillon ne le confirme pas. C'est le piège de la fenêtre glissante
sous une forme que je n'avais pas prévue : non plus une fenêtre qui
bouge trop vite, mais une fenêtre **qui ne bouge pas du tout** et
qu'on prendrait pour une répétition. Le compteur de 15 % attend
toujours sa première confirmation.

**Le suiveur** : toujours exactement trois occurrences dans la
campagne, mais **deux seulement dans la fenêtre de vingt-quatre
heures** — celle de SOL du 27 à 22h02 vient d'en sortir par l'âge.
Rien n'a disparu, c'est la fenêtre qui a glissé, et il faut le dire
ainsi pour ne pas relire un vieillissement comme un événement.

**Le cumulé, strictement inchangé** : `live_rule` n=283 à −15,1 bps,
**−5,06 σ** ; `en risque` n=215 à −19,3 ; équité 9 255,81 en 667
remplissages ; `halted_today` faux, `killed` faux. La dégradation est
arrêtée **parce qu'il ne se passe rien**, ce qui n'est pas la même
chose qu'arrêtée parce que la règle gagne — et la formule vaut d'être
répétée telle quelle tant que le livre est vide.

### Dix-huitième lecture, 23h45 — le carnet s'est rouvert, et le plancher a cessé de mordre tout seul

**Le moteur a rejoué**, et la tranche est propre :

| | 22h44 | 23h45 | |
|---|---|---|---|
| jambes visées | 182 | 187 | **+5** |
| ouvertes ou redimensionnées | 48 | 53 | **+5** |
| refusées au plancher | 127 | 127 | **+0** |
| remplissages | 667 | 676 | +9 |

**Cinq vœux, cinq ouvertures, aucun refus.** Après quatre lectures où le
plancher d'ordre effaçait 63 à 74 % des jambes, il n'en a refusé
**aucune** cette heure-ci. Et la raison se lit dans les notionnels :

```
BCH     1,38 x 247,83 = 342 USD
TRUMP 197,50 x   2,74 = 540 USD
BCH     1,21 x 247,53 = 300 USD
TRUMP 125,60 x   2,73 = 342 USD          plancher = 18,5 USD
```

Un **ordre de grandeur** au-dessus des 10 à 50 USD des lectures
précédentes. La ligne du tableau le confirme : TRUMP porte
`defl +1,2` et `poids +0,0370`, contre `defl +0,3` et `poids +0,0054`
pour les cellules suiveuses d'hier.

**C'est un effet en cascade que je n'avais pas prévu.** Durcir le coût
du suiveur a fait retenir des cellules `fixe` mieux déflatées ; un
`defl` quatre fois plus grand donne un poids de Kelly sept fois plus
gros ; et des jambes sept fois plus grosses passent au-dessus du
plancher. **Le problème du plancher — celui que j'avais renoncé à
corriger le 18h14 — vient de se dissoudre sans qu'on y touche.** Je
n'avais pas vu que la cause du refus n'était pas le seuil mais la
petitesse des poids, et que la petitesse des poids venait en partie de
la famille de stop retenue. Cinq observations : je le note, je ne le
conclus pas.

### Mais il faut regarder ce qui a été retenu

```
23:36:47  15m  live  mlp/h1/abs  net=+101.41bps/trade  stop=4sig/fixe
```

**Cent un points de base par trade sur la 15m.** Les nets crédibles de
cette campagne valent +1 à +8. Le seul précédent d'un tel chiffre est
la cellule 1H à +226 bps aperçue à 14h04 — et **elle avait disparu au
verdict suivant**, comme celle à h=1 de 09h39 avant elle. La différence
est que celle-ci est **`live`**, donc elle dimensionne : c'est très
probablement elle qui porte le `defl +1,2` et les jambes à 540 USD.

Autrement dit : **le carnet s'est rouvert, et peut-être pour une
mauvaise raison.** Le durcissement a écarté les suiveurs ; parmi les
cellules fixes restantes, la sélection est allée chercher une valeur
aberrante. C'est exactement le risque que la barre déflatée existe pour
contenir, et le fait qu'une telle cellule la franchisse mérite d'être
suivie nommément au prochain verdict. Je ne touche à rien — mais si
elle s'évapore comme les deux précédentes, le poids retombera et le
plancher recommencera à mordre.

**Le compte a repris sa perte** : équité 9 255,81 → **9 254,74**, brut
réalisé −29,91 → −30,94, frais +1,14 en une heure. Neuf remplissages.
Une heure, et je n'en conclus rien.

### La part gagnante bouge enfin — sans être confirmée

`8/40 = 20 %` contre `6/41 = 15 %`. **La fenêtre a bougé cette fois**,
donc ce n'est plus la relecture d'un échantillon figé. Mais elle n'a
glissé que d'environ cinq fermetures sur quarante et une : les deux
lectures **partagent près de 88 % de leur échantillon**. Ce n'est
toujours pas une confirmation indépendante, seulement une mesure qui a
recommencé à respirer, et elle respire vers le haut.

**La bascule tient : dix-sept verdicts sur dix-sept en `4sig/fixe`**
depuis 20h47, sans une exception. Trois horloges sont validées
simultanément — `hz=['15m', '1m', '3m']` — ce qui n'était plus arrivé
de la journée.

**Le cumulé** : `live_rule` **n=287 à −15,1 bps**, soit **−5,10 σ**
(contre −5,06). Le n a repris sa marche, le bps est stable. `en risque`
n=219 à −19,1. Équité 9 254,74 en 676 remplissages. `halted_today`
faux, `killed` faux. Le `calcul` du desk est à **6,9-7,1 s**, c'est-à-dire
revenu au niveau d'avant le déploiement : la surestimation d'hier soir
est doublement infirmée.

**Le suiveur** : toujours trois occurrences dans la campagne, deux dans
la fenêtre de vingt-quatre heures. Pas de quatrième.

### Dix-neuvième lecture, 00h46 — l'aberration s'évapore, ma prédiction tombe, et le compte perd plus vite

**La cellule 15m à +101 bps a disparu.** Le verdict suivant rend
`ridge/h1/abs`, `net=+1,48 bps`, `ic=0,032`, **veto** — contre
`mlp/h1/abs`, `net=+101,41`, `ic=0,391`, `live` une demi-heure plus
tôt. **Troisième aberration de la campagne à s'évaporer au verdict
suivant**, après la 1H à +226 bps (14h04) et la h=1 de 09h39. La barre
déflatée fait son travail : ces cellules n'ont jamais tenu deux
verdicts.

**Et ma prédiction est infirmée.** J'avais écrit que si elle
disparaissait, « le poids retombera et le plancher recommencera à
mordre ». Il n'en est rien :

| | 23h45 | 00h46 |
|---|---|---|
| jambes visées | 187 | 192 (**+5**) |
| ouvertes | 53 | 58 (**+5**) |
| refusées au plancher | 127 | 127 (**+0**) |

Deuxième tranche de suite à cinq vœux, cinq ouvertures, **zéro refus**.
La raison est dans le tableau : **BCH** porte `defl +1,4`,
`poids +0,0363`, `USD +336` — une cellule `candle` à h=6 sur la 1m,
pas la 15m aberrante.

**Mon attribution d'hier soir était fausse.** J'avais écrit : « c'est
très probablement elle qui porte le `defl +1,2` et les jambes à
540 USD ». Non. J'ai lié deux faits simultanés qui ne l'étaient pas.
Le gros poids vient des cellules `fixe` **ordinaires**, pas de
l'aberration — et la conclusion en cascade de la dix-huitième lecture
en sort **renforcée**, pas affaiblie : c'est bien la bascule vers
`fixe` qui a relevé le `defl`, donc le poids, donc la taille des
jambes au-dessus du plancher. Dix vœux, dix ouvertures, aucun refus
sur deux tranches.

### Ce qu'il faut dire franchement

**Le compte perd plus vite qu'avant.**

```
equite   9 254,74 -> 9 250,81   (-3,93 USD en une heure, 14 remplissages)
brut       -30,94 ->   -32,34
frais      -54,05 ->   -55,44
```

Contre environ −1 USD/h auparavant, avec des jambes sept fois plus
petites. Et le cumulé — le seul chiffre qui a le droit de conclure —
se dégrade : **−5,06 → −5,10 → −5,17 σ** sur trois lectures.

Il faut le formuler sans détour : **le durcissement de la porte a eu
pour effet net d'augmenter la taille des positions d'une règle dont la
mesure en direct est à 5,2 σ sous zéro.** Ce n'est pas ce que je
visais, et c'est le contraire de ce qu'on veut. La correction était
juste — la porte facturait une sortie impossible — mais son effet de
second ordre, via `defl` → poids de Kelly → taille, va dans le mauvais
sens tant que la règle perd.

**Je ne défais pas le durcissement.** Annuler une correction correcte
parce que son effet indirect déplaît serait exactement le raisonnement
que le paragraphe 10 interdit. Ce qui est en cause n'est pas la
facturation, c'est ce qui laisse une règle à −5 σ prendre des jambes
plus grosses.

### Ce qui devient la question centrale

```
frein 0.98   confiance 0.10   direct n=292 bps=-15.2   (-5,17 sigma)
```

Le rodage est à son **plancher** de 0,10 : il fait son travail, il ne
peut pas faire plus. Mais le **frein de risque vaut 0,98** — il n'a
pratiquement pas bougé — pendant que la mesure en direct est à cinq
écarts types sous zéro depuis une dizaine d'heures. **Une règle mesurée
si nettement perdante devrait voir sa taille écrasée, et elle ne l'est
pas.** C'est la prochaine chose à instruire, et ce serait un
durcissement, donc légitime. Je l'écris ; je ne touche à rien avant de
l'avoir lu dans le code.

### Le reste

**Première exception à la bascule, et elle ne compte pas vraiment.** À
00h44 la **1H** retient `ridge/h3/neu` en `3sig/suiv` — le premier
`suiv` depuis 20h47. Mais elle **veto** (`net=+12,90` contre un seuil
de 10,8, `pente=0,78±0,61`), et c'est l'horloge la moins active du
panel (`parjour=1,9`). Les quatre horloges qui tradent — 1m, 3m, 5m,
15m — restent toutes en `4sig/fixe`, quinze verdicts sur quinze. Ce
n'est donc pas un contre-exemple sur une horloge qui joue.

**La part gagnante** : 15 % → 20 % → **20-21 %**. Trois lectures
cohérentes, mais le recouvrement reste d'environ 82 % : ce n'est
toujours pas trois échantillons indépendants, c'est une même fenêtre
qui glisse lentement dans la bonne direction.

`en risque` n=224 à −19,3. Équité 9 250,81 en 690 remplissages.
`halted_today` faux, `killed` faux — le recul du jour vaut −0,54 %
contre une limite de 8 %, et le recul depuis le sommet −10,3 % contre
un arrêt à 25 %. **Pas de quatrième sortie au suiveur.**

### Vingtième lecture, 01h47 — le frein ne regarde pas la mesure, et c'est écrit dans le code

**`_risk_scale` (`engine.py:1309-1326`) ne lit que trois nombres** :
l'équité, le sommet d'équité et l'équité d'ouverture du jour. Il les
compare à `max_drawdown_pct` (25 %) et `daily_loss_limit_pct` (8 %) à
travers un `taper` qui vaut 1,0 tant que la perte reste sous 40 % de la
limite, puis descend linéairement jusqu'à 0,25 à 85 % de la limite.

**Il ne touche jamais `live_stats`.** La mesure en direct de la règle
— n=296 à −15,2 bps, 5,2 σ sous zéro — n'entre nulle part dans ce
calcul.

L'arithmétique reproduit le chiffre affiché exactement :

```
recul depuis le sommet   10,260 %   limite 25 %   declenche a 10,00 %  -> taper 0,977
recul du jour             0,536 %   limite  8 %   declenche a  3,20 %  -> taper 1,000
frein = min(0,977 ; 1,000) = 0,98
```

Le frein à 0,98 vient **entièrement** du recul depuis le sommet, qui
vient tout juste de franchir son seuil de déclenchement. Le recul du
jour n'y est pour rien. Et pour que le frein atteigne son plancher de
0,25, il faut un recul de **21,25 %** depuis le sommet — c'est-à-dire
une équité de **8 118 USD**, soit 1 132 de plus à perdre.

**L'autre organe, lui, écoute — et il est saturé.** `_confiance`
(`engine.py:1669-1691`) est le seul qui lit la mesure : `n < 30 → 0,1`,
`bps ≤ 0 → 0,1`, sinon montée vers 1,0 à n=130. Avec n=296 et
bps=−15,2, il rend **0,1**. Il fait exactement son travail et **il ne
peut pas faire mieux : 0,1 est son plancher**, pas son fond.

### Le défaut de conception, énoncé

**Le seul organe qui écoute la mesure est saturé à son plancher ; le
seul organe qui a de la marge n'écoute pas la mesure.** Le frein répond
à la question « combien ai-je perdu », jamais à « ce que je joue a-t-il
un avantage mesuré ». Une règle établie perdante à cinq écarts types
sur près de trois cents instants conserve donc **98 % de sa taille**,
et le seul mécanisme capable de la réduire davantage attend d'avoir
perdu un cinquième du capital.

Le rodage à 0,1 n'est pas non plus un frein : c'est un **plancher**.
Une règle mesurée perdante garde indéfiniment un dixième de sa taille
pleine — pour BCH, 0,10 × 3 439 = 344 USD de notionnel — et rien dans
le système ne la ramène à zéro **sur la foi de la mesure**. Seuls les
garde-fous de capital peuvent l'arrêter, et ce sont des garde-fous de
capital, pas de preuve.

C'est la formulation que je cherchais depuis plusieurs lectures :
**Hermes sait mesurer qu'une règle perd, et n'a aucun organe capable
d'en tirer la conséquence sur la taille.** La correction serait un
frein supplémentaire indexé sur `live_rule` — donc un **durcissement**,
donc légitime. Je ne l'écris pas ce soir : je viens de lire le code,
et poser un barème le même quart d'heure serait exactement la
précipitation que le paragraphe 10 interdit.

### Ce que dit le relevé

**La perte a nettement ralenti** : −1,10 USD cette heure contre −3,93
la précédente, sur sept remplissages. Et il faut lire le cumulé avec
précision :

| lecture | n | bps | σ |
|---|---|---|---|
| 22h44 | 283 | −15,1 | −5,06 |
| 23h45 | 287 | −15,1 | −5,10 |
| 00h46 | 292 | −15,2 | −5,17 |
| **01h47** | **296** | **−15,2** | **−5,21** |

**Le bps a cessé de tomber** — quatre lectures à −15,1 / −15,1 / −15,2
/ −15,2. Ce qui continue de croître est le **σ**, et il croît
uniquement parce que n croît. Autrement dit : l'estimation ne se
dégrade plus, c'est la **certitude qu'elle est négative** qui se
renforce. J'ai failli écrire « la dégradation continue », ce qui aurait
été faux.

**Troisième tranche sans aucun refus au plancher** : 3 vœux, 3
ouvertures, 127 refus inchangés. Les jambes restent grosses.

**Aucune nouvelle aberration.** La seule ligne au-dessus de 50 bps dans
la fenêtre reste celle de 23h36, qui a déjà disparu des verdicts. Les
quatre horloges qui tradent sont en `4sig/fixe`, quatorze verdicts sur
quatorze.

**La part gagnante, quatre lectures** : 15 %, 20 %, 21 %, **18 %**.
Elle tourne autour de 18-20 % et le recouvrement se réduit enfin — mais
elle reste une fenêtre de quarante fermetures, et quatre lectures qui
se chevauchent ne font toujours pas quatre échantillons.

`en risque` n=228 à −19,1. Équité **9 249,71** en 697 remplissages,
brut −32,62, frais −56,31. `halted_today` faux, `killed` faux. **Pas de
quatrième sortie au suiveur.**

### Vingt-et-unième lecture, 02h47 — le barème du frein manquant, écrit avant d'être codé

Ce qui suit est écrit **avant** de regarder ce que le barème donnerait
sur les chiffres de ce soir. Choisir une pente après avoir vu son effet
sur le cas courant, c'est ajuster rétrospectivement — précisément le
biais que la barre déflatée existe pour empêcher. L'ordre compte, donc
il est respecté et consigné.

**Le principe.** La porte établit qu'une règle a un avantage sur
l'histoire ; le compteur en direct dit ce qu'elle fait maintenant. Quand
le compteur dit, avec assez de preuve, qu'elle perd, la taille doit
tomber — **proportionnellement à la force de la preuve, pas au montant
déjà perdu**. C'est exactement ce que `_risk_scale` ne fait pas : lui
répond au montant perdu.

**La statistique.** `t = bps / (sd / √n)`, calculée sur le **même
échantillon cumulé** que `bps` : un échantillon, une moyenne, une
dispersion. Cela demande d'accumuler la somme des carrés des rendements
par instant, à côté de la moyenne déjà accumulée. Ce compteur repart de
zéro : le frein restera donc **inerte tant qu'il n'aura pas trente
instants**, le même seuil que `_confiance` utilise déjà. Aucun frein
sans preuve est le comportement correct, et il faut dire qu'il sera
inerte un moment plutôt que de le découvrir ensuite.

**Le barème, et d'où viennent ses deux nombres.** Je refuse de choisir
une pente librement. La porte elle-même exige entre **2,5 et 4,0 σ**
pour laisser une cellule trader — c'est l'échelle `seuil=...bps/2.5sig`
… `/4.0sig` qu'on lit à chaque verdict. Je reprends **la même échelle,
retournée** : ce qu'il faut de preuve pour être admis est ce qu'il faut
de preuve contraire pour être expulsé.

```
t >= -2,5            ->  1,00   rien n etabli, le frein ne fait rien
-4,0 < t < -2,5      ->  interpolation lineaire de 1,00 a 0,00
t <= -4,0            ->  0,00
```

Zéro paramètre libre : les deux bornes sont celles que la porte
s'impose déjà à elle-même. Le frein est **monotone** en t, **borné**,
et il **se relâche** — si `bps` redevient positif, t remonte et le frein
revient à 1,0. Ce n'est pas un interrupteur à sens unique.

**Le plancher est zéro, et c'est argumenté, pas choisi.** L'objection
évidente : une taille nulle arrête le trading, donc `live_rule` cesse
d'accumuler, donc la règle ne peut plus jamais être réhabilitée. Cette
objection **a déjà sa réponse dans le code** : `_explore`
(`engine.py:2043-2075`) joue *exactement* une règle validée dont la
taille a été ramenée à zéro « par le frein du gouverneur », à taille
minimale, précisément pour qu'elle continue d'accumuler de la preuve.
Le mécanisme existe et son commentaire dit qu'il est là pour ce cas. Le
plancher peut donc être zéro sans condamner personne — et c'est mieux
qu'un plancher arbitraire à 0,25, qui laisserait une règle
certainement perdante jouer un quart de taille indéfiniment. C'est le
défaut que le rodage à 0,1 a déjà : **0,1 est un plancher, pas un
fond.**

**Il ne peut jamais augmenter une taille.** Il entre par un `min` avec
`_risk_scale`, jamais autrement. Un frein ne desserre rien ; s'il
pouvait desserrer, ce ne serait pas un frein mais un levier, et un
levier indexé sur une bonne passe est la façon la plus rapide de
transformer du bruit en risque.

**Ce qu'il ne fait pas.** Il ne touche pas au rodage : `_confiance`
reste tel quel, à son barème, et les deux se multiplient. Il ne touche
à aucune porte de validation, à aucune largeur de stop, ni au plancher
d'ordre. Il ne remet aucun compteur à zéro.

**La conséquence, écrite d'avance.** Si la mesure en direct est
nettement négative, les tailles vont chuter — peut-être jusqu'à zéro,
avec les éclaireurs qui prennent le relais à taille minimale. **C'est le
but.** Un carnet plus petit sur une règle mesurée perdante est un
résultat honnête, et le voir se produire ne sera pas une régression.

### Vingt-deuxième lecture, 02h53 — le frein est écrit, et j'ai failli déployer un défaut

Le barème de la lecture précédente est codé : `_t_direct` et
`_frein_mesure`, composés par un `min` avec `_risk_scale` dans
`_pick_lev`. Dix tests neufs, **sept contre-épreuves** vérifiées une à
une. **463 verts.**

**Mais deux d'entre elles ont trouvé des défauts réels, dont un dans ma
conception même.** Il faut les dire.

**Le premier était dans un test.** « Un frein ne peut jamais agrandir
une position » comparait `min(a, b)` à `a` — une tautologie. Il ne
testait rien du moteur. Réécrit pour interroger `_pick_lev`, il restait
borgne : avec un frein de capital à 1,0, composer par `max` au lieu de
`min` laisse la taille **constante**, donc « jamais plus grande » reste
vrai et un frein qui ne descend jamais passerait pour un frein. Il a
fallu une seconde dent — *une mauvaise mesure doit avoir réduit la
taille au moins une fois* — pour que la contre-épreuve morde enfin. Un
test qui affirme une tautologie est pire que pas de test : il donne la
confiance sans la preuve.

**Le second était dans le code, et je l'ai vu juste avant de
déployer.** `carre` ne commence à s'accumuler qu'à la mise en ligne,
alors que `n` en porte déjà **299**. Diviser la somme des carrés par le
n **cumulé** donnait :

```
var = carre/299 - moy^2 = 137   au lieu de   2 500
```

**Un facteur dix-huit de sous-estimation de la variance, donc un facteur
quatre de surestimation de `t`** — et le frein aurait mordu à fond sur
du bruit, exactement ce que son propre barème lui interdit. La
correction : la **dispersion** se lit sur le sous-échantillon qui porte
les carrés, avec *sa* moyenne et *son* compte (`somme`, `n_carre`) ;
l'**erreur type**, elle, se divise par le n cumulé — on a bien 299
observations de la moyenne, on n'a simplement pas gardé leurs carrés.
Deux tests de non-régression gardent la porte, et leurs contre-épreuves
tombent quand on remet la division fautive.

C'est la deuxième fois de la campagne qu'écrire le barème **avant** le
code paie : la contradiction ne portait pas sur la pente — celle-là a
tenu — mais sur la façon de l'alimenter, et je ne l'aurais pas vue en
codant d'abord.

**Ce que le frein fera, et quand.** Le compteur de dispersion repart de
zéro : tant qu'il n'a pas ses trente instants à lui, le frein se tait,
quelle que soit la moyenne. Au rythme actuel — cinq instants par heure —
il sera **inerte environ six heures**. Ensuite, si la mesure reste où
elle est (n=299, −15,1 bps, dispersion ~50 bps, soit `t ≈ −5,2`), le
barème donne **`frein_mesure = 0,00`** : la taille de la règle tombe à
zéro et les éclaireurs prennent le relais à taille minimale. C'est le
but, c'est écrit d'avance, et ce ne sera pas une régression.

### Le relevé, avant le changement

Ce relevé est donc une **ligne de base** : la production tourne encore
`1ffb82f`, sans le frein.

`live_rule` **n=299 à −15,08 bps**, soit **−5,20 σ** contre −5,21. Le
bps s'est très légèrement **amélioré** (−15,2 → −15,08) et l'équité a
**monté** pour la première fois d'une heure à l'autre : 9 249,71 →
**9 250,95**, +1,24 USD sur neuf remplissages. Une heure, et je n'en
conclus rien.

**Quatrième tranche de suite sans aucun refus au plancher** : 200 vœux,
66 ouvertures, 127 refus inchangés. Le poids est retombé (TRUMP
`defl +0,3`, `poids +0,0111`, `USD +102` contre `+0,0363` et `+336`) —
mais 102 USD reste cinq fois au-dessus du plancher de 18,5. Le plancher
ne mord toujours pas.

**La part gagnante monte** : 15 → 20 → 21 → 18 → **24 %**. Cinq
lectures, et la fenêtre a enfin assez glissé pour que ce ne soit plus la
même. C'est encore une fenêtre de trente-neuf fermetures et je ne
conclus pas, mais la direction est constante depuis cinq lectures.

`en risque` n=231 à −18,9. Brut −31,82, frais −56,61, 706 remplissages.
Nouveau jour ouvert à 9 253,58. `halted_today` faux, `killed` faux.
**Pas de quatrième sortie au suiveur** — toujours trois dans la
campagne, et seulement deux dans la fenêtre de vingt-quatre heures,
celle de SOL en étant sortie par l'âge.

### Vingt-troisième lecture, 04h15 — le plancher remord violemment, et je ne peux pas dire pourquoi

**La tranche est spectaculaire, et je ne sais pas l'expliquer.**

| | 02h53 | 04h15 | tranche |
|---|---|---|---|
| jambes visées | 200 | **233** | +33 |
| ouvertes | 66 | **68** | **+2** |
| refusées au plancher | 127 | **158** | **+31** |

**Trente-trois vœux, deux ouvertures, trente et un refus — 94 % de la
tranche.** Après quatre lectures consécutives à zéro refus, le plancher
d'ordre s'est remis à mordre d'un coup, et plus fort que jamais.

C'est exactement la conséquence que j'avais écrite d'avance *si les
tailles chutaient*. Sauf que **je ne peux pas vérifier que c'est bien
cela** :

- le frein de mesure devrait encore être **inerte** — son compteur de
  dispersion repart de zéro et il lui faut trente instants, soit environ
  six heures ; le déploiement date d'une heure ;
- le tableau du bas est **vide** au moment du relevé, donc ni `defl` ni
  `poids` ni `USD` à lire ;
- et surtout : **`frein_mesure` et `t_direct` n'apparaissent nulle
  part**.

### Le défaut est le mien, et c'est exactement celui que je corrige depuis hier

J'ai ajouté ces deux mesures au snapshot **sans les afficher nulle
part** : ni dans `releve_taille.py`, ni dans le grep du workflow. Deux
quantités muettes. C'est mot pour mot le défaut que la vingtième lecture
a mis dix heures à débusquer — *« tant que les refus sont des `continue`
muets, l'écart ne se lit nulle part »* — et je viens de le reproduire
sur mon propre instrument, la nuit même. **Une quantité qui ne se lit
pas ne sert à rien.**

Corrigé : le grep du workflow porte maintenant `frein_mesure`,
`t_direct` et `n_carre` (changement de workflow seul, effet immédiat), et
`releve_taille.py` affiche une ligne dédiée qui dit aussi, en toutes
lettres, quand le frein est **inerte faute de trente instants**. Cette
seconde partie n'est pas déployée — je ne redéploie pas pour de
l'affichage —, mais le grep suffira dès le prochain relevé.

**Donc la réponse honnête à « le frein a-t-il pris effet » est : je ne
sais pas encore.** Deux causes restent possibles pour le plancher qui
remord — le frein neuf, ou un poids de Kelly retombé parce que la
cellule retenue a changé — et je refuse de choisir entre elles sans la
mesure. Le prochain relevé tranchera.

**Un indice, tout de même, et il va contre le frein** : aucune ligne
`explore` dans la fenêtre de deux heures. Le relais des éclaireurs est
précisément ce qui doit apparaître quand le frein met une règle à zéro.
Son absence est cohérente avec un frein encore inerte — mais c'est un
argument négatif, pas une mesure.

### Ce que le cumulé dit, et il dit quelque chose de neuf

| lecture | n | bps | σ |
|---|---|---|---|
| 00h46 | 292 | −15,20 | −5,17 |
| 01h47 | 296 | −15,20 | −5,21 |
| 02h53 | 299 | −15,08 | −5,19 |
| **04h15** | **303** | **−14,60** | **−5,06** |

**Le σ recule pour la première fois de la campagne.** Non pas parce que
n a baissé — il monte — mais parce que le bps s'améliore assez vite pour
l'emporter sur l'accumulation de preuve : −15,20 → −15,08 → −14,60. Deux
lectures consécutives d'amélioration. Le brut réalisé aussi : −31,82 →
**−31,05**, soit **+0,77 USD** gagnés sur l'heure.

Je ne conclus rien : deux lectures, et le compteur reste à cinq écarts
types sous zéro. Mais c'est le premier mouvement dans le bon sens depuis
que je le suis, et il mérite d'être noté comme tel plutôt que passé sous
silence.

**La part gagnante monte pour la quatrième lecture d'affilée** : 15 →
20 → 21 → 18 → 24 → **28 %**. Six lectures, dont les trois dernières
sur des fenêtres suffisamment glissées pour ne plus être la même.

`en risque` n=235 à −18,2 (contre −18,9). Équité 9 250,70 en 711
remplissages. `halted_today` faux, `killed` faux. **Pas de quatrième
sortie au suiveur** — toujours trois dans la campagne, deux dans la
fenêtre de vingt-quatre heures.

### Vingt-quatrième lecture, 05h17 — la question est tranchée, et ce n'était pas le frein

Le grep corrigé donne enfin la réponse en clair :

```
"n_carre": 5        "t_direct": 0.0        "frein_mesure": 1.0
```

**Le frein de mesure est inerte, exactement comme annoncé.** Cinq
instants de dispersion sur les trente qu'il exige. Il n'a donc joué
aucun rôle dans le plancher qui s'est remis à mordre : c'est le **cas
(a)**, et la cause est ailleurs.

**Et la cause se lit maintenant dans le tableau.** TRUMP porte
`defl +1,6`, `poids +0,0491`, **`USD +454`** — contre `+0,3`, `+0,0111`
et `+102` deux lectures plus tôt. Le poids a **quadruplé**, la jambe est
quatre fois plus grosse. Ce n'est donc pas un effondrement des tailles.

Alors pourquoi 171 refus ? **Parce que le nombre de vœux a explosé** :

| tranche | vœux | ouvertes | refus | part |
|---|---|---|---|---|
| 02h53 → 04h15 | **33** | 2 | 31 | 94 % |
| 04h15 → 05h17 | **19** | 6 | 13 | 68 % |

Contre +5, +5, +3, +5 aux quatre tranches précédentes. **Le nombre de
propositions a été multiplié par quatre à six.** Plus d'horloges
validées, donc plus de noms proposés — et le `panel[20]` a une queue de
petits poids qui tombe sous les 18,5 USD pendant que les gros passent
largement. Ce n'est pas la taille moyenne qui s'est effondrée, c'est la
**dispersion des poids entre noms** qui devient visible dès qu'on
propose vingt noms au lieu de trois.

Les quatre tranches à zéro refus n'étaient donc pas la disparition du
problème du plancher : c'étaient les heures où **seuls les gros noms
proposaient**. Je l'avais lu comme une dissolution ; c'était un effet de
composition. La onzième lecture reste juste sur le mécanisme — la
bascule vers `fixe` a bien relevé les poids — mais ma conclusion « le
problème s'est dissous sans qu'on y touche » était **prématurée**.

**Mon annonce de six heures était deux fois trop optimiste.** `n_carre`
monte d'environ 2,4 par heure, pas 5 : il faudra encore une dizaine
d'heures, soit **vers 15h30 UTC**, pour que le frein ait ses trente
instants. Aucune ligne `explore` non plus, ce qui est cohérent : le
relais n'a rien à relayer tant que le frein ne coupe rien.

### Le cumulé, et une divergence qu'il faut nommer

| lecture | n | bps | σ |
|---|---|---|---|
| 01h47 | 296 | −15,20 | −5,21 |
| 02h53 | 299 | −15,08 | −5,19 |
| 04h15 | 303 | −14,60 | −5,06 |
| **05h17** | **308** | **−14,47** | **−5,06** |

**Troisième lecture consécutive d'amélioration du bps.** Le σ, lui, est
stable : le gain sur la moyenne est exactement compensé par la preuve
qui s'accumule.

**Mais l'équité baisse pendant que le bps monte** : 9 250,70 →
**9 246,67**, soit −4,03 USD sur onze remplissages. Le brut ne perd que
0,41 ; **les frais en prennent 1,88 sur l'heure**. Les deux chiffres ne
se contredisent pas — le bps est une moyenne *par instant*, les frais
s'accumulent *par trade* — et leur divergence est la définition même du
moulin que le bandeau annonce depuis le début. Une règle peut s'améliorer
par trade et appauvrir le compte plus vite, simplement en tradant
davantage. C'est exactement ce que fait cette heure-ci, avec quatre à
six fois plus de vœux qu'avant.

**La part gagnante monte pour la cinquième lecture d'affilée** : 15 →
20 → 21 → 18 → 24 → 28 → **29 %**. Et l'attribution ne porte **plus
aucun `TRAIL`** : la fenêtre de trente-huit fermetures est désormais
entièrement du time-stop, à −9,5 bps — le motif le plus coûteux de la
campagne est sorti de la fenêtre par l'âge, pas par correction.

`en risque` n=240 à −18,0. `frein_risque` 0,97 (contre 0,98) : il
descend, lentement, avec le recul depuis le sommet. 722 remplissages.
`halted_today` faux, `killed` faux. **Pas de quatrième sortie au
suiveur** — toujours trois dans la campagne, deux dans la fenêtre de
vingt-quatre heures.

### Vingt-cinquième lecture, 06h17 — le premier stop fixe touché, et il a parfaitement tenu

**Un `SL` apparaît pour la première fois de la campagne**, et il coûte
plus cher à lui seul que les trois sorties au suiveur réunies :

```
attribution sur les 38 dernieres fermetures mesurees
  time-stop      37      -10,9    -15,34   10/37   27%
  SL              1     -538,7    -20,58    0/1     0%
```

L'appariement est direct dans le journal :

```
06h06:33  ouverture  TRUMP +140,900000 @ 2,863250  (candle +10,2bps h=6)
06h07:58  scalp SL 527bps TRUMP +140,900000 @ 2,711000
```

| | valeur |
|---|---|
| perte brute | **531,7 bps** |
| largeur armée | **527** |
| dépassement | **+4,7 bps (+0,9 %)** |
| recoupement | 531,7 + 7,0 de frais = **538,7** — exactement l'attribution |

**Le stop a parfaitement tenu.** Moins d'un pour cent de dépassement,
contre **+27 %** pour le suiveur sur ce même nom le 28 au matin. C'est un
point **en faveur** de la bascule vers `fixe` que le durcissement a
provoquée, et c'est le **troisième recoupement exact** de la chaîne de
mesure — trois fois de suite, prix remplis plus frais aller-retour
retombent à la décimale sur ce qu'annonce la table.

**Ce qui a coûté, ce n'est pas l'exécution, c'est le marché et la
taille.** TRUMP est passé de 2,9503 à 2,7110 en quatorze minutes, soit
**−8,1 %**. Le stop a fait exactement son travail : couper à 527 bps au
lieu de laisser courir. Mais 527 bps sur un notionnel de 403 USD font
**−21,45 USD** d'un coup.

**Et le moteur a rouvert TRUMP deux fois dans les dix minutes
suivantes** — à 06h08:25 en long sur un signal de +39,8 bps, puis à
06h16:06 **en court**. Trois positions sur le même nom pendant qu'il se
disloque. Je le note sans le commenter davantage : c'est peut-être
exactement ce que la règle doit faire dans une dislocation, et je n'ai
pas de quoi trancher.

### La leçon sur la moyenne, et elle est sévère

| lecture | n | bps | σ |
|---|---|---|---|
| 02h53 | 299 | −15,08 | −5,19 |
| 04h15 | 303 | −14,60 | −5,06 |
| 05h17 | 308 | −14,47 | −5,06 |
| **06h17** | **313** | **−16,45** | **−5,80** |

**Trois lectures d'amélioration effacées par un seul événement.** Le bps
recule de 1,98 point — sur trois cent treize instants — parce qu'une
jambe a perdu 531 bps. Je n'avais rien conclu de la série montante, et
c'était la bonne prudence ; mais il faut en tirer la règle explicite :
**une moyenne sur trois cents instants se déplace de deux points de base
par une seule jambe.** Toute « tendance » lue sur trois lectures
consécutives de cette moyenne est à la merci du prochain accident.

Le brut réalisé passe de −31,46 à **−59,01** — presque doublé en une
heure — et l'équité de 9 246,67 à **9 218,47**. Le `frein_risque` réagit,
lui, et descend à **0,95**.

### Le frein de mesure, et ma cadence deux fois fausse

```
"n_carre": 10        "t_direct": 0.0        "frein_mesure": 1.0
```

Toujours inerte, mais il monte de **cinq par heure**, pas 2,4 : il aura
ses trente instants vers **10h20 UTC**, pas 15h30. J'ai d'abord été deux
fois trop optimiste (six heures), puis deux fois trop pessimiste. La
cadence des instants n'est pas stable — elle suit le nombre d'horloges
validées — et il faut cesser de la prédire à partir d'une seule tranche.

**La cadence des vœux est retombée** : 5 sur la tranche, contre 33 puis
19, et **zéro refus au plancher** (171 inchangé). Le flot de
propositions oscille donc entre 5 et 33 par heure selon le nombre
d'horloges validées — ce qui confirme la lecture précédente : ce n'est
pas la taille qui varie, c'est le **nombre de noms qui parlent**.

**La part gagnante baisse pour la première fois** : 15 → 20 → 21 → 18 →
24 → 28 → 29 → **26 %**. Huit lectures.

`en risque` n=245 à −20,5. Glissement +0,30 bps sur 359 ouvertures
(médiane −0,67). 732 remplissages. `halted_today` faux, `killed` faux —
le recul du jour reste très en deçà des 8 %. **Pas de quatrième sortie
au suiveur.**

### Vingt-sixième lecture, 07h18 — une heure calme, et je la rapporte comme telle

Trois remplissages, un vœu, zéro refus. **Il ne s'est presque rien
passé**, et cette lecture sera courte : gonfler le compte rendu d'une
heure morte serait exactement la façon de rendre les lectures illisibles
le jour où il se passera quelque chose.

**L'accident du `SL` était bien un accident.** Le brut réalisé remonte
de −59,01 à **−55,94** (+3,07 USD) et l'équité de 9 218,47 à
**9 222,14**. Le σ suit : **−5,80 → −5,67**.

| lecture | n | bps | σ |
|---|---|---|---|
| 05h17 | 308 | −14,47 | −5,06 |
| 06h17 | 313 | −16,45 | −5,80 |
| **07h18** | **315** | **−16,05** | **−5,67** |

Deux lectures, et je ne conclus rien — d'autant que la règle écrite
l'heure dernière vaut dans les deux sens : une jambe suffit à déplacer
la moyenne de deux points, donc la récupération partielle n'est pas plus
concluante que la chute ne l'était.

**Ni nouveau `SL`, ni quatrième sortie au suiveur.** Le journal de
vingt-quatre heures porte exactement trois lignes de stop : `TRAIL 227`
et `TRAIL 85` du 28, et le `SL 527` de 06h07. Toutes trois appariées et
vérifiées.

**Le frein de mesure : j'arrête de prédire son activation.** `n_carre`
vaut 12 — il est monté de 5, puis de 2. J'ai annoncé six heures, puis
dix, puis quatre ; la cadence des instants suit le nombre d'horloges
validées, qui varie d'un facteur six d'une heure à l'autre. **La bonne
réponse est que je ne sais pas quand, et qu'il n'y a rien à faire
d'autre qu'attendre qu'il ait ses trente.** `t_direct` 0,0,
`frein_mesure` 1,0, aucune ligne `explore`.

**La part gagnante remonte** : 15 → 20 → 21 → 18 → 24 → 28 → 29 → 26 →
**32 %**. Neuf lectures ; c'est la plus haute de la série.

`en risque` n=247 à −19,9. Frais −60,55, 735 remplissages, `frein_risque`
0,95, `halted_today` faux, `killed` faux.

### Vingt-septième lecture, 08h19 — rien. Et c'est tout ce qu'il y a à en dire

Le relevé est **identique au caractère près** à celui de 07h18 :
`live_rule` n=315 à −16,047, `n_carre` 12, équité 9 222,14, brut −55,94,
frais −60,55, 735 remplissages, 258 vœux, 80 ouvertures, 171 refus,
attribution inchangée. **Zéro remplissage en une heure.**

Le moteur vit — `n_entrees` passe de 6 893 à 6 966, les décisions de
3 397 à 3 495, le service est actif, le desk tourne à `calcul` 6,6-6,9 s
— mais une seule horloge est validée (`hz=['5m']`, `net=+9,21`) et elle
n'a rien proposé.

**Donc la part gagnante de 32 % n'est pas une dixième lecture : c'est la
même.** La règle que je me suis donnée s'applique littéralement — relire
deux fois le même échantillon ne le confirme pas — et je note la valeur
sans l'ajouter à la série.

Ni nouveau `SL` ni quatrième `TRAIL`. Le `SL 527` de 06h07 vient de
sortir de la fenêtre de deux heures ; les deux `TRAIL` du 28 restent dans
celle de vingt-quatre. `frein_mesure` 1,0, `t_direct` 0,0, aucune ligne
`explore`. `halted_today` faux, `killed` faux.

### Vingt-huitième lecture, 10h19 — trois heures sans un trade, et ce que cela révèle du frein

Troisième relevé identique : `live_rule` n=315 à −16,047, `n_carre` 12,
équité 9 222,14, brut −55,94, frais −60,55, 735 remplissages, 258 vœux,
171 refus, attribution inchangée. **Aucun remplissage depuis 06h23.**

**Un point de conception que ces trois heures mettent au jour.**
`n_carre` ne monte qu'aux **fermetures**. Si le carnet reste vide, le
frein de mesure reste inerte **indéfiniment** — il ne s'activera jamais
par le seul passage du temps. Ce n'est pas un défaut : un carnet vide ne
perd rien, donc il n'y a rien à freiner. Mais il faut le dire
explicitement, parce que j'ai passé quatre lectures à annoncer des dates
d'activation comme si elles dépendaient de l'horloge. **Elles dépendent
de l'activité.** Le frein est un dispositif pour un régime actif ; il
attendra que le moteur reprenne, et c'est tout.

**Une quatrième aberration, évaporée elle aussi.** La fenêtre 1m sur
douze heures porte une ligne
`live [mlp/h1/abs] net=+12,97bps/trade sr=+0,184 pente=1,69±0,05
profil=+0,03/+0,08/+0,51 parjour=95,9 gainjour=+833bps`. Les deux
verdicts 1m qui suivent (08h46, 09h44) sont `veto` à +2,82 et +4,18, en
`mlp/h6/abs`. Elle n'a pas tenu — comme la 1H à +226, la h=1 de 09h39 et
la 15m à +101. **Quatre sur quatre.** La barre déflatée fait son travail
avec une régularité qui mérite d'être notée pour elle-même.

**Ce que la rafale de TRUMP montre, rétrospectivement.** Le journal de
douze heures porte, entre 04h46 et 06h23, **douze ouvertures
consécutives sur le seul TRUMP**, de 3,026 à 2,700, à 154-182 unités
(460-550 USD la jambe). C'est cette rafale qui a produit le `SL 527`, et
c'est elle qui a fait tout le brut de la journée. Depuis, plus rien. La
concentration sur un nom que la huitième lecture avait cherchée puis
infirmée sur vingt ouvertures existe bel et bien — mais par épisodes,
pas en régime.

Le `SL 527` est sorti de la fenêtre de deux heures, le `TRAIL 227` de
celle de vingt-quatre : il ne reste que le `TRAIL 85` du 28. Huit noms
écartés à 04h39 faute d'historique (XAG, NVDA, LIGHT, CHIP, EDEN, MSTR,
BICO, INTC), ONDO admis. `frein_risque` 0,952, `frein_mesure` 1,0,
`t_direct` 0,0, `halted_today` faux, `killed` faux.

### Vingt-neuvième lecture, 12h19 — le carnet repart, et une cinquième aberration arrive

**Le moteur a rejoué**, après six heures d'immobilité : une ouverture
SOL à 12h17:13, `−1,420000 @ 103,857500`, un **court**. Vœux 258 → 259,
ouvertures 80 → 81, remplissages 735 → 736, position tenue au moment du
relevé. `live_rule` reste à n=315 et `n_carre` à 12 : rien n'a encore
été **fermé**, donc aucune série ne bouge. Trois horloges validées
simultanément — `hz=['1m', '3m', '5m']`.

### La cinquième aberration, et elle n'est pas comme les autres

```
11h55:41  clock 5m panel[20] live [mlp/h1/abs]
  ic=0,468  net=+55,93bps/trade  sr=+0,560  seuil=40,3bps/3,5sig
  stop=4sig/fixe  pente=1,11±0,02 (brut +1,12)
  profil=+0,53/+0,58/+0,58  parjour=11,8  gainjour=+513bps
```

Les quatre précédentes — 1H à +226, h=1 de 09h39, 15m à +101, 1m à
+12,97 — ont toutes disparu au verdict suivant. **Celle-ci n'a pas
encore eu son verdict suivant** : le prochain 5m tombera vers 13h. Je ne
sais donc pas, et je le dis plutôt que de parier sur la série.

**Mais elle diffère des quatre autres sur deux points qui comptent.**
Son `profil` — le Sharpe par tiers chronologique du holdout — vaut
`+0,53 / +0,58 / +0,58` : **plat et élevé sur les trois tiers**, pas
concentré sur le dernier comme la 15m (`+0,03/+0,08/+0,51`). Et sa
`pente` vaut **1,11 ± 0,02** : la relation entre ce qu'elle annonce et
ce qu'elle réalise est estimée avec une erreur type quinze à trente fois
plus petite que celle des autres aberrations (0,61 pour la 1H, 0,48 pour
la 15m). Une pente à l'unité avec cette précision-là est le contraire du
profil d'un artefact de sélection.

Cela ne la valide pas — `ic=0,468` sur une horloge de cinq minutes reste
sans précédent crédible dans cette campagne, et quatre aberrations sur
quatre se sont évaporées. Cela veut seulement dire que **si elle
survivait, ce serait la première à survivre, et pour des raisons
lisibles**. C'est la question du prochain relevé, et elle vaut d'être
posée précisément plutôt que rangée d'avance dans la série.

**Le reste est immobile** : `live_rule` n=315 à −16,047 (−5,67 σ),
`en risque` n=247 à −19,9, équité **9 222,11**, brut −55,94 inchangé,
frais −60,58, `frein_mesure` 1,0, `t_direct` 0,0, `n_carre` 12. Ni
nouveau `SL` ni quatrième `TRAIL` — il ne reste que le `TRAIL 85` dans
la fenêtre de vingt-quatre heures. `halted_today` faux, `killed` faux.

**Je repasse le rappel à une heure** : le carnet a repris.

### Trentième lecture, 13h22 — cinq sur cinq, et la cinquième est morte autrement

**La cinquième aberration n'a pas survécu.** Le verdict 5m suivant est
tombé à 12h55:29, et il faut le lire à côté de celui de 11h55:41, car
c'est **la même cellule** :

```
11h55:41  5m live [mlp/h1/abs]  ic=0,468  net=+55,93  seuil=40,3bps/3,5sig
          pente=1,11±0,02  profil=+0,53/+0,58/+0,58  instants=887
12h55:29  5m live [mlp/h1/abs]  ic=0,164  net=+18,34  seuil=14,1bps/3,5sig
          pente=1,15±0,04  profil=+0,27/+0,37/+0,35  instants=2551  gardee
```

Même signature, même seuil d'entrée (3,5 σ), même stop (4 σ fixe), et le
mot **`gardee`** : l'hystérésis a tenu, la cellule n'a pas été remplacée.
Et pourtant `ic` est divisé par 2,9, le `net` par 3,0, le `profil` par
deux sur les trois tiers. **Les quatre premières aberrations étaient
remplacées au verdict suivant ; celle-ci a été conservée, et c'est son
propre chiffre qui s'est effondré.** Le résultat est le même : cinq sur
cinq, aucune n'a tenu.

### Ce que `gardee` protège, et ce qu'il ne protège pas

Le nombre d'instants déclenchés est passé de **887 à 2551** — presque le
triple — pendant que la base d'entraînement ne gagnait que 252 lignes
(n=715 410 → 715 662). Une règle fixe sur des données quasi identiques ne
peut pas tripler son nombre de déclenchements. La seule explication est
que **le modèle a été réajusté** : le `mlp` est refit à chaque cycle, et
un seuil d'entrée à 3,5 σ appliqué à une distribution prédictive
différente ne coupe pas au même endroit.

Donc `gardee` **préserve l'étiquette, pas le prédicteur**. La cellule
« conservée » n'est pas la même fonction d'une heure sur l'autre. C'est
une conclusion plus dure que celle que je cherchais : je surveillais la
rotation des signatures comme mesure d'instabilité, et la rotation n'est
pas nécessaire pour que tout change.

Et la porte ne peut pas voir cela, parce que **son barreau descend
exactement aussi vite que l'estimation** : `seuil` 40,3 → 14,1, soit le
même facteur 2,9 que le `net`. La cellule reste `live` d'un bout à
l'autre de la déflation. Le barreau déflaté est calculé sur le nombre
d'essais et la taille d'échantillon ; il ne sait rien de la *fraîcheur*
de la sélection, et c'est précisément le défaut par lequel cette cellule
passe.

### La correction que je me dois, et elle porte sur mon argument, pas sur un chiffre

J'avais écrit une heure plus tôt que cette cellule différait des autres
parce que sa `pente` valait 1,11 ± 0,02, « le contraire du profil d'un
artefact de sélection ». **La pente est la seule chose qui a survécu** :
1,11 ± 0,02 → 1,15 ± 0,04. Le `net`, lui, a été divisé par trois.

J'ai donc pris une quantité stable pour une caution d'une autre
quantité. Une pente à l'unité dit que ce qui est annoncé est annoncé à
la bonne **échelle** — c'est un énoncé d'étalonnage. Elle ne dit rien de
l'**ampleur** exploitable une fois les coûts et la prime de sélection
retirés. Les deux se lisent sur la même ligne de journal et n'ont pas la
même valeur probante. La règle est ajoutée au §10.

### Ni les 3m ni les 5m n'ont ouvert quoi que ce soit

Les trois ouvertures de l'heure portent toutes `h=6` :

```
12h17:13  SOL   −1,420000 @ 103,857500  x5  (candle −9,0bps h=6)
12h35:33  TRUMP +55,000000 @   2,693250  x5  (candle +8,0bps h=6)
12h51:31  TRUMP +11,600000 @   2,678250  x5  (candle +16,6bps h=6)
```

Les trois horloges validées sont `1m`, `3m`, `5m`. La 5m est en `h1`
depuis 11h55 et la 3m est passée en `h1` à 12h50 — donc par élimination
un signal `h=6` ne peut venir que de la **1m**, seule cellule en `h6`.
Autrement dit : les deux cellules aux gros chiffres (`3m` à +21,83,
`5m` à +18,34, `parjour` 33,9 chacune) **n'ont produit aucune jambe**,
et la cellule modeste à +5,67 a produit les trois. Une cellule qui
promet trente-quatre trades par jour et n'en ouvre aucun dans l'heure
qui suit sa sélection n'est pas seulement optimiste sur son gain : elle
n'est pas exécutable dans le carnet tel qu'il tourne.

### La chaîne de mesure, recoupée une fois de plus

Les trois clôtures de l'heure sont des `time-stop 6m`, chacune appariable
à son ouverture par **prix remplis** :

| jambe | brut | frais | net |
|---|---|---|---|
| SOL court 103,8575 → 103,800 | +5,54 | 7,0 | **−1,46** |
| TRUMP long 2,693250 → 2,709000 | +58,48 | 7,0 | **+51,48** |
| TRUMP long 2,678250 → 2,670000 | −30,80 | 7,0 | **−37,80** |
| moyenne des trois | | | **+4,071** |

Et le cumulé, lu indépendamment, passe de n=315 à −16,047 vers n=318 à
−15,857, ce qui **impose** une moyenne de `+4,047` bps sur les trois
nouveaux instants. Écart entre le calcul à la main et le cumulé :
**0,024 bps**. La chaîne tient, des prix remplis jusqu'au registre.

Trois clôtures ne concluent rien, et le fait qu'elles soient favorables
ne change pas cette phrase d'un mot.

### Le cumulé, et le frein qui attend encore

`live_rule` **n=318 à −15,857 bps**, soit **−5,63 σ** avec la dispersion
de 50,2 bps par instant. `en risque` n=250 à −19,6. Équité **9 222,77**
(+0,66 sur l'heure), brut réalisé −55,09, frais **−60,78** — les frais
dominent toujours le brut, c'est toujours un moulin. `frein_risque`
0,953, `confiance` 0,10, `halted_today` faux, `killed` faux.

`n_carre` **12 → 15**, `t_direct` 0,0, `frein_mesure` 1,0. Le frein de
mesure gagne **trois observations par heure**, exactement le rythme des
clôtures : il lui reste **cinq heures** avant de pouvoir seulement
parler. Pendant ce temps le cumulé est à −5,6 σ.

Cet écart est le prix d'un choix que je maintiens. La variance n'était
pas suivie avant que j'écrive le frein ; réutiliser le n cumulé pour
diviser une dispersion que je n'ai mesurée que sur quinze points serait
exactement la faute que le §10 interdit — *une dispersion ne doit pas
emprunter un compte qu'elle ne possède pas*. Je note le coût, je ne le
contourne pas.

### Le plancher n'a rien refusé de neuf

Vœux 259 → **261**, ouvertures 81 → **83**, remplissages 736 → **741**.
Refus au plancher **171**, et **1 349 USD** de notionnel jamais ouvert —
les deux chiffres **identiques** à ceux de l'heure précédente. Les deux
vœux nouveaux sont devenus deux ouvertures. L'identité `83 + 171 + 7
(rejet) = 261` boucle exactement ; les 7 `arrondi` chevauchent, par
construction, puisque ce compteur n'interrompt pas la boucle.

### Ce que je change, et ce que je ne change pas

**Je ne déploie pas.** Le carnet a une espérance mesurée négative à 5,6
erreurs types ; en corriger la composition est interdit par le §10, et
poser une règle « deux verdicts consécutifs avant de dimensionner » sur
**une seule** paire observée serait poser un seuil sur une quantité lue
une fois. Le moteur ne s'arrête pas ce tour-ci.

**Je change le relevé, et cela ne coûte rien au moteur.** Le workflow est
lu par Actions dans le dépôt, jamais installé sur la machine : le
modifier n'arrête pas une seconde de moteur. J'ajoute une fenêtre qui
projette chaque verdict sur les six quantités qui montrent la déflation
— heure, horloge, verdict, signature, `net`, `seuil`, `instants`,
`gardee` — sur **vingt-quatre heures** et quarante lignes, là où la
fenêtre complète n'en tient que quatorze sur douze heures. C'est ce qui
transformera « une paire observée » en un comptage, et c'est seulement
alors qu'un seuil sera légitime. La projection est testée hors ligne sur
les lignes réelles, le fichier repasse à quatre apostrophes, le YAML et
le shell sont vérifiés.

**Je garde le rappel à une heure.** La question du prochain relevé est
nette : le verdict 5m de ~13h55 doit dire si le `net` continue de
descendre vers la ligne de fond des autres horloges (~+5 bps) ou s'il se
stabilise vers +18. Et la 3m, passée en `h1` à 12h50 avec +21,83 sur un
barreau de 17,5, aura son propre verdict vers 13h50 : c'est une
deuxième paire, indépendante, sur le même mécanisme.

### Trente-et-unième lecture, 14h26 — ma prédiction était fausse, et la vraie relation est ailleurs

**J'avais annoncé une déflation. La deuxième paire a fait l'inverse.** La
cellule 3m `[mlp/h1/abs]`, sélectionnée fraîche à 12h50 avec +21,83, a
été **gardée** à 13h50 et son net est **monté à +37,11**. Le plan écrit
il y a une heure cède devant la mesure, et voici ce que la mesure dit à
la place.

La nouvelle fenêtre a fonctionné du premier coup : **quarante verdicts
sur huit heures**, projetés sur les six quantités utiles. Elle permet
enfin de compter au lieu de commenter une paire.

### Ce que quarante verdicts disent de la stabilité des signatures

| horloge | changements de signature | instants | net |
|---|---|---|---|
| 1H | **0 / 7** | 787–793 (×1,01) | +11,42…+12,23 (×1,1) |
| 15m | **0 / 7** | 1311–1319 (×1,01) | +1,13…+1,96 (×1,7) |
| 1m | **0 / 7** | 1259–1551 (×1,23) | +2,82…+6,27 (×2,2) |
| 3m | **6 / 7** | 518–1757 (×3,4) | +0,59…**+37,11** (×63) |
| 5m | **2 / 7** | 712–2551 (×3,6) | +0,24…**+55,93** (×233) |

La phrase que j'avais écrite dans les commentaires du relevé — *une règle
qui change d'identité à chaque refit n'a pas de mesure en direct du tout*
— est maintenant **mesurée** et non plus affirmée : la 3m a eu **sept
identités en huit heures**. Et les deux horloges qui produisent toutes
les aberrations sont exactement les deux dont les chiffres balaient un à
deux ordres de grandeur. Les trois horloges à signature stable ont des
chiffres stables.

### La relation qui explique les deux paires avec une seule histoire

Sur les **27 paires à signature identique d'un verdict au suivant**, le
net par trade et le nombre d'instants déclenchés bougent en sens
**opposé** :

```
5m  11:55->12:55  net x0,33   instants x2,88
3m  12:50->13:50  net x1,70   instants x0,68
5m  06:56->07:57  net x38,4   instants x0,42
5m  09:55->10:58  net x0,52   instants x0,92
1m  07:45->08:46  net x0,61   instants x1,23
```

Corrélation de `log(instants après/avant)` contre `log(net après/avant)` :
**r = −0,77** sur les 27 paires ; **−0,62** en retirant la paire extrême
5m de 06h56 ; **−0,81** sur les six paires où les instants bougent de
plus de 5 % et sans l'extrême. Les 1H et 15m ont des instants figés à
1 % près : elles ne peuvent pas porter la relation, elles ne font qu'y
ajouter du bruit vertical — et elle survit quand même.

**Le mécanisme se nomme.** Le seuil d'entrée est libellé en **sigmas de
la distribution prédictive du modèle**. Le refit change l'échelle de
cette distribution. Le même nombre de sigmas correspond donc, d'une
heure sur l'autre, à une **sélectivité économique différente** : moins de
déclenchements, plus triés, net par trade plus haut ; plus de
déclenchements, dilués, net par trade plus bas. Cela explique le signe
dans **les deux** paires, ce que ma lecture « déflation » ne faisait pas.

Six paires à mouvement réel ne fondent aucun seuil, et les paires
consécutives partagent une extrémité, ce qui rend le t optimiste. C'est
une hypothèse avec un mécanisme et une première quantification, pas une
loi. La fenêtre est en place pour la compter.

### Le fait le plus important de l'heure n'est pas là

**La 1m est passée en veto à 13h45** (+4,28 contre un barreau de 9,1).
`hz=['3m', '5m']`.

Or les **vingt ouvertures** de la fenêtre de douze heures portent
**toutes** `h=6`, et la 1m était la **seule** cellule en `h6` de toute la
fenêtre. Les deux horloges encore validées sont la 3m et la 5m — celles
dont l'identité change presque à chaque cycle — et **ni l'une ni l'autre
n'a ouvert une seule jambe** depuis sa sélection, alors qu'elles
promettent 22,9 et 11,2 trades par jour.

Le carnet est donc fermé. Rien n'a bougé de l'heure : `live_rule`
**n=318 à −15,857** (−5,63 σ) inchangé, `n_carre` **15** inchangé,
équité **9 222,77** inchangée, vœux 261 / ouvertures 83 / remplissages
741 inchangés, refus au plancher 171 et 1 349 USD inchangés. Aucun
nouveau `SL`, aucun nouveau `TRAIL`. `halted_today` faux, `killed` faux.

### Et cela bloque le frein de mesure une deuxième fois

Le frein a besoin de **30** observations et en a **15**. Il les gagnait à
raison de trois par heure — par les clôtures. Avec la 1m en veto il n'y a
plus de clôtures du tout, donc **il n'en gagnera plus aucune**.

Le frein de mesure est ainsi bloqué deux fois : par son seuil de trente,
et par l'arrêt de la seule chose qui le nourrit. Un organe qui
n'apprend que de l'activité ne peut rien dire d'un carnet à l'arrêt —
et c'est précisément quand le cumulé est à −5,6 σ qu'on voudrait qu'il
parle. Je note la conséquence ; je ne la contourne pas en lui faisant
emprunter le n cumulé.

### Ce que je ne fais pas

**Aucun déploiement.** L'espérance mesurée reste négative à 5,6 erreurs
types, six paires ne fondent pas un seuil, et rien de ce qui précède ne
demande une modification du moteur pour être mesuré davantage — la
fenêtre ajoutée à l'heure précédente suffit à accumuler les paires. Le
moteur ne s'arrête pas ce tour-ci non plus.

**Je garde le rappel à une heure.** Trois questions nettes pour le
prochain relevé : la 1m redevient-elle validée (c'est la seule qui ait
jamais ouvert une jambe) ; la 3m ou la 5m ouvrent-elles enfin quelque
chose ; et combien de paires nouvelles à signature identique, pour faire
monter le comptage de l'anticorrélation au-dessus de six.

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
5. **La règle jouée perd, et c'est mesuré.** `live_rule` n=179 à
   −11,4 bps, erreur type 3,7 : **trois sigma sous zéro**. `en risque`
   n=111 à −18,2. Ce n'est plus l'écart au holdout qui est en cause —
   c'est le résultat lui-même. Le rodage tient la taille au dixième,
   la perte est lente et bornée, mais elle est réelle.
6. **Les reprises : piste close.** La sonde a répondu — `suite` vaut
   34-36 % au holdout contre 51 % en direct, donc la porte facture
   **69 %** du motif, et le surplus vaut moins d'un dollar sur une
   perte de 65. Ce n'était pas là.
7. **Le livre joué n'est pas le livre validé — la mesure est
   maintenant en place.** Huit noms distincts sur vingt ouvertures :
   la piste « une seule jambe en boucle » est infirmée. Ce qui reste :
   zéro à deux jambes **simultanées** contre vingt mises en commun par
   la porte. Les refus d'`execute_pending` étaient des `continue`
   muets ; ils sont désormais comptés par motif — plancher d'ordre,
   lot minimal, prix, rejet — et « déjà tenue » est distingué d'un
   refus. **Le compteur a tranché : 50 vœux sur 79 meurent sous le
   plancher d'ordre**, 484 USD de notionnel jamais ouvert, et le
   moteur garde les trois plus gros noms de six proposés sur vingt
   mis en commun. Le rodage divise les jambes par dix, le plancher
   efface celles qui tombent en dessous, et ce sont exactement celles
   qui produiraient les trente mesures que le rodage attend. Ce qui
   reste ouvert : le plancher a une bonne raison d'exister pour un
   **redimensionnement** — l'a-t-il pour une **ouverture** ?
8. **Le suiveur : trois occurrences, et le motif se dessine.** SOL
   +3 %, BTC +5 %, TRUMP +27 % au-delà de la largeur armée. Le stop
   tient dans le cas ordinaire et cède sur un mouvement violent ;
   TRUMP est l'exception, pas la norme. Trois lectures ne permettent
   toujours de toucher à aucune largeur, et je n'y touche pas. Les
   deux premières portaient 62 % de la perte brute du compte ; la
   troisième n'a coûté que 0,74 USD, parce que le rodage avait ramené
   la jambe à 77 USD.
9. **Le frein ne regarde pas la mesure.** `_risk_scale`
   (`engine.py:1309-1326`) ne lit que l'equite, son sommet et
   l'ouverture du jour ; il ne touche jamais `live_stats`. Une regle
   a −5,2 sigma garde 98 % de sa taille, et le frein n'atteint son
   plancher de 0,25 qu'apres 21,25 % de recul depuis le sommet.
   `_confiance` (`engine.py:1669-1691`) est le seul organe qui ecoute
   la mesure, et il est deja sature a son plancher de 0,1 — qui est un
   plancher, pas un fond : une regle mesuree perdante garde
   indefiniment un dixieme de sa taille pleine. **Le seul organe qui
   ecoute est sature ; le seul qui a de la marge n'ecoute pas.** La
   correction serait un frein indexe sur `live_rule`, donc un
   durcissement.
10. **CORRIGE le 28 au soir.** La porte facturait `c_win` = 4,75 bps —
   le prix d'un take posé au carnet — à toute jambe suiveuse gagnante
   à l'horizon, alors qu'une cellule `suiv` sort au time-stop en
   taker à 7,0 (2,0 maker + 5,0 taker, `broker.py:54-55`). Écart
   **2,25 bps**, exact. `_cout_sortie` fait désormais payer
   `self.fee` au mode suiveur et laisse le mode fixe intact — là le
   moteur consulte bien son take. Reste à voir combien de cellules
   cessent de passer la barre. *Ancienne formulation :* `clock.py:1396-1398` charge `c_win` = 4,75 bps — le prix
   d'un take posé au carnet — à toute jambe suiveuse gagnante à
   l'horizon. Or une cellule `suiv` n'a pas de take (`engine.py:1913`)
   et sort au time-stop, donc en taker à 7,0 bps
   (`engine.py:1942`). Écart : **2,25 bps** par jambe concernée, soit
   un à deux points de base en moyenne. Le corriger *durcit* la
   porte. Ce qui manque pour le chiffrer : la part des fermetures au
   temps qui finissent gagnantes.
11. **La cadence de la cellule retenue.** 60 à 65 trades par jour,
   et le bandeau d'anomalies dit déjà que les frais dominent le
   brut. Le holdout annonce +4,6 bps par trade après coûts, le
   direct rend −6,0 : dix points de base d'écart à instruire avant
   de toucher à quoi que ce soit.
12. **Le retard sur la clôture de barre : répondu, et ce qui reste.**
   La question posée ici — chargement ou calcul ? — a sa réponse :
   `charge` 0,1-0,4 s, `calcul` 6,0-6,4 s. Le rechargement n'est plus
   le coût. Le total clôture → ordre vaut ~14 s sur la 1m contre 21-26
   avant, et la 5m est passée de 197 s à ~43. Ce qui reste ouvert est
   la **décision elle-même**, six secondes pour vingt noms — et elle
   n'a pas encore été instrumentée.
13. **Le profil chronologique du Sharpe** doit dire si l'avantage est
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

- **Une question posée sur « la prochaine lecture de cette cellule »
  n'est testable que si la cellule survit.** Le 29 août j'ai demandé si
  le net de la 5m continuerait de descendre ; la cellule avait été
  remplacée, et la question n'avait plus d'objet. Poser d'abord la
  question de la survie, ensuite celle de la valeur.
- **Une horloge dont la signature change à chaque cycle n'a pas de
  mesure en direct.** Mesuré le 29 août : 3m six changements sur sept
  transitions, contre zéro pour la 1m, la 15m et la 1H — et ce sont
  exactement les horloges instables qui produisent les aberrations.

- **Une pente bien estimée certifie l'étalonnage, pas l'ampleur.** Une
  pente à l'unité avec une erreur type minuscule dit que ce qui est
  annoncé l'est à la bonne échelle ; elle ne dit rien de la stabilité
  du net après coûts et prime de sélection. Le 29 août la pente a
  survécu (1,11±0,02 → 1,15±0,04) pendant que le net était divisé par
  trois sur la même cellule. Ne jamais faire cautionner une quantité
  par la précision d'une autre.
- **`gardee` préserve l'étiquette, pas le prédicteur.** Une cellule
  conservée par l'hystérésis est refit à chaque cycle : même
  signature, modèle différent. La rotation des signatures n'est donc
  pas une mesure suffisante de l'instabilité.

Elles ne se négocient pas, et elles ont toutes été écrites après avoir
été tentées :

- ne jamais remettre la mesure du direct à zéro pour faire disparaître
  un mauvais chiffre ;
- ne jamais toucher au barème du rodage pendant qu'on le mesure ;
- n'abaisser aucune porte, jamais — un carnet vide est un résultat
  honnête ;
- ne jamais conclure sur une fenêtre glissante de quelques dizaines de
  fermetures : elle décrit surtout le passé, et l'erreur a été commise
  **trois fois** en une nuit — une fois dans chaque sens. Seul le
  compteur cumulé (`live_rule` n et bps) tranche ;
- ne pas corriger la composition d'un livre dont l'espérance mesurée
  est négative à plusieurs écarts types : mieux répartir une perte
  reste une perte, et lever un frein sur un livre qui perd augmente la
  cadence de la perte. On cherche d'abord POURQUOI il perd ;
- un plan que je me suis écrit à moi-même une heure plus tôt n'est pas
  un ordre : quand la mesure nouvelle le contredit, c'est le plan qui
  cède, et il faut écrire pourquoi ;
- une mesure prise juste apres un redemarrage ne mesure pas le regime,
  elle mesure le redemarrage : le `calcul` du desk affichait 10,5 s a
  chaud et 7,7 s une heure plus tard, et j'avais impute l'ecart a mon
  propre code ;
- relire deux fois le meme echantillon ne le confirme pas : quand la
  fenetre d'attribution est identique au caractere pres, c'est qu'il
  ne s'est rien ferme, et le compteur attend toujours sa premiere
  confirmation ;
- un test qui affirme une tautologie est pire que pas de test : il
  donne la confiance sans la preuve. Toute contre-epreuve doit MORDRE,
  et si elle ne mord pas c'est le test qu'il faut renforcer, pas la
  contre-epreuve qu'il faut abandonner ;
- une moyenne sur trois cents instants se deplace de deux points de
  base par UNE SEULE jambe : toute tendance lue sur trois lectures
  consecutives de cette moyenne est a la merci du prochain accident, et
  la prudence de ne rien conclure vaut aussi quand le mouvement va dans
  le bon sens ;
- une quantite qui ne se lit nulle part ne sert a rien : ajouter une
  mesure au snapshot sans l'afficher, c'est refaire le defaut des
  `continue` muets sur son propre instrument — verifier l'affichage EN
  MEME TEMPS que la mesure, pas au releve suivant ;
- une dispersion ne s'emprunte pas a un compte qu'elle ne possede pas :
  diviser une somme de carres fraiche par un compteur cumule
  sous-estimait la variance d'un facteur dix-huit ;
- ne pas raccourcir l'historique pour retrouver un meilleur chiffre :
  choisir la fenêtre qui flatte est exactement le biais que la barre
  déflatée existe pour empêcher ;
- ne redéployer que pour un défaut identifié et nommé — chaque
  redémarrage interrompt la mesure, et c'est elle qui manque.
- déployer en `mode=code`, jamais en `mode=full`, pour un changement
  qui ne touche pas la recherche. Un déploiement complet lance une
  passe de recherche derrière lui et le moteur reste **arrêté**
  jusqu'à ce qu'elle finisse : mesuré le 27 août, **1 h 37 min** sans
  un seul trade (`hermes-research.service: Consumed 2h 50min CPU over
  1h 37min wall clock`), pour un changement qui n'en avait pas besoin.
  `mode=code` relance le moteur immédiatement.
