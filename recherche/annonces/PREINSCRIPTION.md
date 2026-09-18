# Les annonces d'exchange — pré-inscription

*Écrite le 18 septembre 2026, avant qu'un seul chiffre ne soit sorti d'un
banc. Les résultats seront ajoutés en dessous, bons ou mauvais, sans
retoucher cette partie. Si l'hypothèse est réfutée, ce document reste au
dépôt avec sa réfutation : une porte fermée est un résultat.*

## La question

Deux campagnes ont fermé les portes du prix. `avantage.md` a mesuré que le
procédé de sélection ne trouve aucun avantage hors échantillon
(−0,0012 ± 0,0056 de marge par trade, t = −0,22) et qu'il réussit **mieux
sur des journées mélangées** que sur le vrai marché. `direction.md` a
étendu la mesure à 134 instruments, 24 mois, six familles de flux et de
positionnement, 52 cellules : aucune ne passe le test de famille.

La conclusion commune des deux est plus précise que « ça ne marche pas » :
**tout ce que contient la série des prix est arbitré avant nous.** Chercher
une famille de plus sur les mêmes données est explicitement interdit par la
règle 5 de `direction.md`.

D'où la seule question qui reste ouverte sans enfreindre cette règle :

> Existe-t-il, hors de la série des prix, une information **datée,
> publique, et textuelle** dont le marché met plus de temps à se saisir que
> nous n'en mettons à la lire ?

Une candidate, et une seule est traitée ici : **les annonces d'exchange**.
Binance annonce le lancement d'un perpétuel sur un jeton qu'OKX cote déjà ;
OKX annonce un délistage, une hausse de levier, une maintenance. Ces textes
sont horodatés à la seconde, publics, et ne sont dans aucune bougie au
moment où ils paraissent.

Ce n'est pas une idée neuve et ce n'est pas un secret : l'effet d'annonce
de listing est documenté, et il est disputé par des acteurs plus rapides
que nous. L'hypothèse n'est donc pas « personne ne le sait », mais « il
reste une traîne exploitable après la première seconde ». C'est cela qui
est mesuré.

## Le rôle de Jev, et ce qu'il n'est pas

Jev (TypeSafe, sorti le 15 septembre 2026) ne prédit pas une série : il rend
des jugements typés sur un état. Une annonce **est** un état. C'est le seul
endroit de ce dépôt où sa forme correspond à la question posée.

Il faut dire tout de suite ce qu'il n'apporte pas, sinon le crédit qu'on lui
donnera plus tard sera mal placé : **une expression régulière classe
correctement la grande majorité des annonces.** « Will Launch USDⓈ-M X
Perpetual » se reconnaît sans modèle. La part de Jev est ailleurs, et elle
est étroite :

1. les formulations ambiguës ou nouvelles, que la regex range en « autre » ;
2. l'identification de l'instrument concerné **dans notre univers**, quand
   le ticker de l'annonce ne correspond pas exactement au nôtre ;
3. une **probabilité** à la place d'un oui/non — c'est elle qui dimensionne.

Si la mesure montre que la regex seule fait aussi bien, ce sera écrit, et
Jev sortira du chemin. Ce serait un résultat, pas un échec.

## Les données

- **Annonces** : archives publiques Binance (API d'annonces) et OKX (centre
  de support), horodatées. Fenêtre : la plus longue disponible, et elle sera
  déclarée avec le premier chiffre.
- **Prix** : klines **1 minute** des perpétuels OKX autour de chaque
  annonce. Les 5 minutes du dépôt sont trop grossières ici : toute la
  question est la forme des premières minutes.
- **Univers** : causal. Un instrument ne compte que s'il était coté sur OKX
  à l'instant de l'annonce.

Le biais assumé et signalé : les archives d'annonces sont plus complètes
sur la période récente. Cela **favorise** l'hypothèse si l'effet a décru
avec le temps, et il faudra le regarder par sous-période.

## Les hypothèses, déclarées

**H1 — la réaction existe.** Rendement du perpétuel OKX sur l'instrument
nommé, à 5 min / 15 min / 1 h après l'annonce, par type d'événement
(`listing_perp`, `listing_spot`, `delisting`, `autre`). Brut et net de
frais (taker 0,05 %, glissement 0,01 % par exécution).

**H2 — elle est encore là quand nous arrivons.** Même mesure, mais l'entrée
est décalée du délai réel de la chaîne : lecture de l'annonce + appel Jev +
ordre OKX. Ce délai sera **mesuré, pas supposé**, et écrit avant de lire
H2.

**H3 — Jev ajoute quelque chose à la regex.** Trois bras sur les mêmes
événements : (a) regex seule, (b) Jev seul, (c) regex puis Jev sur les
seuls cas classés « autre ». Un seul appel par annonce, toutes les
questions ensemble — elles sont indépendantes et ne se voient pas.

### Les questions Jev, figées ici

Une seule formulation, écrite maintenant, et **elle ne sera pas retouchée
après avoir vu un chiffre**. Chaque reformulation serait un essai non
compté : c'est exactement le degré de liberté qui fabriquait des perles sur
des journées mélangées.

| id | type | ce qu'elle demande |
|---|---|---|
| `type` | choice | le type d'événement, parmi les quatre ci-dessus |
| `instrument` | choice | l'instrument de notre univers concerné, ou `aucun` |
| `haussier_1h` | noul | l'annonce est-elle matériellement haussière à 1 h pour cet instrument |

État fourni : le texte de l'annonce, son horodatage, la liste des
instruments de l'univers, et l'état de marché au moment T (spread, volume
1 h). Rien d'autre — en particulier **aucun rendement futur**, sous aucune
forme.

Le `noul` rend la probabilité de « oui » et n'a pas de confiance séparée.
Un `noul` à 0,50 veut dire « autant oui que non », pas « moyennement
haussier » : le seuil d'entrée ne sera donc jamais 0,50.

## Le juge

Les trois disciplines d'`avantage.md` et de `direction.md` s'appliquent
sans exception.

1. **Nul par permutation.** Les horodatages d'annonces sont permutés par
   blocs sur la même fenêtre, l'instrument nommé étant conservé. La
   distribution des rendements et les grappes de volatilité restent
   identiques ; seul le lien annonce → instant est détruit. Vingt
   répliques. `modules/juge.js` fournit `melangerParBlocs`,
   `distributionNulle` et `percentileDe` ; ils sont importés, jamais
   recopiés.
2. **Hors échantillon par le temps.** Les seuils, s'il y en a, sont choisis
   sur la première moitié de la fenêtre et mesurés sur la seconde.
3. **Test de famille (Westfall-Young, maxT).** La grille compte
   **12 cellules** (4 types × 3 horizons). À 5 %, on attend **0,6 cellule
   brillante par pur hasard** : une seule cellule à t > 2 ne prouve donc
   rien. Toutes les cellules sont imprimées, y compris les mauvaises.

## Les règles de décision, écrites d'avance

- **Règle 1 — une cellule est retenue** si : t net > 2, percentile ≥ 95 de
  son propre nul, ET la famille bat 95 % des maxima de répliques. Les trois,
  pas deux.
- **Règle 2 — Jev est crédité** si le bras (b) ou (c) bat le bras (a) sur
  la même grille, hors échantillon. Sinon la regex reste, et Jev sort.
- **Règle 3 — le délai décide, pas l'espérance.** Si H2 (entrée décalée du
  délai réel) annule ce que H1 montre, l'hypothèse est **close**, quelle que
  soit la beauté de H1. Une réaction qu'on ne peut pas atteindre n'est pas
  un avantage : c'est la mesure d'un avantage que d'autres ont.
- **Règle 4 — rien n'entre dans le moteur** tant que les règles 1 à 3 ne
  sont pas satisfaites. « Pas de perle = pas de trade » vaut ici aussi.

## Ce qui tuerait l'hypothèse, et qu'il faut regarder en premier

La **distribution du temps de réaction**. Si 90 % du mouvement est fait
dans les dix premières secondes, la course est perdue d'avance contre des
bots à expression régulière en quelques millisecondes, et notre chaîne —
lecture + Jev (70–500 ms annoncés, non vérifiés par nous) + OKX — arrive
après. S'il reste une traîne de plusieurs minutes, nous sommes dedans.

C'est donc la **première** mesure à sortir, avant toute espérance : la
courbe du rendement cumulé moyen par seconde après l'annonce, par type.
Elle décide s'il faut continuer.

## Ce qu'il ne faut pas faire ici

Les neuf points de `direction.md` restent valables. Trois s'appliquent
particulièrement :

1. **Ne pas régler les questions Jev après coup.** Elles sont ci-dessus.
2. **Ne pas lire un taux de gain comme une prédiction.** La forme des
   sorties fabrique 60–70 % de trades gagnants sur du bruit pur.
3. **Ne pas lire un verdict trop tôt.** Les annonces exploitables sont
   rares — peut-être quelques dizaines par an et par type. Un avantage
   mesuré sur douze événements n'est pas un avantage, c'est un tirage.

## À faire dès maintenant, sans rien décider

Enregistrer les annonces **avec horodatage à la milliseconde** et le prix
qui suit, en continu. C'est la donnée rare : les archives publiques
donnent la minute, rarement mieux, et le banc de l'an prochain vaudra ce
que vaut cette collecte. Elle n'engage aucune décision et ne coûte rien.

## Budget

Quelques centaines à quelques milliers d'appels Jev, un par annonce, à
0,042 $/MTok en entrée et 0 $ en sortie — de l'ordre du dollar pour toute
l'étude. Le coût n'est pas un argument, ni dans un sens ni dans l'autre.

## Le capital, pour mémoire

7,71 USDT, sous la taille minimale de la plupart des contrats OKX. Même une
hypothèse validée ne se traduirait pas en trades demain. L'ordre reste
celui de `direction.md` : le coupe-circuit journalier et l'exécution maker
d'abord, un avantage démontré ensuite, le capital en troisième.

---

## Résultats

*(vide — à remplir par la mesure, bons ou mauvais)*
