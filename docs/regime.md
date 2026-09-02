# L'état du marché, et ce que les bancs ont trouvé

Ce document décrit la couche de régime ajoutée à Hermes-Astra, les trois
bancs d'essai écrits pour la juger, et ce qu'ils ont mesuré. Il est écrit
pour être lu dans six mois par quelqu'un qui ne se souvient de rien.

## 1. Pourquoi une couche de régime

Les perles retenues par le chercheur sont presque toutes des stratégies
de retour à la moyenne : `vwap_reclaim`, `meche15m`, `meche_regime`,
`keltner3`, `donchian_fade`, `bb_range`, `double_extreme`. Elles gagnent
tant que le marché oscille autour d'une valeur et perdent en série quand
il part en tendance. Le propriétaire décrit exactement ce symptôme :
« ça fonctionne assez bien, puis dès qu'il y a un retournement de marché
ça ne fonctionne plus ».

L'hypothèse était donc : si le moteur savait dans quel état est le
marché, il pourrait se taire dans les états où ses perles perdent.

## 2. Ce qui a été construit

`modules/regime.js` classe le marché en quatre états — `fourchette`,
`tendance_haussiere`, `tendance_baissiere`, `choc` — à partir des seules
clôtures de BTC et d'ETH.

Deux mesures suffisent, et elles sont sans dimension :

| Mesure | Définition | Ce qu'elle dit |
|---|---|---|
| `ratioVol` | écart-type des rendements 5 m sur 1 h ÷ sur 24 h | au-delà de 2,2 : la volatilité explose |
| `force` | déplacement de 24 h ÷ (volatilité 24 h × √288) | au-delà de 1,3 : le mouvement dépasse ce qu'une marche aléatoire produirait |

Le choc est testé en premier : une volatilité qui explose invalide tout
le reste, y compris une belle tendance. ETH ne vote pas à égalité avec
BTC, il confirme — deux marchés qui partent en sens contraire ne sont
pas une tendance de marché mais une rotation, et la moyenne signée des
forces la dégrade correctement vers la fourchette.

### Trois décisions de conception

**Des règles, pas un modèle appris.** Un régime est lent et de faible
dimension. Une règle calibrée est causale, lisible, et surtout identique
partout : le banc, le chercheur et le moteur vivant calculent le même
nombre. Un modèle exporté aurait ajouté une dépendance, un fichier à
poser sur le serveur, et un risque d'écart entre l'entraînement et
l'exécution. Le moteur ne doit jamais pouvoir s'arrêter faute d'un
fichier de modèle. C'est un écart au dossier de mission, qui prescrivait
un export ONNX ; les seuils, eux, restent calibrables hors ligne et
arrivent par `config/regime.json`, dont l'absence est le cas normal.

**BTC et ETH seuls.** La largeur du marché serait un bon indice, mais le
moteur vivant ne tire les bougies que des perles du roster — dix à douze
instruments qui changent toutes les demi-heures — tandis que le banc en
a cinquante. La même formule rendrait deux nombres différents, et l'on
sélectionnerait sur un état pour en trader un autre. Deux instruments
toujours présents : la parité est garantie par construction.

**Écarter les perdants, pas garder les gagnants.** Avec cinq ou dix
trades par état, « elle gagne ici » est du bruit, tandis que « elle
perd ici, sur assez de trades » est une information. Garder les seuls
gagnants transformait le filtre en interrupteur d'arrêt : une perle
validée par le chercheur pouvait être éteinte par une anomalie
d'échantillon. Le défaut est donc le statu quo — sans preuve contre un
état, on y trade.

`banc/epreuve_regime.js` vérifie tout cela en dix-huit points : le sens
des états, la causalité (tronquer le futur ne change aucun état passé),
la parité entre le chemin vivant et le chemin banc sur deux cents
comparaisons, la robustesse aux trous d'horodatage, et le coût.

## 3. Les trois bancs

| Banc | Ce qu'il juge | Commande |
|---|---|---|
| `banc/epreuve_regime.js` | le module lui-même, hors ligne | `node banc/epreuve_regime.js` |
| `deploy/banc_regime.js` | le filtre appliqué au roster en place | entrée `banc_regime` du workflow |
| `deploy/banc_chercheur.js` | le procédé de sélection lui-même | entrée `banc_chercheur` du workflow |

`deploy/histoire_longue.js` alimente les deux derniers en archives
mensuelles publiques de Binance Futures — un zip par mois et par
instrument, sans compte ni clé, avec un lecteur de zip écrit à la main
pour ne pas ajouter de dépendance.

### La discipline commune

1. Le choix se fait toujours sur le passé du bloc mesuré, jamais sur le
   bloc lui-même.
2. La validation est glissante : plusieurs blocs, chacun jugé par ce qui
   le précède.
3. Un **témoin** accompagne chaque filtre : on retire au hasard autant de
   trades, et l'on regarde combien de tirages le filtre bat. Sans lui,
   « filtrer améliore » ne veut rien dire, puisque retirer des trades au
   hasard améliore aussi une fois sur deux quand l'espérance est
   négative.
4. Le simulateur est `modules/backtest.js`, celui du chercheur, importé
   et non recopié.

## 4. Ce que les bancs ont trouvé

### Sur trente jours de données OKX (run 168)

Le marché a passé 87 % du temps en fourchette, 7 % en tendance
haussière, 2 % en tendance baissière. Le filtre n'a écarté que sept
trades sur trois cent vingt-huit. **On ne peut pas mesurer un filtre de
tendance sur un mois sans tendance** : ce passage ne prouve rien, ni
pour ni contre.

Le détail par état, lui, allait dans le sens de l'hypothèse : six perles
sur neuf perdaient en tendance haussière.

### Sur douze mois d'archives, roster figé (run 169)

| État | Trades | Winrate | Net | Par trade |
|---|---|---|---|---|
| fourchette | 4 210 | 61,5 % | −40,45 | −0,0096 |
| choc | 456 | 64,0 % | −4,33 | −0,0095 |
| tendance baissière | 411 | 61,8 % | −7,44 | −0,0181 |
| tendance haussière | 349 | 65,3 % | −0,88 | −0,0025 |

Le roster actuel, rejoué sur un an, **perd de l'argent dans les quatre
états**. Le filtre par état améliore le net de −51 à −23, mais il ne
bat que 9 % des retraits au hasard de même taille : l'amélioration vient
de trader moins, pas de trader mieux. Le témoin a fait son travail.

**La décomposition est le vrai résultat.** Sur 5 167 trades, les frais
coûtent 0,015 de marge par trade, soit 77 au total, pour un net de −51.
Brut de frais, le procédé rapporte donc environ +26, soit +0,005 par
trade. Les stratégies ont un petit avantage réel que les frais mangent
entièrement.

Deux réserves sur ce chiffre, qui comptent : le roster était figé alors
qu'Hermes reselectionne toutes les trente minutes, et les archives sont
des perpétuels Binance, proches mais pas identiques à OKX.

## 5. Ce qui n'a pas été branché, et pourquoi

Rien. Au 2 septembre 2026, la couche de régime existe, elle est testée
et mesurée, mais **elle n'est câblée ni dans le moteur ni dans le
chercheur**, parce qu'aucune mesure ne l'a encore méritée. Le critère
d'acceptation du dossier de mission — améliorer sept perles sur dix hors
échantillon — n'est pas atteint dès lors que le filtre perd contre son
propre témoin.

La suite ne consiste pas à régler les seuils du régime jusqu'à ce qu'un
chiffre passe. Un filtre qui n'aide que sous un réglage sur trente-six
n'a pas été mesuré, il a été trouvé. La suite consiste à traiter ce que
les chiffres désignent : le coût de transaction.

---

## Addendum du 2 septembre 2026 : ce que le régime est devenu

La couche de régime **n'a pas été câblée dans le moteur**, et elle ne le
sera pas sous cette forme. Les mesures ont montré que sur les treize
signaux de retour à la moyenne, le filtre par état fait exactement ce
que ferait un retrait au hasard (témoin entre 14 et 46 %). Sur les six
signaux de suite de tendance, en revanche, il bat 99,8 % des retraits au
hasard — le module fonctionne, il détecte bien ce pour quoi il a été
écrit, mais il était appliqué à la mauvaise famille de stratégies.

`modules/regime.js` et son épreuve restent dans le dépôt pour deux
raisons : ils sont corrects et vérifiés, et le jour où une famille de
stratégies sensible au régime passera la porte du hasard, la couche sera
prête sans un jour de travail supplémentaire.

Le travail utile qui en est sorti n'est pas le filtre, c'est la
**méthode** : le mélange par blocs, le témoin de retrait au hasard, la
validation glissante. Ces trois outils ont servi à établir que le juge
du chercheur ne mesurait pas un avantage, et ils vivent maintenant dans
`modules/juge.js`, où ils gardent la porte d'entrée du moteur.
