#!/usr/bin/env bash
# Tourne SUR LE VPS, pousse par « ssh ... bash -s ».
#
# Le rapport detat. Il repond, dans cet ordre, aux questions quon se
# pose reellement quand on revient voir le robot :
#   est-il en vie ? sur quoi trade-t-il ? a-t-il ouvert quelque chose ?
#   les protections suivent-elles ? quest-ce qui casse ?
#
# Lordre nest pas decoratif : on lit un rapport par la fin, et les
# fenetres consultees a chaque lecture sont donc placees en dernier.
# Une fenetre couteuse a atteindre est une fenetre quon finit par ne
# pas lire.
#
# Il est pousse par lentree standard et non ecrit dans la commande ssh :
# lancienne version etait entouree dapostrophes, et une seule apostrophe
# de plus nimporte ou dedans cassait tout le releve.
set -u
DIR=/root/hermes

echo "===== service ====="
systemctl is-active hermes || true
ss -tln 2>/dev/null | grep -q ":8899 " && echo "port 8899 : a lecoute" || echo "port 8899 : MUET"
systemctl show hermes -p ActiveEnterTimestamp --value 2>/dev/null | sed -e "s/^/demarre : /"
echo -n "sans cle, le serveur repond : "
curl -s -o /dev/null -w "%{http_code}\n" --max-time 6 "http://127.0.0.1:8899/" || echo "injoignable"
echo

echo "===== ce qui casse (6 h) ====="
journalctl -u hermes --since "-6 hours" --no-pager 2>/dev/null \
  | grep -E "_ERR|ERROR|Error:|ECONNREFUSED|rejet" \
  | sed -E "s/^[A-Za-z]+ [0-9]+ ([0-9]+:[0-9]+):[0-9]+ [^ ]+ [^ ]+: //" \
  | sort | uniq -c | sort -rn | head -12 || true
echo

echo "===== cles et mode ====="
if [ -f "$DIR/.env" ]; then
  grep -q "^OKX_API_KEY=.\+" "$DIR/.env" && echo "  cles OKX : presentes" || echo "  cles OKX : ABSENTES — le moteur ne peut pas trader"
  grep -q "^HERMES_UI_MODE=full" "$DIR/.env" && echo "  interface : PILOTAGE" || echo "  interface : lecture seule (defaut)"
  grep -q "^HERMES_AI_DEFAULT_ON=true" "$DIR/.env" && echo "  trading au demarrage : ACTIF" || echo "  trading au demarrage : inactif (defaut)"
else
  echo "  pas de .env"
fi
echo

echo "===== dashboard ====="
# La cle nest pas imprimee : elle commande un moteur en pilotage
# complet, et un journal de run se partage par un lien sans quon pense
# a ce quil contient.
if [ -f "$DIR/.env" ] && grep -q "^HERMES_DASH_TOKEN=.\+" "$DIR/.env"; then
  echo "  cle presente — http://178.104.191.79:8899/?key=<votre cle>"
else
  echo "  pas de cle"
fi
echo

# La question qu'on se pose en premier quand rien ne s'ouvre : la
# taille calculee permet-elle seulement d'acheter un contrat ? Sans
# cette ligne, un capital trop petit produit un silence qu'on attribue
# aux cles, a la strategie, ou au reseau.
echo "===== taille des positions et ce qu'elle permet (24 h) ====="
journalctl -u hermes --since "-24 hours" --no-pager 2>/dev/null \
  | grep -E "\[TAILLE\]" \
  | sed -E "s/^[A-Za-z]+ [0-9]+ ([0-9]+:[0-9]+):[0-9]+ [^ ]+ [^ ]+: \[[^]]*\] /\1 /" \
  | tail -6 || true
echo "  (aucune ligne ci-dessus = le moteur n'a pas encore mesure, ou l'equite est nulle)"
echo

echo "===== univers : quels instruments, et sa rotation (24 h) ====="
journalctl -u hermes --since "-24 hours" --no-pager 2>/dev/null \
  | grep -E "\[UNI\]" \
  | sed -E "s/^[A-Za-z]+ [0-9]+ ([0-9]+:[0-9]+):[0-9]+ [^ ]+ [^ ]+: \[[^]]*\] /\1 /" \
  | tail -6 || true
echo

echo "===== protections : les stops qui ont bouge (24 h) ====="
journalctl -u hermes --since "-24 hours" --no-pager 2>/dev/null \
  | grep -E "STOP_BE|STOP_TRAIL|STOP_PLACED" \
  | sed -E "s/^[A-Za-z]+ [0-9]+ ([0-9]+:[0-9]+):[0-9]+ [^ ]+ [^ ]+: \[[^]]*\] /\1 /" \
  | tail -14 || true
echo

echo "===== positions : ouvertures et fermetures (24 h) ====="
journalctl -u hermes --since "-24 hours" --no-pager 2>/dev/null \
  | grep -E "TRADE_ENTER|TRADE_EXIT" \
  | sed -E "s/^[A-Za-z]+ [0-9]+ ([0-9]+:[0-9]+):[0-9]+ [^ ]+ [^ ]+: \[[^]]*\] /\1 /" \
  | tail -20 || true
echo

echo "===== letat que la page affiche ====="
# On interroge le serveur comme le ferait la page, plutot que de lire
# des fichiers detat : ce qui compte est ce que le proprietaire VOIT.
if [ -f "$DIR/.env" ]; then
  TOK=$(grep "^HERMES_DASH_TOKEN=" "$DIR/.env" | tail -1 | cut -d= -f2-)
  # Une ligne par position, avec exactement les champs que le
  # proprietaire a compares a lapplication OKX le jour ou laffichage
  # mentait : sens, taille, entree, mark, TP, stop, pourcentage, tenue.
  # Le brut tronque a 900 caracteres coupait au milieu dun objet et ne
  # permettait de verifier aucun de ces champs.
  curl -s --max-time 8 -X POST "http://127.0.0.1:8899/api/fetch-portfolio?key=$TOK" \
    | node -e '
      let b = "";
      process.stdin.on("data", (c) => b += c);
      process.stdin.on("end", () => {
        let j; try { j = JSON.parse(b); } catch { console.log("  reponse illisible"); return; }
        const d = (j && j.data) || {};
        console.log("  equite " + ((d.futures && d.futures.total) || 0).toFixed(2)
          + " USDT | disponible " + ((d.futures && d.futures.available) || 0).toFixed(2));
        const ps = d.openPositionsDetails || [];
        if (!ps.length) { console.log("  aucune position ouverte"); return; }
        for (const p of ps) {
          const min = p.entryTime ? Math.round((Date.now() - p.entryTime) / 60000) : null;
          console.log("  " + p.symbol.replace("-USDT-SWAP", "").padEnd(6)
            + " " + String(p.side).padEnd(5)
            + " taille " + p.size
            + " | entree " + p.entryPrice + " mark " + p.markPrice
            + " | TP " + (p.takeProfit ?? "—") + " stop " + (p.stopActuel ?? "—")
            + (p.stopMode ? " (" + p.stopMode + ")" : "")
            + " | pnl " + Number(p.unrealizedPnl).toFixed(2)
            + " (" + Number(p.pnlPctOfMargin).toFixed(2) + " %)"
            + " | tenue " + (min == null ? "—" : min + " min"));
        }
      });
    ' || echo "  injoignable"
fi
echo

echo "===== dou vient le code deploye ====="
# Larchive telechargee depuis SwissTransfer, telle quelle est arrivee.
# Elle est gardee sur la machine : cest la piece qui permet de verifier
# que ce qui tourne vient bien delle, et non dune reconstruction.
if [ -f /root/incoming/Hermes_Astra.zip ]; then
  echo "  archive : $(stat -c %s /root/incoming/Hermes_Astra.zip) octets, tiree le $(stat -c %y /root/incoming/Hermes_Astra.zip | cut -d. -f1)"
  echo "  sha256  : $(sha256sum /root/incoming/Hermes_Astra.zip | cut -c1-32)"
  [ -f /root/incoming/link.json ] && echo "  source  : $(grep -o "downloadHost[^,]*" /root/incoming/link.json | head -1)"
else
  echo "  larchive nest plus sur la machine"
fi

# La verification qui manquait. Limport a filtre par la TAILLE, et une
# regle de taille ne sait pas distinguer une donnee dun gros fichier
# source. Si un .js ou un .json de code depassait 400 Ko, il a ete
# ecarte sans que personne le remarque. On compare donc, fichier par
# fichier, ce que larchive contient et ce qui tourne.
if [ -d /root/astra/Hermes_Astra ]; then
  cd /root/astra/Hermes_Astra || exit 0
  # Les noms sont lus un par un, separes par des octets nuls. Une boucle
  # « for f in $(find ...) » decoupe sur les espaces, et larchive
  # contient un dossier « app/Archives app/ » : le premier essai a
  # compte des morceaux de noms comme des fichiers manquants.
  manquants=0; sauvegardes=0; total=0
  while IFS= read -r -d "" f; do
    case "$f" in *node_modules*) continue ;; esac
    total=$((total + 1))
    if [ ! -f "/root/hermes/$f" ]; then
      # Deux absences tres differentes, et les confondre ferait
      # sonner lalarme pour rien. Les sauvegardes datees de
      # « app/Archives app/ » ont ete retirees a dessein a la table
      # rase : aucune nest referencee par un require, elles ne sont
      # que des copies horodatees. Une absence AUTRE serait un vrai
      # trou dans le deploiement.
      case "$f" in
        *Archives*|*.backup*|*backup_*|*.bak*) sauvegardes=$((sauvegardes + 1)) ;;
        *) manquants=$((manquants + 1))
           [ "$manquants" -le 12 ] && echo "  MANQUE  $(stat -c %s "$f" 2>/dev/null) octets  $f" ;;
      esac
    fi
  done < <(find app modules services config public scripts -type f \
             \( -name "*.js" -o -name "*.json" -o -name "*.html" -o -name "*.css" \) \
             -print0 2>/dev/null)
  echo "  $total fichiers source dans larchive : $sauvegardes sauvegardes datees retirees a dessein, $manquants absences inexpliquees"
  [ "$manquants" = "0" ] && echo "  -> aucun fichier vivant ne manque, le deploiement porte tout le code de larchive"
  cd - >/dev/null || true
else
  echo "  larchive nest plus deballee, comparaison impossible"
fi
echo

echo "===== ce que limport filtre a pu laisser derriere ====="
# Limport a ecarte tout fichier de plus de 400 Ko, plus data/ et logs/.
# La question qui compte est : le moteur a-t-il besoin de quelque chose
# qui est reste dans larchive ? Il ne lit que trois fichiers de
# configuration — tous importes — et des fichiers quil ecrit lui-meme.
# Le seul candidat serieux est un modele deja entraine.
if [ -f "$DIR/data/models/alpha.json" ]; then
  echo "  modele en place : $(stat -c %s "$DIR/data/models/alpha.json") octets, ecrit $(stat -c %y "$DIR/data/models/alpha.json" | cut -d. -f1)"
else
  echo "  pas de modele dans $DIR/data/models/ (le moteur en construit un en tournant)"
fi
if [ -d /root/astra/Hermes_Astra/data ]; then
  echo "  larchive dorigine contient dans data/ :"
  find /root/astra/Hermes_Astra/data -maxdepth 2 -type f -printf "    %8s  %P\n" 2>/dev/null | sort -rn | head -8
  echo "  -> si un modele y figure et pas ci-dessus, il faut le copier."
else
  echo "  larchive dorigine nest plus deballee sur la machine"
fi
echo

echo "===== journal, les 25 dernieres lignes ====="
journalctl -u hermes -n 25 --no-pager 2>/dev/null \
  | sed -E "s/^[A-Za-z]+ [0-9]+ ([0-9]+:[0-9]+):[0-9]+ [^ ]+ [^ ]+: /\1 /" || true
echo

echo "===== disque et memoire ====="
df -h / | tail -1
free -m | sed -n "2p"
