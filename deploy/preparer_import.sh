#!/usr/bin/env bash
# Tourne SUR LE VPS. Deballe larchive et prepare un paquet MINCE, celui
# quon peut versionner : le code, la config, les documents. Pas les
# dependances, pas les donnees, pas les journaux.
#
# Le paquet est refuse au-dela dun plafond, et le refus IMPRIME les plus
# gros fichiers gardes. Un paquet trop gros nest pas un accident a
# reessayer au hasard : cest une exclusion qui manque, et il faut voir
# laquelle.
set -u

ZIP=/root/incoming/Hermes_Astra.zip
SRC=/root/astra
PAQUET=/root/incoming/astra-source.tar.gz
PLAFOND_MO=60

[ -f "$ZIP" ] || { echo "!! $ZIP absent — lancer dabord le rapatriement"; exit 1; }

echo "===== 1. deballage ====="
if [ -d "$SRC/Hermes_Astra" ]; then
  echo "  deja deballe : $(find "$SRC" -type f | wc -l) fichiers"
else
  mkdir -p "$SRC"
  python3 -c "
import zipfile
zipfile.ZipFile('$ZIP').extractall('$SRC')
print('  deballe')
"
fi
RACINE="$SRC/Hermes_Astra"
[ -d "$RACINE" ] || { echo "!! racine attendue absente"; ls -la "$SRC"; exit 1; }
echo "  racine : $RACINE"
echo

echo "===== 2. ce quon garde ====="
cd "$RACINE" || exit 1
# Les exclusions, et pourquoi chacune :
#   node_modules  se reinstalle depuis package.json, 276 Mo
#   data, logs    des donnees et des traces, pas du code
#   .git          lhistoire dun autre depot
#   .pak .map     des artefacts de build, illisibles et lourds
#   .jsonl .log   des journaux deguises en donnees
#
# Les trois suivantes ont ete ajoutees APRES un premier refus a 150 Mo,
# et cest le refus lui-meme qui les a nommees. Ce ne sont pas des
# dependances mais des donnees de recherche, deguisees en code parce
# quelles sont en JSON et rangees dans des dossiers de code :
#   data365       365 jours de bougies par instrument, ~5 Mo piece
#   rapports      les sorties de scans, jusqua 11,8 Mo lunite
#   *_resultats   les memes, posees hors du dossier rapports
tar czf "$PAQUET" \
  --exclude="*/node_modules" --exclude="node_modules" \
  --exclude="./data" --exclude="./logs" \
  --exclude=".git" \
  --exclude="*.pak" --exclude="*.map" \
  --exclude="*.jsonl" --exclude="*.log" \
  --exclude="*.asar" --exclude="*.node" \
  --exclude="data365" --exclude="rapports" \
  --exclude="*_resultats.json" \
  . 2>/dev/null

MO=$(( $(wc -c < "$PAQUET") / 1000000 ))
NB=$(tar tzf "$PAQUET" 2>/dev/null | grep -vc "/$")
echo "  paquet : ${MO} Mo, $NB fichiers"
echo

# Le poids se lit DANS LE PAQUET et non sur le disque : cest le paquet
# qui part, et un du sur larborescence complete raconte ce quon a
# justement decide de ne pas emporter.
echo "  poids par dossier de premier niveau, tel que le paquet le porte (Mo) :"
tar tzvf "$PAQUET" 2>/dev/null \
  | awk '{ n=$6; sub(/^\.\//,"",n); split(n,p,"/"); poids[p[1]] += $3 }
         END { for (d in poids) printf "%10.1f  %s\n", poids[d]/1e6, d }' \
  | sort -rn | head -20 | sed -e "s/^/    /"
echo

echo "  les 25 plus gros fichiers gardes :"
tar tzvf "$PAQUET" 2>/dev/null | awk '{printf "%12d  %s\n", $3, $6}' \
  | sort -rn | head -25 | sed -e "s/^/    /"
echo

if [ "$MO" -gt "$PLAFOND_MO" ]; then
  echo "!! ${MO} Mo depasse le plafond de ${PLAFOND_MO} Mo — il manque une exclusion."
  echo "   La liste ci-dessus dit laquelle. Rien nest transfere."
  rm -f "$PAQUET"
  exit 1
fi

echo "===== 3. la forme du projet ====="
echo "  arborescence, deux niveaux, sans les dependances :"
find . -maxdepth 2 -not -path "*/node_modules*" -not -path "./data/*" \
       -not -path "./logs/*" -not -path "./.git/*" \
  | sort | head -70 | sed -e "s/^/    /"
echo
echo "  package.json de la racine :"
head -c 1400 package.json 2>/dev/null | sed -e "s/^/    /"
echo
echo "===== fin : $PAQUET pret ====="
