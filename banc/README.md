# Le banc d'essai

Les scenes Playwright et les epreuves du tableau de bord. Il vit dans
le depot parce que l'environnement de travail est ephemere : un banc
qui disparait a chaque reset n'est pas un banc.

    cd banc && npm install --no-audit --no-fund playwright-core
    node epreuve_langues.js      # parite des trois langues
    node scene-details.js        # tout ce qui se deplie, verifie en contenus

Chromium est attendu a /opt/pw-browsers/chromium (PLAYWRIGHT_BROWSERS_PATH).
Le double du pont (pont-double.js) sert des donnees fixes : aucune cle,
aucun reseau, aucun ordre.
