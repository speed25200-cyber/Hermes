# Hermes — candidat carry market-neutral

## Statut

Ce moteur est un **candidat de recherche inerte**. Il ne contient aucun client
réseau et ne place aucun ordre. Dans cette version,
`ATOMIC_EXECUTOR_IMPLEMENTED` vaut explicitement `false` : même avec une preuve
et un roster valides, le résultat reste `SHADOW_ONLY`, `authorizedForLive` reste
faux et la liste exécutable `legs` reste vide. Une future proposition ne pourra
obtenir `READY_FOR_ORCHESTRATOR` qu'après l'ajout et l'audit d'un exécuteur
atomique deux jambes, modification qui changera le hash moteur, et si les trois
autres conditions suivantes sont vraies :

1. l'opportunité reste positive après frais, spread, slippage, impact,
   financement et stress de funding ;
2. son sizing respecte les limites de liquidité, inventaire, collatéral,
   concentration et delta résiduel ;
3. la garde live globale a validé la preuve signée et son `rosterSha256`
   correspond au roster contenant exactement l'identifiant, les jambes et le
   hash de configuration du candidat.

Le moteur ne garantit pas un profit. Son rôle est de transformer une hypothèse
de carry en décision testable et fail-closed. La preuve OOS, les stress de
portefeuille, le shadow trading et le canary restent obligatoires.

## Thèse économique

Deux constructions sont évaluées, dans les deux orientations autorisées :

- spot/perp : spot long + perp short lorsque les longs paient un funding
  suffisamment élevé ; perp long + spot short uniquement si l'emprunt est
  réellement disponible et si son coût est inclus ;
- perp/perp : perp au funding faible long + perp au funding élevé short, sur le
  même sous-jacent et deux marchés réellement distincts.

Les deux jambes portent la même quantité de sous-jacent après arrondi aux lots.
L'espérance combine le funding prévu et une fraction bornée de convergence de
basis. Le coût retranche deux exécutions sur chaque jambe, le spread traversé,
le slippage, l'impact, l'emprunt spot et une charge de capital conservatrice.
Le scénario stressé réduit le funding favorable à 35 %, conserve intégralement
les coûts et amplifie les composantes adverses.

La prévision de funding utilise seulement les observations antérieures à
`asOfMs` : EWMA winsorisée, rétrécie par la persistance du signe. Une série trop
courte ou périmée invalide le candidat au lieu d'inventer une valeur.

## Univers top 30 movers OKX, point-in-time

`selectPointInTimeMovers()` classe le rendement absolu observé sur les 24 heures
qui précèdent un cutoff explicite. Le classement contient donc les plus fortes
hausses **et** baisses, avec `topN: 30`. Avant classement, il exige :

- source de marché `OKX`, observation et prix non futurs et encore frais ;
- catégorie crypto `instCategory: 1`, état `live`, règle `normal` et type
  d'instrument `SPOT` ou `SWAP` ;
- actif coté depuis au moins 90 jours ;
- au moins 20 observations passées sur 30 jours : volume et profondeur médians,
  spread médian et p95, en plus du snapshot courant vieux de moins de 2 s ;
- au moins une paire de jambes réellement hedgeable.

Les points postérieurs au cutoff sont filtrés avant tout calcul et ne sont pas
recopiés dans le résultat. Les tests ajoutent un choc futur extrême et vérifient
que la sélection reste strictement identique.

Si le nombre d'actifs conformes est inférieur au `topN` configuré (30 en
production), `accepted` reste faux et la génération autonome retourne zéro
candidat : elle ne relâche jamais silencieusement les filtres.

Le top movers est un **univers de recherche**, pas un signal de direction : le
carry est classé sur son économie nette et conserve une exposition delta-neutre.
Le roster est reconstruit chaque heure, comme le sélecteur canonique utilisé par
l'exécution et par la validation quantitative.

## API pure destinée à l'orchestrateur

Le module `modules/carry_strategy.js` exporte notamment :

- `selectPointInTimeMovers({ assets, asOfMs, config })` ;
- `generateCarryConfigurationSpace({ baseConfig, grid })` : grille déterministe,
  dédupliquée, bornée à 27 configurations par défaut et 100 au maximum ;
- `enumerateCarryCandidates({ asset, legs, asOfMs, config })` ;
- `generateAndScoreCarryCandidates(...)` : sélection, génération, scoring,
  sizing et proposition en un appel pur ;
- `sizeDeltaNeutral(...)` ;
- `createOrchestratorProposal(...)` ;
- `evaluateCarryHorizons(...)` ;
- `evaluateCarryExit(...)`.

Une jambe OKX de marché doit fournir au minimum :

```json
{
  "asset": "BTC",
  "venue": "OKX",
  "kind": "perp",
  "instType": "SWAP",
  "instCategory": "1",
  "state": "live",
  "ruleType": "normal",
  "instrumentId": "BTC-USDT-SWAP",
  "active": true,
  "canLong": true,
  "canShort": true,
  "observedAtMs": 0,
  "bid": 0,
  "ask": 0,
  "volume24hUsd": 0,
  "bookDepthUsd": 0,
  "openInterestUsd": 0,
  "takerFeeBps": 0,
  "feeObservedAtMs": 0,
  "slippageBps": 0,
  "impactBps": 0,
  "fundingIntervalHours": 8,
  "fundingHistory": [{ "timestampMs": 0, "rate": 0 }],
  "lotSize": 1,
  "contractValueBase": 0.01,
  "maxLeverage": 2,
  "basisVolAnnualized": 0,
  "priceCorrelation": 1
}
```

Pour une jambe spot short, `canShort: true`, `borrowApr` et
`borrowAvailableUsd` sont obligatoires en pratique. Les coûts absents valent
échec, jamais zéro. `takerFeeBps` doit venir du tier réel du compte et une
observation de frais vieille de plus de 24 heures invalide le candidat.

La proposition de l'orchestrateur exige deux jambes simultanées, l'annulation
de la sœur en cas de rejet et l'aplatissement immédiat de toute jambe isolée.
Une proposition `RESEARCH_ONLY` ou `SHADOW_ONLY` expose ses quantités dans `researchLegs`, mais
garde `legs` vide afin qu'un consommateur naïf ne puisse pas l'exécuter.

## Diagnostic statique 1/2/3 ans au même cutoff

`evaluateCarryHorizons()` est uniquement un **diagnostic d'un couple statique**.
Il ne rejoue ni le portefeuille, ni la sélection/reconstitution historique du
Top30, ni l'allocation synchronisée. Sa sortie porte donc explicitement
`diagnosticType: STATIC_PAIR_CARRY_DIAGNOSTIC_V1`,
`portfolioScope: one_static_pair` et
`confirmatoryPortfolioBacktest: false`. Le backtest confirmatoire du processus
Top30 appartient à `modules/quant_validation.js` ; ce diagnostic ne peut pas le
remplacer dans une preuve ou une promotion.

La fonction évalue par défaut trois fenêtres glissantes de 1, 2 et 3 ans,
toutes terminées au même `cutoffMs`. Toute observation future est ignorée. Le
modèle utilise :

- inventaire de base apparié, sans supposer une neutralité en dollars fictive ;
- variation spot/perp ou perp/perp des deux jambes ;
- funding effectivement réglé (`fundingRatePaid`) ;
- emprunt spot et charge de capital proratisés dans le temps ;
- frais, demi-spread, slippage et impact aux deux extrémités ;
- drawdown de la courbe nette et taux d'intervalles profitables.

Chaque ligne historique représente un état de prix ; un
`fundingRatePaid` non nul doit correspondre à un règlement de funding réellement
survenu à cet horodatage. Le contrat versionné par défaut
`carry-static-pair-8h-v1` impose un intervalle attendu de 8 heures, un trou
interne maximal de 16 heures et au plus 8 heures manquantes à chaque extrémité.
Il exige simultanément au moins 99 % de couverture calendaire et 99 % de densité
d'observations. Deux seuls points aux extrémités sont donc refusés, tout comme
un trou interne, même si le ratio de couverture brut paraît élevé.

L'intervalle peut être remplacé pour un jeu pré-enregistré d'une autre fréquence
seulement avec une nouvelle `samplingContractVersion`, `expectedIntervalMs`,
`maxGapMs` et `maxEndpointGapMs`. Ces valeurs appartiennent à la configuration
hashée. La fonction reste indépendante de la durée demandée et accepte d'autres
horizons pré-enregistrés, tout en gardant un cutoff commun.

## Sorties et dégradations

`evaluateCarryExit()` ordonne une sortie d'urgence en cas de :

- cotation périmée ou venue dégradée ;
- rappel/indisponibilité de l'emprunt spot ;
- divergence de basis, delta critique ou perte maximale.

Une sortie normale est demandée à convergence de basis, expiration de la durée,
épuisement de l'espérance, persistance d'un funding adverse ou dégradation de
liquidité. Une dérive de delta intermédiaire et isolée produit `REBALANCE` ; la
dérive critique produit toujours `EXIT`.

## Limites de risque par défaut

La configuration versionnée est `config/carry-candidate.json`. Parmi les
limites : notionnel apparié 10 % de l'equity, gross global 50 %, gross par actif
15 %, gross par venue 35 %, collatéral estimé 25 %, participation à la
profondeur 5 %, participation au volume quotidien 5 points de base,
participation à l'open interest 10 points de base, levier
maximal 2 et mismatch delta maximal 5 points de base.

Ces plafonds sont des bornes initiales pour la recherche/shadow, pas une
autorisation live.

## Usage des recherches Hermes antérieures

Le PDF d'étude existant (SHA-256
`460EE15DA1A2E816303D96F908BF05762FE4B4DE3EE55BBCF1B33A70AC42FC0B`) peut
servir de prior pour les familles et régimes à étudier. Son univers Binance
top-100 est un snapshot statique, le funding y est absent, le portefeuille et
les corrélations ne sont pas simulés et de nombreux profils ont 1 à 20 trades.
Ses paramètres et métriques ne sont donc jamais importés comme preuve, ni
inscrits automatiquement dans le roster live.

## Promotion minimale

Avant de proposer une entrée au roster signé : données OKX point-in-time avec
manifest et checksums, fenêtres purgées/embargo, 1/2/3 ans au cutoff commun,
coûts réels par tier et par taille, borrow/funding réalisés, fills partiels et
risque de jambe simulés, contrôle familial sur toute la grille, folds et régimes
diversifiés, puis au moins 90 jours de shadow. Toute modification du module ou
de la configuration change le hash et invalide l'autorisation précédente.
