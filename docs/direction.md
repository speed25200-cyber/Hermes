# La direction d'Hermes — rapport de recherche

*Pré-inscription écrite le 5 septembre 2026, avant qu'un seul chiffre ne
soit sorti du banc. Les résultats seront ajoutés en dessous, bons ou
mauvais, sans retoucher cette partie.*

## La question

Le propriétaire demande : parmi les stratégies « à la mode » sur les
cinquante contrats les plus actifs d'OKX — profils optimisés du papier
*Top 100 movers x20*, microstructure (flux d'ordres agressif, CVD,
carnet), positionnement (intérêt ouvert, ratios long/short, funding),
volatilité, classement transversal — **lesquelles marchent, comment
Hermes doit être construit, et ce qu'il ne faut pas faire.**

Il demande aussi « une prédiction des marchés infaillible ». Ce point
est traité en fin de document, et il l'est franchement.

## Ce qui est mesuré, et comment

### Les données

Archives publiques Binance USDT-M, proxy des perpétuels OKX (l'engin
trade sur OKX ; les deux marchés sont arbitrés à la seconde, et les
signaux mesurés ici sont de l'échelle de l'heure ou plus) :

- klines 5 minutes **avec le volume acheteur agressif** (`taker_buy`).
  Le delta de flux `2·tb − v` est exact : c'est le CVD sans un seul tick.
  La classification de Lee-Ready n'a pas d'objet quand l'échange donne
  le côté agresseur — Binance et OKX le donnent tous deux.
- `metrics` 5 minutes : intérêt ouvert, ratio long/short des gros
  comptes, ratio long/short global, ratio volume taker achat/vente.
- taux de financement ; indice de prime (la base perpétuel/indice).
- 24 mois, 136 instruments : les 30 majeurs du banc, le top-50 OKX par
  volume du 5 septembre 2026, et les 100 movers du papier convertis.

Ce qui n'est **pas** utilisé, et pourquoi : les `aggTrades` (418 Mo par
mois pour BTC ; inutiles puisque les klines portent le flux) ; le
`bookDepth` (560 Ko par jour et par instrument : un échantillon sera
regardé pour la question de l'exécution, pas pour prédire).

### Les univers, causaux

Chaque jour, à partir des données jusqu'à la veille : **top-50 par
volume 24 h**, et **top-50 par variation absolue 24 h hors cinq plus
gros volumes** — la définition du papier, mais recalculée chaque jour.
Un trade ne compte que si le contrat était dans l'univers à l'instant du
signal. Un instrument n'entre qu'avec trente jours d'histoire.

Le papier utilise un instantané du 4 septembre projeté sur tout le
passé : ce sont des contrats sélectionnés *parce qu'ils ont bougé* —
biais de survie que le papier reconnaît lui-même page 8.

### Les hypothèses, déclarées

**H1 — le papier.** Ses 88 profils individuels, rejoués à l'identique
(régime 1 h EMA 50/200, tendance locale, DMI/ADX/RSI, déclencheur par
famille, qualité, sorties SL/TP/suivi/temps sur bougies 5 minutes) avec
funding et coûts par rotation :

- (a) sur leur propre contrat, toute la fenêtre — reproduit-on l'ordre
  de grandeur annoncé (69 % de gain, PF 1,52) ?
- (b) contre le hasard : la même règle, sur le même contrat privé de sa
  mémoire (blocs de six heures), et 20 répliques. Un profil optimisé
  sur son contrat qui ne bat pas ce nul n'a rien appris de ce contrat.
- (c) transportés sur les autres movers : un avantage réel survit au
  changement d'instrument ; un artefact d'optimisation ne survit pas.
- (d) le **profil global** — seule règle du papier non optimisée par
  symbole — sur l'univers causal des movers.

**H2 — le flux.** OFI (moyenne 24 h, z-score 96 bougies) en momentum et
en contrarien ; divergence et confirmation CVD/prix sur 24 h. Horizons
1 h, 4 h, 24 h, entrée à l'ouverture suivante, sortie à horizon fixe.

**H3 — le positionnement.** Variation d'intérêt ouvert croisée avec le
prix (les deux « squeezes » et le momentum d'OI) ; ratio taker et ratio
des gros comptes aux extrêmes (contrarien et momentum) ; funding
extrême ; base extrême. Mêmes horizons.

**H4 — la volatilité.** Cassure de Donchian 24 h filtrée par l'ATR ;
expansion d'ATR en momentum et en contrarien.

**H5 — le transversal.** Sur le top-50 volume, 10 longs / 10 courts,
rebalancement 24 h, classement par : OFI 24 h, rendement 24 h (momentum
et retour), variation d'OI, financement, ratio taker, base.

### Le juge

Le même que dans tout ce dépôt, et il est décrit dans `docs/juge.md` :

- **nul par blocs** : les bougies 30 min sont permutées par blocs de six
  heures (la structure intrabloc reste, la mémoire au-delà disparaît) ;
  le flux et les metrics sont permutés **indépendamment** du prix, sinon
  un signal intrajournalier survivrait au mélange des journées et
  battrait son nul pour rien ;
- **deux t** : brut (le signal existe-t-il ?) et net (est-il
  négociable ?) — une cellule sans effet rend déjà t ≈ −4 en net sur
  mille trades par le seul coût des exécutions ;
- **coûts** : 0,05 % par exécution, 0,01 % de glissement déclaré,
  funding accumulé sur la durée de détention ; en transversal, frais
  comptés sur la rotation réelle ;
- **test de famille** Westfall-Young (maxT) sur toute la grille H2–H5 :
  la meilleure cellule réelle contre la meilleure cellule de chaque
  réplique. C'est le seul chiffre qui autorise à parler d'avantage.

### Les règles de décision, écrites d'avance

1. Une cellule n'est **retenue** que si : t net > 2, percentile ≥ 95 de
   son nul, **et** la famille entière passe 95 %. Sinon rien n'est
   démontré, quel que soit l'éclat d'une case isolée.
2. Le papier est **crédité** si (a) reproduit l'ordre de grandeur, (b)
   bat 95 % du nul, et (c) garde un t net > 0 en transfert. S'il échoue
   à (b), ses 69 % sont la forme de la sortie (stop serré, cibles
   larges) et non un avantage — et le nul le montrera en produisant le
   même taux de gain.
3. Si la grille entière échoue au test de famille, **aucune** de ces
   stratégies n'entre dans Hermes, et la conclusion sera que la
   direction n'est pas là — pas qu'il faut chercher une septième famille
   sur les mêmes 24 mois.

Le banc est `deploy/banc_movers.js` ; son épreuve
`banc/epreuve_movers.js` vérifie que les indicateurs sont causaux, que
les sorties font ce qu'elles disent, que l'univers du jour ignore le
futur, qu'un effet planté est retrouvé, et **que le nul le détruit**.

---

*(Les résultats suivent, ajoutés après la mesure.)*
