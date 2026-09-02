# Le banc d'essai

Les scenes Playwright et les epreuves du tableau de bord. Il vit dans
le depot parce que l'environnement de travail est ephemere : un banc
qui disparait a chaque reset n'est pas un banc.

    cd banc && npm install
    node epreuve_langues.js            # parite des trois langues
    node epreuve_juge.js               # melange par blocs et distribution nulle
    node epreuve_regime.js             # sens, causalite, parite vivant/banc
    node epreuve_hors_echantillon.js   # l'hypothese pre-inscrite est-elle encore gelee
    node scene-details.js              # tout ce qui se deplie, verifie en contenus

Le `package.json` de ce dossier est VERSIONNE, et il faut qu'il le
reste. Sans lui, `npm install` lance ici remonte jusqu'a la racine et
inscrit le pilote de navigateur dans les dependances du MOTEUR, qui
part ensuite sur un VPS de deux gigaoctets. C'est arrive : le manifeste
de la racine a gagne une ligne `playwright-core` qu'il a fallu retirer
a la main. Les outils d'essai vivent ici et n'en sortent pas ; ce
dossier est exclu du rsync de deploiement.

Chromium est attendu a /opt/pw-browsers/chromium (PLAYWRIGHT_BROWSERS_PATH).
Le double du pont (pont-double.js) sert des donnees fixes : aucune cle,
aucun reseau, aucun ordre.
