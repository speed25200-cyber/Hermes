#!/bin/bash
cd "$(dirname "$0")"
OUT=verif_top_resultats.jsonl
: > "$OUT"
for M in web_structure_1 web_orb_1 champions_1 canaux_1 web_vwap_1 sessions_1 oscillo_1 patterns_1 _opt_O champions_2 _opt_YGG patterns_2 patterns_3 _opt_STABLE multiech_2; do
  echo "--- $M ---"
  node verif90_harness.js "candidates/$M.js" | tee -a "$OUT"
done
echo "VERIF TOP TERMINEE"
