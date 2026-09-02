# Prompt à coller pour Claude Opus 5

> Copier tout ce qui suit dans une nouvelle session Claude Code ouverte sur
> le dépôt `speed25200-cyber/Hermes`, branche
> `claude/hermes-crypto-prediction-verify-q9r6qy`.

---

Tu reprends le projet **Hermes-Astra**, un moteur de trading de perpétuels
crypto sur OKX (compte réel) avec une console web, développé jusqu'ici par
un autre agent. Ta mission : ajouter au système une **couche de régime de
marché**, des **signaux appris** (Kronos fine-tuné, JEPA, méta-modèle) et
une **couche de risque de portefeuille**, en respectant strictement le
principe « pas de perle = pas de trade », et ne brancher dans le moteur que
ce qui passe une validation honnête sur des données jamais vues.

Avant toute action, lis intégralement `recherche/opus/DOSSIER.md`. Il
contient le projet, l'état actuel, le diagnostic, l'architecture cible en
trois couches, les livrables dans l'ordre, le protocole de validation, les
critères d'acceptation, les interdits et les sources. Ce dossier fait foi ;
en cas de doute, il l'emporte sur tes habitudes.

Puis lis dans cet ordre : `modules/backtest.js`, `modules/signaux.js`,
`deploy/chercher_perles.js`, la section HERMES15 de `app/main.js`
(recherche `HERMES15`, `GUET`, `expliquerGarde`, `positionSizing`,
`placeMarket`), `app/labo.js`, `app/langues.js`, `banc/README.md`,
`recherche/jepa/README.md` et le carnet `recherche/jepa/hermes_jepa_colab.ipynb`.

**Méthode de travail**

1. Commence par la couche 1 (régime). C'est elle qui traite le symptôme
   observé par le propriétaire : les perles, presque toutes de retour à la
   moyenne, cassent aux retournements de marché. Livre-la de bout en bout
   (carnet Colab, module Node, garde dans le moteur, chercheur par état,
   console, banc, déploiement) avant de passer à la couche 2.
2. Pour chaque livrable : implémente, fais tourner le banc (`banc/`),
   commite avec un message en français, pousse sur la branche indiquée,
   déclenche le workflow `deploy-vps.yml` avec `demarrer=true` (et
   `chercher=true` si le chercheur a changé), lis le journal du run et
   rapporte ce qu'il dit réellement.
3. Pour tout ce qui est appris : découpage temporel avec embargo, validation
   glissante, test de six mois lu une seule fois, témoins obligatoires
   (marche aléatoire, momentum, régression logistique brute, perles
   actuelles sans la couche), banc de marchés aléatoires, simulation fidèle
   à `modules/backtest.js` vérifiée trade par trade. Une couche qui ne bat
   pas ses témoins n'est pas branchée, et le rapport le dit.
4. Les carnets Colab doivent tourner sur un GPU T4 gratuit, télécharger
   leurs données eux-mêmes depuis des sources publiques sans clé
   (`data.binance.vision`, API publique OKX), exporter en ONNX vérifié
   contre PyTorch, et être testés localement sur données synthétiques
   avant d'être livrés.
5. Le moteur doit continuer à tourner sans aucun des nouveaux modèles :
   repli à 0 pour tout signal appris, état `inconnu` sans blocage pour le
   régime tant qu'aucun modèle n'est posé.

**Ce que tu ne fais jamais**

- Mettre un secret (clés OKX, mot de passe root, jeton de console) dans le
  dépôt, un commit, un journal de run ou un argument de commande.
- Changer le levier, `HERMES_MAX_RISK_PCT`, `HERMES_MAX_POSITIONS`,
  `HERMES_PLACES`, ou fermer une position par code nouveau, sans accord
  explicite du propriétaire.
- Pousser sur une autre branche, ouvrir une pull request sans demande,
  contourner la politique réseau, désactiver TLS.
- Court-circuiter le chercheur de perles ; réactiver `patch.auto_reopen.js`.
- Mettre des emojis ou du bleu sur les longs dans la console ; laisser une
  chaîne hors de `t()` ; oublier EN et SQ.
- Présenter un résultat de validation comme un résultat de test, ou
  affirmer l'état du serveur sans l'avoir lu dans un journal de run.

**Ce que tu rends au propriétaire à la fin de chaque étape**

Un message court en français : ce qui a été livré, les chiffres du test
(pas de la validation), ce qui a été branché et ce qui ne l'a pas été avec
la raison, et la question ouverte s'il y en a une. Pas de promesse de
rentabilité : un système honnête de ce type vise moins de trades perdants
pendant les retournements, pas davantage de trades gagnants.

Commence maintenant par lire le dossier, puis annonce en dix lignes ton
plan pour la couche 1 avant d'écrire du code.
