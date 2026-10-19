# Pulse — self-hosted server monitoring panel

One **central server** with a dark web dashboard, one lightweight **agent** per
machine. Pure Python standard library — no pip, no dependencies, no build step.
Monitors CPU / RAM / disk / network / temperatures / GPUs (ROCm), including
AMD fan speed and Auto/manual PWM control when the agent can write the GPU's
hwmon files, Docker
containers and images, and can act on nodes (kill processes, Docker controls,
llama.cpp start/stop) from the browser.

Some Navi 31 firmware/driver combinations expose writable fan files but reject
manual mode with `EINVAL`. Pulse detects that response, keeps Auto enabled, and
marks the control unsupported instead of repeatedly offering a broken slider.

```
            browser ──► central server :8090 (dashboard + API, key-gated)
                                   │
              action proxy (kill, docker, llama)
                                   │
        ┌──────────────────────────┴──────────────────────────┐
        │  agent :9611  ◄──  agent :9611  ◄──  agent :9611 …   │
        │  (box 1)            (box 2)          (box N)         │
        └──────────▲────────────────▲────────────────▲────────┘
                   └────── HTTP POST /api/ingest every 2 s (token)
```

---

## Install — one line

The dashboard's **Install** tab holds the exact one-liners for *your* server —
with the ingest token already filled in — plus copy buttons. The form:

On the machine that should be the **central server** (also installs the local
agent, like a normal node reporting to `127.0.0.1`). Server mode works from
**any network** — fetch it from the public domain if the new server isn't on
the existing one's LAN (second deployment):

```bash
curl -fsSL https://<server-domain>/install.sh | bash -s -- server
```

On **every other machine** (agent only, reports to that server):

```bash
curl -fsSL http://<server-lan-ip>:8090/install.sh | bash -s -- client http://<server-lan-ip>:8090 <token>
```

`<token>` is the shared ingest token — it's shown in the Install tab. It
travels as a command-line argument, never inside the served script; an
explicit token wins over one already stored on the box, and client mode with
no token anywhere **refuses to run** — it never invents one.

Node data is LAN-only by design: agents always point at the server's LAN URL,
and the public edge answers 403 to `POST /api/ingest`. When the server serves
`/install.sh` it rewrites two blank assignments in the script:
`INSTALL_BASE="http://<lan-ip>:8090"` — its own auto-detected LAN address
(default-route egress interface, override with `PULSE_LAN_IP` in
`~/.pulse-server.env`) — and `DOWNLOAD_ORIGIN="<the URL the request came in
as>"`. The agent's `SERVER_URL` always defaults to the LAN URL (so even a
script fetched through the public domain produces a LAN one-liner), and the
code download follows the mode: **client** mode downloads from the LAN base —
a box that can't reach it isn't a valid client box, so the installer fails
fast instead of installing an agent that could only 403 or time out — while
**server** mode downloads from the origin that served the script: a new
central server may live on another network entirely, so its code comes back
over the public endpoint while everything it runs stays local.

The installer:

1. checks prerequisites (`python3` — installed via apt/dnf/pacman if missing,
   `curl`/`wget`, a systemd user session);
2. downloads the current code straight from the server (`/install/…` — a
   whitelisted endpoint; client mode from the LAN base, server mode from the
   host that served the script);
3. writes `~/pulse/` (code + configs, `chmod 600`) — existing token / API key
   are reused (a token from the command line wins), re-running is idempotent;
4. installs + enables + restarts the systemd **user** units
   (`pulse-agent`, and `pulse-server` in server mode);
5. in server mode prints the dashboard URL and the **panel API key — shown
   once, store it now**.

Run it as a normal user; `sudo` is only needed if a package has to be
installed. Before committing, test it without changing anything:

```bash
curl -fsSL http://<server-lan-ip>:8090/install.sh | bash -s -- client http://<server-lan-ip>:8090 <token> --dry-run
```

### Arguments

```
bash install.sh client [SERVER_URL] [TOKEN] [--dry-run]
bash install.sh server [PORT] [--dry-run]
```

| arg | meaning |
|---|---|
| `client` | agent only on this box (required first argument) |
| `server` | central server + local agent on this box (required first argument) |
| `SERVER_URL` | client mode: where the agent reports; defaults to the LAN URL of the server that hosted the script |
| `TOKEN` | client mode: the shared ingest token (Install tab); wins over a stored one, required on a fresh box |
| `PORT` | server mode: server port, default `8090` |
| `--dry-run` | download everything and preview the configs, change nothing |

After the server install, two things are worth doing once:

```bash
sudo loginctl enable-linger $USER      # keep the units alive after logout/boot
```

…then open `http://<server-lan-ip>:8090/` (or your domain) and enter the API key
from the install output. To add a node, run the Install tab's `client`
one-liner on it.

---

## What you see in the dashboard

- **Top bar** — one pill per node (status dot, name, live CPU %), plus pills
  for **Main** (DDNS / Wake-on-LAN hub) and **Install** (the instructions above,
  with the ingest token filled in, plus copy buttons). The `…ms` combo box sets
  the UI refresh interval (persisted); the LIVE badge flips to OFFLINE when the
  server stops answering.
- **Overview** — every node as a live card: CPU, RAM, disk, load, GPU chips,
  sparklines; a silent node (20 s) goes offline.
- **Node view** — live tiles (CPU/RAM/disk/net/temp/GPU), charts with a 15-min
  live window plus up to 6 h of server-side history, a **task manager**
  (filterable process table, kill via SIGTERM/SIGKILL), a **Docker** section
  (containers + images with live CPU/MEM/NET, per-container
  start/stop/restart/remove, image delete) and **devices** (filesystems,
  interfaces, GPUs, temperatures, PCI/USB inventory). A node whose agent user
  can read `/var/run/docker.sock` gets Docker monitoring/controls; without the
  socket it just reports "not installed".
- **Main** — fleet overview plus **Cloudflare DDNS** (keep A/AAAA records
  pointed at the box — public IP is self-detected, router push via
  `/nic/update` is a fast path, not a dependency) and **Wake-on-LAN** (magic
  packet from the server to agent-less LAN devices).
- **Install** — the one-liners from the Install section above, generated for
  the server you're looking at, ingest token already filled in.

Polling is 2 s end to end; all timestamps are epoch seconds.

## Files

| file | role |
|---|---|
| `pulse_agent.py` | agent — reads /proc, sysfs, hwmon, rocm-smi, PCI/USB; probes the Docker Engine API over the unix socket (if available); pushes snapshots every 2 s; runs the local action API on :9611 (kill + docker + llama.cpp controls) |
| `pulse_server.py` | central — ingest, in-memory history (per-metric, 6 h, persisted to `~/.pulse-server/state.json`), action proxy, DDNS + WOL, static web hosting, the `/install.sh` + `/install/…` bootstrap endpoints |
| `web/` | the dashboard (vanilla JS + canvas, no build step) |
| `install.sh` | the one-line installer (served with the server's auto-detected LAN base URL substituted in; the ingest token is a CLI argument, never in the script) |
| `deploy.sh` | alternative one-shot installer for systemd **user** units (`deploy.sh agent|server|all`), for fleet/manual use |
| `deploy/` | unit files + config templates |
| `local_test_agent.py` | dev rig — fake node generator + fake action API for testing the server on a laptop |

## Commands

Services (systemd **user** units — run as the user that owns the install):

```bash
systemctl --user status   pulse-server pulse-agent
systemctl --user restart  pulse-server
systemctl --user restart  pulse-agent
journalctl --user -u pulse-server -f
journalctl --user -u pulse-agent -f

sudo loginctl enable-linger $USER     # once per box: survive logout/boot
```

API from a shell (`KEY` = the panel API key):

```bash
curl -s -H "X-API-Key: $KEY" http://<server>:8090/api/state
curl -s -H "X-API-Key: $KEY" "http://<server>:8090/api/series?node=NAME&points=600"
curl -s -H "X-API-Key: $KEY" "http://<server>:8090/api/series?node=NAME&points=300&window=900"

# actions (proxied to the node's agent action API, token-protected)
curl -s -H "X-API-Key: $KEY" -X POST -d '{"node":"NAME","pid":1234,"sig":15}'      http://<server>:8090/api/action
curl -s -H "X-API-Key: $KEY" -X POST -d '{"node":"NAME","docker":{"cmd":"restart","container":"x"}}' http://<server>:8090/api/action
curl -s -H "X-API-Key: $KEY" -X POST -d '{"node":"NAME","llama":{"cmd":"start","args":"./llama-server -m model.gguf -c 4096"}}' http://<server>:8090/api/action
curl -s -H "X-API-Key: $KEY" -X POST -d '{"node":"NAME","gpu":{"cmd":"fan","index":0,"auto":false,"percent":45}}' http://<server>:8090/api/action

# wake-on-lan (agent-less devices)
curl -s -H "X-API-Key: $KEY" -X POST http://<server>:8090/api/wol/wake/<device-name>
```

## API (server)

Dashboard-side endpoints need the API key (`Authorization: Bearer <key>`,
`X-API-Key`, `?key=`, or the `pulse_key` cookie). `/api/ingest` needs the agent
token and is meant to be reached **over the LAN only** — the public edge
answers 403 for it (Security notes). `/nic/update` and `/install/…` are public
by design.

| endpoint | notes |
|---|---|
| `POST /api/ingest` | agent → server, `X-Pulse-Token`, **LAN-only** (the public edge 403s it); body `{v, name, agent, action_url, action_token, snap}`; `action_url` is only accepted from the agent's own ingest IP (SSRF guard) |
| `GET /api/state` | all nodes: online flag, last_seen, latest snapshot + DDNS/WOL summaries + an `install` block (LAN base URL + ingest token — what the Install tab renders) |
| `GET /api/series?node=NAME&points=N[&window=S]` | history for 12 metrics; without `window` the whole buffer is average-downsampled to N points, with `window=S` only the last S seconds are returned at full 2 s resolution |
| `POST /api/action` | `{node, pid, sig}` → kill on that node; `{node, docker: {…}}` → Docker controls; `{node, llama: {…}}` → llama.cpp controls; or `{node, gpu: {cmd: "fan", index, auto, percent?}}` → AMD fan Auto/manual control (manual range 20–100%). Expected action failures come back as HTTP 200 `{"ok": false, "error": "…"}` |
| `GET /api/ddns` / `POST /api/ddns` | read / save the Cloudflare DDNS config (secrets masked) |
| `POST /api/ddns/apply` / `POST /api/ddns/test` | re-detect public IP + re-write records now / read-only zone + record listing |
| `GET /api/wol` / `POST /api/wol` | read / replace the Wake-on-LAN device list |
| `POST /api/wol/wake/<name>` | fire the magic packet for one device |
| `GET /api/health` | liveness + node count |
| `GET /nic/update` | **public** No-IP-style endpoint for router DynDNS (`?hostname=…&myip=…&myipv6=…`), own Basic-auth check (optional — unset = closed), own lockout; responses `good <ip>`, `badauth`, `nohost`, `badip`, `disabled` |
| `GET /install.sh` / `GET /install/<file>` | **public** bootstrap: the installer (with two blank lines filled in: `INSTALL_BASE` = the server's auto-detected **LAN** base URL — never the request origin — and `DOWNLOAD_ORIGIN` = the URL the request came in as, so server mode can install off-LAN) and the whitelisted install assets — agent, server, `web/*`, `deploy.sh`, `llama_presets.json` |

## Configuration

All under the installing user's home:

| file | what's in it |
|---|---|
| `~/pulse/agent.conf` | `SERVER_URL`, `TOKEN` (shared ingest token), `INTERVAL=2`, `ACTION_PORT=9611` — mode 600 |
| `~/.pulse-server.env` | `PULSE_PORT`, `PULSE_BIND`, `PULSE_TOKEN`, `PULSE_API_KEY` (alias `PULSE_DASH_KEY`), `PULSE_STATE_DIR`, `PULSE_TLS_PROXY` (`1` when a TLS proxy like Caddy fronts the port → Secure cookies + client IPs from `X-Forwarded-For`) — mode 600 |
| `~/.pulse-server/state.json` | persisted history buffer |
| `~/.pulse-server/ddns.json` | DDNS: zone, token, TTL, records, toggles (absent = disabled) |
| `~/.pulse-server/wol.json` | WOL devices `[{"name","mac","ip"?}]` (absent = none) |
| `~/pulse/llama_presets.json` | (per node) llama.cpp presets `[{"name","args"}]`, edited live from the dashboard; re-read each snapshot |

Change anything → `systemctl --user restart pulse-server` (or `pulse-agent`);
`ddns.json`/`wol.json`/`llama_presets.json` hot-reload or re-read without a
restart where noted.

## Security notes

- **The dashboard side is key-gated and fail-closed.** `PULSE_API_KEY` in
  `~/.pulse-server.env` is *required* — the server refuses to start without it
  (`--no-auth` exists only for trusted-LAN dev). Opening `/` without a key
  redirects to the plain, JS-free `/keygate.html` form; a successful entry sets
  a **30-day** `pulse_key` cookie (`HttpOnly; SameSite=Lax`, `Secure` over
  TLS). There is deliberately **no per-IP lockout** — the key is 128-bit random
  and 401s are logged with the client IP instead (`journalctl --user -u
  pulse-server | grep 401`).
- **Ingest and action are separately token-protected** (`X-Pulse-Token` /
  `X-Pulse-Action-Token`, constant-time compares) — and ingest is **LAN-only**:
  the public edge (Caddy behind Cloudflare) answers 403 for
  `POST /api/ingest` before the request reaches the server. An agent may only
  pin an `action_url` reachable from its own ingest IP, and the server only
  ever POSTs actions there.
- **The agent action API only kills processes owned by the agent's own user.**
  `llama.cpp` control likewise only touches the agent's own processes.
- **Docker controls are docker-daemon powerful.** Whoever holds the panel API
  key can start/stop/restart/remove *any* container and delete *any* image on a
  node whose agent has socket access — same privilege as the `docker` group.
  Treat the key accordingly.
- **Public endpoints are read-only and whitelisted.** `/install/…` serves a
  fixed list of files (the code will be public here anyway); `/nic/update` has
  its own optional Basic-auth + per-IP lockout. The dashboard itself is never
  public. The ingest token is deliberately **not** part of the public script —
  it is a CLI argument of the installer and is only ever shown in the
  key-gated Install tab / `/api/state` response.
- **Reboot persistence:** systemd *user* services need lingering enabled once
  per box: `sudo loginctl enable-linger $USER`.

## Gotchas learned the hard way

- **Seconds, not milliseconds, end to end:** every timestamp in the system
  (`snap.ts`, history, `/api/series`) is epoch **seconds**. The chart window is
  therefore `CHART_WINDOW_S` in `app.js`; mixing in a millisecond constant
  silently widens the X-axis to days and squashes the line into a sliver.
- **CRLF:** piping scripts from Windows into `ssh host 'bash -s'` — strip `\r`
  first (`(Get-Content -Raw f) -replace "`r","" | ssh …`), otherwise the last
  line (or an inline unit name) silently corrupts.
- **rocm-smi in services:** the non-JSON `--showproductname` crashes inside a
  systemd user service (multiprocessing.Lock + resource_tracker need HOME).
  Use `--showproductname --json`. Even the JSON form reports
  `Card Series: N/A` while the GPU is in a low-power state — so the agent falls
  back to a PCI vendor:device:subsystem name table (`AMD_PCI_NAMES` in the
  agent).
- **DRM card numbering is not Intel/AMD ordered:** on a dual-GPU box `card0`
  may be the AMD card and `card1` the Intel one. The agent joins rocm's JSON
  cards to the amdgpu sysfs cards by driver + order instead of assuming card
  names.
- **Loopback LAN address:** the agent derives its reported IP from a UDP route
  lookup toward the server URL. When agent and server share a host
  (`SERVER_URL=http://127.0.0.1:8090`), that yields `127.0.0.1` — so the agent
  falls back to the primary network interface (lookup toward `1.1.1.1`, no
  packets sent) and reports the real LAN address instead.
- **Cloudflare 1010 bans the agent at the edge:** the agent pushes with a
  `Python-urllib` user agent, and a Cloudflare zone with bot protection
  answers **403, error 1010** ("banned based on your browser's signature")
  before the request reaches the origin — no `via: Caddy` header, and nothing
  in the server log. This is why node data is LAN-only: every agent points at
  the server's LAN URL, and the public Caddy block 403s `/api/ingest` anyway.
- **No `pip` anywhere** — everything is stdlib on purpose.
