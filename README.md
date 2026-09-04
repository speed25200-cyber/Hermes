# Hermes

Robot de trading sur les perpétuels OKX. Il ouvre en long comme en
short, avec levier et taille dynamique, et se pilote depuis une page
web.

Ce dépôt repart de la version **Hermes Astra v4.2.5**. L'état antérieur,
un moteur Python distinct, reste récupérable au commit `ccb34a6`.

> **État du live (audit du 4 septembre 2026)** — aucune stratégie du
> dépôt ne possède aujourd'hui une preuve process-level de rentabilité
> après frais, funding, spread et slippage. Le live est donc fail-closed :
> un `config/approved-roster.json` explicitement promu ET
> `data/live-evidence.json`, liés par hash au manifeste, au roster, à la
> politique de risque, aux dépendances et au code exact, sont obligatoires.
> La preuve doit être signée Ed25519 par le job de validation; le moteur
> ne possède que les clés publiques `config/evidence-public-key.pem` et
> `config/monitoring-public-key.pem`, jamais les clés privées. Les deux clés
> doivent être distinctes.
> Le mode démo permet la validation shadow-live, mais exige lui aussi ce
> roster et une identité stable `HERMES_ALGO_OWNER` afin de ne jamais
> confondre les protections de deux moteurs. `npm run gate:status` explique
> chaque refus.

## Les stratégies

Le classement du 31 août 2026 avait retenu GPS et SOON sur plusieurs
fenêtres. La réplication ultérieure du processus de sélection sur douze
mois a invalidé cette conclusion : l'avantage brut par trade est
statistiquement indistinguable de zéro et les frais rendent le résultat
net négatif. Le winrate seul n'est pas un objectif économique.

La recherche reste expérimentale. `config/roster.json` est seulement le
roster candidat réécrit par le chercheur. Le moteur ne lit que
`config/approved-roster.json`, artefact immuable pendant le shadow test :
le chercheur ne peut donc plus réactiver seul une stratégie. Une promotion
live exige maintenant
au minimum une validation walk-forward purgée sur le processus complet,
une correction familiale à 1 %, 9 999 réplications nulles, une borne
basse nette positive sous stress de coûts, puis 90 jours de shadow-live.
Les critères complets sont dans `config/live-gate.policy.json`.

Le nouveau chemin autonome est un système champion/challenger, pas une
promesse de rendement. Il génère et journalise les essais, reconstruit le Top
30 OKX à chaque cutoff, valide les mêmes règles sur 365, 730 et 1 095 jours,
puis passe par shadow et canary. Il ne peut écrire le roster approuvé qu'avec
une preuve indépendante Ed25519 liée au code, aux données et au roster exacts.
Une dégradation remet automatiquement le roster en quarantaine. Le candidat
carry spot/perp est volontairement `SHADOW_ONLY` tant qu'un exécuteur atomique
deux jambes n'a pas été ajouté et audité.

## Comment c'est fait

    app/          la page et le processus principal
    modules/      le moteur : signaux, exécution, risque, simulation
    services/     les connexions OKX, REST et WebSocket
    config/       stratégie courante, politique de sortie, risque, univers
    lab_vagues/   le laboratoire de recherche qui a produit le classement
    deploy/       le rapatriement et la préparation d'import

## Les clés d'API

Elles vivent dans un fichier `.env` **sur la machine**, jamais dans le
dépôt. `.gitignore` les refuse, et le script d'import les refuse deux
fois : par le nom du fichier, puis par son contenu.

Ce n'est pas une précaution théorique. L'archive d'origine contenait
trois fichiers d'environnement portant de vraies clés OKX de
production, et ils sont partis dans un commit poussé sur ce dépôt
avant d'être retirés.

Une correction s'impose ici, parce que la première version de ce
paragraphe disait le dépôt public et en tirait des conséquences plus
graves qu'elles ne le sont. Vérification faite par l'API, il est
**privé** (`visibility: private`) : ces clés n'ont donc pas été
exposées au monde, seulement à qui a accès au dépôt. Cela réduit
l'urgence, cela ne l'annule pas — l'historique garde ce qu'on y a
écrit, et un secret dans un dépôt ne se répare pas en le supprimant.

## Réglages qui décident du comportement

**Correction, elle-même corrigée.** Ce paragraphe renvoyait à
`config/strategy.current.json` et `config/policy.json`. Vérification
faite : `strategy.current.json` n'est référencé que par
`modules/engine.js`, qu'`app/main.js` ne charge jamais — le régler ne
change rien. `config/policy.json`, en revanche, **est lu** : il porte
les seuils de score du moteur générique (`minLiveScoreAbs`,
`cooldownLiveSec`…). Ses champs de sortie (`slInitPctOfMargin` −40 %…)
appartiennent à l'ancien chemin ; les sorties des entrées actuelles
viennent de la constante `SPEC` d'`app/main.js` (take-profit +80 % de
la marge, stop −30 %, trail), modulée stratégie par stratégie par les
`ov` du roster HERMES15.

Ce qui décide réellement :

| réglage | où | défaut |
|---|---|---|
| levier | `HERMES_DEFAULT_LEVERAGE` | 15 |
| positions simultanées | `HERMES_MAX_POSITIONS` | 3 |
| marge totale maximale | `HERMES_MAX_MARGIN_PCT` | 0,25 |
| perte planifiée par trade | `HERMES_RISK_PER_TRADE_PCT` | 0,005 (0,5 %) |
| perte journalière maximale | `HERMES_MAX_DAILY_LOSS_PCT` | 0,02 |
| drawdown maximal depuis le pic | `HERMES_MAX_DRAWDOWN_PCT` | 0,10 |
| équité sous laquelle rien n'est tenté | `HERMES_MIN_EQUITY_USDT` | 5 |
| plancher / plafond de marge par trade | `HERMES_MARGIN_MIN` / `HERMES_MARGIN_MAX` | 3 / 200 |
| identité stable de l'instance | `HERMES_ALGO_OWNER` | générée une fois par l'installateur |

Changer `HERMES_ALGO_OWNER` rend les anciennes protections volontairement
non attribuables : elles ne seront jamais annulées automatiquement. Toute
rotation de cette identité impose donc une réconciliation manuelle sur OKX.

Les seuils de sortie sont la constante `SPEC` d'`app/main.js` :
take-profit à +80 % de la marge, stop à −30 %, armement du trail à
+10 %, rappel de 5 %.

### La taille des positions

Elle se recalcule **à chaque décision**, à partir de l'équité que le
compte affiche sur le moment — jamais d'un montant écrit à l'avance.

    budget marge  = équité × 0,25
    budget risque = équité × 0,005
    marge / trade = min(budget marge ÷ 3, budget risque ÷ 0,30, plafond)
    si cette marge est sous le plancher, le trade est refusé

Ce que cela donne :

| équité | marge / trade | notionnel (×15) | places |
|---:|---:|---:|---:|
| 10 USDT | refusée | 0 | 0 |
| 20 USDT | refusée | 0 | 0 |
| 334 USDT | 5,57 | 84 | 3 |
| 1 000 USDT | 16,67 | 250 | 3 |

Le nombre de places était auparavant fixé à 10 quel que soit le
capital. Le plan annonçait donc 1 503 USDT de marge pour 300
disponibles, et 90 pour 9 — une garde budgétaire séparée rattrapait
l'affaire sans rien dire, ce qui déplaçait la décision là où elle était
illisible. Le plancher de marge, lui, valait 50 USDT : sur un compte de
10, il écrasait la règle de la moitié et faisait partir **tout** le
capital dans un seul trade.

Un capital petit peut ne financer aucun lot : à 68 USDT de notionnel,
le pas minimal de BTC (0,1 contrat, soit ~110 USDT) est hors d'atteinte.
Le moteur imprime alors, et à chaque changement de taille, une ligne
`[TAILLE]` qui nomme les instruments accessibles et ceux qui ne le sont
pas. Sans elle, l'échec est muet : le moteur tourne, reçoit les
signaux, et n'ouvre rien.

## L'univers

Par défaut, Hermes observe les **30 plus grands mouvements absolus sur 24 h
parmi les perpétuels crypto USDT d'OKX**, rafraîchis toutes les heures. Ce
classement définit l'univers ; il ne constitue jamais, seul, un signal.

Avant le classement, le sélecteur exige `instCategory=1`, `state=live`,
`ruleType=normal`, 90 jours d'ancienneté, au moins 5 M$ de volume notionnel,
un spread inférieur ou égal à 15 points de base et une paire spot live. Un
snapshot horodaté et hashé est ajouté à `data/universe-top30.jsonl`. Si trente
marchés conformes ne sont pas disponibles, l'univers devient vide : BTC/ETH
ne sont plus substitués silencieusement à une méthode qui a échoué.

Le classement se faisait auparavant sur le champ `volCcy24h` seul. C'est
un volume exprimé dans la monnaie de base de chaque instrument : trier
dessus revient à comparer des BTC à des DOGE, donc à classer par nombre
de pièces et non par argent échangé. SHIB et PEPE écrasaient
mécaniquement BTC — le classement obtenu n'était pas « les plus gros
volumes » mais « les moins chers ». Il est désormais multiplié par le
dernier prix.

La rotation est imprimée au journal, entrées et sorties nommées : un
univers qui change en silence est un univers dont on ne peut pas
expliquer les trades après coup. Un instrument sur lequel une position
est ouverte ne quitte jamais l'univers, sinon le moteur cesserait de
recevoir son prix et ne pourrait plus ni la surveiller ni la fermer.

Ces paramètres ne sont plus modifiables par variables d'environnement : ils
font partie de `config/autopilot.policy.json`, lui-même inclus dans le hash de
preuve. Le contrat actuel impose 30 actifs, une rotation horaire, 5 M$ de
volume, 15 bp de spread, 90 jours de listing, 7 jours avant une radiation et
un ticker vieux de dix minutes au maximum. Un snapshot expire au bout d'une
heure même si le timer ou OKX se bloque; les nouveaux ordres sont alors refusés.
`HERMES_MARKETS` reste utile en démo, mais ferme explicitement le live réel.

Le snapshot n'est pas un simple log best-effort : le sélecteur archive les
réponses publiques complètes (tickers, instruments swap et spot) en JSON gzip,
avec hashes et écriture atomique. Une archive incomplète ou impossible à
persister produit un univers d'entrée vide.

## Recherche autonome et statut des backtests

`hermes-perles.timer` reconstruit le Top30 et explore la grille directionnelle
toutes les trente minutes. Il écrit un catalogue `discovery-only`; ses 30 jours
ne sont jamais présentés comme les backtests demandés. `hermes-autopilot.timer`
réconcilie toutes les cinq minutes le cycle champion/challenger, journalise
chaque essai et peut appliquer automatiquement seulement un bundle exact qui a
franchi les validations 365, 730 et 1 095 jours au même cutoff.

Le compilateur quantitatif est volontairement fermé aujourd'hui : le dépôt ne
contient pas l'inventaire OKX historique point-in-time, les radiations, les
frais réels du compte, funding/borrow, carnets/fills/latence, MTM portefeuille
et matrices de toutes les hypothèses nécessaires pour rejouer honnêtement ces
trois fenêtres. Il retourne donc `rejected`; aucun rendement 1/2/3 ans n'est
inventé. Les sorties déclaratives ne deviennent jamais une preuve.

Un run complet n'est toutefois plus bloqué par un refus codé en dur. Le
compilateur émet trois requêtes d'attestation déterministes, puis vérifie deux
autorités Ed25519 externes : une clé données/processus sous deux domaines
séparés (fills-attribution et rejeu complet) et une clé distincte qui ancre la
hash-chain append-only du journal autonome. Les empreintes sont pinées dans
`config/quant-validation.policy.json` et répétées hors dépôt; la policy exacte
est elle-même ancrée par `HERMES_QUANT_POLICY_SHA256`. Le compilateur ne lit
jamais de clé privée et ne signe rien. Après un vrai `passed`, l'option explicite
`--candidate-catalog … --candidate-id …` peut enrichir atomiquement le candidat
exact avec les rapports 1/2/3 ans, sans promotion ni activation live. Le contrat
détaillé et les domaines sont dans `docs/validation_quantitative.md`.

Après une validation reproductible, l'état doit rester réellement 90 jours en
shadow. Le canary commence à 1 % de l'equity, sans montée automatique, et exige
un monitoring OKX signé vieux de moins de cinq minutes. Deux autorités Ed25519
distinctes sont obligatoires : la preuve de promotion utilise
`config/evidence-public-key.pem` et `HERMES_EVIDENCE_PUBLIC_KEY_SPKI_SHA256`, le
monitoring utilise `config/monitoring-public-key.pem` (ou
`HERMES_MONITORING_PUBLIC_KEY_FILE`) et
`HERMES_MONITORING_PUBLIC_KEY_SPKI_SHA256`. Leurs empreintes SPKI doivent aussi
correspondre aux deux champs de `config/live-gate.policy.json`; une valeur
`UNCONFIGURED`, une clé partagée ou une seule ancre ferme le live.

Les signatures sont séparées par domaine cryptographique :
`hermes/live-evidence/v1` pour la preuve et
`hermes/okx-account-monitoring/v1` pour la réconciliation. Une signature
monitoring ne peut donc jamais être réutilisée comme signature de promotion,
ni l'inverse. Ce changement est volontairement incompatible avec les anciennes
signatures : les artefacts doivent être resignés par leurs autorités respectives.
`config/live-evidence.example.json` et `config/monitoring.example.json` montrent
les deux schémas; l'exemple monitoring est volontairement malsain et non signé.

La séquence de monitoring est monotone globalement pour une autorité
`clé SPKI + source`, et non remise à zéro à chaque candidat. Sa marque durable
vit dans `data/autopilot/monitoring-high-water.json`. Une régression, la
réutilisation d'un numéro avec un autre payload, l'absence/corruption de cette
marque ou l'échec de son écriture ferment le live. Une observation signée qui
annonce un breach fait avancer la marque avant la quarantaine : restaurer
ensuite un ancien message sain ne peut pas rouvrir le système. Le producteur de
monitoring externe doit donc conserver cette séquence lors d'une promotion.

Enfin, le repli maker→market revalorise maintenant la marge exacte avec la
nouvelle cotation et le lot déjà arrondi. Il refuse l'ordre si cette marge
dépasse la réservation, la limite par trade ou le reliquat du canary, même si
la distance du stop resterait séparément sous son budget dollar. Après
exécution, le même calcul est refait au prix moyen réellement rempli; tout
dépassement verrouille le moteur et déclenche immédiatement l'aplatissement.

Le PDF de profils Top100 sert uniquement de prior pour les familles et régimes
à explorer (`config/report-profile-priors.json`). Son univers Binance statique,
l'absence de funding, les petits échantillons et l'absence de portefeuille
interdisent d'en importer les chiffres comme preuve ou roster live.

L'ancien filtre heuristique week-end reste seulement dans une fonction legacy
non appelée, pour l'historique du projet. Il n'influence ni le Top30 courant,
ni la recherche, ni une preuve quantitative.
