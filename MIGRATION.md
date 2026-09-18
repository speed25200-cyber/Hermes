# Migration vers la plateforme quantitative OKX + JEV

Ce dépôt contient l'ancien Hermes (Node.js). Il est **remplacé** par une plateforme quantitative
construite selon la spécification maîtresse, qui vit dans un autre dépôt :

**<https://github.com/speed25200-cyber/Hermes-Fork>**, branche `claude/hermes-fork-migration-m4wcbm`.

L'interface graphique de Hermes y est **conservée** — mêmes couleurs, mêmes composants, même trilingue
français / anglais / albanais — puis étendue de quatre vues : Décisions, Recherche, JEV, Risque.

## Pourquoi la migration se déclenche depuis CE dépôt

La plateforme est dans `Hermes-Fork`, mais le secret `VPS_PASSWORD` est enregistré dans les secrets
Actions de **ce** dépôt. Le workflow
[`migrer-vers-okxq.yml`](.github/workflows/migrer-vers-okxq.yml) récupère donc la plateforme depuis
`Hermes-Fork` et l'installe, en utilisant le secret qui vit ici.

`Hermes-Fork` est un dépôt **public** ; aucun jeton n'est nécessaire pour l'y récupérer. Si sa
visibilité devenait privée, il faudrait ajouter un `token:` à l'étape de récupération — le travail
échouerait alors franchement plutôt que de continuer à moitié.

## Ce que la migration fait, dans cet ordre

1. **Relevé préalable** : combien de positions sont ouvertes sur l'ancien moteur.
2. **Reprise de la clé de console** : la clé du tableau de bord que vous connaissez devient la clé
   opérateur de la nouvelle interface, de machine à machine. Votre lien continue de fonctionner.
3. **Copie de la plateforme** et construction de l'image Docker, **pendant que l'ancien moteur tourne
   encore**.
4. **Retrait de l'ancien Hermes et effacement de ses données** (services systemd, dossiers, caches).
5. **Installation et démarrage** en profil `paper` : aucune clé OKX requise, LIVE désactivé.

## Trois gardes, et pourquoi elles existent

| Garde | Effet |
| --- | --- |
| `confirmer` doit valoir exactement `EFFACER` | un effacement ne s'improvise pas |
| refus si des positions sont **ouvertes** sur l'ancien moteur | sauf `positions_ouvertes=accepter` |
| refus si l'état des positions n'a **pas pu être déterminé** | sauf `positions_inconnues=accepter` |

La troisième est la plus importante, et la moins évidente. Un moteur arrêté **ne ferme aucune
position** : elles restent ouvertes chez OKX. Si le relevé ne peut pas lire l'état (service arrêté,
console injoignable, jeton absent), la réponse honnête est « je ne sais pas », pas « il n'y a rien ».
Traiter l'inconnu comme zéro reviendrait à effacer la machine qui supervisait ces positions en croyant
qu'il n'y en avait aucune.

## Avant de lancer

1. Vérifiez **directement sur OKX** qu'aucune position n'est ouverte, et fermez ce qui doit l'être.
2. L'effacement est **irréversible**. Si vous voulez garder quoi que ce soit de l'ancien Hermes,
   copiez-le d'abord.
3. Lancez le workflow avec `migrer=true` et `confirmer=EFFACER`. Le profil par défaut est `paper`.

## Après la migration

L'interface répond sur le port 8899, et la porte est fermée sans clé : une réponse `403` sur `/` sans
clé est le **bon** comportement. `/health/ready` peut renvoyer `503` au premier démarrage, le temps
que la réconciliation et les données soient prêtes.

Aucun passage en argent réel n'est possible sans une autorisation explicite : LIVE est désactivé par
conception et exige un manifeste d'approbation signé. Voir `docs/live_readiness.md` dans
`Hermes-Fork`, dont le verdict actuel est un refus.

## Où lire la suite

Tout est dans `Hermes-Fork` : `DELIVERY_REPORT.md` (ce qui est vérifié et ce qui ne l'est pas),
`BUILD_STATUS.md` (avancement et défauts connus), `docs/runbooks/` (démarrer, arrêter, sauvegarder,
tourner les clés), `docs/threat_model.md` et `docs/test_matrix.md`.
