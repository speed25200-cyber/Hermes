#!/usr/bin/env bash
# Tourne SUR LE VPS, pousse par « ssh ... bash -s -- <uuid> ».
#
# Deux etapes, et la seconde peut tourner seule : rapatrier, puis DECRIRE.
# Le telechargement est idempotent — un fichier deja present a la bonne
# taille nest pas re-tire. Cela compte : le lien porte un compteur de
# telechargements, et relancer linspection ne doit pas le consommer.
#
# Linspection se fait en Python et non avec file/unzip : la machine na
# ni lun ni lautre. Une inspection qui depend doutils absents nest pas
# une inspection, cest une ligne « command not found ».
set -u

UUID="${1:?usage: rapatrier_archive.sh <uuid-swisstransfer>}"
DEST=/root/incoming
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"

mkdir -p "$DEST"
cd "$DEST" || exit 1

echo "===== 1. interrogation du lien ====="
echo "uuid: $UUID"
code=$(curl -sS -L --max-time 60 -A "$UA" \
       -H "Accept: application/json" \
       -w "%{http_code}" \
       "https://www.swisstransfer.com/api/links/$UUID" -o link.json)
echo "http: $code   octets: $(wc -c < link.json 2>/dev/null || echo 0)"
if [ "$code" != "200" ]; then
  echo "!! l API n a pas repondu 200 :"
  head -c 1000 link.json 2>/dev/null; echo
  exit 1
fi

python3 - "$UUID" <<'PY' > plan.txt
import json, sys
uuid = sys.argv[1]
d = json.load(open("/root/incoming/link.json"))
if isinstance(d, dict) and "data" in d:
    d = d["data"]
if isinstance(d, list) and d:
    d = d[0]
host = d.get("downloadHost") or "www.swisstransfer.com"
link = d.get("linkUUID") or uuid
cont = d.get("container") or {}
print("HOST\t%s" % host)
print("LINK\t%s" % link)
for f in (cont.get("files") or d.get("files") or []):
    print("FILE\t%s\t%s\t%s" % (f.get("UUID") or "",
                                f.get("fileSizeInBytes") or 0,
                                f.get("fileName") or "sans-nom"))
PY

sed -e "s/^/  /" plan.txt
HOST=$(awk -F'\t' '$1=="HOST"{print $2}' plan.txt)
LINK=$(awk -F'\t' '$1=="LINK"{print $2}' plan.txt)
echo

echo "===== 2. telechargement (idempotent) ====="
awk -F'\t' '$1=="FILE"{print $2"\t"$3"\t"$4}' plan.txt | while IFS=$'\t' read -r FID TAI NOM; do
  [ -z "$FID" ] && continue
  DEJA=$(wc -c < "$NOM" 2>/dev/null || echo 0)
  if [ "$DEJA" = "$TAI" ]; then
    echo "  $NOM : deja present, $DEJA octets — pas de nouveau tirage"
    continue
  fi
  echo "  $NOM : attendu $TAI octets, present $DEJA — tirage"
  hc=$(curl -sS -L --max-time 1800 -A "$UA" \
       -H "Referer: https://www.swisstransfer.com/d/$UUID" \
       -w "%{http_code}" \
       "https://$HOST/api/download/$LINK/$FID" -o "$NOM")
  echo "    http $hc, $(wc -c < "$NOM" 2>/dev/null || echo 0) octets"
done
echo

echo "===== 3. ce que larchive contient ====="
python3 - "$DEST" <<'PY'
import os, sys, zipfile, collections, posixpath

dest = sys.argv[1]
for nom in sorted(os.listdir(dest)):
    if nom in ("link.json", "plan.txt"):
        continue
    chemin = os.path.join(dest, nom)
    if not os.path.isfile(chemin):
        continue
    print("--- %s  (%d octets)" % (nom, os.path.getsize(chemin)))
    if not zipfile.is_zipfile(chemin):
        print("    ce nest pas une archive zip")
        continue
    z = zipfile.ZipFile(chemin)
    noms = [i.filename for i in z.infolist() if not i.is_dir()]
    print("    %d fichiers" % len(noms))

    # La racine commune : une archive emballe souvent tout dans un dossier,
    # et savoir lequel evite de deballer au mauvais endroit.
    parts = [n.split("/")[0] for n in noms]
    racines = collections.Counter(parts)
    print("    racines : %s" % ", ".join(
        "%s (%d)" % (r, n) for r, n in racines.most_common(6)))

    ext = collections.Counter(
        posixpath.splitext(n)[1].lower() or "(sans)" for n in noms)
    print("    extensions : %s" % ", ".join(
        "%s %d" % (e, n) for e, n in ext.most_common(14)))

    # Le poids par premier niveau sous la racine : ou est le gros du code,
    # et ou sont les donnees quon ne veut pas embarquer.
    poids = collections.Counter()
    for i in z.infolist():
        if i.is_dir():
            continue
        p = i.filename.split("/")
        cle = "/".join(p[:2]) if len(p) > 1 else p[0]
        poids[cle] += i.file_size
    print("    poids par dossier (Mo) :")
    for cle, o in poids.most_common(18):
        print("      %-46s %8.1f" % (cle, o / 1e6))

    # Les fichiers qui disent ce que le projet EST, avant de lire le code.
    interessants = ("readme", "package.json", "requirements", "pyproject",
                    "setup.py", "dockerfile", "makefile", ".env.example",
                    "config", "vite.config", "tsconfig", "index.html")
    trouves = [n for n in noms
               if any(k in posixpath.basename(n).lower() for k in interessants)]
    print("    fichiers de tete (%d) :" % len(trouves))
    for n in sorted(trouves)[:40]:
        print("      %s" % n)
PY
echo
echo "===== fin ====="
