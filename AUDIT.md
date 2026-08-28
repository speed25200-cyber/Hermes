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
7. **Le livre joué n'est pas le livre validé.** La porte mesure un
   `panel[20]` ; le moteur tient **une à deux jambes** et occupe
   0,15 % de son plafond de notionnel. Huit ouvertures d'affilée sur
   le seul SOL entre 08h46 et 09h35. Compter les jambes proposées
   contre les jambes ouvertes, et la raison des refus, est la
   prochaine mesure — pas encore faite.
8. **La cadence de la cellule retenue.** 60 à 65 trades par jour,
   et le bandeau d'anomalies dit déjà que les frais dominent le
   brut. Le holdout annonce +4,6 bps par trade après coûts, le
   direct rend −6,0 : dix points de base d'écart à instruire avant
   de toucher à quoi que ce soit.
9. **Le retard sur la clôture de barre : répondu, et ce qui reste.**
   La question posée ici — chargement ou calcul ? — a sa réponse :
   `charge` 0,1-0,4 s, `calcul` 6,0-6,4 s. Le rechargement n'est plus
   le coût. Le total clôture → ordre vaut ~14 s sur la 1m contre 21-26
   avant, et la 5m est passée de 197 s à ~43. Ce qui reste ouvert est
   la **décision elle-même**, six secondes pour vingt noms — et elle
   n'a pas encore été instrumentée.
10. **Le profil chronologique du Sharpe** doit dire si l'avantage est
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
- déployer en `mode=code`, jamais en `mode=full`, pour un changement
  qui ne touche pas la recherche. Un déploiement complet lance une
  passe de recherche derrière lui et le moteur reste **arrêté**
  jusqu'à ce qu'elle finisse : mesuré le 27 août, **1 h 37 min** sans
  un seul trade (`hermes-research.service: Consumed 2h 50min CPU over
  1h 37min wall clock`), pour un changement qui n'en avait pas besoin.
  `mode=code` relance le moteur immédiatement.
