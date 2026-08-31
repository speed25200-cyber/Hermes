# Protocole pré-enregistré (itération 1, avant lecture des résultats complets)

Discipline de sélection, fixée AVANT le run final sur données complètes :

1. La grille stage1 (S x V, exits E1, lock=exit) est balayée sur aout_IS uniquement.
2. Shortlist = cellules avec esp_IS > 0 ET tout le voisinage ±0,1 S / ±0,5 V positif en IS (plateau, pas de pic isolé).
3. Départage de la shortlist par aout_OOS (jamais utilisé pour choisir les valeurs), puis epoque2 en 2e juge.
4. Un seul passage d'affinage (lock / côté / exits) autour de la cellule retenue, avec les mêmes juges.
5. Chiffres officiels = tools_fable_ancienne_final.js sur la formule figée, avec IC bootstrap 90 %.

Aveux de contamination : les grilles lock/diag ont déjà été vues sur données PARTIELLES
(avant fin de collecte data_fable) — impact limité mais non nul ; signalé dans la synthèse.

Caveat survivance : les instruments délistés d'OKX depuis 2025 (fichiers data_fable vides)
sont intestables sur l'époque 2 -> le chiffre epoque2 exclut ces cas.

Contraintes dures respectées : pas de look-ahead (entrée à la clôture de la bougie 5m qui
contient le signal, features calculées sur les 288 bougies closes à cet instant),
sl<=0,30, levier 15, coûts 0,12 %, max 2 filtres empilés (seuil de score + volume),
paramètres à 1 décimale.
