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
# Trois formes acceptees, et le script les distingue seul. La raison
# est simple : cest a loutil de sadapter a ce quon lui donne, pas
# linverse.
#
#   1. un terminal          -> il demande les trois valeurs, masquees
#   2. quatre lignes        -> cle, secret, phrase, demo (un workflow)
#   3. un fichier .env colle -> il y prend ce dont il a besoin
#
# La troisieme est celle qui demande le moins : coller le fichier tel
# quel, sans rien decouper ni renommer.
if [ -t 0 ]; then
  echo "Saisie des cles OKX. Rien ne saffiche pendant la frappe, cest normal."
  echo
  printf "  cle dAPI          : "; IFS= read -rs CLE;    echo
  printf "  secret            : "; IFS= read -rs SECRET; echo
  printf "  phrase de passe   : "; IFS= read -rs PASSE;  echo
  printf "  compte demo ? 1=oui 0=non [0] : "; IFS= read -r SIMULE
  SIMULE="${SIMULE:-0}"
  echo
else
  BRUT=$(cat)
  if printf '%s' "$BRUT" | grep -q "^[[:space:]]*OKX_API_KEY[[:space:]]*="; then
    echo "  un fichier .env a ete reconnu : $(printf '%s' "$BRUT" | grep -c "^[[:space:]]*[A-Za-z_][A-Za-z_0-9]*[[:space:]]*=") variables"
    lire() {
      printf '%s' "$BRUT" | grep -m1 "^[[:space:]]*$1[[:space:]]*=" \
        | sed -E "s/^[[:space:]]*[A-Za-z_0-9]+[[:space:]]*=[[:space:]]*//" \
        | sed -E "s/^[\"']//; s/[\"']$//" | tr -d '\r'
    }
    CLE=$(lire OKX_API_KEY)
    SECRET=$(lire OKX_API_SECRET)
    PASSE=$(lire OKX_API_PASSPHRASE)
    # Certains fichiers portent OKX_API_PASS au lieu de la forme longue.
    [ -z "$PASSE" ] && PASSE=$(lire OKX_API_PASS)
    SIMULE=$(lire OKX_SIMULATED); SIMULE="${SIMULE:-0}"
    # Le proprietaire a tranche : rien dautre que les cles. La question
    # a ete posee une fois, avec son cout chiffre — HERMES_MAX_POSITIONS
    # 5 contre 10 par defaut, HERMES_CANDLE_SECONDS 60 contre 15 — et la
    # reponse a ete confirmee. Cest sa decision, elle sapplique.
    total=$(printf '%s' "$BRUT" | grep -c "^[[:space:]]*[A-Za-z_][A-Za-z_0-9]*[[:space:]]*=")
    echo "  $total variables recues, 3 conservees (les cles OKX), $((total - 3)) ecartees"
  else
    CLE=$(printf '%s' "$BRUT"    | sed -n 1p | tr -d '\r')
    SECRET=$(printf '%s' "$BRUT" | sed -n 2p | tr -d '\r')
    PASSE=$(printf '%s' "$BRUT"  | sed -n 3p | tr -d '\r')
    SIMULE=$(printf '%s' "$BRUT" | sed -n 4p | tr -d '\r'); SIMULE="${SIMULE:-0}"
  fi
fi

# Une seule ligne portant les trois valeurs, separees par un signe.
# Cest la forme la plus courte a saisir sur telephone, et elle sert de
# repli quand le fichier complet nest pas disponible.
#
# Le decoupage se fait ICI, sur le serveur, et non sur le runner : GitHub
# masque la valeur EXACTE dun secret dans ses journaux, jamais ses
# morceaux. Decouper « a:b:c » la-bas produirait trois fragments que
# plus rien ne protegerait.
if [ -n "$CLE" ] && [ -z "$SECRET$PASSE" ]; then
  case "$CLE" in
    *:*|*\|*|*\;*|*,*)
      ancien="$CLE"; n=0; CLE=""; SECRET=""; PASSE=""
      for m in $(printf '%s' "$ancien" | tr ':|;,' '\n\n\n\n'); do
        [ -z "$m" ] && continue
        n=$((n + 1))
        case $n in 1) CLE="$m";; 2) SECRET="$m";; 3) PASSE="$m";; esac
      done
      echo "  une seule ligne, $n morceau(x)"
      if [ "$n" -ne 3 ]; then
        echo "  !! il en faut exactement TROIS : cle:secret:phrase_de_passe"
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
node --dns-result-order=ipv4first --input-type=module -e '
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
    "50110": "adresse IP non autorisee. Ladresse que voit OKX est nommee dans le message ci-dessus — cest CELLE-LA quil faut ajouter aux restrictions de la cle, pas celle quon suppose. Le moteur sort desormais en IPv4, donc 178.104.191.79 ; si le message montre encore une adresse en 2a01:, cest que le service na pas ete relance avec le nouveau reglage.",
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
sed -i -E '/^(OKX_API_KEY|OKX_API_SECRET|OKX_API_PASSPHRASE|OKX_SIMULATED|OK_ACCESS_KEY|OK_SECRET_KEY|OK_PASSPHRASE|OKX_API_PASS)=/d' "$ENV"
{
  printf 'OKX_API_KEY=%s\n' "$CLE"
  printf 'OKX_API_SECRET=%s\n' "$SECRET"
  printf 'OKX_API_PASSPHRASE=%s\n' "$PASSE"
} >> "$ENV"
chmod 600 "$ENV"
echo "  ecrit, droits 600 (lisible par root seul)"

echo
echo "===== 3. relance et verification ====="
# On note lheure AVANT de relancer, et on ne lira que ce qui suit.
#
# « depuis 30 secondes » ramassait aussi le demarrage precedent — celui
# davant la pose, ou le moteur navait pas encore de cles. Son 401
# saffichait alors a cote dune connexion privee reussie, et le rapport
# se contredisait lui-meme sans quon puisse dire laquelle des deux
# lignes decrivait letat present.
# « @secondes » plutot quune date formatee : journalctl lit une date
# nue dans le fuseau LOCAL de la machine, et une heure ecrite en UTC y
# designerait alors un autre instant — assez pour ne rien voir, ou pour
# tout voir. Lepoque ne souffre pas dinterpretation.
DEPUIS="@$(date +%s)"
systemctl restart hermes

# On attend le moteur au lieu de le supposer parti. Une attente fixe de
# cinq secondes mesure la vitesse de la machine, pas letat du moteur :
# elle declare en panne un demarrage simplement lent, et elle attend
# pour rien quand tout va bien.
vu=0
for _ in $(seq 1 12); do
  if journalctl -u hermes --since "$DEPUIS" --no-pager 2>/dev/null | grep -q "\[ENV\] OKX key: true"; then
    vu=1; break
  fi
  sleep 2
done
if [ "$vu" = "1" ]; then
  echo "  le moteur voit ses cles"
else
  echo "  !! les cles sont ecrites et OKX les accepte, mais le moteur ne"
  echo "     les lit pas. Le fichier est peut-etre masque par une autre"
  echo "     ligne, ou le service tourne depuis un autre repertoire."
  journalctl -u hermes --since "$DEPUIS" --no-pager 2>/dev/null | grep -E "\[ENV\]|OKX" | head -5
  exit 1
fi
journalctl -u hermes --since "$DEPUIS" --no-pager 2>/dev/null \
  | grep -E "ACCOUNT|posMode|\[WS\] private" | head -4 | sed -e "s/^.*: //" -e "s/^/  /"
echo
echo "fait."

# Supprime seulement la copie temporaire deposee par un workflow. Celle
# de /root/hermes/deploy/ reste : lancee a la main, on veut pouvoir la
# relancer sans redeployer.
#
# Ecrit « [ test ] && rm », ce menage devenait le code de sortie du
# script : lance depuis /root/hermes/deploy/, le test est faux, il
# renvoie 1, et une pose parfaitement reussie se declarait en panne.
# Cest arrive : les cles etaient posees, OKX les avait acceptees, la
# WebSocket privee etait connectee — et le workflow a saute le
# demarrage parce quil croyait avoir echoue.
#
# Le if ne renvoie rien quand sa condition est fausse, et le exit 0
# finit de rendre la sortie explicite plutot que subie.
if [ "$0" = "/tmp/poser_cles.sh" ]; then rm -f /tmp/poser_cles.sh; fi
exit 0
