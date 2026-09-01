#!/usr/bin/env bash
# Pose les cles OKX dans /root/hermes/.env, APRES les avoir testees.
#
# Tourne SUR LE VPS. Les valeurs arrivent par lENTREE STANDARD, une par
# ligne, et jamais en argument : un argument est visible dans la liste
# des processus de la machine, le temps que la commande vive. Elles ne
# sont jamais imprimees, ni en clair ni tronquees — une cle a moitie
# affichee reste une cle a moitie divulguee.
#
# Lordre compte : on TESTE dabord, on ecrit ensuite. Une cle posee sans
# etre verifiee est une cle dont on decouvre trois jours plus tard
# quelle portait la mauvaise restriction dIP, ou quil manquait le droit
# de trader. Le moteur, lui, aurait tourne tout ce temps sans rien
# pouvoir ouvrir.
set -u

ENV=/root/hermes/.env

# Deux usages, et le script les distingue tout seul.
#
# Pousse par un workflow, les valeurs arrivent par lentree standard.
# Lance a la main sur le serveur, lentree standard EST le terminal : il
# demande alors les trois valeurs, saisie masquee. Cest la voie qui ne
# depend de personne — ni dun depot, ni dune conversation, ni dun
# service tiers — et cest donc celle qui reste quand les autres
# echouent.
if [ -t 0 ]; then
  echo "Saisie des cles OKX. Rien ne saffiche pendant la frappe, cest normal."
  echo "Coller la valeur puis Entree."
  echo
  printf "  cle dAPI          : "; IFS= read -rs CLE;    echo
  printf "  secret            : "; IFS= read -rs SECRET; echo
  printf "  phrase de passe   : "; IFS= read -rs PASSE;  echo
  printf "  compte demo ? 1=oui 0=non [0] : "; IFS= read -r SIMULE
  SIMULE="${SIMULE:-0}"
  echo
else
  IFS= read -r CLE       || CLE=""
  IFS= read -r SECRET    || SECRET=""
  IFS= read -r PASSE     || PASSE=""
  IFS= read -r SIMULE    || SIMULE=""
fi

# Un secret unique portant les trois valeurs.
#
# Sur telephone, creer trois secrets veut dire remplir trois
# formulaires ; en modifier un seul en veut dire un. Cest une raison
# suffisante pour accepter les deux formes. Quand la premiere ligne
# contient des separateurs et que les deux suivantes sont vides, elle
# est decoupee ici.
#
# Le decoupage se fait sur le SERVEUR et non sur le runner, et ce
# detail nest pas anodin : GitHub masque la valeur EXACTE dun secret
# dans ses journaux, mais pas ses morceaux. Decouper « a:b:c » cote
# runner produirait trois fragments que plus rien ne masquerait.
if [ -n "$CLE" ] && [ -z "$SECRET$PASSE" ]; then
  case "$CLE" in
    *:*|*\|*|*\;*|*,*|*\ *)
      ancien="$CLE"; n=0; CLE=""; SECRET=""; PASSE=""
      for m in $(printf '%s' "$ancien" | tr ':|;, \t' '\n\n\n\n\n\n'); do
        [ -z "$m" ] && continue
        n=$((n + 1))
        case $n in 1) CLE="$m";; 2) SECRET="$m";; 3) PASSE="$m";; esac
      done
      echo "  secret unique detecte : $n morceau(x)"
      if [ "$n" -ne 3 ]; then
        echo "  !! il en faut exactement TROIS, dans cet ordre :"
        echo "     cle:secret:phrase_de_passe"
        echo "     (les separateurs acceptes sont : | ; , espace)"
        exit 1
      fi
      ;;
  esac
fi

manque=""
[ -z "$CLE" ]    && manque="$manque OKX_API_KEY"
[ -z "$SECRET" ] && manque="$manque OKX_API_SECRET"
[ -z "$PASSE" ]  && manque="$manque OKX_API_PASSPHRASE"
if [ -n "$manque" ]; then
  echo "!! secret(s) vide(s) :$manque"
  echo "   Les renseigner dans Settings > Secrets and variables > Actions du depot."
  exit 1
fi

echo "===== 1. epreuve des cles aupres dOKX ====="
echo "  longueurs recues : cle ${#CLE}, secret ${#SECRET}, phrase ${#PASSE}"
echo "  (les valeurs elles-memes ne sont jamais imprimees)"

# La signature OKX est un HMAC-SHA256 encode en base64 sur
# timestamp + methode + chemin. Elle se fait en Node plutot quen bash :
# openssl passerait le secret en argument ou par un fichier temporaire,
# et les deux laissent une trace.
export OKX_CLE="$CLE" OKX_SECRET="$SECRET" OKX_PASSE="$PASSE" OKX_SIMULE="${SIMULE:-0}"
node --input-type=module -e '
const crypto = await import("node:crypto");
const cle = process.env.OKX_CLE, secret = process.env.OKX_SECRET, passe = process.env.OKX_PASSE;
const simule = String(process.env.OKX_SIMULE || "0") === "1";
const chemin = "/api/v5/account/config";
const ts = new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
const sign = crypto.createHmac("sha256", secret).update(ts + "GET" + chemin).digest("base64");
const en = { "OK-ACCESS-KEY": cle, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": ts,
             "OK-ACCESS-PASSPHRASE": passe, "Content-Type": "application/json" };
if (simule) en["x-simulated-trading"] = "1";
const r = await fetch("https://www.okx.com" + chemin, { headers: en });
const j = await r.json().catch(() => ({}));
if (j.code !== "0") {
  // Le message dOKX est repris tel quel : il dit precisement ce qui
  // ne va pas — cle inconnue, phrase fausse, IP non autorisee — et le
  // paraphraser ferait perdre cette precision.
  console.log("  ECHEC  code " + (j.code || "?") + " : " + (j.msg || "reponse illisible"));
  const aide = {
    "50111": "cle dAPI invalide ou inconnue",
    "50113": "signature invalide — le SECRET ne correspond pas a la cle",
    "50105": "phrase de passe invalide",
    "50110": "adresse IP non autorisee : ajouter 178.104.191.79 dans les restrictions de la cle",
    "50102": "horloge de la machine desynchronisee",
  }[String(j.code)];
  if (aide) console.log("  -> " + aide);
  process.exit(1);
}
const d = (j.data && j.data[0]) || {};
console.log("  OK  compte " + (d.uid ? "uid " + String(d.uid).slice(0, 4) + "…" : "?")
  + " | niveau " + (d.acctLv || "?") + " | mode de position " + (d.posMode || "?"));
' || { echo "!! les cles sont refusees par OKX. RIEN na ete ecrit sur le serveur."; exit 1; }

echo
echo "===== 2. ecriture dans $ENV ====="
touch "$ENV"; chmod 600 "$ENV"
# Les anciennes lignes sont retirees avant, sinon dotenv garderait la
# PREMIERE occurrence et la nouvelle cle nauraient servi a rien.
sed -i -E '/^(OKX_API_KEY|OKX_API_SECRET|OKX_API_PASSPHRASE|OKX_SIMULATED|OK_ACCESS_KEY|OK_SECRET_KEY|OK_PASSPHRASE)=/d' "$ENV"
{
  printf 'OKX_API_KEY=%s\n' "$CLE"
  printf 'OKX_API_SECRET=%s\n' "$SECRET"
  printf 'OKX_API_PASSPHRASE=%s\n' "$PASSE"
  printf 'OKX_SIMULATED=%s\n' "${SIMULE:-0}"
} >> "$ENV"
chmod 600 "$ENV"
echo "  ecrit, droits 600 (lisible par root seul)"

echo
echo "===== 3. relance et verification ====="
systemctl restart hermes
sleep 5
if journalctl -u hermes --since "-30 seconds" --no-pager 2>/dev/null | grep -q "\[ENV\] OKX key: true"; then
  echo "  le moteur voit ses cles"
else
  echo "  !! le moteur ne voit pas les cles :"
  journalctl -u hermes --since "-30 seconds" --no-pager 2>/dev/null | grep -E "\[ENV\]|OKX" | head -5
fi
journalctl -u hermes --since "-30 seconds" --no-pager 2>/dev/null \
  | grep -E "ACCOUNT|posMode|\[WS\] private" | head -4 | sed -e "s/^.*: //" -e "s/^/  /"
echo
echo "fait."

# Supprime seulement la copie temporaire deposee par un workflow. Celle
# de /root/hermes/deploy/ reste : lancee a la main, on veut pouvoir la
# relancer sans redeployer.
[ "$0" = "/tmp/poser_cles.sh" ] && rm -f /tmp/poser_cles.sh
