"use strict";

/* Ce script historique contournait le roster signe, le Top 30, le budget
   canary et la preuve de monitoring. Il reste present pour rendre explicite
   la rupture de compatibilite, mais aucune ouverture reelle n'est possible. */
console.error(
  "[HERMES] test_trade.js desactive: utilisez exclusivement l'executeur gate de app/main.js.",
);
process.exitCode = 2;
