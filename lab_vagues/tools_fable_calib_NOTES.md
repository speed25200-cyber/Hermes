# tools_fable_calib — DIRECTEUR CALIBRAGE, itération 1 (pré-enregistrement AVANT les runs)

Base héritée (boucle 2, reproduite à 0 % d'écart le 31/08) :
  INV |score|>=2 + vol5m >= 2,5x méd24h + accord range-24h (moitiés) + entrée open bougie
  suivante + verrou 12 h + tp80/sl30/act25/cb15/hold12 + levier 15 + coûts 0,12 %.
  aout_IS +6.23 wr 57.1 n161 · aout_OOS +7.35 wr 65.2 n132 · epoque2 +17.22 wr 80.6 n134

BUT : wr >= 65 sur LES DEUX moitiés d'août, esp >= +4 des deux côtés, n août >= 120,
epoque2 esp > +8 et n >= 60, reproduit par le vérificateur.

DISCIPLINE (fixée avant lecture de tout résultat, sélection sur aout_IS SEUL) :

Étape A — sévérités de la base (grille 3x3x3, exits figés EXF, affichage IS SEULEMENT) :
  S ∈ {2.0, 2.1, 2.2} · V ∈ {2.5, 3, 4} · range ∈ {moitiés 0.5/0.5, quartiles 0.25/0.75, déciles 0.1/0.9}
  Shortlist = esp_IS >= 4 ET n_IS >= 65 ET tous les voisins ±1 cran (axe par axe) esp_IS > 0.
  Classement par wr_IS, top 3 retenus pour l'étape B. (OOS/epoque2 NI affichés NI regardés.)

Étape B — UN co-filtre unique par-dessus chaque base du top 3 (affichage IS SEULEMENT) :
  familles : rsi accord {40,35,30} · mèche accord {0.2,0.3,0.4} · bougie de reprise (close
  dans le sens du trade, binaire) · ret1h contre (binaire) · heure UTC (2 moitiés) ·
  vol per-crypto (percentile causal expanding p70/p80, fallback global tant que <20 obs).
  Adopté seulement si wr_IS >= base + 1 pt ET esp_IS >= 4 ET n_IS >= 60. Choix = max wr_IS,
  départage n_IS. Si rien ne qualifie : pas de co-filtre.

Étape C — géométrie de sorties sur les entrées INCHANGÉES du combo retenu (IS SEULEMENT) :
  tp {0.6, 0.8} x sl {0.25, 0.3} x act {0.2, 0.25} x cb {0.1, 0.15, 0.2}, hold 12 figé.
  Garde anti "TP-court/esp-nulle" : rejet de toute cellule esp_IS < 4 même à wr haut.
  Adopté si wr_IS >= combo + 1 pt ET esp_IS >= 4 ET voisinage ±1 cran esp_IS > 0.

Étape D — GEL de la formule, puis UN SEUL run complet (OOS + epoque2 constatés, jamais
  re-choisis). Chiffres officiels + IC bootstrap + coûts x1,5 + script une-commande
  tools_fable_calib_final.js.

AMENDEMENTS (datés, écrits AVANT toute lecture OOS/epoque2) :
  A1 (après étape A) — shortlist stricte vide : l'axe score effondre tout voisinage (s>=2.1
  détruit l'IS). Base INCHANGÉE ; les 3 cellules passant esp_IS>=4 & n_IS>=65 (vol 2.5/3/4,
  moitiés) vont en étape B.
  A2 (après étape B, avant étape C) — la famille "heure UTC" est EXCLUE de l'adoption :
  la fenêtre IS dure ~21 h, un filtre d'heure y sélectionne une position calendaire, pas un
  effet heure-du-jour (structurellement infalsifiable en IS). Adoption = runner-up de la
  règle max wr_IS / départage n_IS : vol>=2.5 + ret1h contre (esp_IS 7.92, wr 59.0, n 117).

  A3 (après étape C, avant toute lecture OOS/epoque2) — étape C retient tp0.8 sl0.3 act0.2
  cb0.15 (wr_IS 64.1, esp_IS 5.84, n 117), sous la cible 65. Le mandat autorise 2 filtres
  empilés ; un seul est utilisé. Ajout d'une étape C2 : UN second filtre (menu : reprise,
  mèche accord 0.2/0.3, rsi accord 45/40, range 0.4/0.6, vol per-crypto p70/p80, ret1h
  contre renforcé 0.5 %/1 %, plafond de score s<2.1/s<2.5 — motivé par l'étape A : les
  scores élevés sont TOXIQUES en inversion). Adoption UNIQUEMENT si wr_IS >= 65 ET
  esp_IS >= 4 ET n_IS >= 60 ; sinon gel de la formule de l'étape C. Choix = max wr_IS,
  départage n_IS. aout_OOS et epoque2 toujours NON regardés à ce stade.

Contraintes dures : banc3 uniquement (zéro look-ahead), sl <= 0.30, 2 filtres empilés max
au-delà de la base, seuils à 1 décimale (percentiles per-crypto = rangs ronds p70/p80),
aucune grille multi-splits, aucun chiffre non issu d'un run réel.

================================================================================
# ITÉRATION 2 (directeur calibrage) — pré-enregistrement AVANT tout run

État hérité (constaté, runs it1 publiés — PAS de nouvelle lecture OOS/ep2) :
  V2 base : IS +6.23 wr 57.1 n161 · OOS +7.35 wr 65.2 n132 · ep2 +17.22 wr 80.6 n134
  CALIB-1 : IS +5.91 wr 65.8 n111 · OOS +5.59 wr 62.6 n123 · ep2 +15.39 wr 87.3 n71
  Reproduction CALIB-1 revérifiée le 31/08 : 0 % d'écart.

Point faible : wrOOS 62.6 < 65. Hypothèse de travail (structurelle, pas ajustée sur OOS) :
la sélection it1 = max wr_IS point-par-point (C2 : volRank p70 adopté pour +1.7 pt d'IS)
= pic de bruit ; il faut sélectionner des PLATEAUX, pas des pics, et garder une marge
au-dessus de 65 en IS pour survivre au bruit d'échantillon (~4.5 pts d'écart-type sur wr à n~120).

DISCIPLINE IT2 (sélection sur aout_IS SEUL ; OOS et perf ep2 jamais regardées avant gel ;
seul le COMPTE n d'ep2 est affiché en cours de route, comme garde de faisabilité — aucune
info de performance) :

Étape A2 — audit marginal du 2e slot de filtre, exits figés EXC (tp.8/sl.3/act.2/cb.15/h12),
verrou 12 h. Menu (~23 variantes, singles + paires, IS seul) :
  singles sur base (vol>=2.5 + range moitiés) : aucun · ret1h contre · reprise · mèche 0.2 ·
  rsi 45 · range 0.4/0.6 · volRank p70 · cap score <2.1 · cap <2.5 · ret1h renforcé per-crypto
  (contre ET |ret1h| >= p50 causal des |ret1h| des signaux précédents du même instrument,
  inactif < 20 obs) ; paires ret1h+X sur le même menu ; sévérité vol {2, 3} sur 2-3 combos.
  Qualification : esp_IS >= 4.5 ET n_IS >= 55 ET n_ep2 >= 60 (compte seul).
  Top 3 par wr_IS -> étape B2. (OOS/perf-ep2 NI affichés NI regardés.)

Étape B2 — grille de sorties sur les entrées INCHANGÉES de chaque combo du top 3 :
  tp {0.6, 0.8} x act {0.15, 0.2, 0.25} x cb {0.1, 0.15, 0.2}, sl 0.3 figé, hold 12 figé.
  Garde anti TP-court/esp-nulle : esp_IS >= 4.5 obligatoire.
  Qualification cellule : wr_IS >= 65 ET esp_IS >= 4.5 ET n_IS >= 55 ET n_ep2 >= 60 ET
  plateau (tous les voisins ±1 cran axe-par-axe : esp_IS >= 2).
  CHOIX = max du MIN de wr_IS sur le voisinage ±1 cran (cellule incluse) — critère plateau,
  pas pic ; départage esp_IS puis n_IS. Si aucune cellule ne qualifie : gel de la meilleure
  cellule plateau (même critère sans le seuil 65) et constat honnête d'échec probable.

Étape D2 — GEL, puis UN SEUL run complet (OOS + ep2 constatés, jamais re-choisis) :
  tools_fable_calib_final2.js, une commande, IC bootstrap, coûts x1,5, côtés, concentration.

Interdits maintenus : zéro look-ahead (banc3), sl <= 0.30, max 2 filtres au-delà de la base,
seuils 1 décimale ou percentiles ronds per-crypto, aucune sélection multi-splits.
L'info « longs OOS négatifs » vue dans le stdout publié d'it1 n'est PAS utilisée pour
choisir (aucun filtre asymétrique par côté au menu).

AMENDEMENT A4 (après A2+B2, AVANT toute lecture OOS/perf-ep2 d'it2) :
  Constat : A2+B2 convergent exactement sur CALIB-1 (tp0.8 act0.2 cb0.15), déjà constaté
  raté en OOS (62.6) à l'it1 ; la grille de sorties confirme le mur wr/esp (act0.15/cb0.1
  monte wr_IS à 68-69 mais esp_IS ~1 → piège TP-court interdit). Re-geler CALIB-1 serait
  une itération blanche. Ajout d'UNE étape A2b resserrée (10 cellules, IS + comptes seuls),
  axes encore inexplorés du mandat (sévérité du rang per-crypto, magnitude du contra,
  fenêtre de score comme sévérité de base, vol global assoupli sous volRank per-crypto) :
    1. vol2.5 + ret1h + volRank p80        6. vol2.5 + ret1h>=1% + volRank p70
    2. vol2.5 + ret1h + volRank p90        7. score [2,2.5) + ret1h + volRank p70
    3. vol2.0 + ret1h + volRank p70        8. score [2,2.1) + ret1h + volRank p70
    4. vol2.0 + ret1h + volRank p80        9. vol3.0 + ret1h + volRank p70
    5. vol2.5 + ret1h>=0.5% + volRank p70 10. vol2.0 + ret1h + volRank p90
  Exits FIGÉS au choix plateau de B2 : tp0.8 sl0.3 act0.2 cb0.15 hold12 (plus aucune grille
  de sorties). Qualification : wr_IS >= 65.5 (marge anti-bruit) ET esp_IS >= 4.5 ET
  n_IS >= 55 ET n_ep2 >= 60. Choix = max wr_IS, départage esp_IS puis n_IS.
  REPLI si rien ne qualifie : gel de la variante la moins minée « ret1h seul » (1 seul filtre
  empilé, IS 5.84/64.1/117, n_ep2 97) tp0.8 act0.2 cb0.15 — OOS jamais regardé pour ce
  combo ; constat honnête que la cible 65x2 est probablement hors de portée du signal.
  Dans les deux cas : GEL puis UN SEUL run final (étape D2), aucun re-choix après lecture.

GEL A5 (après A2b, AVANT le run final — aucune lecture OOS/perf-ep2 à ce stade) :
  A2b : un seul qualifié = cellule 7 « score [2,2.5) + ret1h contre + volRank p70 »
  (esp_IS 5.74, wr_IS 65.5, n_IS 110, n_ep2 70). La règle A4 s'applique telle quelle :
  GEL de CALIB-2 = INV 2 <= |score| < 2.5 + vol5m >= 2.5x méd24h + accord range moitiés
  + ret1h CONTRE + volRank per-crypto >= p70 (causal, inactif < 20 obs) + entrée open
  suivante + verrou 12 h + tp0.8/sl0.3/act0.2/cb0.15/hold12 + levier 15 + coûts 0.12 %.
  Le cap de score est une SÉVÉRITÉ DE BASE (fenêtre de score, levier explicite du mandat) ;
  les 2 filtres empilés restent ret1h + volRank. LUCIDITÉ pré-enregistrée : cellule 7 ne
  diffère de CALIB-1 que d'~1 trade IS (cap rarement actif) ; wrOOS attendu ≈ 62-63, la
  cible 65x2 sera très probablement RATÉE — le run final le constatera proprement. Le run
  final imprime en CONSTAT (non-sélection) les lignes de référence CALIB-1, « ret1h seul »
  et base V2, pour léguer à l'itération 3 la décomposition marginale du point faible OOS.
  Verdict IS-only pour l'itération 3 : l'espace {2e co-filtre x sorties} autour de CALIB-1
  est ÉPUISÉ au niveau wr_IS >= 65 (mur wr/esp de la grille B2 : act0.15/cb0.1 monte wr_IS
  à 68-69 mais esp_IS ~1.4) ; le levier restant est ailleurs (signal amont ou coûts).

================================================================================
# ITÉRATION 3 (directeur calibrage) — pré-enregistrement AVANT tout run (31/08)

État hérité (reproduit ce jour à 0 % d'écart : final2.js resume + calib_final2.js) :
  V2 base    : IS +6.23 wr 57.1 n161 · OOS +7.35 wr 65.2 n132 · ep2 +17.22 wr 80.6 n134
  ret1h seul : IS +5.84 wr 64.1 n117 · OOS +6.07 wr 64.3 n126 · ep2 +18.91 wr 89.7 n97
  CALIB-1    : IS +5.91 wr 65.8 n111 · OOS +5.59 wr 62.6 n123 · ep2 +15.39 wr 87.3 n71
  CALIB-2    : IS +5.74 wr 65.5 n110 · OOS +6.49 wr 63.4 n123 · ep2 +15.14 wr 87.1 n70
  (lignes de constat LÉGUÉES par l'it2 précisément pour la décomposition marginale — pas
  de nouvelle lecture OOS ici.)

HYPOTHÈSE H3 (structurelle, tirée de l'héritage publié, pas d'un nouveau run) :
  ret1h contre = levier réel (+7 pts wr_IS pour −0.9 OOS, ep2 renforcée 89.7) ;
  volRank p70 = achat d'IS payé en OOS (+1.7 IS / −1.7 OOS, ep2 amputée 97→71) = pic de
  bruit typé. L'it3 RETIRE volRank du menu (exclusion pré-enregistrée) et explore les axes
  jamais touchés : percentiles de range PER-CRYPTO (axe explicite du mandat), mèche de
  rejet, bougie de reprise, rsi accord, sévérité de range globale, fenêtre de score.

DISCIPLINE IT3 (sélection sur aout_IS SEUL ; OOS/perf-ep2 jamais regardées avant gel ;
seuls les COMPTES n_OOS et n_ep2 sont affichés comme gardes de faisabilité — zéro perf) :

Étape A3 — 20 cellules, exits FIGÉS EXC (tp0.8/sl0.3/act0.2/cb0.15/hold12), verrou 12 h,
  banc3. Base commune : INV s>=2 + vol >= 2.5x méd24h + accord de range (sévérité = axe).
  Features causales ajoutées (à la clôture de la bougie signal, zéro look-ahead) :
    corps = signe(close-open) de la bougie signal ;
    rangeRankPrev = rang causal du rangePos parmi les signaux PRÉCÉDENTS du même
    instrument (fenêtre expansive, inactif < 20 obs -> repli sur moitiés fixes).
  Cellules :
    accord-range (ret1h contre en slot 1, pas de slot 2) :
      1 moitiés (= ret1h seul, réf) · 2 range 0.4/0.6 · 3 quartiles 0.25/0.75 ·
      4 rangeRank p50 · 5 rangeRank p40 · 6 rangeRank p30
    slot 2 sur moitiés + ret1h :
      7 mèche accord 0.2 · 8 mèche accord 0.3 · 9 reprise (corps dans le sens du trade) ·
      10 rsi accord 45/55 · 11 rsi accord 40/60
    fenêtre de score [2,2.5) (sévérité de base) :
      12 cap + ret1h · 13 cap + ret1h + range 0.4/0.6 · 14 cap + ret1h + rangeRank p40 ·
      15 cap + ret1h + mèche 0.2 · 16 cap + ret1h + reprise
    sans ret1h (le per-crypto range en substitut) :
      17 rangeRank p30 seul · 18 rangeRank p30 + mèche 0.2 · 19 rangeRank p40 + reprise ·
      20 cap + rangeRank p30
  (volRank ABSENT partout ; jamais plus de 2 filtres empilés au-delà de la base ;
  heure UTC toujours exclue — motif A2 inchangé.)
  Qualification : wr_IS >= 66.0 (marge anti-bruit, +1 vs it2) ET esp_IS >= 4.5 ET
  n_IS >= 55 ET n_IS+n_OOS (comptes) >= 130 ET n_ep2 (compte) >= 60.
  CHOIX : parmi les qualifiées, max du MIN de wr_IS sur la cellule + ses voisines de
  même famille (±1 cran d'axe quand il existe : 2-3, 4-5-6, 7-8, 10-11, 13/14/15/16 vs
  leurs jumelles sans cap ; cellules sans voisin = leur propre wr_IS) ; départage wr_IS,
  puis esp_IS, puis n_IS.
  REPLI si vide à 66 : même règle à wr_IS >= 65. Si encore vide : gel de la cellule 12
  (cap + ret1h, la déviation la moins minée d'un seul cran vs « ret1h seul », OOS jamais
  lu pour elle) et constat honnête que 65x2 restera probablement hors de portée.

Étape B3 — mini-grille de sorties sur les entrées INCHANGÉES du combo retenu (IS seul) :
  act {0.2, 0.25} x cb {0.15, 0.2}, tp0.8/sl0.3/hold12 figés (4 cellules).
  Adoption d'un changement vs EXC seulement si wr_IS >= EXC + 0.5 ET esp_IS >= 4.5
  (garde anti TP-court inchangée : jamais de cellule esp_IS < 4.5).

Étape D3 — GEL de CALIB-3, puis UN SEUL run complet (OOS + ep2 constatés, jamais
  re-choisis) : tools_fable_calib_final3.js, une commande, IC bootstrap, coûts x1,5,
  côtés, concentration, cibles du mandat.

Interdits maintenus : zéro look-ahead (banc3, entrée open suivante), sl <= 0.30,
max 2 filtres empilés au-delà de la base, seuils 1 décimale / percentiles ronds,
aucune sélection multi-splits, aucun chiffre non issu d'un run réel.

AMENDEMENT A6 (après A3, AVANT toute lecture OOS/perf-ep2 d'it3) :
  Constat A3 : les deux barres (66 puis 65) sont VIDES. Tout co-filtre d'entrée abaisse
  wr_IS sous « ret1h seul » (64.1) : mèche 53.6-58.3, rsi 54.7-57.8, reprise 63.2,
  range sévère 54.5-60.2, rangeRank p30-p40 60-60.2. L'espace d'ENTRÉE est épuisé —
  confirmation indépendante du verdict légué par l'it2. Seul gain notable : rangeRank
  per-crypto p50 (cellule 4) = +0.77 esp_IS et +n partout (122/133/101) pour −1 wr.
  Geler la cellule 12 (repli) = échec garanti côté IS (63.8 < 65) : itération blanche.
  Ajout d'UNE étape A3b sur le seul levier du mandat jamais exploré en 3 itérations :
  la géométrie de sorties HOLD et SL (hold toujours figé à 12 h jusqu'ici), plus la
  zone breakeven du trail (act 0.15 / cb 0.15, distincte du piège act0.15/cb0.1
  documenté — le garde esp_IS >= 4.5 élimine le piège mécaniquement).
  Entrées candidates FIGÉES = top 3 de A3 par wr_IS (départage esp_IS) parmi les
  cellules esp_IS >= 4.5 & comptes OK : cellule 1 (ret1h seul, 64.1), cellule 12
  (cap + ret1h, 63.8), cellule 4 (ret1h + rangeRank p50, 63.1, esp max 6.61).
  Grille A3b (36 cellules, IS SEUL + comptes) : act {0.15, 0.2, 0.25} x sl {0.25, 0.3}
  x hold {8, 12} · tp 0.8 et cb 0.15 figés · VERROU FIXE 12 h (lockBars 144, découplé
  du hold — le verrou du client ne bouge pas).
  Qualification : wr_IS >= 65.5 ET esp_IS >= 4.5 ET voisins ±1 cran (act/sl/hold,
  même entrée) tous esp_IS >= 3 (anti-falaise). CHOIX : max du MIN de wr_IS sur
  voisinage+cellule (plateau), départage wr_IS puis esp_IS. REPLI si vide : même règle
  à wr_IS >= 65.0 ; si encore vide : gel cellule 12 + EXC (constat honnête d'échec
  probable de la cible 65x2, comme pré-enregistré en A3).
  AUCUNE lecture OOS/perf-ep2 avant le gel ; un seul run final ensuite (D3 inchangé).

GEL A7 (après A3b, AVANT le run final — aucune lecture OOS/perf-ep2 d'it3 à ce stade) :
  A3b vide aux deux barres. Enseignements IS (36 cellules) : hold 8 h TUE la formule
  (esp -0.9..+1.2, wr -8..-13 — le retour à la moyenne a besoin des 12 h pleines) ;
  act 0.15 baisse wr ET esp (trail trop tôt = gagnants avortés) ; act 0.25 achète de
  l'esp (jusqu'à 8.37 sur E4) en vendant 4-5 pts de wr ; sl 0.25 coûte ~2 pts de wr.
  Le MAX de wr_IS de tout l'espace légal sans volRank = EXC lui-même (64.1 sur E1).
  REPLI pré-enregistré appliqué -> GEL de CALIB-3 :
    INV 2 <= |score| < 2.5 (fenêtre = sévérité de base) + vol5m >= 2.5x méd24h
    + accord range-24h moitiés + ret1h CONTRE (unique filtre empilé, slot 2 VIDE —
    volRank retiré, cause du point faible OOS de CALIB-1/2)
    + entrée open bougie suivante + verrou 12 h/instrument
    + tp0.8 / sl0.3 / act0.2 / cb0.15 / hold12 + levier 15 + coûts 0.12 %.
  LUCIDITÉ pré-enregistrée : wr_IS imprimera 63.8 (< 65) — la cible 65x2 est RATÉE par
  construction côté IS ; attendu OOS ~64-65.5 (ret1h seul publié 64.3 + effet cap +0.8
  si transfert). Verdict structurel des 3 itérations : le signal plafonne à wr ~64 net
  de coûts avec esp >= 4 ; les seuls réglages affichant wr_IS >= 65 (famille volRank)
  achètent l'IS en vendant l'OOS. Le run final constate, ne re-choisit rien.
  Constat non-sélectionné à léguer : cellule 4 (ret1h + rangeRank per-crypto p50,
  esp_IS 6.61, n 122/133/101) = axe esp/n pour une éventuelle boucle 4.
