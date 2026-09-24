#!/usr/bin/env bash
# Champion / challenger : installe le modèle <dossier> comme champion selon une règle unique, partagée par le
# réentraînement mensuel sur runner GitHub (workflow Retrain) et par retrain.sh sur un VPS d'au moins 12 Go.
# Même configuration que le champion : la nouvelle évaluation (plus de données) fait foi et le remplace
# toujours -- un champion promu qui échoue désormais la porte est rétrogradé (le moteur réel aplatit alors le
# livre) ; une réussite chanceuse ne devient jamais permanente.
# Configuration différente : le challenger ne remplace le champion que s'il est promu, ou si le champion ne
# l'est pas lui-même. Le moteur recharge le modèle à chaud (sans redémarrage).
# Usage (root, depuis n'importe où) : bash /opt/hermes/deploy/challenger.sh <dossier du modèle>
set -euo pipefail
NEW_DIR="${1:?usage : challenger.sh <dossier du modèle>}"
cd "${HERMES_ROOT:-/opt/hermes}"
HERMES="${HERMES_BIN:-.venv/bin/hermes}"
as_hermes() {
  if [ "$(id -u)" = 0 ] && id hermes >/dev/null 2>&1; then runuser -u hermes -- "$@"; else "$@"; fi
}
meta() { python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2], ''))" "$1" "$2"; }
NEW="$NEW_DIR/bundle.json"
[ -f "$NEW" ] || { echo "pas de modèle : $NEW" >&2; exit 1; }
NEW_PROMOTED=$(meta "$NEW" promoted)
CUR=artifacts/models/champion/bundle.json
CUR_PROMOTED=False
CUR_HASH=""
if [ -f "$CUR" ]; then
  CUR_PROMOTED=$(meta "$CUR" promoted)
  CUR_HASH=$(meta "$CUR" config_hash)
fi
if [ "$(meta "$NEW" config_hash)" = "$CUR_HASH" ] || [ "$NEW_PROMOTED" = "True" ] || [ "$CUR_PROMOTED" != "True" ]; then
  as_hermes "$HERMES" model install "$NEW_DIR" --to artifacts/models/champion
  echo "champion remplacé (promu=$NEW_PROMOTED, entraîné jusqu'au $(meta "$NEW" train_end))"
else
  echo "challenger d'une autre configuration non promu : le champion promu reste en place"
fi
