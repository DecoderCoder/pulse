#!/usr/bin/env bash
# Pulse — one-line installer (bootstrap)
#
#   curl -fsSL http://<server>:8090/install.sh | bash -s -- server
#   curl -fsSL http://<server>:8090/install.sh | bash -s -- client <SERVER_URL> <TOKEN>
#
# The exact commands (token already filled in) are on the dashboard's
# Install tab. Node data flows over the LAN only: agents always point at
# the server's LAN URL, never at a public endpoint.
#
# or from a local copy:
#
#   bash install.sh server                     # central server + its own agent
#   bash install.sh client http://<server>:8090 <TOKEN>
#
# Modes:
#   server  installs the central server AND an agent on the same box
#           (the agent reports to http://127.0.0.1:<PORT>).
#   client  installs only the agent, pointing it at the server that hosts
#           this script (or at the explicit SERVER_URL) with the shared
#           ingest TOKEN.
#
# What it does (no root needed — systemd *user* units):
#   * checks python3 (installs it via apt/dnf/pacman if missing), curl/wget,
#     and a systemd user session
#   * downloads pulse_agent.py / pulse_server.py + web/ from
#     <SERVER_URL>/install/... (whitelisted on the server side)
#   * writes ~/pulse/agent.conf and ~/.pulse-server.env (server mode);
#     server mode generates a fresh ingest token + API key when nothing
#     exists, client mode takes the token as an argument (or reuses one
#     already on the box) and never invents one — re-running is idempotent
#   * installs + enables + restarts the pulse-agent / pulse-server user units
#   * prints the API key (server mode) and the linger/firewall notes
#
# --dry-run  check prerequisites, download + validate the files, preview the
#            generated configs — but change nothing (no ~/pulse writes, no
#            systemd). Safe to run anywhere to test the one-liner.

set -euo pipefail

# When this script is fetched via /install.sh, the server replaces the
# empty value below with its LAN base URL (e.g.
# http://192.168.178.12:8090) — agents always talk over the LAN, never
# through a public endpoint. When run from a local copy it stays empty
# and client mode requires an explicit SERVER_URL.
INSTALL_BASE=""

usage() {
  cat <<'EOF'
Pulse installer — usage:

  bash install.sh <client|server> [args...] [--dry-run]

  client   agent only:            client [SERVER_URL] [TOKEN]
  server   central server + local agent on the same box
           (agent -> http://127.0.0.1:PORT):  server [PORT]

  SERVER_URL  where the agent reports; default: the server hosting this
               script when fetched via /install.sh (always its LAN URL)
  TOKEN       the shared ingest token (see the dashboard's Install tab);
               required for client mode unless this box already has one
               in ~/pulse/agent.conf or ~/.pulse-server.env
  PORT        server mode only; default: 8090
  --dry-run   preview everything, change nothing
EOF
}

die() { echo "install.sh: $*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------- arguments ----------------
DRY_RUN=""
MODE="" URL="" PORT=8090 TOKEN_ARG=""
POS=0
for a in "$@"; do
  case "$a" in
    --dry-run|-n)   DRY_RUN=1 ;;
    -h|--help)      usage; exit 0 ;;
    -*)             die "unknown option: $a (see --help)" ;;
    *)
      [ -n "$MODE" ] || { MODE="$a"; continue; }
      POS=$((POS + 1))
      case "$MODE" in
        client)
          case $POS in
            1) URL="$a" ;;
            2) TOKEN_ARG="$a" ;;
            *) die "too many positional arguments for client mode: $a (see --help)" ;;
          esac ;;
        server)
          case $POS in
            1) PORT="$a" ;;
            *) die "too many positional arguments for server mode: $a (see --help)" ;;
          esac ;;
        *) die "unknown mode: $MODE (use client or server)" ;;
      esac ;;
  esac
done

case "$MODE" in
  client|server) ;;
  "") usage; echo >&2; die "a mode is required: client or server" ;;
  *) die "unknown mode: $MODE (use client or server)" ;;
esac
case "$PORT" in
  ''|*[!0-9]*) die "PORT must be numeric, got: $PORT" ;;
esac

if [ -z "$INSTALL_BASE" ] && [ -z "$URL" ]; then
  if [ "$MODE" = client ]; then
    die "no server URL known (local copy of install.sh) — pass it explicitly:
    bash install.sh client http://<server-host>:8090 <TOKEN>"
  fi
  # server mode: the agent points at localhost, nothing to fetch from a base
fi
if [ -z "$URL" ]; then
  if [ "$MODE" = server ]; then URL="http://127.0.0.1:$PORT"
  else URL="$INSTALL_BASE"; fi
fi
URL="${URL%/}"
[ -n "$URL" ] || die "empty SERVER_URL"
case "$URL" in http://*|https://*) ;; *) die "SERVER_URL must start with http:// or https://, got: $URL" ;; esac
# code is always downloaded from the server that hosts this script
# (fetched copy); a local copy falls back to the target URL itself
DOWNLOAD_BASE="$URL"
[ -n "$INSTALL_BASE" ] && DOWNLOAD_BASE="${INSTALL_BASE%/}"

# ---------------- helpers ----------------
gen_secret() { python3 -c 'import secrets; print(secrets.token_hex(16))'; }

fetch() { # $1 = url, $2 = destination file
  if have curl; then
    curl -fsSL --retry 3 --connect-timeout 10 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

SUDO=""
[ "$(id -u)" = 0 ] || SUDO="sudo"

echo "Pulse installer — mode: $MODE, server: $URL, port: $PORT${DRY_RUN:+, DRY RUN}"
echo

# ---------------- prerequisites ----------------
if [ "$(id -u)" = 0 ]; then
  echo "note: running as root — units will be installed in root's user manager"
fi
if ! have python3; then
  echo "python3 not found — installing it (needs sudo)…"
  if have apt-get;   then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq python3
  elif have dnf;     then $SUDO dnf install -y -q python3
  elif have pacman;  then $SUDO pacman -Sy --noconfirm python
  else die "python3 is required and no known package manager (apt/dnf/pacman) was found"
  fi
fi
have curl || have wget || die "curl or wget is required to download the files"
have systemctl || die "systemd not found — Pulse is managed via systemd user units"
[ -n "${XDG_RUNTIME_DIR:-}" ] || die "no systemd user session (XDG_RUNTIME_DIR is unset) — run this from a normal login session"
echo "prereqs ok (python3 $(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])'), $( have curl && echo curl || echo wget ), systemd user)"
echo

# ---------------- download ----------------
TMP="$(mktemp -d /tmp/pulse-install.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

ASSETS="pulse_agent.py"
[ "$MODE" = server ] && ASSETS="pulse_agent.py pulse_server.py web/index.html web/app.js web/style.css web/keygate.html web/keygate.css"

echo "downloading from $DOWNLOAD_BASE/install/ …"
for f in $ASSETS; do
  dest="$TMP/$f"
  mkdir -p "$(dirname "$dest")"
  fetch "$DOWNLOAD_BASE/install/$f" "$dest" || die "failed to download $f from $DOWNLOAD_BASE/install/$f — is this box on the server's LAN? (installs and node data only flow over the LAN)"
  [ -s "$dest" ] || die "downloaded $f is empty"
done
# optional extras (tolerate 404 — not every server has them)
for f in llama_presets.json deploy.sh; do
  dest="$TMP/$f"
  fetch "$DOWNLOAD_BASE/install/$f" "$dest" 2>/dev/null || rm -f "$dest"
done

# sanity: real pulse sources, not an HTML error page
grep -q "Pulse" "$TMP/pulse_agent.py"      || die "pulse_agent.py failed sanity check"
[ "$MODE" = server ] && {
  grep -q "Pulse Server" "$TMP/pulse_server.py" || die "pulse_server.py failed sanity check"
  grep -q "Pulse" "$TMP/web/index.html"          || die "web/index.html failed sanity check"
}
echo "files ok"
echo

# ---------------- config ----------------
HOME_DIR="$HOME"
PULSE_DIR="$HOME_DIR/pulse"
UNIT_DIR="$HOME_DIR/.config/systemd/user"
STATE_DIR="$HOME_DIR/.pulse-server"
ENV_FILE="$HOME_DIR/.pulse-server.env"
CONF_FILE="$PULSE_DIR/agent.conf"

get_val() { # $1 file, $2 key -> value (or empty)
  [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | head -1
}

TOKEN=""
if [ -n "$TOKEN_ARG" ]; then
  TOKEN="$TOKEN_ARG"
  echo "ingest token: from the command line"
elif [ -f "$ENV_FILE" ]; then
  TOKEN="$(get_val "$ENV_FILE" PULSE_TOKEN)"
  [ -n "$TOKEN" ] && echo "ingest token: reused from $ENV_FILE"
elif [ -f "$CONF_FILE" ]; then
  TOKEN="$(get_val "$CONF_FILE" TOKEN)"
  [ -n "$TOKEN" ] && echo "ingest token: reused from $CONF_FILE"
fi
API_KEY="" TLS=0
if [ -f "$ENV_FILE" ]; then
  API_KEY="$(get_val "$ENV_FILE" PULSE_API_KEY)"
  [ -n "$API_KEY" ] || API_KEY="$(get_val "$ENV_FILE" PULSE_DASH_KEY)"
  TLS="$(get_val "$ENV_FILE" PULSE_TLS_PROXY)"
  [ -n "$TLS" ] || TLS=0
fi
if [ -z "$TOKEN" ]; then
  if [ "$MODE" = server ]; then
    TOKEN="$(gen_secret)"; echo "generated new ingest token"
  else
    die "no ingest token found — client mode never invents one.
Copy the agent one-liner from the server's dashboard (Install tab);
it already contains the server URL and the token."
  fi
fi
[ -n "$API_KEY" ] || { API_KEY="$(gen_secret)"; echo "generated new api key"; }
# installing over https implies a TLS-terminating proxy in front of this box
case "$URL" in https://*) TLS=1 ;; esac

AGENT_CONF="SERVER_URL=$URL
TOKEN=$TOKEN
INTERVAL=2
ACTION_PORT=9611
"
SERVER_ENV="PULSE_PORT=$PORT
PULSE_BIND=0.0.0.0
PULSE_TOKEN=$TOKEN
PULSE_API_KEY=$API_KEY
PULSE_STATE_DIR=$STATE_DIR
# 1 when a TLS-terminating reverse proxy (Caddy/nginx) fronts this port:
# Secure cookies + client IPs read from X-Forwarded-For.
# When 1, firewall PULSE_PORT to the proxy host (and your LAN).
PULSE_TLS_PROXY=$TLS
"

if [ "$DRY_RUN" = 1 ]; then
  echo "DRY RUN — nothing will be written, no systemd changes."
  echo "target dir:  $PULSE_DIR"
  echo "agent.conf:  $CONF_FILE"
  echo "$AGENT_CONF"
  if [ "$MODE" = server ]; then
    echo "server env:  $ENV_FILE"
    echo "$SERVER_ENV"
  fi
  echo "units would be (re)installed in $UNIT_DIR:"
  [ "$MODE" = server ] && echo "  pulse-server.service, pulse-agent.service" || echo "  pulse-agent.service"
  echo
  echo "DRY RUN finished — change nothing. Remove --dry-run to install for real."
  exit 0
fi

# ---------------- install ----------------
mkdir -p "$PULSE_DIR/web" "$UNIT_DIR" "$STATE_DIR"
for f in $ASSETS; do
  install -m 644 "$TMP/$f" "$PULSE_DIR/$f"
done
[ -s "$TMP/llama_presets.json" ] && [ ! -f "$PULSE_DIR/llama_presets.json" ] \
  && install -m 644 "$TMP/llama_presets.json" "$PULSE_DIR/llama_presets.json"

printf '%s\n' "$AGENT_CONF" > "$CONF_FILE"
chmod 600 "$CONF_FILE"

cat > "$UNIT_DIR/pulse-agent.service" <<EOF
[Unit]
Description=Pulse monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 $PULSE_DIR/pulse_agent.py --config $CONF_FILE
Restart=always
RestartSec=3
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/opt/rocm/bin

[Install]
WantedBy=default.target
EOF

if [ "$MODE" = server ]; then
  printf '%s\n' "$SERVER_ENV" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  cat > "$UNIT_DIR/pulse-server.service" <<EOF
[Unit]
Description=Pulse monitoring server
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/opt/rocm/bin
ExecStart=/usr/bin/python3 $PULSE_DIR/pulse_server.py --port $PORT
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
fi

systemctl --user daemon-reload
systemctl --user enable pulse-agent.service >/dev/null
[ "$MODE" = server ] && systemctl --user enable pulse-server.service >/dev/null
systemctl --user restart pulse-agent.service
[ "$MODE" = server ] && systemctl --user restart pulse-server.service
sleep 1

echo
echo "done."
echo "agent:  $(systemctl --user is-active pulse-agent)  -> $URL"
if [ "$MODE" = server ]; then
  echo "server: $(systemctl --user is-active pulse-server)  on :$PORT"
  echo
  echo "PANEL API KEY (shown once — store it now, it opens the dashboard):"
  echo "    $API_KEY"
  if [ -n "$INSTALL_BASE" ]; then
    echo "panel:  $INSTALL_BASE"
  else
    echo "panel:  http://$(hostname 2>/dev/null || echo localhost):$PORT"
  fi
  echo
  echo "notes:"
  PANEL="${INSTALL_BASE:-$URL}"
  echo "  * agents on other boxes (must be on the server's LAN):"
  echo "      curl -fsSL $PANEL/install.sh | bash -s -- client $PANEL $TOKEN"
  echo "  * a TLS proxy (Caddy/nginx) in front sets Secure cookies (PULSE_TLS_PROXY=$TLS)"
  echo "    — firewall :$PORT to the proxy host and your LAN"
fi

echo
echo "NOTE: for boot persistence (survives logout/reboot) run once with sudo:"
echo "      sudo loginctl enable-linger $USER"
