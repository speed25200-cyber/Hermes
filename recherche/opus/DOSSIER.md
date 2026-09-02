# Dossier de mission — Hermes-Astra, couche régime, signaux appris, risque

Ce dossier est écrit pour être lu par un agent (Claude Opus 5) qui reprend le
travail sans avoir vu la conversation précédente. Il contient tout ce qu'il
faut savoir sur le projet, l'état actuel, le diagnostic, l'architecture
cible, les livrables, le protocole de validation, les critères d'acceptation
et les interdits. Le prompt à coller est dans `PROMPT.md`, à côté.

---

## 1. Le projet en une page

**Hermes-Astra** est un moteur de trading de perpétuels crypto sur OKX
(compte réel, `OKX_SIMULATED=0`) avec une console web. Dépôt privé
`speed25200-cyber/Hermes`, branche de travail
`claude/hermes-crypto-prediction-verify-q9r6qy`. Le serveur est un VPS
(Ubuntu, 2 Go, Node), déployé par le workflow GitHub Actions
`.github/workflows/deploy-vps.yml`.

Principe fondateur, non négociable : **pas de perle = pas de trade**. Un
chercheur de perles (`deploy/chercher_perles.js`) teste toutes les 30
minutes, sur 50 instruments, 13 signaux × 4 sorties × 3 durées, et n'écrit
dans `config/roster.json` que les combinaisons qui ont passé une validation
sur des jours jamais regardés. Le moteur ne trade que ces perles.

### Arborescence utile

| Chemin | Rôle |
|---|---|
| `app/main.js` (~3 100 lignes) | Le moteur : boucle HERMES15, portes d'entrée, `placeMarket`, dimensionnement du capital, garde de corrélation, GUET, canaux IPC (`fetch-portfolio`, `laboratoire`, `chercher-perles`, …) |
| `app/serveur.js` | Doublure Electron→HTTP : sert `app/index.html`, expose les canaux IPC en HTTP, clé d'accès `?key=` → cookie `hermes_key` (`HERMES_DASH_TOKEN`), page de saisie de clé sur 403 |
| `app/index.html` | Toute la console (CSS inclus) : thème « noir & champagne », pages Marché et Laboratoire |
| `app/vue.js` | Page Marché : héros, tuiles, positions ouvertes, historique clôturé, santé, journal |
| `app/labo.js` | Page Laboratoire : constellation des perles, méthode en 3 temps, refus, guet, capital |
| `app/graphe.js` | Courbe de prix |
| `app/langues.js` | i18n FR / EN / SQ, ~235 clés, `t("cle", {vars})`, `Langues.surChangement` |
| `app/pont.js` | Pont entre la page et les canaux HTTP |
| `modules/signaux.js` | Les 13 signaux, `evalSignal(sig, c5, etat)` → `1`, `-1`, `0` ; tous symétriques |
| `modules/backtest.js` | `serieSignaux`, `simuler`, `resumer` : simulateur fidèle au moteur vivant |
| `deploy/chercher_perles.js` | Le chercheur de perles (juge en trois temps) |
| `deploy/install.sh` | Services systemd `hermes.service` et `hermes-perles.service` + minuteur 30 min |
| `config/roster.json` | Écrit par le chercheur, relu à chaud par le moteur (60 s). **Exclu du rsync.** |
| `data/cache-5m/` | Cache des bougies 5 m du chercheur (serveur seulement) |
| `banc/` | Banc d'essai de la console (Playwright + Chromium) : `pont-double.js`, `epreuve_langues.js`, `scene-details.js` |
| `recherche/jepa/` | Carnet Colab JEPA livré (voir §6) |

### Le moteur, en détail utile

- Boucle REST toutes les 20 s ; chaque perle est évaluée par `evalSignal` sur
  **exactement 299 bougies 5 m closes** (limite REST 300 moins la bougie en
  cours). Le chercheur évalue sur des fenêtres glissantes de 299 pour tester
  le même programme que celui qui trade (`FENETRE_VIVANTE`).
- Entrée au marché à la clôture de la bougie signalée. Sorties attachées à
  l'entrée : TP / SL en % de la **marge**, convertis en prix par le levier
  (levier 15 : `HERMES_DEFAULT_LEVERAGE`), trail OKX armé à `act` et rappelé
  de `cb`, fermeture au marché passé `holdMs`. Frais taker 0,05 % par jambe
  (le vivant tente maker d'abord, `HERMES_MAKER_WAIT_MS`).
- Portes d'entrée (`canPlaceOrder`) : moteur actif, pas d'ordre en vol,
  cooldown, levier posé, places libres, pas de position déjà ouverte sur
  l'instrument, équité, solde, flux de données, budget 90 %.
- **GUET** : pour chaque perle, `GUET[instId] = {ts, bougie, sig, dir, prix,
  dernierSignal, garde, refus}` ; `expliquerGarde(instId)` renvoie
  `"moteur"|"enPosition"|"place"|"equite"|"levier"|"repit"|"flux"|"budget"|null`.
  Exposé par le canal `laboratoire`.
- **Capital** : `positionSizing` : places = min(`HERMES_PLACES`||3,
  `HERMES_MAX_POSITIONS`) ; si utilisable/places < `HERMES_MARGIN_MIN`||3,
  places = floor(utilisable/3). `globalThis.__hermesCapital()` →
  `{equite, places, parTrade, ouvertes, engage, budget}`. Garde de
  corrélation dans `placeMarket` : au-delà de `HERMES_MEME_SENS_PLEIN`(2)
  positions dans le même sens, marge × `HERMES_CORREL_ECHELLE`(0,6), journal
  `[CORREL]`.
- **Vérité OKX** : `positions-history` (cache 60 s) alimente l'historique
  clôturé et deux winrates (24 h et total) ; repli sur les deals locaux sans
  clés.
- Mode de position OKX : `net_mode` (pas de long et short simultanés sur un
  même instrument).

### Le chercheur de perles, en détail utile

- Univers : top `HERMES_UNIVERSE_SIZE`(50) par volume 24 h, avec un critère
  d'activité le week-end (`HERMES_WEEKEND_MIN` 0,34).
- Données : 30 jours de 5 m (`PERLES_JOURS`), validation sur les 7 derniers
  (`PERLES_VALID_JOURS`), cache `data/cache-5m`.
- Grille : 13 signaux × 4 sorties `{tp,act}` ∈ {(0,80;0,30),(0,60;0,20),
  (0,40;0,30),(0,30;0,15)} × durées {8,12,24} h ; `SL=0,30`, `CB=0,05`.
- Juge en trois temps : (1) pour concourir, positif dans deux sous-fenêtres
  disjointes A et B avec ≥ 6 trades chacune, winrate A+B ≥ 55 %
  (`PERLES_MIN_WR_SEL`), gain moyen ≥ 0,02 de marge (`PERLES_MIN_MOYENNE`) ;
  (2) argmax winrate désigne UN vainqueur ; (3) la validation ne juge que
  lui (≥ 5 trades, winrate ≥ 50 %), **sans repêchage du deuxième**.
- Ces seuils ont été réglés sur des **marchés aléatoires** : la première
  version trouvait des perles dans du bruit. Tout nouveau juge doit repasser
  ce banc de marches aléatoires et n'y trouver (presque) rien.
- Format de `config/roster.json` :
  ```json
  {
    "genere": "ISO", "fenetres": {...}, "levier": 15, "dureeS": 87,
    "candidats": ["ETH-USDT-SWAP", ...],
    "perles": { "BTC-USDT-SWAP": { "sig": "vwap_reclaim",
        "ov": {"tpPctMargin":0.3,"trailActPctMargin":0.15,"holdMs":86400000},
        "mesures": { "a": {...}, "b": {...},
                     "sel": {"trades":23,"winrate":74,"netMarge":1.0,"longs":{"trades":11,"winrate":82},"shorts":{...}},
                     "val": {...} },
        "finalistes": [...] } },
    "refus": { "ETH-USDT-SWAP": { "raison": "...", "concourantes": 0, "vainqueur": {...}, "presque": {...} } }
  }
  ```
  Écriture atomique (tmp + rename). Historique des passes dans un fichier
  JSONL à côté.

### La console

- Deux pages : Marché (héros dépliable, tuiles, positions, historique,
  santé, journal) et Laboratoire (constellation, méthode, refus dépliables,
  perles dépliables avec A/B/sel/val, longs/shorts, guet, capital).
- Thème « noir & champagne » : `--fond #070708`, or `--accent #c9a254`,
  `--long/--gain #0ecb81`, `--short/--perte #f6465d`. Titres Space Grotesk,
  chiffres Inter tabulaire, mono réservé au journal et aux identifiants.
  Interdiction d'emojis. Phrases complètes dans les panneaux (grilles
  `minmax(0,1fr)` + `min-width:0`).
- i18n obligatoire : chaque texte passe par `t("cle")` et existe en FR, EN,
  SQ. `banc/epreuve_langues.js` vérifie la parité et les clés demandées.
- `banc/scene-details.js` rejoue la console sur des fixtures
  (`pont-double.js`) avec Chromium (`/opt/pw-browsers/chromium`,
  `npm install playwright-core` dans `banc/`).

### Déploiement

- `deploy-vps.yml`, `workflow_dispatch`, entrées : `root_password` (masqué),
  `paquet` (clés OKX chiffrées, base64), `demarrer`, `diagnostic`,
  `chercher`. Le run copie le dépôt par rsync en excluant
  `/.git /state /data /.env /node_modules /logs /runtime /config/roster.json
  /banc /recherche`, lance `install.sh`, redémarre les services, et avec
  `chercher=true` imprime le verdict complet dans le journal du run.
- `hermes-perles.timer` : 5 min après le boot puis toutes les 30 min,
  `TimeoutStartSec=2700`. Marqueurs « passe morte » à 45 min dans le moteur.
- Le VPS n'est **pas** joignable depuis une session Claude ; tout passe par
  le workflow. Les journaux du run sont la seule fenêtre sur le serveur.

---

## 2. État actuel (2 septembre 2026)

- Équité : ~12 USDT → 3 places × ~3,6 USDT. Le propriétaire n'a pas répondu
  sur la réduction du risque (`HERMES_MAX_RISK_PCT`, `HERMES_MAX_POSITIONS`)
  : **ne rien changer à ces réglages sans lui**.
- Dernier verdict (run 167) : 10 perles sur 50 candidats, en 86 s :

| Perle | Signal | Sélection | Validation | Longs / shorts (sél.) |
|---|---|---|---|---|
| BTC | vwap_reclaim | 23 t, 74 % | 8 t, 75 % | 11 à 82 % / 12 à 67 % |
| FIL | meche15m | 26 t, 88 % | 14 t, 86 % | 18 à 83 % / 8 à 100 % |
| LINK | run5_5m | 66 t, 59 % | 16 t, 50 % | 34 à 74 % / 32 à 44 % |
| CHIP | vwap_reclaim | 61 t, 67 % | 19 t, 68 % | 26 à 65 % / 35 à 69 % |
| LTC | donchian_fade | 27 t, 70 % | 8 t, 88 % | 13 à 85 % / 14 à 57 % |
| BCH | vwap_reclaim | 39 t, 77 % | 14 t, 93 % | 16 à 75 % / 23 à 78 % |
| AVAX | vwap_reclaim | 29 t, 83 % | 16 t, 81 % | 11 à 91 % / 18 à 78 % |
| SHIB | meche_regime | 40 t, 78 % | 18 t, 78 % | 20 à 75 % / 20 à 80 % |
| STX | keltner3 | 64 t, 75 % | 14 t, 86 % | 27 à 74 % / 37 à 76 % |
| INJ | meche15m | 32 t, 75 % | 10 t, 90 % | 13 à 85 % / 19 à 68 % |

- Les 13 signaux sont bidirectionnels. Le gain moyen par trade tourne
  autour de +5 % de marge en validation, pour un coût de frais de 1,5 % de
  marge par trade (2 × 0,05 % × 15).

---

## 3. Diagnostic

Le propriétaire observe : « ça fonctionne assez bien, puis dès qu'il y a un
retournement de marché, ça ne fonctionne plus ». Les perles retenues sont
presque toutes du **retour à la moyenne** (vwap_reclaim, meche15m,
meche_regime, keltner3, donchian_fade, bb_range, double_extreme). Elles
gagnent tant que le marché oscille et perdent en série quand il part en
tendance ou se retourne violemment. Aucun prédicteur regardant la même
bougie 5 m ne corrige cela. Ce qui manque est une couche qui connaît
**l'état du marché** et coupe ou réduit les perles quand l'état ne leur
convient plus, plus une estimation de confiance par entrée, plus un risque
géré au niveau du portefeuille.

Ce que la littérature 2025-2026 dit (sources en §9) : les modèles de
fondation temporels généralistes (Chronos-2, TimesFM-3, Moirai 2.0)
n'apportent que des gains « petits et épars » sur les rendements financiers,
significatifs dans 2 cas sur l'ensemble testé. Kronos, seul modèle
pré-entraîné sur des chandeliers (crypto comprise, MIT, fine-tuning fourni,
25 M de paramètres pour la version small), montre en tests indépendants un
IC de +0,022 non significatif en journalier et 45 à 60 % de précision
directionnelle en 30 minutes, sans amélioration du trading par le
fine-tuning. Les agents LLM (TradingAgents, Trading-R1, RD-Agent) sont
conçus pour des actions en journalier avec des nouvelles. Conclusion : ces
outils sont des **compléments à juger**, pas des remplaçants. Le système
qui tient dans la littérature crypto récente (Sharpe 2,41, drawdown 12,7 %
sur 150 paires 2022-2024) doit sa robustesse au régime de volatilité, aux
stops adaptatifs et à la sélection glissante des actifs, pas à un modèle.

---

## 4. Architecture cible : trois couches

### Couche 1 — Régime (prioritaire, elle seule traite le symptôme)

**But** : un état de marché toutes les 5 minutes, parmi
`fourchette | tendance_haussiere | tendance_baissiere | choc`, avec une
probabilité par état.

**Entrées** (toutes publiques, OKX ou Binance) : bougies 5 m / 1 h de BTC et
ETH ; largeur du marché (part des 50 instruments au-dessus de leur moyenne
24 h, dispersion des rendements 1 h) ; volatilité réalisée 1 h / 24 h et son
rapport ; taux de financement (`/api/v5/public/funding-rate`,
historique `funding-rate-history`) ; intérêt ouvert
(`/api/v5/rubik/stat/contracts/open-interest-volume` ou
`/api/v5/public/open-interest`) ; liquidations si accessibles. Sur Binance :
`data.binance.vision` (klines, metrics) sans clé.

**Étiquetage** : sans vérité terrain, deux voies à comparer : (a) modèle de
Markov caché gaussien à 4 états sur (rendement 1 h, volatilité 1 h, largeur),
(b) étiquettes par règles rétrospectives (tendance = |rendement 24 h| > k ×
volatilité, choc = volatilité 1 h > 3 × médiane 30 j) puis un classifieur
**causal** (LightGBM ou petit MLP, indifférent) qui prédit l'état des 4 h à
venir avec les seules données passées. La voie (b) est préférée parce
qu'elle est causale et lisible.

**Sortie** : `hermes_regime.onnx` (entrée : vecteur de caractéristiques,
sortie : 4 probabilités) + `regime_normalisation.json`. Côté Hermes, un
module `modules/regime.js` calcule les caractéristiques à partir des bougies
et des séries publiques déjà tirées par le moteur, appelle onnxruntime-node,
et expose `etatMarche() → {etat, probas, ts}`.

**Usage** : le chercheur de perles évalue **chaque perle par état** : une
perle n'est validée que dans les états où sa validation tient (≥ 5 trades,
winrate ≥ 50 %) et `roster.json` porte pour chaque perle la liste
`etatsAutorises`. Le moteur refuse l'entrée (nouvelle garde `"regime"` dans
`expliquerGarde`, visible dans le guet) quand l'état courant n'est pas
autorisé. L'état `choc` coupe toutes les entrées et réduit la marge des
positions restantes n'est **pas** touchée (on ne ferme rien de force sans
décision du propriétaire).

### Couche 2 — Signaux appris et méta-modèle

**2a. Kronos-small fine-tuné** sur les perpétuels OKX (ou Binance USDT-M),
bougies 15 min et 1 h, 50 instruments, 2022 → aujourd'hui. Contexte 512
bougies maximum. Sorties utiles : mouvement attendu à 1 h / 4 h et dispersion
des échantillons (5 tirages, température 0,6). Ces deux valeurs deviennent
(i) un 14ᵉ signal `kronos` dans `modules/signaux.js` (long si mouvement
attendu > seuil et dispersion < seuil, symétrique), jugé par le chercheur
comme les 13 autres ; (ii) des caractéristiques du méta-modèle.

**2b. JEPA** (carnet déjà livré, `recherche/jepa/`) : son plongement gelé
(256 dims) est une caractéristique supplémentaire du méta-modèle, et sa
sonde peut devenir un 15ᵉ signal `jepa` si, et seulement si, son banc
d'essai passe les portes du chercheur.

**2c. Méta-modèle** : pour chaque signal de perle émis (instrument, signal,
sens, heure), estimer la probabilité que le trade finisse gagnant sachant :
état de régime et probabilités, mouvement/dispersion Kronos, plongement JEPA,
financement, intérêt ouvert, volatilité, heure, jour, winrate glissant de la
perle sur 7 jours. Modèle : LightGBM **ou** MLP, le choix est libre ; ce qui
n'est pas libre est la validation (§5). Sortie : `hermes_meta.onnx`. Usage :
le moteur n'entre que si p ≥ seuil choisi sur la validation ; la marge est
modulée entre 0,5 × et 1 × selon p. Le refus est journalisé (`[META]`) et
visible dans le guet (`garde: "meta"`).

### Couche 3 — Risque de portefeuille

- **Ciblage de volatilité** : marge par trade ∝ 1 / volatilité 24 h de
  l'instrument, plafonnée par les règles existantes (`HERMES_MARGIN_MIN/MAX`,
  places). N'entre en vigueur qu'avec l'accord du propriétaire pour tout
  changement de levier ou de `HERMES_MAX_RISK_PCT`.
- **Exécution maker** : vérifier ce que fait déjà `HERMES_MAKER_WAIT_MS`,
  mesurer sur les journaux la part réelle d'ordres maker, et améliorer (ordre
  limite au meilleur prix, attente courte, repli marché) : c'est le gain le
  plus sûr de toute la mission (frais ÷ 2,5).
- **Coupe-circuit** : état `choc` ou drawdown 24 h > seuil (paramètre
  `HERMES_COUPE_DD24`, défaut prudent) → plus d'entrées ; journal `[COUPE]`
  ; puce visible sur la page Marché.
- Garde de corrélation existante : conserver.

---

## 5. Protocole de validation, obligatoire pour tout ce qui est appris

1. **Découpage par le temps** : entraînement / validation / test, avec un
   embargo d'au moins une fenêtre de contexte à chaque frontière. Le test
   couvre **au moins six mois** jamais regardés, et contient au moins un
   retournement de marché documenté (2025-2026 en offre plusieurs).
2. **Validation glissante** (walk-forward) pour tout ce qui touche à la
   sélection de perles ou au méta-modèle : réentraîner à chaque pas,
   n'évaluer que sur le pas suivant.
3. **Le test est lu une seule fois**, avec la combinaison choisie sur la
   validation. Pas de repêchage, pas de « deuxième essai ».
4. **Témoins obligatoires** : marche aléatoire, momentum 1 h, régression
   logistique sur caractéristiques brutes, et les perles actuelles **sans**
   les nouvelles couches. Chaque couche doit battre les témoins sur le test,
   sinon elle n'est pas branchée.
5. **Banc de marchés aléatoires** : tout juge (chercheur enrichi,
   méta-modèle) doit être passé sur des marches aléatoires et n'y trouver
   presque rien. Un système qui trouve des perles dans du bruit n'est pas
   branché.
6. **Simulation fidèle** : `modules/backtest.js` fait foi. Toute
   réimplémentation (Python, Colab) est vérifiée trade par trade contre le
   JavaScript sur les mêmes données (le carnet JEPA livré contient cette
   vérification : 3 906 trades, zéro écart).
7. **Coûts** : taker 0,05 % par jambe partout, sauf pour la mesure de
   l'exécution maker qui utilise le taux maker réel du compte.

---

## 6. Ce qui existe déjà et se réutilise

- `recherche/jepa/hermes_jepa_colab.ipynb` : téléchargement Binance /
  repli OKX, onze caractéristiques causales, JEPA (contexte 24 h, cible 4 h),
  sonde, témoins, banc d'essai fidèle, export ONNX vérifié. Réutiliser la
  collecte, les caractéristiques, le simulateur et l'export. Ne pas
  redévelopper ce qui y est.
- `modules/backtest.js` et `deploy/chercher_perles.js` : le juge à enrichir
  (par état de régime), pas à remplacer.
- `banc/` : fixtures et scènes à étendre pour chaque ajout d'interface.

---

## 7. Livrables attendus, dans l'ordre

1. `recherche/regime/hermes_regime_colab.ipynb` : collecte (bougies,
   financement, intérêt ouvert), étiquetage par règles + HMM en comparaison,
   classifieur causal, validation §5, export `hermes_regime.onnx` +
   normalisation, rapport JSON, et un graphique de l'état dans le temps
   superposé au prix BTC (contrôle visuel du sens des états).
2. `modules/regime.js` + branchement dans `app/main.js` : état toutes les 5
   minutes, garde `"regime"` dans `expliquerGarde`, journal `[REGIME]`,
   canal `laboratoire` enrichi (`regime: {etat, probas, ts}`), puce d'état
   sur la page Marché et sur chaque perle du Laboratoire (états autorisés,
   état courant), clés i18n FR/EN/SQ, fixtures et scène du banc.
3. `deploy/chercher_perles.js` : validation par état, champ
   `etatsAutorises` par perle, verdict imprimé enrichi, banc de marchés
   aléatoires repassé et journalisé.
4. `recherche/kronos/hermes_kronos_colab.ipynb` : fine-tuning de
   Kronos-small sur 15 min et 1 h, sorties mouvement/dispersion, signal
   `kronos` jugé par le simulateur fidèle, export.
5. `modules/signaux.js` : signal `kronos` (et `jepa` si mérité) via
   onnxruntime-node, avec **repli à 0** si le modèle ou la bibliothèque
   manque, pour que le moteur ne dépende jamais d'eux pour tourner.
6. `recherche/meta/hermes_meta_colab.ipynb` + `modules/meta.js` : méta-modèle,
   seuil et modulation de marge, garde `"meta"`, journal `[META]`.
7. Couche risque : mesure de l'exécution maker sur les journaux, amélioration,
   coupe-circuit, ciblage de volatilité **proposé** au propriétaire avec les
   chiffres, activé seulement sur son accord.
8. `deploy/install.sh` : installation de `onnxruntime-node` et dépôt des
   modèles dans `runtime/modeles/` (exclu du rsync ; livrés par un nouveau
   champ `workflow_dispatch` `modeles` en base64 ou par téléchargement d'une
   release privée, au choix, sans jamais mettre de secret dans le dépôt).
9. Documentation : `docs/regime.md`, `docs/meta.md`, mise à jour de
   `banc/README.md`.

Chaque livrable est **commité et poussé séparément**, avec le banc vert,
et déployé par le workflow (`demarrer=true`, `chercher=true` quand le
chercheur change) ; le verdict du run est lu et rapporté au propriétaire.

---

## 8. Critères d'acceptation (sur le test, jamais sur la validation)

| Couche | Critère |
|---|---|
| Régime | Les états sont lisibles sur le graphique BTC (les chocs de 2025-2026 sont marqués « choc ») ; les perles actuelles, filtrées par état, ont sur le test un gain net supérieur et un drawdown inférieur à sans filtre, sur au moins 7 perles sur 10 |
| Signal kronos / jepa | Passe les portes du chercheur sur au moins 3 instruments du test, bat le témoin brut ; sinon, n'est pas branché et le rapport le dit |
| Méta-modèle | À seuil choisi sur la validation, sur le test : winrate des trades acceptés ≥ winrate sans filtre + 5 points, gain net ≥ gain sans filtre, nombre de trades ≥ 40 % des trades initiaux |
| Maker | Part d'ordres maker mesurée avant/après ; coût moyen par trade en baisse, journalisé |
| Banc aléatoire | Le juge enrichi trouve ≤ 1 perle sur 10 marches aléatoires |
| Console | `banc/epreuve_langues.js` et `banc/scene-details.js` verts ; aucune régression sur les pages existantes |

Ce qui ne passe pas n'est pas branché, et le rapport final le dit
clairement. Un résultat plat honnêtement rapporté vaut mieux qu'un
branchement flatteur.

---

## 9. Interdits et règles de conduite

- **Secrets** : aucune clé API, aucun mot de passe, aucun jeton dans le
  dépôt, dans les journaux de run, dans les messages de commit, ni dans les
  arguments de ligne de commande. Le mot de passe root ne passe que par
  l'entrée masquée `root_password` du workflow. La clé de console
  (`HERMES_DASH_TOKEN`) vit dans `.env` sur la machine. Ne jamais afficher
  les clés OKX. L'adresse e-mail du propriétaire sert à l'identification
  seulement.
- **Branche** : développer et pousser uniquement sur
  `claude/hermes-crypto-prediction-verify-q9r6qy`. Pas de pull request sans
  demande explicite. Si le conteneur est réinitialisé (arbre revenu à un
  ancien commit, `node_modules` absent) : `git fetch origin <branche> &&
  git checkout -B <branche> origin/<branche>`, puis réinstaller
  `playwright-core` dans `banc/`.
- **Commits** : messages en français, descriptifs, sans identifiant de
  modèle. Trailer exigé : `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
  (adapter au modèle réellement utilisé si le harnais l'impose).
- **Compte réel** : `OKX_SIMULATED=0`. Ne jamais changer levier,
  `HERMES_MAX_RISK_PCT`, `HERMES_MAX_POSITIONS`, `HERMES_PLACES` sans accord
  explicite du propriétaire. Ne jamais fermer une position par code
  nouveau sans son accord. Ne jamais réactiver `app/patch.auto_reopen.js`.
- **Réseau** : ne pas contourner la politique réseau, ne jamais désactiver
  TLS ni retirer `HTTPS_PROXY`. Le VPS n'est pas joignable depuis la
  session : tout passe par le workflow.
- **Console** : pas d'emojis ; thème noir & champagne ; vert pour long/gain,
  rouge pour short/perte, jamais de bleu sur les longs ; chiffres en Inter
  tabulaire, mono réservé au journal ; phrases complètes ; toute chaîne
  passe par `t()` en FR/EN/SQ.
- **Honnêteté du rapport** : ne jamais affirmer un état du serveur sans
  l'avoir lu dans un journal de run ; ne jamais présenter un résultat de
  validation comme un résultat de test ; si un test échoue, le dire avec la
  sortie.
- **Scope** : le chercheur de perles reste le juge, le moteur ne trade que
  des perles validées. Aucune couche nouvelle ne court-circuite cette règle.

---

## 10. Sources (état de l'art vérifié le 2 septembre 2026)

- Kronos : dépôt https://github.com/shiyu-coder/Kronos, article
  https://arxiv.org/abs/2508.02739, tests indépendants
  https://github.com/shiyu-coder/Kronos/issues/375 et
  https://github.com/shiyu-coder/Kronos/issues/355
- Chronos-2 : https://www.amazon.science/blog/introducing-chronos-2-from-univariate-to-universal-forecasting
- TimesFM-3 : https://www.marktechpost.com/2026/08/31/google-ai-releases-timesfm-3-a-330m-parameter-zero-shot-foundation-model-for-multivariate-time-series-forecasting/
- Modèles de fondation et rendements financiers : https://arxiv.org/abs/2606.27100
- FinCast : https://github.com/vincent05r/FinCast-fts
- TradingAgents : https://github.com/tauricresearch/tradingagents ;
  Trading-R1 : https://arxiv.org/pdf/2509.11420 ;
  LiveTradeBench : https://arxiv.org/pdf/2511.03628 ;
  RD-Agent : https://github.com/microsoft/rd-agent
- Suivi de tendance crypto adaptatif : https://arxiv.org/abs/2602.11708
- Jane Street / Numerai : https://forum.numer.ai/t/autoencoder-and-multitask-mlp-on-new-dataset-from-kaggle-jane-street/4338
