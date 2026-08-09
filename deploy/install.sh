#!/usr/bin/env bash
# Hermes VPS installer — idempotent; run as root on Ubuntu 24.04/26.04.
# Executed remotely by .github/workflows/deploy-vps.yml (the repo content
# is rsync'ed to /root/hermes before this runs).
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

HERMES_DIR=/root/hermes
VENV=/root/venv

# --- base system -----------------------------------------------------------
apt-get update
apt-get -y install python3-pip python3-venv ufw
# 2 GB swap safety net on small instances
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
# firewall: SSH only
ufw allow OpenSSH
ufw --force enable

# --- python environment ----------------------------------------------------
[ -d "$VENV" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$HERMES_DIR/requirements.txt"

# --- systemd units ---------------------------------------------------------
cat > /etc/systemd/system/hermes.service <<EOF
[Unit]
Description=Hermes trading engine (paper mode)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$HERMES_DIR
EnvironmentFile=-$HERMES_DIR/.env
ExecStart=$VENV/bin/python -m hermes run --mode paper
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

# one-shot: backfill data + run research, then (re)start the engine
cat > /etc/systemd/system/hermes-research.service <<EOF
[Unit]
Description=Hermes data backfill + alpha research (one-shot)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$HERMES_DIR
EnvironmentFile=-$HERMES_DIR/.env
ExecStart=$VENV/bin/python -m hermes fetch
ExecStart=$VENV/bin/python -m hermes research
ExecStartPost=/bin/systemctl restart hermes
TimeoutStartSec=4h
EOF

systemctl daemon-reload
systemctl enable hermes >/dev/null 2>&1 || true
echo "install: OK"
