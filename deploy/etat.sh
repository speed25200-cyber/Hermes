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
if [ -f "$DIR/.env" ]; then
  TOK=$(grep "^HERMES_DASH_TOKEN=" "$DIR/.env" | tail -1 | cut -d= -f2-)
  [ -n "$TOK" ] && echo "url: http://178.104.191.79:8899/?key=$TOK" || echo "pas de cle"
fi
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
  curl -s --max-time 8 -X POST "http://127.0.0.1:8899/api/fetch-portfolio?key=$TOK" \
    | head -c 900 | sed -e "s/,/,\n  /g" | head -22 || echo "  injoignable"
fi
echo

echo "===== journal, les 25 dernieres lignes ====="
journalctl -u hermes -n 25 --no-pager 2>/dev/null \
  | sed -E "s/^[A-Za-z]+ [0-9]+ ([0-9]+:[0-9]+):[0-9]+ [^ ]+ [^ ]+: /\1 /" || true
echo

echo "===== disque et memoire ====="
df -h / | tail -1
free -m | sed -n "2p"
