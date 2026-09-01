#!/usr/bin/env bash
# Installateur Hermes pour le VPS — idempotent, a lancer en root.
# Appele a distance par .github/workflows/deploy-vps.yml, apres que le
# depot a ete rsync vers /root/hermes.
#
# Ce fichier remplace linstallateur Python. Trois changements de fond :
#
#   1. Le moteur est en Node, pas en Python. Electron ne peut pas tourner
#      sur une machine sans ecran ; app/serveur.js presente la meme
#      surface adossee a un serveur HTTP.
#   2. Il ny a plus de service de tableau de bord separe. Le serveur vit
#      DANS le moteur — un seul processus, donc un seul etat, et plus de
#      risque que la page montre les chiffres dun moteur different de
#      celui qui trade.
#   3. Il ny a plus de service de recherche. Astra apporte des
#      strategies deja validees ; le laboratoire tourne a la main.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

DIR=/root/hermes
ENV_FILE="$DIR/.env"

echo "=== 1. demontage de lancienne installation Python ==="
# On DESACTIVE avant de reecrire : un service laisse actif redemarrerait
# un interpreteur qui na plus de code a executer, et il remplirait le
# journal de traces sans rapport avec le probleme quon chercherait.
for u in hermes-research.timer hermes-research.service hermes-dashboard.service; do
  systemctl disable --now "$u" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$u"
  echo "  $u retire"
done
systemctl stop hermes >/dev/null 2>&1 || true
systemctl daemon-reload

echo "=== 2. Node ==="
besoin_node=1
if command -v node >/dev/null 2>&1; then
  v=$(node --version | sed "s/^v//" | cut -d. -f1)
  [ "$v" -ge 18 ] 2>/dev/null && besoin_node=0 && echo "  node $(node --version) deja present"
fi
if [ "$besoin_node" = "1" ]; then
  apt-get update -qq
  apt-get -y -qq install curl ca-certificates
  # NodeSource plutot que le paquet Ubuntu : celui de la distribution est
  # souvent deux versions majeures en retard, et axios 1.12 comme ws 8.18
  # attendent mieux. Si NodeSource echoue, le paquet de la distribution
  # reste un repli acceptable — le code nutilise rien de recent.
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/node.sh \
    && bash /tmp/node.sh >/dev/null 2>&1 \
    && apt-get -y -qq install nodejs \
    || { echo "  NodeSource indisponible, repli sur le paquet de la distribution"; apt-get -y -qq install nodejs npm; }
  echo "  node $(node --version)"
fi

echo "=== 3. dependances ==="
cd "$DIR"
# --omit=dev ecarte Electron : trois cents megaoctets de binaire pour une
# fenetre quon nouvrira jamais sur un serveur sans ecran.
npm install --no-audit --no-fund --omit=dev 2>&1 | tail -3

echo "=== 4. reseau ==="
apt-get -y -qq install ufw >/dev/null 2>&1 || true
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 8899/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true
echo "  8899 ouvert"

echo "=== 5. environnement ==="
# La cle du tableau de bord vit ici et nulle part ailleurs. rsync exclut
# /.env, donc elle survit aux deploiements — sans cette exclusion chaque
# mise en ligne en aurait forge une nouvelle et aurait mis le
# proprietaire dehors de sa propre console.
set +x
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
if ! grep -q "^HERMES_DASH_TOKEN=" "$ENV_FILE" 2>/dev/null; then
  echo "HERMES_DASH_TOKEN=$(openssl rand -hex 16)" >> "$ENV_FILE"
  echo "  cle de tableau de bord creee (dans $ENV_FILE, jamais dans le journal)"
else
  echo "  cle de tableau de bord conservee"
fi
if grep -q "^OKX_API_KEY=.\+" "$ENV_FILE" 2>/dev/null; then
  echo "  cles OKX presentes"
else
  echo "  AUCUNE cle OKX dans $ENV_FILE : le moteur demarrera en lecture"
  echo "  seule et nouvrira aucune position. Cest voulu tant que les cles"
  echo "  compromises nont pas ete remplacees."
fi
set -x 2>/dev/null || true

echo "=== 6. service ==="
mkdir -p "$DIR/logs" "$DIR/data" "$DIR/runtime"
cat > /etc/systemd/system/hermes.service <<UNIT
[Unit]
Description=Hermes — moteur de trading et console web
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
EnvironmentFile=-$DIR/.env
Environment=NODE_ENV=production
Environment=HERMES_PORT=8899
Environment=HERMES_HOST=0.0.0.0
# Le pilotage, demande explicitement par le proprietaire.
#
# Le defaut du code est « lecture seule », et ce defaut est le bon :
# servi par le reseau, ladresse decoute ne dit rien de qui se connecte,
# et un robot de trading joignable sur Internet ne doit pas obeir au
# premier venu. Ici la garde qui reste est la cle du tableau de bord —
# trente-deux caracteres, exigee a chaque requete, sans laquelle le
# serveur repond 403 avant meme de lire le chemin demande.
#
# Ce que cela ouvre, dit franchement : quiconque possede cette cle peut
# demarrer et arreter le moteur, et passer un ordre. La cle merite donc
# le meme soin quun mot de passe de compte.
Environment=HERMES_UI_MODE=full
# Sortir en IPv4.
#
# La machine a une adresse dans chaque famille. Node, depuis la 18,
# contacte lhote dans lordre que le resolveur renvoie — souvent lIPv6
# dabord. OKX a donc vu arriver 2a01:4f8:c014:5ea::1 et a refuse la cle
# en code 50110, alors que la liste blanche porte ladresse IPv4.
#
# Cest une panne qui ne ressemble pas a ce quelle est : le message
# parle de liste blanche, on ajoute ladresse quon connait, et rien ne
# change — parce que ce nest pas par celle-la que le moteur sort.
#
# ipv4first restaure lordre attendu. Le trafic part alors de
# 178.104.191.79, ladresse que le proprietaire a sous les yeux et la
# seule quil ait une raison dautoriser.
Environment=NODE_OPTIONS=--dns-result-order=ipv4first
ExecStart=/usr/bin/env node app/main.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable hermes >/dev/null 2>&1 || true
systemctl restart hermes

echo "=== 7. verification ==="
sleep 3
systemctl is-active hermes && echo "  service actif" || { echo "  !! service inactif"; journalctl -u hermes -n 30 --no-pager; exit 1; }

# On interroge le serveur pour de vrai. « Le service est actif » ne dit
# pas que le port repond : un processus peut vivre et navoir jamais
# reussi a ecouter.
#
# On REESSAIE pendant trente secondes au lieu de trancher au premier
# coup. Un controle a quatre secondes a deja fait echouer un
# deploiement parfaitement sain : le demarrage interroge OKX, et un
# echange lent suffisait alors a faire declarer en panne un moteur qui
# se portait bien. Un controle qui depend du temps de reponse dun tiers
# ne mesure pas ce quil croit mesurer.
code=000
for _ in $(seq 1 15); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 "http://127.0.0.1:8899/" || echo 000)
  [ "$code" != "000" ] && break
  sleep 2
done
if [ "$code" = "403" ]; then
  echo "  port 8899 repond, et il refuse une requete sans cle — cest le bon comportement"
elif [ "$code" = "200" ]; then
  echo "  !! port 8899 repond 200 SANS CLE : la protection ne sapplique pas"
  exit 1
else
  echo "  !! port 8899 a repondu $code"
  journalctl -u hermes -n 30 --no-pager
  exit 1
fi
echo "install: OK"
