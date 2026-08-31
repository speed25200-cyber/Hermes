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
# Jai dabord chasse les dossiers un par un — data365, puis rapports —
# et le second refus a montre data90, data180, databinance : meme
# nature, autres noms. Nommer les coupables un par un ne pouvait pas
# converger. La regle qui les couvre tous est une regle de TAILLE :
# dans ce projet, un fichier volumineux est une donnee, jamais du code.
#
# Le seuil est donc pose a $SEUIL_KO, et ce qui tombe dessous est
# imprime : une regle de taille peut ecarter un vrai fichier source, et
# une exclusion quon ne voit pas est une exclusion quon ne corrige pas.
# La seule exception est nommee a la main, arborescence_et_code.txt,
# parce que cest le vidage du projet par son auteur et quil vaut ses
# cinq megaoctets.
SEUIL_KO=400
LISTE=/tmp/astra_liste.txt
EXCLUS=/tmp/astra_exclus.txt
# Les listes sont refaites a chaque fois : laissees en place, elles
# sallongeraient dune execution a lautre et le paquet grossirait sans
# quaucune ligne du rapport ne le dise.
rm -f "$LISTE" "$EXCLUS"

# La taille vient de find lui-meme (-printf %s). Un stat par fichier,
# sur pres de cinq mille, coute une minute pour rien. Le separateur est
# une tabulation parce que les noms contiennent des espaces — il y a un
# « Archives app/index.html.backup ( Version okey sauf bouton).html »
# dans cette arborescence, et un decoupage sur lespace le perdrait.
find . -type f \
  -not -path "*/node_modules/*" \
  -not -path "./data/*" -not -path "./logs/*" -not -path "./.git/*" \
  ! -name "*.pak" ! -name "*.map" ! -name "*.jsonl" \
  ! -name "*.log" ! -name "*.asar" ! -name "*.node" \
  -printf "%s\t%p\n" \
| awk -F'\t' -v s=$((SEUIL_KO * 1024)) -v l="$LISTE" -v e="$EXCLUS" '
    $1 + 0 < s { print $2 > l; next }
                { printf "%10d  %s\n", $1, $2 > e }'

# La seule exception, nommee a la main : le vidage du projet par son
# auteur vaut ses cinq megaoctets.
echo "./arborescence_et_code.txt" >> "$LISTE"

echo "  ecartes par la regle de taille (plus de ${SEUIL_KO} Ko) : $(wc -l < "$EXCLUS" 2>/dev/null || echo 0) fichiers"
echo "  les 20 plus gros ecartes — verifier quaucun nest du code :"
sort -rn "$EXCLUS" 2>/dev/null | head -20 | sed -e "s/^/    /"
echo

tar czf "$PAQUET" -T "$LISTE" 2>/dev/null

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
