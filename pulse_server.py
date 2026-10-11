#!/usr/bin/env python3
"""
Pulse Server — central collector + dashboard host. Single file, stdlib only.

Endpoints:
  POST /api/ingest     agent -> server snapshot (X-Pulse-Token). LAN-only
                       by design — the public edge answers 403 for it and
                       the installer always points agents at the LAN URL
  GET  /api/state      latest state of all nodes (dashboard)
  GET  /api/series     downsampled history  ?node=X&points=300
  POST /api/action     proxy action to an agent  {node, pid, sig} or
                       {node, docker: {cmd, container|image, force}}
  GET  /api/ddns       Cloudflare DDNS config (secrets masked) + status
  POST /api/ddns       update the DDNS config (blank secrets keep old values)
  POST /api/ddns/apply re-apply config now (re-detect public IPs,
                       cleanup + write records)
  The server also re-detects its public IPv4/IPv6 every 5 min on its own
  and re-writes the records (skip-if-unchanged), so Cloudflare stays
  current even when the router's /nic/update push is silent.
  POST /api/ddns/test  read-only Cloudflare connectivity check
  GET  /api/wol        Wake-on-LAN device list (config + status)
  POST /api/wol        update the WOL device list
  POST /api/wol/wake/<name>
                       send the magic packet for a device (LAN broadcast,
                       UDP ports 9 + 7, fired from the central server)
  GET/POST /nic/update FRITZ!Box-style DynDNS endpoint (own Basic auth,
                        not behind the API-key gate — see below)
  GET  /install.sh    one-line installer (public, same pattern as
  GET  /install/<f>   /nic/update): serves install.sh with its
                      INSTALL_BASE="" line replaced by this server's
                      LAN base URL (http://<lan-ip>:<port>,
                      auto-detected; PULSE_LAN_IP overrides it) plus
                      the whitelisted assets the script downloads from
                      this host. /api/state (key-gated) also carries an
                      "install" block {url, token} that the dashboard's
                      Install tab renders as copy-ready one-liners
  GET  /*              static dashboard (web/)

Auth:
  Every request on the dashboard side (API + static files) requires the
  API key: `Authorization: Bearer <key>`, `X-API-Key: <key>`, `?key=<key>`
  (also issues a session cookie) or the `pulse_key` cookie. The agent
  ingest channel is separate and uses X-Pulse-Token.

Config via environment:
  PULSE_PORT      8090
  PULSE_BIND      0.0.0.0
  PULSE_TOKEN     required ingest token (shared with agents)
  PULSE_API_KEY   required dashboard/API key (PULSE_DASH_KEY is accepted
                  as an alias). If unset the server refuses to start —
                  pass --no-auth only on a fully trusted LAN.
  PULSE_TLS_PROXY 1 = a TLS-terminating reverse proxy sits in front:
                  Secure cookies + client IPs read from X-Forwarded-For.
                  (Firewall this port to the proxy host!)
  PULSE_LAN_IP    override for the auto-detected LAN IP that goes into
                  the installer's INSTALL_BASE and the dashboard's
                  install one-liners (multi-homed boxes whose default
                  route is not the Pulse LAN)
  PULSE_STATE_DIR ~/.pulse-server (also holds ddns.json, the Cloudflare
                    DDNS config, absent = DDNS disabled, and wol.json,
                    the Wake-on-LAN device list, absent = no devices)

/nic/update auth:
   The DynDNS endpoint is public by design (routers speak only HTTP Basic)
   and is therefore NOT behind the API-key gate. It is protected by its own
   Basic-auth (ddnsUser/ddnsPass from ddns.json) with its own per-IP
   lockout (10 fails / 5 min -> 5 min). If no credentials are configured
   the endpoint is closed (503 disabled) — ddnsUser/ddnsPass are optional
   for Cloudflare-only setups.
"""

import base64
import hmac
import ipaddress
import json
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlencode, urlparse

SERVER_VERSION = "1.4.0"
INSTALL_URL = ""               # LAN base URL for the installer (set in main)
ONLINE_WINDOW = 20.0          # seconds before a node is marked offline
HISTORY_MAX = 10800           # ~6h at 2s resolution (per metric)
HISTORY_PERSIST = 1800        # ~1h kept in state.json
METRICS = ("cpu", "mem", "swap", "load1", "load5", "load15",
           "drio", "driw", "nrx", "ntx", "temp", "gpu")
STATIC_DIR = Path(__file__).resolve().parent / "web"
MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".json": "application/json",
    ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


def now():
    return time.time()


def log(msg):
    print(f"[pulse-server] {msg}", flush=True)


def local_ips():
    """Non-loopback local IPv4 addresses (UDP route lookup, no packets)."""
    ips = set()
    for target in ("1.1.1.1", "8.8.8.8"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(1)
            s.connect((target, 80))
            ips.add(s.getsockname()[0])
            s.close()
        except OSError:
            pass
    return ips


# No per-IP lockout on the dashboard key gate: the key is 128-bit random,
# so online brute force is infeasible, and IP-based lockouts kept biting
# legitimate users (shared proxy exit IPs, a stale keyless tab hammering
# the same IP as its owner). 401s are still logged with the client IP
# (X-Forwarded-For when PULSE_TLS_PROXY=1) for monitoring.
COOKIE_MAX_AGE = 30 * 86400   # pulse_key cookie lifetime: 30 days
LOCAL_IPS = local_ips()


def extract_metrics(snap):
    """Scalars stored per tick for charting."""
    cpu = (snap.get("cpu") or {}).get("pct", 0) or 0
    mem = snap.get("mem") or {}
    mt, mu = mem.get("total", 0), mem.get("used", 0)
    sw_t, sw_u = mem.get("swap_total", 0), mem.get("swap_used", 0)
    load = (snap.get("cpu") or {}).get("load") or {}
    drio = sum(v.get("r", 0) for v in (snap.get("disk_io") or {}).values())
    driw = sum(v.get("w", 0) for v in (snap.get("disk_io") or {}).values())
    nrx = sum(v.get("rx", 0) for v in (snap.get("net_io") or {}).values())
    ntx = sum(v.get("tx", 0) for v in (snap.get("net_io") or {}).values())
    temps = [t.get("c") for t in (snap.get("temps") or []) if t.get("c") is not None]
    gpus = snap.get("gpu") or []
    gpu_use = gpus[0].get("use") if gpus and gpus[0].get("use") is not None else 0
    return {
        "cpu": round(float(cpu), 1),
        "mem": round(mu * 100.0 / mt, 1) if mt else 0.0,
        "swap": round(sw_u * 100.0 / sw_t, 1) if sw_t else 0.0,
        "load1": load.get("load1", 0.0),
        "load5": load.get("load5", 0.0),
        "load15": load.get("load15", 0.0),
        "drio": round(drio, 1),
        "driw": round(driw, 1),
        "nrx": round(nrx, 1),
        "ntx": round(ntx, 1),
        "temp": round(max(temps), 1) if temps else 0.0,
        "gpu": round(float(gpu_use), 1),
    }


class Node:
    def __init__(self, name):
        self.name = name
        self.history = {m: deque(maxlen=HISTORY_MAX) for m in METRICS}
        self.latest = None
        self.action_url = None
        self.action_token = None
        self.agent_version = None
        self.last_seen = 0.0
        self.first_seen = now()

    def add(self, payload, client_ip=None):
        snap = payload.get("snap") or {}
        self.latest = snap
        self.last_seen = now()
        # SSRF guard: the server later POSTs to action_url, so only trust a
        # URL the agent claims from its own ingest address (or from
        # localhost for a same-host agent claiming its own LAN IP).
        url = payload.get("action_url")
        if url:
            u = urlparse(url)
            host = (u.hostname or "").lower()
            ok = (u.scheme == "http" and host
                  and (host == client_ip
                       or (client_ip in ("127.0.0.1", "::1")
                           and (host in ("127.0.0.1", "localhost")
                                or host in LOCAL_IPS))))
            if ok:
                self.action_url = url
            elif url != getattr(self, "_last_rejected_url", None):
                self._last_rejected_url = url
                log(f"action_url for {self.name} rejected: {url} "
                    f"(ingest client {client_ip})")
        self.action_token = payload.get("action_token")
        self.agent_version = payload.get("agent")
        m = extract_metrics(snap)
        ts = snap.get("ts") or now()
        for k in METRICS:
            self.history[k].append((round(ts, 2), m.get(k, 0.0)))

    def online(self):
        return now() - self.last_seen < ONLINE_WINDOW


class Store:
    def __init__(self, state_dir):
        self.dir = Path(state_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.state_file = self.dir / "state.json"
        self.nodes = {}
        self.lock = threading.Lock()
        self.load()

    def get(self, name):
        with self.lock:
            n = self.nodes.get(name)
            if n is None:
                n = self.nodes[name] = Node(name)
            return n

    def load(self):
        if not self.state_file.exists():
            return
        try:
            data = json.loads(self.state_file.read_text())
            for name, nd in data.get("nodes", {}).items():
                n = Node(name)
                n.latest = nd.get("latest")
                n.action_url = nd.get("action_url")
                n.action_token = nd.get("action_token")
                n.agent_version = nd.get("agent_version")
                n.last_seen = nd.get("last_seen", 0)
                n.first_seen = nd.get("first_seen", n.last_seen)
                for k, series in (nd.get("history") or {}).items():
                    if k in n.history:
                        n.history[k].extend(series)
                self.nodes[name] = n
            log(f"restored {len(self.nodes)} node(s) from {self.state_file}")
        except Exception as e:
            log(f"state load failed: {e}")

    def save(self):
        with self.lock:
            data = {
                "saved": now(),
                "nodes": {
                    name: {
                        "latest": n.latest,
                        "action_url": n.action_url,
                        "action_token": n.action_token,
                        "agent_version": n.agent_version,
                        "last_seen": n.last_seen,
                        "first_seen": n.first_seen,
                        "history": {
                            k: list(h)[-HISTORY_PERSIST:]
                            for k, h in n.history.items()
                        },
                    }
                    for name, n in self.nodes.items()
                },
            }
        tmp = self.state_file.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(data))
            os.replace(tmp, self.state_file)
        except OSError as e:
            log(f"state save failed: {e}")


# ---------------------------------------------------------------------------
# Cloudflare DDNS engine — port of the standalone cloudflare-ddns-adapter.ps1
# (FRITZ!Box -> /nic/update -> Cloudflare A/AAAA).
# ---------------------------------------------------------------------------

DDNS_AUTH_LIMIT = 10          # failed Basic-auth attempts ...
DDNS_AUTH_WINDOW = 300.0      # ... counted over this many seconds
DDNS_AUTH_LOCKOUT = 300.0     # -> /nic/update locked out this long
DDNS_REFRESH_INTERVAL = 300.0  # seconds between public-IP self-refreshes
DDNS_IP_URLS_V4 = ("https://api.ipify.org", "https://v4.ident.me")
DDNS_IP_URLS_V6 = ("https://api6.ipify.org", "https://v6.ident.me")
_ddns_failures = {}           # ip -> [count, window_start, locked_until]
_ddns_failures_lock = threading.Lock()


def ddns_auth_blocked(ip):
    with _ddns_failures_lock:
        rec = _ddns_failures.get(ip)
        return bool(rec and rec[2] > now())


def ddns_auth_fail(ip):
    t = now()
    with _ddns_failures_lock:
        rec = _ddns_failures.get(ip)
        if not rec or t - rec[1] > DDNS_AUTH_WINDOW:
            rec = [1, t, 0.0]
            _ddns_failures[ip] = rec
        else:
            rec[0] += 1
        if rec[0] >= DDNS_AUTH_LIMIT and rec[2] <= t:
            rec[2] = t + DDNS_AUTH_LOCKOUT
            log(f"ddns: {ip} locked out for {int(DDNS_AUTH_LOCKOUT)}s after "
                f"{rec[0]} failed attempts")


class DDNS:
    """Config: <state_dir>/ddns.json (same schema as the standalone adapter):
    cfApiToken, zoneName, recordNames ([{name, proxied} | "name"]),
    ddnsUser, ddnsPass (optional — /nic/update Basic auth; unset = the
    endpoint is closed), ttl, proxied, enableA, enableAAAA,
    deleteDisabledRecords.
    Secrets are never logged and only ever echoed back as set/unset flags.

    IP sources, in order of freshness: the router's /nic/update push
    (seconds, when it works) and the server's own periodic detection of
    its public IP (every DDNS_REFRESH_INTERVAL, via public IP-echo
    services) — the fallback that keeps records current when the router
    push is silent or misconfigured.
    """

    CF_BASE = "https://api.cloudflare.com/client/v4"

    def __init__(self, state_dir):
        self.file = Path(state_dir) / "ddns.json"
        self.lock = threading.RLock()
        self.cfg = None
        self.zone_id = None
        self.rec_cache = {}            # "TYPE|name" -> record id
        self.stats = self._new_stats()
        self.apply_busy = False
        self._applied_fp = None   # fingerprint of the last successful apply
        self.load()

    @staticmethod
    def _new_stats():
        return {
            "requests": 0, "accepted": 0, "updates": 0,
            "last_request": 0.0, "last_request_ip": "",
            "last_update": 0.0, "last_ips": {"v4": "", "v6": ""},
            "last_ip_source": "", "last_error": "", "last_error_ts": 0.0,
        }

    # -- config ---------------------------------------------------------

    @staticmethod
    def _parse(raw):
        """Validate + normalize a raw config dict; raises ValueError."""
        if not isinstance(raw, dict):
            raise ValueError("config must be a JSON object")
        for f in ("cfApiToken", "zoneName"):
            v = raw.get(f)
            if not (isinstance(v, str) and v.strip()):
                raise ValueError("missing required config field: " + f)
        items = raw.get("recordNames")
        if items is None:
            items = [raw["recordName"]] if raw.get("recordName") else []
        if not isinstance(items, list):
            raise ValueError("recordNames must be a list")
        proxied_def = bool(raw.get("proxied", False))
        records, seen = [], set()
        for it in items:
            if isinstance(it, str):
                name, prox = it.strip(), proxied_def
            elif isinstance(it, dict) and str(it.get("name") or "").strip():
                name = str(it["name"]).strip()
                prox = bool(it.get("proxied", proxied_def))
            else:
                continue
            if not name or name in seen:
                continue
            seen.add(name)
            records.append({"name": name, "proxied": prox})
        if not records:
            raise ValueError("at least one record name is required")
        try:
            ttl = int(raw.get("ttl", 1))
        except (TypeError, ValueError):
            raise ValueError("ttl must be an integer")
        if ttl < 1:
            raise ValueError("ttl must be >= 1")
        # Cloudflare only accepts 1 (Automatic) or 60..86400 as a record
        # TTL — snap anything in between to Automatic so a write can never
        # fail with error 9021 (legacy configs carry ttl=30).
        if 1 < ttl < 60:
            ttl = 1
        elif ttl > 86400:
            ttl = 86400
        return {
            "cfApiToken": raw["cfApiToken"].strip(),
            "zoneName": raw["zoneName"].strip(),
            "records": records,
            "ddnsUser": str(raw.get("ddnsUser") or ""),
            "ddnsPass": str(raw.get("ddnsPass") or ""),
            "ttl": ttl,
            "proxied": proxied_def,
            "enableA": bool(raw.get("enableA", True)),
            "enableAAAA": bool(raw.get("enableAAAA", True)),
            "deleteDisabledRecords": bool(
                raw.get("deleteDisabledRecords", False)),
        }

    def load(self):
        with self.lock:
            if not self.file.exists():
                self.cfg = None
                log(f"ddns: no {self.file} — Cloudflare DDNS disabled "
                    "(set it up from the dashboard Main page)")
                return
            try:
                self.cfg = self._parse(json.loads(self.file.read_text()))
            except Exception as e:
                self.cfg = None
                log(f"ddns: config load failed: {e}")
                return
            self.zone_id = None
            self.rec_cache = {}
            self._applied_fp = None
            log(f"ddns: config loaded (zone {self.cfg['zoneName']}, "
                f"{len(self.cfg['records'])} record(s), A "
                f"{'on' if self.cfg['enableA'] else 'off'}, AAAA "
                f"{'on' if self.cfg['enableAAAA'] else 'off'})")

    def _write(self, cfg):
        out = {
            "cfApiToken": cfg["cfApiToken"],
            "zoneName": cfg["zoneName"],
            "recordNames": cfg["records"],
            "ddnsUser": cfg["ddnsUser"],
            "ddnsPass": cfg["ddnsPass"],
            "ttl": cfg["ttl"],
            "proxied": cfg["proxied"],
            "enableA": cfg["enableA"],
            "enableAAAA": cfg["enableAAAA"],
            "deleteDisabledRecords": cfg["deleteDisabledRecords"],
        }
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(out, indent=2))
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.file)

    def update(self, raw):
        """Merge + validate a dashboard-submitted config, persist it, and
        re-apply in the background. Blank cfApiToken / ddnsUser / ddnsPass
        keep the stored values, and omitted optional fields (ttl / toggles)
        keep the stored ones too, so partial updates cannot silently
        re-default them. Unknown keys (e.g. a legacy "noip" block) are
        dropped."""
        with self.lock:
            old = self.cfg or {}
            if not isinstance(raw, dict):
                raise ValueError("config must be a JSON object")
            merged = dict(raw)
            for f in ("cfApiToken", "ddnsUser", "ddnsPass"):
                v = merged.get(f)
                if not (isinstance(v, str) and v.strip()) and old.get(f):
                    merged[f] = old[f]
            for f in ("ttl", "proxied", "enableA", "enableAAAA",
                      "deleteDisabledRecords"):
                if f not in merged and old.get(f) is not None:
                    merged[f] = old[f]
            merged.pop("noip", None)   # legacy key, removed in v1.2.2
            cfg = self._parse(merged)
            self.cfg = cfg
            self.zone_id = None
            self.rec_cache = {}
            self._applied_fp = None
            self._write(cfg)
            log(f"ddns: config updated (zone {cfg['zoneName']}, "
                f"{len(cfg['records'])} record(s))")
            self.request_apply_async("config save")

    # -- views (secrets masked) ------------------------------------------

    def _status(self):
        s = self.stats
        return {
            "zone": (self.cfg or {}).get("zoneName", ""),
            "zoneId": self.zone_id or "",
            "requests": s["requests"],
            "accepted": s["accepted"],
            "updates": s["updates"],
            "lastRequest": s["last_request"],
            "lastRequestIp": s["last_request_ip"],
            "lastUpdate": s["last_update"],
            "lastIps": dict(s["last_ips"]),
            "lastIpSource": s["last_ip_source"],
            "lastError": s["last_error"],
            "lastErrorTs": s["last_error_ts"],
        }

    def view(self):
        with self.lock:
            if not self.cfg:
                return {"ok": True, "enabled": False, "config": None,
                        "status": self._status()}
            c = self.cfg
            return {"ok": True, "enabled": True,
                    "config": {
                        "zoneName": c["zoneName"],
                        "ttl": c["ttl"],
                        "proxied": c["proxied"],
                        "enableA": c["enableA"],
                        "enableAAAA": c["enableAAAA"],
                        "deleteDisabledRecords": c["deleteDisabledRecords"],
                        "records": [dict(r) for r in c["records"]],
                        "cfApiTokenSet": True,
                        "ddnsUser": c["ddnsUser"],
                        "ddnsPassSet": bool(c["ddnsPass"]),
                    },
                    "status": self._status()}

    def state_line(self):
        """Compact status for the /api/state poll."""
        with self.lock:
            s = self.stats
            cfg = self.cfg
            return {
                "enabled": bool(cfg),
                "zone": cfg["zoneName"] if cfg else "",
                "zoneId": self.zone_id or "",
                "records": len(cfg["records"]) if cfg else 0,
                "a": cfg["enableA"] if cfg else False,
                "aaaa": cfg["enableAAAA"] if cfg else False,
                "lastUpdate": s["last_update"],
                "lastIps": dict(s["last_ips"]),
                "lastIpSource": s["last_ip_source"],
                "lastRequest": s["last_request"],
                "lastRequestIp": s["last_request_ip"],
                "requests": s["requests"],
                "accepted": s["accepted"],
                "updates": s["updates"],
                "lastError": s["last_error"],
                "lastErrorTs": s["last_error_ts"],
            }

    # -- Cloudflare API ---------------------------------------------------

    @staticmethod
    def _cf_error_detail(result, method, path):
        msgs = []
        for k in ("errors", "messages"):
            for err in result.get(k) or []:
                parts = []
                if err.get("code"):
                    parts.append("code=" + str(err["code"]))
                if err.get("message"):
                    parts.append("message=" + str(err["message"]))
                src = err.get("source") or {}
                if src.get("pointer"):
                    parts.append("pointer=" + str(src["pointer"]))
                if parts:
                    msgs.append(" ".join(parts))
        if msgs:
            return f"Cloudflare API {method} {path} failed: " + "; ".join(msgs)
        return f"Cloudflare API {method} {path} failed: no error details"

    def _cf(self, method, path, query=None, body=None):
        """One Cloudflare API call (caller holds self.lock). Returns the
        parsed response dict; raises RuntimeError on any failure. The token
        never appears in errors or logs."""
        url = self.CF_BASE + path
        if query:
            url += "?" + urlencode(query)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Bearer " + self.cfg["cfApiToken"],
            "Content-Type": "application/json",
            "User-Agent": "PulseServer/" + SERVER_VERSION,
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                result = json.loads(r.read())
        except urllib.error.HTTPError as e:
            detail = f"HTTP {e.code}"
            try:
                detail = self._cf_error_detail(
                    json.loads(e.read()), method, path)
            except Exception:
                pass
            raise RuntimeError(
                f"Cloudflare API {method} {path} failed: {detail}"
                if detail == f"HTTP {e.code}"
                else detail)
        except Exception as e:
            raise RuntimeError(f"Cloudflare API {method} {path} failed: {e}")
        if result.get("success") is not True:
            raise RuntimeError(self._cf_error_detail(result, method, path))
        return result

    def _zone_id(self):
        if self.zone_id:
            return self.zone_id
        result = self._cf("GET", "/zones",
                          {"name": self.cfg["zoneName"], "per_page": 50})
        zone = next((z for z in result.get("result") or []
                     if z.get("name") == self.cfg["zoneName"]), None)
        if not zone:
            raise RuntimeError(
                f"Cloudflare zone not found: {self.cfg['zoneName']}")
        self.zone_id = str(zone["id"])
        log(f"ddns: discovered Cloudflare zone {self.cfg['zoneName']} "
            f"({self.zone_id})")
        return self.zone_id

    def _record_id(self, rtype, name):
        key = rtype + "|" + name
        if key in self.rec_cache:
            return self.rec_cache[key]
        zone = self._zone_id()
        result = self._cf("GET", f"/zones/{zone}/dns_records",
                          {"type": rtype, "name": name, "per_page": 50})
        rec = next((r for r in result.get("result") or []
                    if r.get("type") == rtype and r.get("name") == name), None)
        if rec:
            self.rec_cache[key] = str(rec["id"])
            return self.rec_cache[key]
        return None

    @staticmethod
    def _proxied_for(records, name, fallback):
        for r in records:
            if r["name"] == name:
                return r["proxied"]
        return fallback

    def _set_record(self, rtype, name, content):
        """Create or update one record; returns 'created'/'updated'."""
        zone = self._zone_id()
        body = {
            "type": rtype,
            "name": name,
            "content": content,
            "ttl": self.cfg["ttl"],
            "proxied": self._proxied_for(self.cfg["records"], name,
                                         self.cfg["proxied"]),
        }
        rid = self._record_id(rtype, name)
        if not rid:
            result = self._cf("POST", f"/zones/{zone}/dns_records", body=body)
            new_id = (result.get("result") or {}).get("id")
            if new_id:
                self.rec_cache[rtype + "|" + name] = str(new_id)
            return "created"
        self._cf("PUT", f"/zones/{zone}/dns_records/{rid}", body=body)
        return "updated"

    def _delete_records(self, rtype, name):
        """Delete all matching records (disabled-type cleanup); count."""
        zone = self._zone_id()
        result = self._cf("GET", f"/zones/{zone}/dns_records",
                          {"type": rtype, "name": name, "per_page": 100})
        deleted = 0
        for rec in result.get("result") or []:
            if rec.get("type") == rtype and rec.get("name") == name:
                self._cf("DELETE", f"/zones/{zone}/dns_records/{rec['id']}")
                self.rec_cache.pop(rtype + "|" + name, None)
                deleted += 1
                log(f"ddns: deleted disabled {rtype} record for {name}")
        return deleted

    def _cleanup_disabled(self):
        """Delete records of disabled record types (deleteDisabledRecords)."""
        if not self.cfg["deleteDisabledRecords"]:
            return
        deleted = 0
        for r in self.cfg["records"]:
            if not self.cfg["enableA"]:
                deleted += self._delete_records("A", r["name"])
            if not self.cfg["enableAAAA"]:
                deleted += self._delete_records("AAAA", r["name"])
        log(f"ddns: disabled-record cleanup done, deleted {deleted}")

    def _detect_ip(self, version):
        """Detect our own public IP of the given family (4/6) by asking
        public IP-echo services. Returns the IP string, or None when
        nothing reachable (e.g. no egress of that family). This is what
        lets the server push records even when the router's /nic/update
        push is silent or misconfigured (caller holds self.lock)."""
        urls = DDNS_IP_URLS_V4 if version == 4 else DDNS_IP_URLS_V6
        for url in urls:
            try:
                with urllib.request.urlopen(url, timeout=10) as r:
                    value = r.read(128).decode("utf-8", "replace").strip()
            except Exception:
                continue
            try:
                ip = ipaddress.ip_address(value)
            except ValueError:
                continue
            if ip.version == version:
                return value
        return None

    # -- updates --------------------------------------------------------------

    @staticmethod
    def _valid_ip(value, version):
        """Return value if it parses as an IP of `version`, else None."""
        if not value:
            return None
        try:
            ip = ipaddress.ip_address(value)
        except ValueError:
            return None
        return value if ip.version == version else None

    def _apply_fingerprint(self, v4, v6):
        """Hash-free fingerprint of everything a write round depends on:
        IPs + config. Lets periodic refreshes skip Cloudflare entirely
        when nothing changed."""
        c = self.cfg
        return json.dumps([c["zoneName"], v4, v6, c["ttl"], c["enableA"],
                           c["enableAAAA"], c["deleteDisabledRecords"],
                           [[r["name"], r["proxied"]] for r in c["records"]]])

    def apply(self, v4, v6, force=False):
        """Update the configured Cloudflare records with validated IPs
        (caller holds self.lock). Skips the write round-trip when IPs +
        config are unchanged since the last successful apply (unless
        force). Returns the number of records written."""
        cfg = self.cfg
        fp = self._apply_fingerprint(v4, v6)
        if not force and fp == self._applied_fp:
            log("ddns: nothing to do (IPs and config unchanged)")
            return 0
        done = 0
        for r in cfg["records"]:
            if cfg["enableA"] and v4:
                action = self._set_record("A", r["name"], v4)
                log(f"ddns: A record {action} for {r['name']}")
                done += 1
            if cfg["enableAAAA"] and v6:
                action = self._set_record("AAAA", r["name"], v6)
                log(f"ddns: AAAA record {action} for {r['name']}")
                done += 1
        s = self.stats
        s["last_ips"]["v4"] = v4 or s["last_ips"]["v4"]
        s["last_ips"]["v6"] = v6 or s["last_ips"]["v6"]
        if done:
            s["last_update"] = now()
            s["updates"] += done
            s["last_error"] = ""
            self._applied_fp = fp
        return done

    @staticmethod
    def _basic_auth_ok(header, cfg):
        """Constant-time HTTP Basic check against ddnsUser/ddnsPass."""
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:].strip()).decode("utf-8")
        except Exception:
            return False
        user, sep, pw = decoded.partition(":")
        if not sep:
            return False
        return (hmac.compare_digest(user.encode(), cfg["ddnsUser"].encode())
                and hmac.compare_digest(pw.encode(), cfg["ddnsPass"].encode()))

    def handle_update(self, headers, query, client_ip):
        """FRITZ!Box-style /nic/update. -> (status, body, extra_headers).
        Bodies follow the classic DynDNS update conventions:
        good <ip> [<ip6>] | nohost | badip | badauth | 911 | disabled."""
        def out(code, body, extra=None):
            return code, body, extra or {}
        with self.lock:
            s = self.stats
            s["requests"] += 1
            s["last_request"] = now()
            s["last_request_ip"] = client_ip
            cfg = self.cfg
        if not cfg:
            return out(503, "disabled")
        if not (cfg["ddnsUser"] and cfg["ddnsPass"]):
            return out(503, "disabled")   # no Basic-auth creds -> closed
        if ddns_auth_blocked(client_ip):
            log(f"ddns: locked-out {client_ip} rejected")
            return out(401, "badauth",
                       {"WWW-Authenticate": 'Basic realm="PulseDDNS"'})
        if not self._basic_auth_ok(headers.get("Authorization", ""), cfg):
            ddns_auth_fail(client_ip)
            log(f"ddns: rejected unauthenticated /nic/update from "
                f"{client_ip}")
            return out(401, "badauth",
                       {"WWW-Authenticate": 'Basic realm="PulseDDNS"'})
        hostname = (query.get("hostname") or [""])[0]
        allowed = {r["name"] for r in cfg["records"]} | {cfg["zoneName"]}
        if hostname not in allowed:       # case-sensitive, like the original
            log(f"ddns: rejected hostname {hostname!r} from {client_ip}")
            return out(400, "nohost")
        myip = (query.get("myip") or [""])[0]
        myipv6 = (query.get("myipv6") or [""])[0]
        v4 = self._valid_ip(myip, 4)
        v6 = self._valid_ip(myipv6, 6)
        if ((myip and v4 is None and cfg["enableA"])
                or (myipv6 and v6 is None and cfg["enableAAAA"])):
            log(f"ddns: rejected invalid IP from {client_ip}")
            return out(400, "badip")
        do_a = cfg["enableA"] and v4
        do_aaaa = cfg["enableAAAA"] and v6
        if not (do_a or do_aaaa):
            log(f"ddns: no enabled target has a valid IP ({client_ip})")
            return out(400, "badip")
        try:
            with self.lock:
                done = self.apply(v4 if do_a else None,
                                  v6 if do_aaaa else None)
                self.stats["accepted"] += 1
                self.stats["last_ip_source"] = "router"
        except Exception as e:
            with self.lock:
                self.stats["last_error"] = str(e)
                self.stats["last_error_ts"] = now()
            log(f"ddns: update failed from {client_ip}: {e}")
            return out(500, "911")
        parts = ["good"]
        if do_a:
            parts.append(v4)
        if do_aaaa:
            parts.append(v6)
        log(f"ddns: update completed from {client_ip} ({done} record(s))")
        return out(200, " ".join(parts))

    def request_apply_async(self, reason=""):
        """Re-apply the config in a background thread: re-detect the
        current public IPs (falling back to the last known ones), cleanup
        of disabled record types, then records at those IPs. Returns False
        when DDNS is disabled or an apply is already running."""
        with self.lock:
            if not self.cfg or self.apply_busy:
                return False
            self.apply_busy = True

        def work():
            try:
                with self.lock:
                    self._cleanup_disabled()
                    detected = False
                    if self.cfg["enableA"]:
                        v4 = self._detect_ip(4)
                        if v4:
                            detected = True
                            log(f"ddns: detected public IPv4 {v4}")
                            self.stats["last_ips"]["v4"] = v4
                            self.stats["last_ip_source"] = "detected"
                    if self.cfg["enableAAAA"]:
                        v6 = self._detect_ip(6)
                        if v6:
                            detected = True
                            log(f"ddns: detected public IPv6 {v6}")
                            self.stats["last_ips"]["v6"] = v6
                            self.stats["last_ip_source"] = "detected"
                    if not detected:
                        log(f"ddns: IP detection failed ({reason}) — "
                            "using last known IPs")
                    v4 = self.stats["last_ips"]["v4"] or None
                    v6 = self.stats["last_ips"]["v6"] or None
                    if v4 or v6:
                        done = self.apply(v4, v6)
                        log(f"ddns: re-applied ({done} record(s), {reason})")
                    else:
                        log(f"ddns: re-apply has no known IPs ({reason}) — "
                            "records update on the next /nic/update")
            except Exception as e:
                with self.lock:
                    self.stats["last_error"] = str(e)
                    self.stats["last_error_ts"] = now()
                log(f"ddns: re-apply failed ({reason}): {e}")
            finally:
                with self.lock:
                    self.apply_busy = False

        threading.Thread(target=work, daemon=True).start()
        return True

    def test(self):
        """Read-only connectivity check: token, zone, current record values."""
        with self.lock:
            if not self.cfg:
                raise RuntimeError("DDNS not configured")
            zone = self._zone_id()
            found = []
            for r in self.cfg["records"]:
                for rtype in ("A", "AAAA"):
                    res = self._cf("GET", f"/zones/{zone}/dns_records",
                                   {"type": rtype, "name": r["name"],
                                    "per_page": 50})
                    for rec in res.get("result") or []:
                        if (rec.get("type") == rtype
                                and rec.get("name") == r["name"]):
                            found.append({
                                "type": rtype,
                                "name": r["name"],
                                "content": rec.get("content", ""),
                                "proxied": bool(rec.get("proxied")),
                                "ttl": rec.get("ttl"),
                            })
            return {"zone": self.cfg["zoneName"], "zoneId": zone,
                    "records": found}


class WOL:
    """Wake-on-LAN for agent-less LAN devices (printers, NAS, ...).

    Config: <state_dir>/wol.json — {"devices": [{"name", "mac", "ip"?}]}.
    Absent file = no devices configured (not an error). The server sends
    the magic packet (6x 0xFF + MAC x 16) itself as UDP to the LAN
    broadcast addresses of its own interfaces (assuming /24, plus
    255.255.255.255) on port 9 and 7 (fallback), and to the device's
    optional "ip" directly — so waking works for devices that run no
    Pulse agent. Waking never fails on the packet side by design:
    broadcast UDP cannot be acknowledged."""

    MAX_DEVICES = 50

    def __init__(self, state_dir):
        self.file = Path(state_dir) / "wol.json"
        self.lock = threading.RLock()
        self.cfg = None
        self.stats = self._new_stats()
        self.load()

    @staticmethod
    def _new_stats():
        return {"wakes": 0, "last_wake": 0.0, "last_wake_device": "",
                "last_error": "", "last_error_ts": 0.0}

    # -- config ---------------------------------------------------------

    @staticmethod
    def _norm_mac(mac):
        """Normalize 'AA-BB-CC-DD-EE-FF' / 'AABB.CCDD.EEFF' / plain hex to
        'aa:bb:cc:dd:ee:ff'; raises ValueError on anything else."""
        h = re.sub(r"[\s:.-]", "", str(mac or "").lower())
        if len(h) != 12 or any(c not in "0123456789abcdef" for c in h):
            raise ValueError(f"invalid MAC address: {mac!r}")
        return ":".join(h[i:i + 2] for i in range(0, 12, 2))

    @classmethod
    def _mac_bytes(cls, mac):
        return bytes(int(p, 16) for p in cls._norm_mac(mac).split(":"))

    @classmethod
    def _parse(cls, raw):
        """Validate + normalize a raw config; raises ValueError."""
        if not isinstance(raw, dict):
            raise ValueError("config must be a JSON object")
        items = raw.get("devices")
        if items is None:
            items = []
        if not isinstance(items, list):
            raise ValueError("devices must be a list")
        if len(items) > cls.MAX_DEVICES:
            raise ValueError(f"too many devices (max {cls.MAX_DEVICES})")
        devices, seen_mac, seen_name = [], set(), set()
        for it in items:
            name, mac, ip = "", "", ""
            if isinstance(it, dict):
                name = str(it.get("name") or "").strip()
                mac = str(it.get("mac") or "").strip()
                ip = str(it.get("ip") or "").strip()
            elif isinstance(it, str):
                # hand-edited convenience: "Name aa:bb:cc:dd:ee:ff [ip]"
                parts = it.split()
                if len(parts) == 1:
                    mac = parts[0]
                else:
                    mac = parts[-1]
                    name = " ".join(parts[:-1])
                    if len(parts) >= 3:
                        try:
                            ipaddress.ip_address(parts[-2])
                            ip = parts[-2]
                        except ValueError:
                            pass
            else:
                continue
            if not mac:
                continue
            mac = cls._norm_mac(mac)
            name = name or mac
            if len(name) > 40 or "/" in name or re.search(r"[\x00-\x1f]", name):
                raise ValueError(f"invalid device name: {name!r}")
            if ip:
                try:
                    ip = str(ipaddress.ip_address(ip))
                except ValueError:
                    raise ValueError(f"invalid device IP: {ip!r}")
            if mac in seen_mac:
                continue
            key = name.lower()
            if key in seen_name:
                raise ValueError(f"duplicate device name: {name!r}")
            seen_mac.add(mac)
            seen_name.add(key)
            devices.append({"name": name, "mac": mac, "ip": ip})
        return {"devices": devices}

    def load(self):
        with self.lock:
            if not self.file.exists():
                self.cfg = None
                log(f"wol: no {self.file} — no Wake-on-LAN devices "
                    "(add them from the dashboard Main page)")
                return
            try:
                self.cfg = self._parse(json.loads(self.file.read_text()))
            except Exception as e:
                self.cfg = None
                log(f"wol: config load failed: {e}")
                return
            log(f"wol: config loaded ({len(self.cfg['devices'])} device(s))")

    def _write(self, cfg):
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(cfg, indent=2))
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.file)

    def update(self, raw):
        """Full-list replacement from the dashboard (no secrets to merge)."""
        with self.lock:
            cfg = self._parse(raw)
            self.cfg = cfg
            self._write(cfg)
            log(f"wol: config saved ({len(cfg['devices'])} device(s))")

    # -- views ------------------------------------------------------------

    def _status(self):
        with self.lock:
            s = self.stats
            return {
                "devices": len(self.cfg["devices"]) if self.cfg else 0,
                "interfaces": sorted(LOCAL_IPS),
                "wakes": s["wakes"],
                "lastWake": s["last_wake"],
                "lastWakeDevice": s["last_wake_device"],
                "lastError": s["last_error"],
                "lastErrorTs": s["last_error_ts"],
            }

    def view(self):
        with self.lock:
            return {
                "ok": True,
                "enabled": bool(self.cfg),
                "config": ({"devices": [dict(d) for d in self.cfg["devices"]]}
                           if self.cfg else None),
                "status": self._status(),
            }

    def state_line(self):
        """Compact status for the /api/state poll."""
        with self.lock:
            return self._status()

    # -- waking -----------------------------------------------------------

    @staticmethod
    def _wake_destinations(directed_ip=""):
        """(ip, port) pairs: subnet broadcast (assumed /24) + global
        broadcast on ports 9 and 7, plus the device's own IP if set."""
        dests, seen = [], set()

        def add(ip, port):
            if ip and (ip, port) not in seen:
                seen.add((ip, port))
                dests.append((ip, port))

        for ip in sorted(LOCAL_IPS):
            try:
                bcast = str(ipaddress.ip_network(f"{ip}/24",
                                                 strict=False).broadcast_address)
            except ValueError:
                continue
            add(bcast, 9)
            add(bcast, 7)
        add("255.255.255.255", 9)
        add("255.255.255.255", 7)
        if directed_ip:
            add(directed_ip, 9)
            add(directed_ip, 7)
        return dests

    @staticmethod
    def _send_packet(packet, dests):
        sent, errors = [], []
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            s.settimeout(2)
            for ip, port in dests:
                try:
                    s.sendto(packet, (ip, port))
                    sent.append(f"{ip}:{port}")
                except OSError as e:
                    errors.append(f"{ip}:{port}: {e.strerror or e}")
        finally:
            s.close()
        if not sent:
            raise RuntimeError("could not send the magic packet: "
                               + "; ".join(errors))
        return sent

    def wake(self, name):
        """Send the magic packet for one device; raises KeyError if
        unknown, ValueError on a bad MAC, RuntimeError on send failure."""
        with self.lock:
            if not self.cfg:
                raise KeyError(str(name))
            key = str(name or "").strip().lower()
            dev = next((d for d in self.cfg["devices"]
                        if d["name"].lower() == key), None)
            if not dev:
                raise KeyError(str(name))
            mac = self._norm_mac(dev["mac"])   # validated at parse, re-check
            packet = b"\xff" * 6 + self._mac_bytes(mac) * 16
            dests = self._wake_destinations(dev.get("ip"))
        sent = self._send_packet(packet, dests)
        with self.lock:
            self.stats["wakes"] += 1
            self.stats["last_wake"] = now()
            self.stats["last_wake_device"] = dev["name"]
            self.stats["last_error"] = ""
            self.stats["last_error_ts"] = 0.0
        log(f"wol: magic packet for {dev['name']} ({mac}) "
            f"-> {', '.join(sent)}")
        return {"name": dev["name"], "mac": mac, "sent": sent}

    def note_error(self, err):
        with self.lock:
            self.stats["last_error"] = str(err)[:300]
            self.stats["last_error_ts"] = now()


class Handler(BaseHTTPRequestHandler):
    server_version = "PulseServer/" + SERVER_VERSION
    sys_version = ""             # don't advertise the Python version
    store: Store = None
    ddns: DDNS = None
    wol: WOL = None
    token: str = ""
    api_key: str = ""
    auth_required: bool = True
    tls_proxy: bool = False

    # -- plumbing
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, obj, content_type="application/json",
              cache="no-store", headers=None):
        if isinstance(obj, (dict, list)):
            body = json.dumps(obj).encode()
        elif isinstance(obj, (bytes, bytearray)):
            body = bytes(obj)
        else:
            body = str(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if cache:
            self.send_header("Cache-Control", cache)
        if getattr(self, "_set_dash_cookie", False):
            # 30-day persistent cookie. Secure only when this request
            # actually arrived over TLS (the reverse proxy sets
            # X-Forwarded-Proto: https) — browsers refuse to store a
            # Secure cookie set over plain http, which would break LAN
            # access while no proxy is in front yet.
            proto = self.headers.get("X-Forwarded-Proto", "") \
                .split(",")[0].strip().lower()
            secure = "; Secure" if (self.tls_proxy and proto == "https") \
                else ""
            expires = time.strftime("%a, %d %b %Y %H:%M:%S GMT",
                                    time.gmtime(time.time() + COOKIE_MAX_AGE))
            self.send_header("Set-Cookie",
                             f"pulse_key={self.api_key}; Path=/; HttpOnly;"
                             f" SameSite=Lax; Max-Age={COOKIE_MAX_AGE};"
                             f" Expires={expires}{secure}")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n <= 0 or n > 10 * 1024 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(n))
        except Exception:
            return None

    # -- auth
    def _client_ip(self):
        """Client IP; behind a TLS proxy the real one is X-Forwarded-For."""
        if self.tls_proxy:
            first = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            if first:
                return first
        return self.client_address[0]

    def _authed(self):
        """API-key gate for the dashboard, API and static files.

        Accepted: `Authorization: Bearer <key>`, `X-API-Key: <key>`,
        `?key=<key>` (issues the session cookie), `pulse_key` cookie.
        All comparisons are constant-time. No per-IP lockout — 401s are
        logged for monitoring only."""
        if not self.auth_required:
            return True
        ip = self._client_ip()
        key = None
        a = self.headers.get("Authorization", "")
        if a.startswith("Bearer "):
            key = a[7:].strip()
        elif self.headers.get("X-API-Key"):
            key = self.headers.get("X-API-Key", "").strip()
        ok = bool(key) and hmac.compare_digest(key, self.api_key)
        via_qs = False
        if not ok:
            m = re.search(r"(?:^|;\s*)pulse_key=([^;]+)",
                          self.headers.get("Cookie", ""))
            if m:
                ok = hmac.compare_digest(m.group(1), self.api_key)
        if not ok:
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            m = re.search(r"(?:^|&|;)\s*key=([^&]+)", qs)
            if m and hmac.compare_digest(unquote(m.group(1)), self.api_key):
                ok, via_qs = True, True
        if ok:
            if via_qs:
                self._set_dash_cookie = True
            return True
        log(f"401 from {ip} {self.path.split('?', 1)[0]}")
        return False

    # -- routes
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/nic/update":
            # public endpoint, own Basic auth — must precede the key gate
            return self._ddns_update()
        if path == "/install.sh" or path.startswith("/install/"):
            # public one-line installer (same pattern as /nic/update:
            # before the key gate; the served files are the same ones
            # shipped in the public repo)
            return self._install_request(path)
        if path == "/api/ddns":
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            return self._send(200, self.ddns.view())
        if path == "/api/wol":
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            return self._send(200, self.wol.view())
        if path == "/api/state":
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            with self.store.lock:
                nodes = {}
                for name, n in self.store.nodes.items():
                    nodes[name] = {
                        "online": n.online(),
                        "last_seen": n.last_seen,
                        "first_seen": n.first_seen,
                        "agent_version": n.agent_version,
                        "has_action": bool(n.action_url and n.action_token),
                        "latest": n.latest,
                    }
            self._send(200, {"ok": True, "server": SERVER_VERSION,
                             "ts": now(), "nodes": nodes,
                             "ddns": self.ddns.state_line(),
                             "wol": self.wol.state_line(),
                             "install": {"url": INSTALL_URL,
                                         "token": self.token}})
            return
        if path == "/api/series":
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            params = dict(re.findall(r"([\w]+)=([^&]+)", qs))
            node_name = params.get("node", "")
            try:
                points = max(2, min(2000, int(params.get("points", 300))))
            except ValueError:
                points = 300
            # window=SECONDS: restrict to the last N seconds and skip
            # downsampling (returns full 2s resolution for chart windows)
            try:
                window = max(0, min(86400, int(params.get("window", "0"))))
            except ValueError:
                window = 0
            n = self.store.nodes.get(node_name)
            if not n:
                return self._send(404, {"ok": False, "error": "no such node"})
            out = {}
            with self.store.lock:
                cutoff = now() - window if window else 0
                for k, h in n.history.items():
                    data = [p for p in h if p[0] >= cutoff] if cutoff else list(h)
                    if not data:
                        continue
                    out[k] = downsample(data, points)
            self._send(200, {"ok": True, "node": node_name, "series": out})
            return
        if path in ("/api/health", "/healthz"):
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            return self._send(200, {"ok": True, "server": SERVER_VERSION,
                                    "nodes": len(self.store.nodes)})
        if path in ("/keygate.html", "/keygate.css"):
            # public key-entry page (plain HTML+CSS form, no JS, no secrets)
            return self._static()
        if not self._authed():
            if path == "/":
                # browsers landing without a key get the key-entry form
                # instead of a raw JSON 401 body
                self.send_response(302)
                self.send_header("Location", "/keygate.html")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            return self._send(401, {"ok": False, "error": "unauthorized"})
        return self._static()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/nic/update":
            # some DynDNS clients POST instead of GET
            return self._ddns_update()
        if path == "/api/ddns":
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            try:
                self.ddns.update(self._body() or {})
            except ValueError as e:
                return self._send(400, {"ok": False, "error": str(e)})
            return self._send(200, self.ddns.view())
        if path == "/api/ddns/apply":
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            started = self.ddns.request_apply_async("manual apply")
            return self._send(200 if started else 503, {
                "ok": started,
                "error": None if started else
                "DDNS disabled or an apply is already running"})
        if path == "/api/ddns/test":
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            try:
                result = self.ddns.test()
            except RuntimeError as e:
                return self._send(502, {"ok": False, "error": str(e)})
            return self._send(200, {"ok": True, **result})
        if path == "/api/wol":
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            try:
                self.wol.update(self._body() or {})
            except ValueError as e:
                return self._send(400, {"ok": False, "error": str(e)})
            return self._send(200, self.wol.view())
        if path.startswith("/api/wol/wake/"):
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            name = unquote(path[len("/api/wol/wake/"):])
            if not name:
                return self._send(400, {"ok": False, "error": "device name required"})
            try:
                result = self.wol.wake(name)
            except KeyError:
                return self._send(404, {"ok": False,
                                        "error": f"no such device: {name}"})
            except (ValueError, RuntimeError) as e:
                self.wol.note_error(e)
                return self._send(502, {"ok": False, "error": str(e)})
            return self._send(200, {"ok": True, **result})
        if path == "/api/ingest":
            tok = self.headers.get("X-Pulse-Token", "")
            if not self.token or not hmac.compare_digest(tok, self.token):
                return self._send(401, {"ok": False, "error": "bad token"})
            payload = self._body()
            if not payload or not payload.get("name") or not payload.get("snap"):
                return self._send(400, {"ok": False, "error": "bad payload"})
            node = self.store.get(payload["name"])
            node.add(payload, self._client_ip())
            return self._send(200, {"ok": True})
        if path == "/api/action":
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            body = self._body() or {}
            name = body.get("node", "")
            node = self.store.nodes.get(name)
            if not node or not node.action_url or not node.action_token:
                return self._send(404, {"ok": False, "error": "node has no action api"})
            if isinstance(body.get("docker"), dict):
                fwd = {"docker": body["docker"]}
                label = ("docker " + str(fwd["docker"].get("cmd", "?"))
                         + " " + str(fwd["docker"].get("container")
                                     or fwd["docker"].get("image") or "")).strip()
                timeout = 35
            elif isinstance(body.get("llama"), dict):
                fwd = {"llama": body["llama"]}
                label = "llama " + str(fwd["llama"].get("cmd", "?"))
                timeout = 35
            else:
                try:
                    pid = int(body["pid"])
                    sig = int(body.get("sig", 15))
                except (KeyError, ValueError):
                    return self._send(400, {"ok": False,
                                            "error": "need {pid, sig}, {docker} or {llama}"})
                fwd = {"pid": pid, "sig": sig}
                label = f"pid={pid} sig={sig}"
                timeout = 5
            req = urllib.request.Request(
                node.action_url + "/action",
                data=json.dumps(fwd).encode(),
                headers={"Content-Type": "application/json",
                         "X-Action-Token": node.action_token},
                method="POST")
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    resp = json.loads(r.read())
                log(f"action {name} {label} -> {resp}")
                return self._send(200, resp)
            except urllib.error.HTTPError as e:
                try:
                    resp = json.loads(e.read())
                except Exception:
                    resp = {"ok": False, "error": str(e)}
                return self._send(e.code, resp)
            except Exception as e:
                return self._send(502, {"ok": False,
                                        "error": f"agent unreachable: {e}"})
        return self._send(404, {"ok": False, "error": "not found"})

    def _ddns_update(self):
        """Dispatch /nic/update to the DDNS engine (plain-text response)."""
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        query = {}
        for k, v in re.findall(r"([\w-]+)=([^&]*)", qs):
            query.setdefault(k, []).append(unquote(v))
        code, body, extra = self.ddns.handle_update(
            self.headers, query, self._client_ip())
        self._send(code, body, "text/plain", cache="no-store", headers=extra)

    # -- public one-line installer (handled before the key gate,
    #    same pattern as /nic/update — the files served are the same
    #    ones that ship in the public repo, plus install.sh)
    INSTALL_ASSETS = (
        ("pulse_agent.py", "pulse_agent.py", "text/x-python; charset=utf-8"),
        ("pulse_server.py", "pulse_server.py", "text/x-python; charset=utf-8"),
        ("deploy.sh", "deploy.sh", "text/x-shellscript; charset=utf-8"),
        ("llama_presets.json", "llama_presets.json", "application/json"),
        ("web/index.html", "web/index.html", MIME[".html"]),
        ("web/app.js", "web/app.js", MIME[".js"]),
        ("web/style.css", "web/style.css", MIME[".css"]),
        ("web/keygate.html", "web/keygate.html", MIME[".html"]),
        ("web/keygate.css", "web/keygate.css", MIME[".css"]),
    )


    def _install_request(self, path):
        base = Path(__file__).resolve().parent
        if path == "/install.sh":
            fp = base / "install.sh"
            if not fp.is_file():
                return self._send(404, "not found", "text/plain")
            body = fp.read_bytes().replace(
                b'INSTALL_BASE=""',
                ('INSTALL_BASE="%s"' % INSTALL_URL).encode())
            return self._send(200, body, "text/x-shellscript; charset=utf-8",
                              headers={"X-Content-Type-Options": "nosniff",
                                       "Referrer-Policy": "no-referrer"})
        name = path[len("/install/"):]
        entry = next((e for e in self.INSTALL_ASSETS if e[0] == name), None)
        if not entry:
            return self._send(404, "not found", "text/plain")
        rel, mime = entry[1], entry[2]
        fp = (base / rel).resolve()
        try:
            inside = fp.is_relative_to(base)
        except AttributeError:      # Python < 3.9
            inside = str(fp) == str(base) or \
                str(fp).startswith(str(base) + os.sep)
        if not inside or not fp.is_file():
            return self._send(404, "not found", "text/plain")
        return self._send(200, fp.read_bytes(), mime,
                          headers={"X-Content-Type-Options": "nosniff",
                                   "Referrer-Policy": "no-referrer"})

    # -- static
    def _static(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"
        fp = (STATIC_DIR / path.lstrip("/")).resolve()
        try:
            inside = fp.is_relative_to(STATIC_DIR)
        except AttributeError:  # Python < 3.9
            inside = str(fp) == str(STATIC_DIR) or \
                str(fp).startswith(str(STATIC_DIR) + os.sep)
        if not inside:
            return self._send(403, "forbidden", "text/plain")
        if fp.is_dir():
            fp = fp / "index.html"
        if not fp.is_file():
            return self._send(404, "not found", "text/plain")
        mime = MIME.get(fp.suffix, "application/octet-stream")
        body = fp.read_bytes()
        cache = ("max-age=300" if fp.suffix in (".js", ".css")
                 else ("no-cache" if fp.suffix == ".html" else None))
        return self._send(200, body, mime, cache=cache, headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": (
                "default-src 'self'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data:"
            ),
            "Referrer-Policy": "no-referrer",
        })


def downsample(data, points):
    """Average-bucket downsample of [[ts, val], ...]."""
    if len(data) <= points:
        return data
    n = len(data)
    bucket = n / points
    out = []
    for i in range(points):
        lo = int(i * bucket)
        hi = max(lo + 1, int((i + 1) * bucket))
        seg = data[lo:hi]
        ts = seg[0][0]
        val = sum(v for _, v in seg) / len(seg)
        out.append([ts, round(val, 2)])
    return out


def saver_loop(store):
    while True:
        time.sleep(60)
        store.save()


def ddns_refresh_loop(ddns):
    """Periodically re-detect the public IPs and re-apply the records, so
    the Cloudflare names stay current even when the router's /nic/update
    push is silent or misconfigured (the router push remains the faster
    path). apply() skips the Cloudflare round-trip when nothing changed.
    Returns when the process is dying (daemon thread)."""
    next_run = now() + DDNS_REFRESH_INTERVAL
    while True:
        time.sleep(15)
        if now() < next_run:
            continue
        next_run = now() + DDNS_REFRESH_INTERVAL
        if not ddns.request_apply_async("periodic refresh"):
            next_run = now() + 60   # disabled or busy — check again soon


def lan_base_url(port):
    """LAN base URL for the installer: http://<lan-ip>:<port>.

    Agents report over the LAN only (node data never flows through the
    public endpoint), so the served installer and the dashboard's
    install one-liners always carry this server's LAN address. The
    interface behind the default route is the LAN interface; the UDP
    connect selects it without sending any packet. PULSE_LAN_IP
    overrides the detection for multi-homed boxes."""
    ip = os.environ.get("PULSE_LAN_IP", "").strip()
    if not ip:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        except Exception:
            try:
                ip = socket.gethostbyname(socket.gethostname())
            except Exception:
                ip = "127.0.0.1"
        finally:
            s.close()
    return "http://%s:%d" % (ip, port)


def main():
    import argparse
    ap = argparse.ArgumentParser(description="Pulse monitoring server")
    ap.add_argument("--port", default=os.environ.get("PULSE_PORT", "8090"))
    ap.add_argument("--bind", default=os.environ.get("PULSE_BIND", "0.0.0.0"))
    ap.add_argument("--token", default=os.environ.get("PULSE_TOKEN", ""))
    ap.add_argument("--api-key",
                    default=os.environ.get("PULSE_API_KEY")
                    or os.environ.get("PULSE_DASH_KEY", ""))
    ap.add_argument("--no-auth", action="store_true",
                    help="disable the API-key gate (trusted LAN only)")
    ap.add_argument("--tls-proxy",
                    default=os.environ.get("PULSE_TLS_PROXY", "0"),
                    help="1 = TLS-terminating reverse proxy in front "
                         "(Secure cookies, X-Forwarded-For client IPs)")
    ap.add_argument("--state-dir",
                    default=os.environ.get("PULSE_STATE_DIR",
                                           str(Path.home() / ".pulse-server")))
    args = ap.parse_args()
    if not args.token:
        raise SystemExit("PULSE_TOKEN is required (env or --token)")
    if not args.api_key and not args.no_auth:
        raise SystemExit("PULSE_API_KEY is required (env or --api-key); "
                         "pass --no-auth only on a fully trusted LAN")
    if args.tls_proxy not in ("0", "1"):
        raise SystemExit("--tls-proxy must be 0 or 1")

    Handler.store = Store(args.state_dir)
    Handler.ddns = DDNS(args.state_dir)
    Handler.wol = WOL(args.state_dir)
    Handler.token = args.token
    Handler.api_key = args.api_key
    Handler.auth_required = not args.no_auth
    Handler.tls_proxy = args.tls_proxy == "1"
    global INSTALL_URL
    INSTALL_URL = lan_base_url(int(args.port))

    httpd = ThreadingHTTPServer((args.bind, int(args.port)), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=saver_loop, daemon=True, args=(Handler.store,)).start()
    threading.Thread(target=ddns_refresh_loop, args=(Handler.ddns,),
                     daemon=True).start()
    if Handler.ddns.cfg:
        Handler.ddns.request_apply_async("startup")
    log(f"Pulse server v{SERVER_VERSION} listening on {args.bind}:{args.port} "
        f"(web: {STATIC_DIR}, state: {args.state_dir}, install base: {INSTALL_URL})")
    log(f"auth: {'DISABLED via --no-auth (trusted LAN only!)'
         if args.no_auth else 'API key required on all dashboard-side requests'}"
        + (", TLS proxy mode (X-Forwarded-For client IPs; Secure cookie "
           "over https only)" if Handler.tls_proxy else ""))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        Handler.store.save()
        log("state saved, bye")


if __name__ == "__main__":
    main()
