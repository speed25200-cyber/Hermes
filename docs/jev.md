# Jev : la décision à la minute

*Écrit le 18 septembre 2026, le jour où la source a été construite. Ce
document dit ce que le système fait, ce qu'il garantit, ce qu'il ne
garantit pas, et comment on le fait passer de l'observation au réel.*

## D'où ça vient, et ce qu'il faut savoir avant de lire la suite

Le propriétaire a décidé, le 18 septembre, que Jev (TypeSafe AI) prendrait
les décisions d'Hermes sur des bougies d'une minute. Ce document construit
cette décision proprement ; il ne la discute pas. Mais il doit rappeler ce
que le dépôt a mesuré avant elle, parce que la porte du réel en dépend :

- `avantage.md` et `direction.md` ont testé, sur 30 puis 134 instruments,
  jusqu'à 24 mois, tout ce que le prix et ses proxys contiennent à
  l'échelle de 5 minutes à 24 heures. Rien n'a battu son nul au niveau de
  la famille.
- Jev est un modèle de jugement zéro-shot : il n'a pas vu une bougie à
  l'entraînement et ne s'affine pas sur nos données. Sa calibration est
  une promesse du fournisseur, pas une mesure sur OKX.

D'où la règle, identique à celle des perles : **pas de verdict = pas de
réel.** Le décideur tourne, juge, journalise ; il n'engage l'argent que
lorsque `deploy/banc_jev_1m.js` a écrit `config/jev_verdict.json` avec
`autorise: true`, pour ces questions-là. Rien dans l'environnement ne
contourne cela.

## Comment ça marche

```
OKX ws business ─ candle1m ─► bougies1m.js ─ close ─► decideur_jev.js
                                                         │  etat_jev.js : état compact + 3 questions figées
                                                         │  jev.js      : un POST, budget de latence
                                                         ▼
                                              proposition {long|short}
                                                         │
                          gardes communes (canPlaceOrder, coupe-circuit, places, budget, fraîcheur)
                                                         │
                                      GATE V2 : maker puis marché, TP/SL attachés sur OKX, trailing
```

**Le flux.** Les chandelles d'OKX vivent sur le point *business*
(`wss://ws.okx.com:8443/ws/v5/business`), pas sur le point public. Seules
les bougies `confirm = 1` sont évaluées — décider sur une bougie ouverte
est le *repaint* que l'audit du 29 août relevait. Préchargement REST de
300 bougies, rechargement sur trou, battement armé après le ping.

**L'état.** Compact, relatif, lisible (`modules/etat_jev.js`) : rendements
à 1/5/15/60 min en points de base, volatilité réalisée et son ratio
court/long, volume relatif, position dans le range 24 h, funding, régime
de marché (BTC/ETH 5 m), spread et **coût aller-retour en bps de prix** —
c'est lui que le mouvement doit battre. Environ 730 tokens.

**Les questions.** Trois, en un seul appel, **figées** et signées
(`SIGNATURE`, dans chaque ligne de journal et dans le verdict) :

| id | type | ce qu'elle demande |
|---|---|---|
| `direction` | choice | long / short / aucun : dans quel sens le prix bougera-t-il de *plus que le coût* à l'horizon |
| `depasse_cout` | noul | le mouvement *absolu* dépassera-t-il le coût, quel que soit le sens |
| `conviction` | score 1–5 | cohérence des indices entre eux |

Changer un mot change la signature et invalide le verdict. C'est voulu :
reformuler après avoir vu un chiffre est un essai non compté.

**La règle de décision** (`decider`) : long si `p(long) ≥ seuil_sens` et
`p(dépasse) ≥ seuil_cout` ; symétrique pour short ; sinon rien. Jamais
0,50 — un noul à 0,50 veut dire « autant oui que non ». Les seuils sont des
réglages, choisis par le banc sur la première moitié de sa fenêtre.

**Les sorties**, en % de la marge comme partout dans le GATE V2 : TP +15 %,
SL −10 %, trail armé à +5 % avec rappel 3 %, échéance à deux horizons. À
×15 : +1 % / −0,67 % de prix. Une position Jev est protégée exactement
comme une perle — TP/SL attachés à l'ordre côté OKX, trailing, garde
horaire qui répare.

**Ce que le décideur garantit** : un budget de latence (réponse au-delà =
journalisée, pas remise au moteur), un plafond de coût par jour UTC,
une concurrence bornée avec remplacement de la bougie périmée par la plus
récente, un journal de *chaque* décision (`data/jev-decisions.jsonl`), et
Jev injoignable = pas d'avis, jamais un incident. **Aucun appel sur le
chemin d'une sortie de position.**

## Les trois modes

| mode | condition | ce qui se passe |
|---|---|---|
| observation | défaut sur un compte réel | décisions journalisées, aucun ordre |
| démo | `OKX_SIMULATED=true` | vrais ordres sur le compte de démonstration OKX |
| réel | `HERMES_JEV_REEL=1` **et** `config/jev_verdict.json` avec `autorise:true` et la même signature | ordres sur le compte réel |

Le mode est imprimé au démarrage (`[JEV] mode …`) avec la raison quand ce
n'est pas le réel, et il est affiché sur la page. Le verdict est relu
chaque minute : retirer le fichier coupe le réel à la minute.

## Le coupe-circuit journalier

Le garde-fou que `direction.md` nommait comme premier chantier, et qui
n'existait pas. `modules/coupe_circuit.js` : à chaque jour UTC, l'équité du
premier relevé devient la référence ; sous référence × (1 − seuil), le
circuit s'ouvre et **aucune source** ne peut plus entrer (il est lu dans
`canPlaceOrder`). Persisté ; ne se referme qu'au changement de jour, jamais
sur un rebond ; ne s'ouvre jamais sur une lecture d'équité en échec.
`HERMES_COUPE_CIRCUIT_FERMER=1` ferme aussi les positions ouvertes.

## La porte du réel : le banc

`deploy/banc_jev_1m.js`, sur le VPS (la seule machine qui joint OKX et
`api.typesafe.ai`) :

1. Histoire 1 m des instruments (OKX `history-candles`), régime recalculé
   depuis BTC/ETH agrégés en 5 m.
2. À chaque bougie, l'état est construit avec les seules bougies passées
   et Jev est interrogé — une fois, réponse mise en cache par (signature,
   instrument, horodatage). Rejouer ne coûte rien.
3. Les deux seuils sont choisis sur la première moitié (grille fixe de
   15 cellules) et mesurés sur la seconde, jamais regardée pour choisir.
4. Nul : les mêmes décisions décalées d'au moins deux heures, vingt
   répliques, zéro appel. Test de famille maxT sur la grille.

**Règles, écrites avant la mesure** — `autorise:true` si, sur la seconde
moitié : ≥ 30 trades, t net > 2, au-dessus du 95ᵉ percentile du nul, et
le meilleur t de la grille bat 95 % des maxima des répliques. Sinon
`autorise:false` avec les chiffres.

Ce que le banc ne voit pas et qui ne peut que *dégrader* le réel : le
spread réel (le coût du banc est frais seuls), le glissement, les refus de
lot. Un verdict positif est une condition nécessaire, pas une promesse.

Éprouvé hors ligne : sur une marche aléatoire avec un modèle factice, il
refuse (t négatif, échec au test de famille).

**La calibration** (`deploy/calibration_jev.js`) relit le journal des
décisions et mesure sur *nos* données ce que le fournisseur affirme : Brier
contre un modèle constant, fiabilité par tranche, justesse de la direction,
monotonie de la conviction. À lire après quelques jours d'observation,
avant même de lancer le banc.

## Réglages

| variable | défaut | effet |
|---|---|---|
| `HERMES_STRATEGIE` | `hermes15` (`jev1m` sur le VPS) | source des entrées : `hermes15`, `jev1m`, `les-deux` |
| `TYPESAFE_AI_API_KEY` | — | la clé, dans le `.env` de la machine, jamais dans le dépôt |
| `HERMES_JEV_REEL` | absent | avec le verdict du banc, autorise le réel |
| `HERMES_JEV_HORIZON_MIN` | 15 | horizon des questions |
| `HERMES_JEV_SEUIL_SENS` / `_COUT` | 0,65 / 0,60 | règle de décision (le banc les choisit) |
| `HERMES_JEV_TP_PCT` / `_SL_PCT` / `_TRAIL_ACT_PCT` / `_TRAIL_CB_PCT` | 0,15 / 0,10 / 0,05 / 0,03 | sorties, en fraction de marge |
| `HERMES_JEV_HOLD_MIN` | 2 × horizon | échéance |
| `HERMES_JEV_LATENCE_MAX_MS` | 2000 | budget de latence |
| `HERMES_JEV_BUDGET_USD_JOUR` | 5 | plafond de coût par jour UTC |
| `HERMES_JEV_CONCURRENCE` | 6 | appels simultanés |
| `HERMES_COUPE_CIRCUIT_PCT` | 0,05 | perte journalière qui ouvre le circuit |
| `HERMES_COUPE_CIRCUIT_FERMER` | 0 | 1 = fermer aussi les positions à l'ouverture |
| `HERMES_BANC_JOURS` / `_INSTRUMENTS` / `_REPLIQUES` | 3 / 10 / 20 | le banc |

## Le coût

≈ 730 tokens par décision, 0,042 $/MTok en entrée, 0 $ en sortie : une
décision coûte trois cent-millièmes de dollar. Vingt instruments à la
minute font 28 800 décisions par jour, soit **≈ 0,90 $/jour**. Le banc sur
dix instruments et trois jours coûte moins de deux dollars ; au-delà il
demande `--confirmer`.

## Ce qui est mesuré, et ce qui ne l'est pas encore

Mesuré : le pipeline entier hors ligne (magasin, état, décideur, banc,
calibration : tests dans le journal de session), le démarrage du moteur
avec la source Jev, l'API `jev-etat`, le panneau de la page.

**Pas encore mesuré, et c'est ce qui compte** : un seul appel réel à Jev
n'a pu partir de la session qui a écrit ce code (réseau sortant bloqué
vers `api.typesafe.ai`). La latence réelle, la forme exacte des réponses
de l'API et — surtout — le verdict du banc sont à obtenir sur le VPS. La
première chose à lire ne sera pas le P&L : ce sera la table de
calibration après vingt-quatre heures d'observation.

## Exploitation

- Démarrer : le service `hermes` avec `HERMES_STRATEGIE=jev1m` (posé par
  `deploy/install.sh`). Journal : `journalctl -u hermes -f | grep JEV`.
- Page : bloc « Jev — décisions à la minute » (mode, appels, latence,
  coût, verdict, coupe-circuit, dernières décisions). API : `POST /api/jev-etat`.
- Banc : workflow « Deploy Hermes to VPS », entrée `banc_jev` = nombre de
  jours. Calibration : entrée `calibration_jev`.
- Passer au réel : entrée `jev_reel=true` **après** un verdict positif.
  Jamais l'inverse.

## Ce qu'il ne faut pas faire

1. Reformuler les questions parce qu'un chiffre déplaît.
2. Lire un taux de gain comme une prédiction : la forme des sorties
   fabrique 60 % de gagnants sur du bruit.
3. Poser `HERMES_JEV_REEL=1` avant le verdict, ou lancer le banc jusqu'à ce
   qu'il dise oui — chaque relance sur les mêmes jours est un essai non
   compté.
4. Mettre un appel réseau sur le chemin de sortie d'une position. Il n'y
   en a aucun, et il ne doit jamais y en avoir.
