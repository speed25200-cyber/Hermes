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

## Résultats — mesure du 2026-09-05

Fenêtre 2024-08-31 → 2026-08-31. 134 instruments avec histoire, dont 134 avec le flux acheteur (klines v2), 134 avec les metrics, 134 avec la base. Frais 0.05 % et glissement 0.01 % par exécution, funding accumulé. 20 répliques, blocs de 12 bougies de 30 min. Durée 217 s.

### H1 — le papier « Top 100 movers x20 »

| Mesure | 88 profils, leur contrat | Profil global, movers causaux | 88 profils transportés |
|---|---|---|---|
| trades | 6572 | 1904 | 525304 |
| taux de gain | 73.5 % | 68.2 % | 69.1 % |
| profit factor | 1.35 | 1.00 | 1.00 |
| brut / trade | 0.236 % | 0.111 % | 0.108 % |
| net / trade | 0.126 % | 0.001 % | -0.002 % |
| t brut / t net | 17.53 / 9.36 | 4.37 / 0.05 | 75.72 / -1.43 |
| percentile du nul (t net) | 100e | 10e | — |

Le papier annonce 69,25 % de gain et un PF médian de 1,52 en OOS. Ici, sur toute la fenêtre : WR 73.5 %, PF 1.35. Le nul — mêmes règles, mêmes contrats privés de leur mémoire — donne un taux de gain médian de **69.0 %** et un PF médian de **1.03**. Le hasard produit le même taux de gain : c'est la forme des sorties (stop à 1,25 %, cibles à 2–8 %) qui le fabrique, pas la prédiction.

Par famille, sur leur propre contrat :

| famille | trades | WR | PF | net / trade | t brut | t net |
|---|---|---|---|---|---|---|
| breakout | 3125 | 71.8 % | 1.23 | 0.089 % | 10.06 | 4.50 |
| momentum | 1109 | 77.7 % | 1.55 | 0.165 % | 8.76 | 5.24 |
| pullback | 1416 | 75.0 % | 1.55 | 0.183 % | 10.32 | 6.44 |
| reversion | 115 | 67.0 % | 1.09 | 0.038 % | 1.52 | 0.39 |
| hybrid | 807 | 72.9 % | 1.35 | 0.130 % | 5.94 | 3.22 |

Sorties : trail 4808, sl 1717, tp 19, temps 28.

Sur 84 profils rejouables (≥ 5 trades ici), 69 ont un net positif sur toute la fenêtre. Le papier en donnait 65 à PF > 1 sur son OOS.

### H2–H5 — flux, positionnement, volatilité, transversal

Toutes les cellules, y compris les mauvaises. Percentile : le t net réel dans la distribution des t nets des répliques.

| cellule | trades / périodes | WR | brut / trade | net / trade | t brut | t net | nul médian | percentile |
|---|---|---|---|---|---|---|---|---|
| xs_dOI@24h | 697 | — | 0.116 % | 0.023 % | 1.57 | 0.30 | -1.54 | 95e |
| atr_expansion_con@24h | 11161 | 50.9 % | 0.121 % | 0.004 % | 1.22 | 0.04 | -0.90 | 75e |
| xs_retour24_rev@24h | 697 | — | 0.082 % | -0.010 % | 0.98 | -0.12 | -1.88 | 100e |
| ofi_momentum@24h | 18737 | 49.2 % | 0.117 % | -0.006 % | 2.24 | -0.12 | -2.86 | 100e |
| financement_contr@24h | 5471 | 47.3 % | -0.146 % | -0.089 % | -1.06 | -0.64 | 0.16 | 20e |
| squeeze_court@24h | 15547 | 46.1 % | 0.057 % | -0.047 % | 0.79 | -0.65 | -0.08 | 5e |
| xs_ofi24@24h | 697 | — | -0.007 % | -0.094 % | -0.11 | -1.45 | -1.79 | 70e |
| xs_financement@24h | 697 | — | -0.041 % | -0.108 % | -0.65 | -1.73 | -1.80 | 60e |
| cvd_confirmation@24h | 19277 | 48.2 % | 0.001 % | -0.121 % | 0.01 | -1.99 | -2.71 | 90e |
| xs_retour24_mom@24h | 697 | — | -0.082 % | -0.173 % | -0.98 | -2.08 | -1.47 | 40e |
| xs_base@24h | 697 | — | -0.067 % | -0.145 % | -0.97 | -2.10 | -1.55 | 30e |
| taker_contrarien@24h | 23840 | 51.3 % | 0.019 % | -0.104 % | 0.42 | -2.35 | -4.62 | 100e |
| atr_expansion_mom@24h | 11161 | 46.7 % | -0.121 % | -0.244 % | -1.22 | -2.46 | -2.65 | 65e |
| gros_comptes_contr@24h | 17697 | 49.9 % | -0.038 % | -0.150 % | -0.68 | -2.68 | -2.35 | 50e |
| breakout_donchian@24h | 22992 | 47.0 % | -0.036 % | -0.158 % | -0.64 | -2.81 | -3.67 | 90e |
| cvd_divergence@24h | 24182 | 51.0 % | -0.025 % | -0.141 % | -0.50 | -2.82 | -1.88 | 5e |
| squeeze_long@24h | 16638 | 52.9 % | -0.078 % | -0.210 % | -1.05 | -2.83 | -3.95 | 100e |
| financement_contr@4h | 15456 | 47.2 % | -0.016 % | -0.103 % | -0.45 | -2.87 | -4.48 | 90e |
| taker_momentum@24h | 23840 | 46.1 % | -0.019 % | -0.136 % | -0.42 | -3.05 | -1.09 | 0e |
| xs_taker@24h | 697 | — | -0.066 % | -0.162 % | -1.31 | -3.25 | -1.61 | 10e |
| oi_momentum@24h | 21823 | 47.0 % | -0.078 % | -0.200 % | -1.28 | -3.31 | -4.04 | 75e |
| atr_expansion_mom@4h | 24592 | 46.3 % | 0.011 % | -0.110 % | 0.36 | -3.75 | -6.49 | 100e |
| base_contrarien@24h | 22527 | 48.8 % | -0.087 % | -0.196 % | -1.76 | -3.96 | -2.89 | 20e |
| atr_expansion_con@4h | 24592 | 48.3 % | -0.011 % | -0.130 % | -0.36 | -4.43 | -2.65 | 5e |
| ofi_contrarien@24h | 18737 | 48.1 % | -0.117 % | -0.234 % | -2.24 | -4.46 | -2.32 | 0e |
| cvd_confirmation@4h | 39467 | 44.9 % | 0.024 % | -0.097 % | 1.28 | -5.23 | -7.13 | 100e |
| squeeze_court@4h | 28852 | 46.7 % | -0.018 % | -0.134 % | -0.75 | -5.63 | -4.62 | 5e |
| oi_momentum@4h | 53827 | 46.2 % | 0.021 % | -0.100 % | 1.20 | -5.80 | -14.14 | 100e |
| squeeze_long@4h | 32609 | 50.4 % | -0.029 % | -0.151 % | -1.21 | -6.35 | -9.87 | 100e |
| base_contrarien@4h | 52845 | 47.4 % | 0.019 % | -0.098 % | 1.34 | -6.77 | -10.53 | 100e |
| breakout_donchian@4h | 48358 | 43.6 % | -0.016 % | -0.137 % | -0.97 | -8.04 | -11.68 | 100e |
| ofi_contrarien@4h | 45279 | 47.1 % | 0.004 % | -0.116 % | 0.27 | -8.32 | -9.47 | 90e |
| taker_contrarien@4h | 55514 | 47.9 % | 0.018 % | -0.102 % | 1.58 | -8.84 | -11.57 | 100e |
| ofi_momentum@4h | 45279 | 45.7 % | -0.004 % | -0.124 % | -0.27 | -8.96 | -9.90 | 85e |
| gros_comptes_contr@4h | 45941 | 46.8 % | -0.027 % | -0.145 % | -1.76 | -9.49 | -7.15 | 0e |
| atr_expansion_mom@1h | 71528 | 43.9 % | 0.020 % | -0.100 % | 2.07 | -10.10 | -15.85 | 100e |
| cvd_divergence@4h | 57137 | 49.1 % | -0.041 % | -0.160 % | -2.90 | -11.35 | -7.43 | 0e |
| taker_momentum@4h | 55514 | 44.1 % | -0.018 % | -0.138 % | -1.58 | -11.97 | -9.34 | 5e |
| financement_contr@1h | 57368 | 43.6 % | -0.008 % | -0.120 % | -0.85 | -12.99 | -20.28 | 100e |
| squeeze_court@1h | 59391 | 45.6 % | -0.009 % | -0.128 % | -1.01 | -13.93 | -19.81 | 100e |
| atr_expansion_con@1h | 71528 | 46.0 % | -0.020 % | -0.140 % | -2.07 | -14.18 | -11.37 | 0e |
| squeeze_long@1h | 71525 | 48.1 % | -0.001 % | -0.122 % | -0.12 | -14.25 | -24.89 | 100e |
| cvd_confirmation@1h | 67319 | 40.6 % | -0.005 % | -0.126 % | -0.65 | -14.97 | -14.00 | 10e |
| breakout_donchian@1h | 72625 | 41.2 % | -0.009 % | -0.129 % | -1.05 | -15.10 | -22.78 | 100e |
| base_contrarien@1h | 74702 | 44.0 % | -0.005 % | -0.124 % | -0.70 | -17.00 | -25.09 | 100e |
| oi_momentum@1h | 128978 | 43.6 % | 0.004 % | -0.116 % | 0.67 | -18.45 | -38.27 | 100e |
| cvd_divergence@1h | 99540 | 47.0 % | -0.007 % | -0.127 % | -1.20 | -21.40 | -22.18 | 75e |
| taker_contrarien@1h | 72752 | 43.5 % | 0.009 % | -0.111 % | 1.79 | -22.84 | -24.24 | 90e |
| ofi_contrarien@1h | 119476 | 43.9 % | 0.008 % | -0.111 % | 1.99 | -26.03 | -31.08 | 100e |
| taker_momentum@1h | 72752 | 40.7 % | -0.009 % | -0.129 % | -1.79 | -26.40 | -23.53 | 0e |
| gros_comptes_contr@1h | 129919 | 43.2 % | -0.006 % | -0.126 % | -1.29 | -26.50 | -22.20 | 0e |
| ofi_momentum@1h | 119476 | 41.4 % | -0.008 % | -0.129 % | -1.99 | -30.08 | -30.80 | 70e |

**Test de famille (Westfall-Young, maxT, 52 cellules)** : meilleure cellule réelle xs_dOI@24h, t 0.3 ; médiane des maxima des répliques 0.72 ; le meilleur t réel bat **30 %** des maxima de répliques. Sous le seuil de 95 % : rien n'est démontré au niveau de la famille.

### Application des règles écrites d'avance

- Règle 1 (cellule retenue : t net > 2, percentile ≥ 95, famille ≥ 95 %) : **aucune cellule retenue**.
- Règle 2 (le papier) : (a) ordre de grandeur reproduit — oui (WR 73.5 %, PF 1.35) ; (b) bat 95 % du nul — oui (100e) ; (c) t net > 0 en transfert — non (-1.43). **Le papier n'est pas crédité.**
- Règle 3 : **la grille échoue au test de famille : aucune de ces stratégies n'entre dans Hermes.**

### Lecture — pourquoi t = 9,36 n'est pas une preuve, et ce qui l'est

La première colonne du tableau H1 paraît écrasante : 88 profils, 6572
trades, t net 9,36, 100e percentile du nul. Elle ne prouve rien, et il
faut dire précisément pourquoi.

**La fenêtre de mesure contient la fenêtre d'entraînement du papier.**
Le papier découpe l'histoire de chaque contrat en 60 % entraînement,
20 % validation, 20 % hors échantillon, et choisit famille, indicateurs,
seuils et sorties sur les 80 premiers pour cent (page 5). Nos 24 mois
(2024-08-31 → 2026-08-31) couvrent la quasi-totalité de l'histoire de la
plupart de ces contrats : quand on rejoue un profil sur son propre
contrat, on le rejoue à 80 % sur les données qui l'ont fabriqué. Un
profil optimisé sur une série y gagne par construction. Le nul par
blocs ne corrige pas cela : il détruit la mémoire du marché, pas la
mémoire du profil, qui a été choisi *parce que* ces règles gagnaient sur
ces bougies-là. La colonne « leur contrat » mesure donc l'ajustement,
pas la prédiction. Un test propre exigerait de rejouer chaque profil sur
ses seuls 20 % finaux — 11 trades médians par contrat, ce qui ne
distingue rien — ou d'attendre des mois de données que personne n'a
encore vues.

**Les deux colonnes qui n'ont pas ce défaut disent zéro.** Le profil
global appliqué aux movers *causaux* du jour — les contrats qui, ce
jour-là, avaient le plus bougé sur 24 h, sans regarder l'avenir — fait
1904 trades pour 0,001 % net par trade, t 0,05, 10e percentile de son
nul. Les 88 profils transportés sur les autres movers — mêmes règles,
mêmes sorties, autre contrat — font 525 304 trades pour −0,002 % net,
t −1,43. Le t brut de 75,7 sur cette colonne dit seulement que la forme
des sorties (stop serré, cibles larges, trail) produit une espérance
brute positive de 0,108 % par trade sur du bruit, systématiquement ;
les 0,11 % de coûts la mangent entièrement. Ce que les profils savent
n'est pas transportable : c'est la signature d'un ajustement.

**Le nul reproduit le taux de gain du papier.** 69,0 % de trades
gagnants et un PF de 1,03 sur des contrats privés de leur mémoire. Le
papier annonce 69,25 %. Le taux de gain est fabriqué par la géométrie
des sorties — 4808 sorties sur trail contre 19 sur cible — et ne dit
rien de la prédiction. Le seul chiffre à regarder est l'espérance nette
par trade, comparée au nul ; sur les deux tests honnêtes, elle vaut zéro.

**Les 52 cellules de flux et de positionnement ne montrent rien.** Les
cellules à 1 h et 4 h sont toutes négatives après coûts, souvent à
t < −5 : à ces horizons, l'espérance brute d'un signal de carnet ou de
flux (OFI, CVD, taker, OI, base, squeeze, Donchian, expansion d'ATR) est
comprise entre −0,04 % et +0,02 % par trade, pour 0,11 % de coûts. À
24 h, aucune cellule n'a un t net supérieur à 0,3 ; la meilleure
(classement transversal par variation d'intérêt ouvert, 697 périodes)
bat 30 % des maxima des répliques. C'est exactement ce qu'on attend
d'une grille de 52 essais sur du bruit.

**Ce que la mesure complète a corrigé.** Une première passe, faite
avec les metrics de 56 instruments sur 134, montrait trois cellules
transversales à t 0,8–0,9 sur 118 périodes (dOI, base, taker) et un test
de famille à 55 %. Avec les 134 instruments et 697 périodes, ces trois
cellules tombent à t 0,30, −2,10 et −3,25. Les cellules qui
frémissaient étaient celles qui avaient le moins de données : c'est la
signature du bruit, et la raison pour laquelle ce document n'a écrit
aucun verdict avant que la mesure soit complète. Les cellules qui ne
dépendent pas des metrics (flux, volatilité, Donchian) n'ont bougé que
de quelques centièmes de t entre les deux passes : ce qui a changé,
c'est uniquement ce qui manquait de données.

**Ce que dit la famille breakout/momentum/pullback à t 4–6 sur leur
contrat.** Ces familles sont celles que le papier a le plus optimisées
(77 des 88 profils). Que leurs t soient les plus hauts *dans la fenêtre
d'ajustement* et que la même famille transportée fasse t −1,43 est la
preuve la plus directe qu'il s'agit de l'ajustement.

**Verdict, par les règles écrites avant la mesure.** Aucune cellule
retenue (règle 1). Le papier reproduit son ordre de grandeur et bat son
nul dans sa fenêtre, mais échoue au transfert : non crédité (règle 2).
La grille échoue au test de famille : rien de tout cela n'entre dans
Hermes, et la conclusion est que la direction n'est pas là (règle 3) —
pas qu'il faut une septième famille sur les mêmes 24 mois.

## L'exécution : ce qu'elle peut et ne peut pas

« Une exécution parfaite qui permet d'amortir les retournements » mélange
deux choses qu'il faut séparer, parce qu'elles n'ont pas le même
remède.

**Ce que l'exécution peut faire : réduire un coût.** Sur OKX, un ordre
taker coûte 0,05 % de notionnel, un ordre maker 0,02 %. Un aller-retour
taker coûte donc 0,10 %, maker 0,04 % — 0,06 % d'écart par trade, soit
0,9 % de marge par trade au levier 15. Le journal du moteur dit où l'on
en est : **douze entrées, zéro en maker**, parce que la limite post-only
ne se remplissait pas en cinq secondes ou était refusée pour une taille
mal arrondie (corrigé le 2 septembre, sous interrupteur). Passer les
deux jambes en maker est le seul chantier d'exécution qui change un
chiffre, et il change celui-là : il divise le coût par 2,5. Il ne
change rien à l'avantage brut.

**Ce que l'exécution ne peut pas faire : créer un avantage.** Le rapport
`avantage.md` l'a mesuré : l'avantage brut des stratégies du dépôt vaut
zéro (−0,0012 ± 0,0056 de marge par trade, t = −0,22). Les frais étant
soustractifs, un système à brut nul rapporte zéro même à frais nuls.
Aucune qualité d'exécution ne remonte ce zéro. C'est de l'arithmétique.

**« Amortir les retournements » n'est pas de l'exécution, c'est du
dimensionnement.** Le papier x20 le montre malgré lui, page 7 : cinq
stops simultanés font −13,5 % du capital avant même qu'un retournement
ait commencé. À x20 avec un stop à 1,25 %, un mouvement adverse de 1,25 %
— une bougie ordinaire sur un mover — coûte 25 % de la marge engagée.
Ce qui protège d'un retournement, ce n'est pas d'anticiper la bougie,
c'est que la perte maximale d'une journée soit bornée par la taille des
positions et leur nombre. Hermes a ces garde-fous (`HERMES_MAX_RISK_PCT`,
`HERMES_MAX_POSITIONS`) ; ils valent plus que n'importe quel signal, et
c'est eux qu'un scénario catastrophe teste.

**À l'échelle actuelle, la question ne se pose pas.** Avec 7,71 USDT
d'équité, une position vaut 52 USDT de notionnel et une exécution coûte
2,6 centimes. Le carnet d'un mover absorbe cela sans bouger d'un tick.
La profondeur ne devient un sujet qu'à partir de quelques milliers de
dollars par ordre sur les alts illiquides — et là, l'échantillon
`bookDepth` de Binance (560 Ko par jour et par contrat) permettra de le
mesurer le jour où ce sera la question.

## Sur la « prédiction infaillible long et short »

Elle n'existe pas, et il faut le dire avant de dire quoi que ce soit
d'autre, parce que toute la suite en dépend.

**Ce que « infaillible » demanderait.** Un taux de gain proche de 100 %
sur des sorties symétriques. Ce que les meilleurs systèmes documentés
obtiennent, avec des sorties symétriques et après frais, c'est 52 à
56 % — et ils en vivent parce qu'ils jouent des milliers de fois. Les
69 % du papier ne sont pas un taux de prédiction : avec un stop à 1,25 %
et des cibles à 2–8 %, la *forme* des sorties fabrique un taux de gain
élevé quelle que soit la prédiction, et une stratégie qui tire au sort
son sens obtient un taux du même ordre. Le banc le vérifie (section
« le papier contre le hasard ») ; le seul chiffre qui dit si l'on
prédit quelque chose est l'espérance par trade **brute**, comparée au nul.

**Pourquoi c'est structurel et non un manque d'effort.** Un marché où
l'on prédirait le sens de la prochaine heure avec, disons, 70 % de
fiabilité serait arbitré en quelques jours par les acteurs qui voient
le carnet tick par tick et paient des frais dix fois plus faibles. Ce
qui reste pour un moteur sur bougies fermées, c'est ce que ces acteurs
ne peuvent ou ne veulent pas porter : du risque tenu longtemps (des
jours), sur des primes lentes (funding, base, portage), avec des
avantages par trade petits devant le bruit — que l'on ne peut donc
valider qu'en années, comme `avantage.md` l'a calculé (214 périodes de
72 h, mi-2028, pour la seule hypothèse pré-inscrite).

**Ce que « prédire les retournements » veut vraiment dire pour Hermes.**
Pas anticiper le point de bascule : personne ne le fait de façon
répétable. Mais (1) ne pas être en position dans le mauvais sens avec
une taille qui ne survivrait pas au mouvement — dimensionnement ; (2) ne
pas tenir une stratégie de continuation quand le régime a changé —
c'est ce que `modules/regime.js` mesure, et le banc du régime a montré
qu'il fonctionne sur les stratégies de tendance et pas sur celles de
retour à la moyenne ; (3) avoir un coupe-circuit journalier qui bloque
les nouvelles entrées après une perte donnée — le papier le recommande
page 7, Hermes n'en a pas encore un explicite.

Ce que ce document peut promettre, c'est une mesure honnête de ce qui
marche. Ce qu'il ne promettra jamais, c'est l'infaillibilité — et un
document qui la promettrait devrait être jeté.

## Ce qu'il ne faut pas faire — établi par les mesures de ce dépôt

Chaque point ci-dessous a été **mesuré** ici, pas seulement lu ailleurs.

1. **Optimiser par symbole.** Le papier a 88 profils pour 88 contrats,
   onze trades OOS médians chacun. Douze mois de mesures du chercheur de
   perles ont montré que ce procédé trouve autant de « perles » sur des
   données mélangées que sur le vrai marché — et qu'elles y rapportent
   davantage. Un profil par contrat est un degré de liberté par contrat ;
   le hasard en remplit toujours quelques-uns.

2. **Choisir l'univers après coup.** Un instantané de « movers » du
   4 septembre projeté sur deux ans sélectionne les contrats *parce
   qu'ils ont bougé*. Le banc de largeur l'a chiffré sur le financement :
   +0,133 de sharpe sur trente noms choisis, −0,027 sur trente noms
   tirés au sort dans le même univers. Le choix des noms est un essai non
   compté.

3. **Lire un taux de gain comme une prédiction.** Avec un stop à 1,25 %
   et des cibles à 2–8 %, la forme des sorties fabrique 60–70 % de trades
   gagnants sur du bruit pur. La seule question est l'espérance par
   trade brute, comparée au nul.

4. **Lire un verdict trop tôt.** Un avantage de la taille de ceux que
   l'on trouve ici (sharpe par période ~0,1) demande deux ans pour être
   distingué du bruit à t = 2. Trois mois de beaux chiffres sont trois
   mois de bruit.

5. **Chercher une famille de plus sur les mêmes vingt-quatre mois.** Six
   familles ont été essayées et réfutées ; chaque essai supplémentaire
   sur les mêmes données augmente la probabilité d'un faux positif et
   diminue la valeur de tout ce qui a été trouvé.

6. **Confondre exécution et avantage.** L'exécution réduit un coût
   (0,10 % → 0,04 % l'aller-retour en maker). Elle ne remonte pas un
   brut nul.

7. **Trader à x20 avec un stop à 1,25 % sans coupe-circuit journalier.**
   Le papier le calcule lui-même : cinq stops font −13,5 % du capital.
   Hermes n'a pas de limite de perte journalière explicite ; c'est un
   garde-fou à construire avant tout signal.

8. **Faire tourner deux moteurs sur un compte.** Le 5 septembre, un
   second moteur déployé par une autre session a effacé les clés, le
   roster et l'état du premier. Un compte, un moteur, un déploiement
   maîtrisé.

9. **Passer des secrets en entrées de workflow.** Le runner les imprime
   avant tout masque ; le mot de passe root a figuré en clair dans 450
   journaux. Les secrets vont dans les *secrets* du dépôt.

## Comment Hermes doit être construit — ce qui découle de tout cela

Deux campagnes de mesure (`avantage.md`, et celle-ci) ont testé, sur
30 puis 134 instruments et jusqu'à 24 mois, les stratégies du dépôt, le
financement transversal, six familles de flux et de positionnement, et
les 100 profils d'un papier extérieur. Rien n'a battu son nul au niveau
de la famille. La direction d'Hermes ne peut donc pas être « ajouter le
signal qui marche » : il n'y en a pas de démontré. Elle est celle-ci.

- **Un juge avant un signal — c'est fait, et c'est l'actif principal.**
  Le nul par blocs, le test de famille Westfall-Young, le relevé hors
  échantillon, les épreuves qui vérifient qu'un effet planté est
  retrouvé et que le nul le détruit (`modules/juge.js`,
  `deploy/banc_movers.js`, `banc/`). Rien n'entre sans passer ce juge.
  Un moteur qui possède cette chaîne et zéro stratégie vaut plus qu'un
  moteur qui a dix stratégies et pas de chaîne : le premier saura
  reconnaître un avantage le jour où il en verra un, le second perdra
  de l'argent sur les dix.

- **Le risque avant la prédiction.** Taille par position bornée par le
  capital (`HERMES_MAX_RISK_PCT`), nombre de positions borné
  (`HERMES_MAX_POSITIONS`), régime de marché pour couper les stratégies
  de tendance quand il change (`modules/regime.js`, mesuré efficace sur
  celles-là et pas sur le retour à la moyenne). **À ajouter : un
  coupe-circuit journalier** — plus d'entrée après une perte de X % du
  capital dans la journée — parce que c'est le seul garde-fou qui borne
  un scénario catastrophe et qu'Hermes n'en a pas d'explicite. C'est le
  premier chantier de code, avant tout signal.

- **L'exécution en maker sur les deux jambes.** Le seul chantier
  d'exécution qui change un chiffre : 0,10 % → 0,04 % l'aller-retour, ce
  qui rend positive une espérance brute de 0,05–0,10 % par trade que le
  taker rend nulle. Le journal montre zéro remplissage maker sur douze
  entrées ; l'arrondi de taille est corrigé sous interrupteur
  (`HERMES_TAILLE_EXACTE`), le délai de remplissage reste à revoir. Sans
  cela, aucun avantage petit ne survit, et les avantages sont petits.

- **Des primes lentes, mesurées longtemps, plutôt que des bougies
  rapides.** Toutes les cellules à 1 h et 4 h sont négatives, et à
  24 h aucune ne dépasse t 0,3 une fois les données complètes. Le
  financement transversal reste l'hypothèse pré-inscrite
  (`avantage.md`, verdict mi-2028). On ne la remplace pas ; on attend
  qu'elle ait le nombre de périodes qu'il lui faut, et on ne lit pas le
  compteur entre-temps.

- **Pas de trading réel sur ce qui n'a pas passé le juge.** « Pas de
  perle = pas de trade » reste la règle, et aujourd'hui il n'y a pas de
  perle. Le capital (7,71 USDT) est de toute façon en dessous de la
  taille minimale de la plupart des contrats ; la question du réel se
  posera avec un capital et une hypothèse validée, dans cet ordre.

- **Un seul chemin de données, un seul chemin de déploiement.** Les
  archives publiques Binance sont la source d'histoire (klines 30 min
  avec flux acheteur, metrics journalières, prime) ; le workflow est le
  seul chemin vers la machine ; les secrets vont dans les secrets du
  dépôt et jamais dans une entrée de workflow ; un compte, un moteur.

- **Ce qui serait un vrai pas en avant, et qui n'est pas dans ce
  dépôt.** Des données que personne n'a exploitées à cette échelle :
  le carnet (`bookDepth`, 560 Ko/jour/contrat depuis 2023) et les
  transactions agrégées (418 Mo/mois pour BTC), pour mesurer la
  microstructure vraie — pas ses proxys sur bougies. C'est un
  chantier de données de plusieurs semaines, à ouvrir seulement avec
  une hypothèse écrite d'avance et une nouvelle fenêtre de temps, pas
  les 24 mois déjà usés.

**En une phrase.** Hermes est aujourd'hui un instrument de mesure
honnête posé sur un compte réel, sans avantage démontré à exploiter ;
sa direction est de rester honnête, de borner le risque, de rendre
l'exécution la moins chère possible, et d'attendre la mesure — pas de
promettre une prédiction que personne ne possède.

