#!/usr/bin/env bash
# Pulse one-shot installer — run on the target box as the service user
# (e.g. `decode`). Installs systemd *user* units; no root needed.
#
#   bash deploy.sh agent  SERVER_URL=http://192.168.178.11:8090
#       -> install + start the agent (expects ~/pulse/pulse_agent.py)
#
#   bash deploy.sh server [PORT=8090]
#       -> install + start the central server (expects ~/pulse/pulse_server.py
#          and ~/pulse/web/)
#
#   bash deploy.sh all SERVER_URL=http://127.0.0.1:8090
#       -> both, for the box that hosts the server
#
# Re-running is idempotent: existing tokens/configs are kept.

set -euo pipefail

MODE="${1:-agent}"
shift || true
SERVER_URL="http://127.0.0.1:8090"
PORT=8090
for kv in "$@"; do
  case "$kv" in
    SERVER_URL=*) SERVER_URL="${kv#SERVER_URL=}" ;;
    PORT=*)       PORT="${kv#PORT=}" ;;
  esac
done

HOME_DIR="$HOME"
PULSE_DIR="$HOME_DIR/pulse"
UNIT_DIR="$HOME_DIR/.config/systemd/user"
STATE_DIR="$HOME_DIR/.pulse-server"
mkdir -p "$PULSE_DIR" "$UNIT_DIR"

gen_token() { python3 -c 'import secrets; print(secrets.token_hex(16))'; }

install_agent() {
  [ -f "$PULSE_DIR/pulse_agent.py" ] || { echo "missing $PULSE_DIR/pulse_agent.py (scp it first)" >&2; exit 1; }
  # keep an existing token, else generate + reuse for the server env if present
  local tok=""
  if [ -f "$PULSE_DIR/agent.conf" ]; then
    tok="$(sed -n 's/^TOKEN=//p' "$PULSE_DIR/agent.conf" | head -1)"
  elif [ -f "$HOME_DIR/.pulse-server.env" ]; then
    tok="$(sed -n 's/^PULSE_TOKEN=//p' "$HOME_DIR/.pulse-server.env" | head -1)"
  fi
  [ -n "$tok" ] || { tok="$(gen_token)"; echo "generated new ingest token"; }
  # NOTE (GPU nodes): if llama-server launched from the agent dies with
  # "no ROCm-capable device is detected" while it works from a shell, the
  # user manager's supplementary groups are stale (missing render/video,
  # i.e. /dev/kfd access). Fix = re-spawn the manager with the current
  # groups:  sudo systemctl restart user@$(id -u)   (or reboot).
  # Do NOT add SupplementaryGroups=render video to the unit: if the manager
  # lacks those groups itself, systemd fails the unit with 216/GROUP.
  cat > "$PULSE_DIR/agent.conf" <<EOF
SERVER_URL=$SERVER_URL
TOKEN=$tok
INTERVAL=2
ACTION_PORT=9611
EOF
  chmod 600 "$PULSE_DIR/agent.conf"

  cat > "$UNIT_DIR/pulse-agent.service" <<EOF
[Unit]
Description=Pulse monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 $PULSE_DIR/pulse_agent.py --config $PULSE_DIR/agent.conf
Restart=always
RestartSec=3
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/opt/rocm/bin

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable pulse-agent.service
  systemctl --user restart pulse-agent.service
  echo "agent: $(systemctl --user is-active pulse-agent) -> $SERVER_URL"
}

install_server() {
  [ -f "$PULSE_DIR/pulse_server.py" ] || { echo "missing $PULSE_DIR/pulse_server.py (scp it first)" >&2; exit 1; }
  [ -d "$PULSE_DIR/web" ] || { echo "missing $PULSE_DIR/web/ (scp it first)" >&2; exit 1; }
  mkdir -p "$STATE_DIR"

  local tok="" key="" tls="0"
  if [ -f "$HOME_DIR/.pulse-server.env" ]; then
    tok="$(sed -n 's/^PULSE_TOKEN=//p' "$HOME_DIR/.pulse-server.env" | head -1)"
    key="$(sed -n 's/^PULSE_API_KEY=//p' "$HOME_DIR/.pulse-server.env" | head -1)"
    [ -n "$key" ] || key="$(sed -n 's/^PULSE_DASH_KEY=//p' "$HOME_DIR/.pulse-server.env" | head -1)"
    tls="$(sed -n 's/^PULSE_TLS_PROXY=//p' "$HOME_DIR/.pulse-server.env" | head -1)"
    [ -n "$tls" ] || tls=0
  elif [ -f "$PULSE_DIR/agent.conf" ]; then
    tok="$(sed -n 's/^TOKEN=//p' "$PULSE_DIR/agent.conf" | head -1)"
  fi
  [ -n "$tok" ] || { tok="$(gen_token)"; echo "generated new ingest token"; }
  # The API key is REQUIRED by the server (fail-closed); keep a previous
  # one, else generate. It is printed once here — that is the only
  # place to copy it from.
  [ -n "$key" ] || { key="$(gen_token)"; echo "generated new api key (copy it now — needed to open the panel)"; }
  echo "api key: $key"
  cat > "$HOME_DIR/.pulse-server.env" <<EOF
PULSE_PORT=$PORT
PULSE_BIND=0.0.0.0
PULSE_TOKEN=$tok
PULSE_API_KEY=$key
PULSE_STATE_DIR=$STATE_DIR
# 1 when a TLS-terminating reverse proxy (Caddy/nginx) fronts this port:
# Secure cookies + client IPs read from X-Forwarded-For.
# When 1, firewall PULSE_PORT to the proxy host (and your LAN).
PULSE_TLS_PROXY=$tls
EOF
  chmod 600 "$HOME_DIR/.pulse-server.env"

  cat > "$UNIT_DIR/pulse-server.service" <<EOF
[Unit]
Description=Pulse monitoring server
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$HOME_DIR/.pulse-server.env
ExecStart=/usr/bin/python3 $PULSE_DIR/pulse_server.py --port $PORT
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable pulse-server.service
  systemctl --user restart pulse-server.service
  sleep 1
  echo "server: $(systemctl --user is-active pulse-server) on :$PORT"
}

case "$MODE" in
  agent)  install_agent ;;
  server) install_server ;;
  all)    install_server; install_agent ;;
  *) echo "unknown mode: $MODE (use agent|server|all)" >&2; exit 1 ;;
esac

echo
echo "NOTE: for boot persistence (survives logout/reboot) run once with sudo:"
echo "      sudo loginctl enable-linger $USER"
