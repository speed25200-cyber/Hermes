#!/usr/bin/env bash
# Tourne SUR LE VPS, pousse par « ssh ... bash -s -- <uuid> ».
#
# Trois etapes, et chacune imprime ce qu elle a vu AVANT de decider :
# interroger l API du lien, telecharger les fichiers, dire ce qu ils
# contiennent. La reponse brute de l API est imprimee meme quand tout
# marche, parce que le jour ou le format change, c est la seule chose
# qui permette de comprendre pourquoi sans relancer.
set -u

UUID="${1:?usage: rapatrier_archive.sh <uuid-swisstransfer>}"
DEST=/root/incoming
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"

rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST" || exit 1

echo "===== 1. interrogation du lien ====="
echo "uuid: $UUID"
code=$(curl -sS -L --max-time 60 -A "$UA" \
       -H "Accept: application/json" \
       -w "%{http_code}" \
       "https://www.swisstransfer.com/api/links/$UUID" -o link.json)
echo "http: $code   octets: $(wc -c < link.json 2>/dev/null || echo 0)"
echo "--- reponse brute (3000 premiers octets) ---"
head -c 3000 link.json 2>/dev/null
echo
echo

if [ "$code" != "200" ]; then
  echo "!! l API n a pas repondu 200 — rien a telecharger."
  exit 1
fi

echo "===== 2. ce que le lien contient ====="
python3 - "$UUID" <<'PY' > plan.txt
import json, sys

uuid = sys.argv[1]
d = json.load(open("/root/incoming/link.json"))

# La reponse a deja voyage sous deux formes : un objet avec une cle
# « data », et l objet nu. On accepte les deux plutot que de parier.
if isinstance(d, dict) and "data" in d:
    d = d["data"]
if isinstance(d, list) and d:
    d = d[0]

host = d.get("downloadHost") or d.get("download_host") or "www.swisstransfer.com"
link = d.get("linkUUID") or d.get("linkUuid") or uuid
cont = d.get("container") or {}
files = cont.get("files") or d.get("files") or []

print("HOST\t%s" % host)
print("LINK\t%s" % link)
print("CONTAINER\t%s" % (cont.get("UUID") or cont.get("uuid") or ""))
for f in files:
    fid = f.get("UUID") or f.get("uuid") or ""
    nom = f.get("fileName") or f.get("filename") or "sans-nom"
    tai = f.get("fileSizeInBytes") or f.get("size") or 0
    print("FILE\t%s\t%s\t%s" % (fid, tai, nom))
PY

if [ ! -s plan.txt ]; then
  echo "!! lecture de la reponse impossible."
  exit 1
fi
sed -e "s/^/  /" plan.txt
echo

HOST=$(awk -F'\t' '$1=="HOST"{print $2}' plan.txt)
LINK=$(awk -F'\t' '$1=="LINK"{print $2}' plan.txt)
NFIC=$(awk -F'\t' '$1=="FILE"' plan.txt | wc -l)
echo "  -> $NFIC fichier(s), hote de telechargement: $HOST"
echo

echo "===== 3. telechargement ====="
awk -F'\t' '$1=="FILE"{print $2"\t"$4}' plan.txt | while IFS=$'\t' read -r FID NOM; do
  [ -z "$FID" ] && continue
  echo "--- $NOM"
  for URL in \
    "https://$HOST/api/download/$LINK/$FID" \
    "https://www.swisstransfer.com/api/download/$LINK/$FID" ; do
    hc=$(curl -sS -L --max-time 900 -A "$UA" \
         -H "Referer: https://www.swisstransfer.com/d/$UUID" \
         -w "%{http_code}" "$URL" -o "$NOM")
    sz=$(wc -c < "$NOM" 2>/dev/null || echo 0)
    echo "    $URL -> http $hc, $sz octets"
    [ "$hc" = "200" ] && [ "$sz" -gt 1024 ] && break
  done
done

echo
echo "===== 4. ce qui est arrive ====="
ls -la "$DEST"
echo
for f in "$DEST"/*; do
  case "$f" in
    */link.json|*/plan.txt) continue ;;
  esac
  echo "--- $(basename "$f") : $(file -b "$f")"
  echo "    sha256 $(sha256sum "$f" | cut -c1-16)"
  case "$(file -b "$f")" in
    *Zip*)  echo "    contenu (60 premieres entrees) :"
            unzip -l "$f" 2>/dev/null | head -66 | sed -e "s/^/      /" ;;
    *gzip*|*tar*)
            echo "    contenu (60 premieres entrees) :"
            tar tzf "$f" 2>/dev/null | head -60 | sed -e "s/^/      /" ;;
  esac
done
echo
echo "===== fin ====="
