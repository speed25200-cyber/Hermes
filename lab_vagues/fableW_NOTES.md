# fableW — ANGLE 1 : combler le winrate (pré-enregistrement, écrit AVANT les runs)

Base (banc3, zéro look-ahead, entrée open bougie suivante) — formule it1 figée
(INV |score|>=2 + vol>=2x méd24h + accord range-24h + verrou 12h, tp80/sl30/act30/cb10/hold12) :
  aout_IS +3.68 wr 51.1 n174 · aout_OOS +9.64 wr 64.6 n130 · epoque2 +18.97 wr 76.1 n155

But : wr >= 55 sur les 3 fenêtres (idéal 60+), esp > 3 partout, sans effondrer n.

Discipline fixée d'avance :
1. fableW_exits : grille de géométrie de sorties sur les ENTRÉES INCHANGÉES de la formule it1.
   Shortlist = cellules avec esp_IS >= 3 ET wr_IS >= 55 ET tous les voisins ±1 cran esp_IS > 0
   (anti-pic isolé). Piège esp-nulle surveillé : une cellule à wr haut mais esp < 3 n'entre PAS.
2. Départage de la shortlist par min(esp_OOS, esp_ep2) puis min des 3 wr. OOS/ep2 ne servent
   JAMAIS à choisir les valeurs de la grille, seulement à départager la shortlist.
3. fableW_filtre : UN filtre supplémentaire unique testé par-dessus la géométrie retenue
   (RSI accord / mèche accord / ret1h contre / sévérité score / sévérité range / volume plus haut).
   Retenu seulement si min des 3 wr monte, esp reste > 3 partout, et n aout total >= 100.
4. fableW_final : chiffres officiels de la formule complète (bootstrap IC90, côtés, coûts x1,5).

Contraintes dures : banc3 uniquement (pas de look-ahead), sl <= 0.30, levier 15, coûts 0,12 %,
paramètres à 1 décimale max (pas de seuils à 3 décimales), aucun chiffre non issu d'un run réel.
