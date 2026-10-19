#!/usr/bin/env python3
"""
Pulse Agent — single-file, stdlib-only system monitoring client.

Collects CPU (overall + per-core), load, memory, swap, disk usage/IO,
network IO, temperatures, GPU stats (rocm-smi / sysfs), PCI/USB device
inventory and a full process table (task-manager data), then pushes a
JSON snapshot to the Pulse server every N seconds.

Also runs a tiny local action API (default 127.0.0.1 is NOT used — binds
0.0.0.0:ACTION_PORT with a per-install secret token) so the central
server can proxy actions like "kill process" (own-user processes only)
and docker controls (start/stop/restart/remove containers, remove images,
via the Docker Engine API on the unix socket — no CLI, no pip).

Config file (KEY=VALUE):
  SERVER_URL   http://192.168.178.11:8090
  TOKEN        <ingest token shared with the server>
  INTERVAL     2          # seconds between snapshots
  ACTION_PORT  9611
  NAME         <node name, defaults to hostname>
"""

import http.client
import hmac
import json
import os
import pwd
import re
import secrets
import shlex
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

AGENT_VERSION = "1.3.0"
CLK_TCK = os.sysconf("SC_CLK_TCK")
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")
BOOT_TIME = time.time() - float(open("/proc/uptime").read().split()[0])
BOOT_EPOCH = BOOT_TIME

REAL_FS = {
    "ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "vfat", "exfat",
    "zfs", "ntfs3", "ntfs", "fuseblk", "overlay",
}

# ---------------------------------------------------------------- utilities

def rfile(path):
    try:
        with open(path, "rb") as f:
            return f.read().decode("utf-8", "replace")
    except OSError:
        return None


def rfloat(path):
    try:
        return float(open(path).read().strip())
    except (OSError, ValueError):
        return None


def log(msg):
    print(f"[pulse-agent] {msg}", flush=True)


def now():
    return time.time()


def lan_ip_for(target_ip):
    """Best local source IP (UDP route lookup — no packets are sent).

    Tries the interface used to reach the Pulse server first. If that
    resolves to loopback (agent and server on the same host, e.g.
    SERVER_URL=http://127.0.0.1:8090), falls back to the primary
    network interface so the node reports a real LAN address."""
    cands = []
    for target in (target_ip, "1.1.1.1"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(1)
            s.connect((target, 80))
            cands.append(s.getsockname()[0])
            s.close()
        except OSError:
            pass
    for ip in cands:
        if not ip.startswith("127."):
            return ip
    return cands[0] if cands else "127.0.0.1"


# ---------------------------------------------------------------- collectors

def read_cpu_raw():
    """Return (total_ticks, per_core list) from /proc/stat."""
    data = rfile("/proc/stat")
    if not data:
        return None
    total = [0.0] * 8
    per_core = []
    for line in data.splitlines():
        if not line.startswith("cpu"):
            break
        parts = line.split()
        vals = [float(x) for x in parts[1:9]]
        if line.startswith("cpu "):
            for i, v in enumerate(vals):
                total[i] += v
        else:
            per_core.append(vals)
    # user nice system idle iowait irq softirq steal
    return total, per_core


def read_meminfo():
    mi = {}
    data = rfile("/proc/meminfo")
    if not data:
        return None
    for line in data.splitlines():
        k, _, v = line.partition(":")
        mi[k] = int(v.split()[0]) * 1024  # kB -> bytes
    return mi


def read_loadavg():
    data = rfile("/proc/loadavg")
    if not data:
        return None
    p = data.split()
    return {"load1": float(p[0]), "load5": float(p[1]), "load15": float(p[2])}


def read_psi():
    out = {}
    for name in ("cpu", "memory", "io"):
        data = rfile(f"/proc/pressure/{name}")
        if not data:
            continue
        m = re.search(r"some avg10=([\d.]+)", data)
        if m:
            out[name] = float(m.group(1))
    return out


def read_diskstats():
    """Whole-disk sectors: {name: (sectors_read, sectors_written)}."""
    out = {}
    data = rfile("/proc/diskstats")
    if not data:
        return out
    for line in data.splitlines():
        parts = line.split()
        if len(parts) < 14:
            continue
        name = parts[2]
        if not re.fullmatch(r"(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+)", name):
            continue
        out[name] = (int(parts[5]), int(parts[9]))
    return out


def read_netdev():
    """Per-interface rx/tx bytes: {name: (rx, tx)}."""
    out = {}
    data = rfile("/proc/net/dev")
    if not data:
        return out
    for line in data.splitlines()[2:]:
        if ":" not in line:
            continue
        name, _, rest = line.partition(":")
        f = rest.split()
        if len(f) < 16:
            continue
        name = name.strip()
        if name == "lo" or name.startswith("veth"):
            continue
        out[name] = (int(f[0]), int(f[8]))
    return out


def read_mounts():
    """Unique real-filesystem mounts: [{mount, fs, root}]"""
    seen = set()
    mounts = []
    data = rfile("/proc/mounts")
    if not data:
        return mounts
    for line in data.splitlines():
        p = line.split()
        if len(p) < 3:
            continue
        dev, mp, fs = p[0], p[1], p[2]
        if fs not in REAL_FS:
            continue
        try:
            mp = mp.encode().decode("unicode_escape")
        except Exception:
            pass
        if mp in seen or mp.startswith(("/snap/", "/boot/efi")):
            continue
        seen.add(mp)
        mounts.append({"mount": mp, "fs": fs, "dev": dev})
    mounts.sort(key=lambda m: m["mount"] == "/" and 0 or 1, reverse=False)
    return mounts


def read_mount_usage(mounts):
    out = []
    for m in mounts:
        try:
            st = os.statvfs(m["mount"])
        except OSError:
            continue
        total = st.f_frsize * st.f_blocks
        free = st.f_frsize * st.f_bavail
        if total <= 0:
            continue
        used = total - (st.f_frsize * st.f_bfree)
        out.append({
            "mount": m["mount"], "fs": m["fs"], "dev": m["dev"],
            "total": total, "used": used, "free": free,
            "pct": round(used * 100.0 / total, 1),
        })
    out.sort(key=lambda d: 0 if d["mount"] == "/" else 1)
    return out


def read_thermals():
    temps = []
    seen_vals = set()
    for d in sorted(Path("/sys/class/hwmon").glob("hwmon*")):
        name = (d / "name").read_text().strip() if (d / "name").exists() else d.name
        for i in (1, 2, 3):
            v = rfloat(d / f"temp{i}_input")
            if v is None:
                continue
            label = None
            lf = d / f"temp{i}_label"
            if lf.exists():
                label = lf.read_text().strip() or None
            key = (name, label or i)
            if key in seen_vals:
                continue
            seen_vals.add(key)
            temps.append({"name": name, "label": label or f"sensor{i}",
                          "c": round(v / 1000.0, 1)})
    for d in sorted(Path("/sys/class/thermal").glob("thermal_zone*")):
        v = rfloat(d / "temp")
        if v is None:
            continue
        try:
            ttype = (d / "type").read_text().strip()
        except OSError:
            ttype = d.name
        # skip if an hwmon sensor already reported a near-identical value
        if any(abs(t["c"] - v / 1000.0) < 0.6 for t in temps):
            continue
        temps.append({"name": ttype, "label": "thermal", "c": round(v / 1000.0, 1)})
    return temps


def read_procs(prev, wall, total_mem):
    """Full process table with CPU%/MEM% since previous sample."""
    procs = []
    pids = []
    try:
        for entry in os.listdir("/proc"):
            if entry.isdigit():
                pids.append(int(entry))
    except OSError:
        return []
    for pid in pids:
        base = f"/proc/{pid}"
        stat = rfile(f"{base}/stat")
        if not stat:
            continue
        try:
            lp = stat.index("(")
            rp = stat.rindex(")")
            comm = stat[lp + 1:rp]
            rest = stat[rp + 2:].split()
            # rest: state(0) ppid(1) ... utime(11) stime(12) ... num_threads(17) ... starttime(19) ...
            state = rest[0]
            ppid = int(rest[1])
            utime = int(rest[11])
            stime = int(rest[12])
            threads = int(rest[17])
            start_ticks = int(rest[19])
            nice = int(rest[18]) if len(rest) > 18 else 0
        except (ValueError, IndexError):
            continue
        statm = rfile(f"{base}/statm")
        rss_kb = int(statm.split()[1]) * PAGE_SIZE // 1024 if statm else 0
        status = rfile(f"{base}/status")
        uid = os.getuid()
        if status:
            m = re.search(r"^Uid:\s*(\d+)", status, re.M)
            if m:
                uid = int(m.group(1))
        try:
            user = pwd.getpwuid(uid).pw_name
        except KeyError:
            user = str(uid)
        cmdline = rfile(f"{base}/cmdline")
        if cmdline:
            cmd = " ".join(x for x in cmdline.split("\0") if x)[:200]
        else:
            cmd = f"[{comm}]"
        ticks = utime + stime
        cpu_pct = None
        p = prev.get(pid)
        if p and wall > 0:
            dt = ticks - p[0]
            if dt >= 0:
                cpu_pct = round(100.0 * dt / (wall * CLK_TCK), 1)
        start_epoch = BOOT_EPOCH - start_ticks / CLK_TCK
        procs.append({
            "pid": pid, "ppid": ppid, "user": user, "name": comm,
            "cmd": cmd, "state": state, "threads": threads, "nice": nice,
            "rss_kb": rss_kb,
            "cpu": cpu_pct if cpu_pct is not None else 0.0,
            "mem": round(rss_kb * 1024.0 * 100.0 / total_mem, 2) if total_mem else 0.0,
            "start": int(start_epoch),
        })
        prev[pid] = (ticks, time.time())
    # prune dead pids
    for k in [k for k in prev if k not in pids]:
        del prev[k]
    return procs


# ---------------------------------------------------------------- GPU

class GpuCollector(threading.Thread):
    """Background thread: rocm-smi (AMD) every 5s + sysfs stats.

    Joins rocm JSON cards with the amdgpu sysfs cards positionally so the
    same physical GPU is never listed twice; other DRM cards (e.g. iGPUs)
    that expose sysfs stats are added separately.
    """

    def __init__(self):
        super().__init__(daemon=True)
        self.data = []
        self.model = None
        self._rocm = shutil_which("rocm-smi")

    def run(self):
        while True:
            cards = _sysfs_cards()
            amd_sysfs = [c for c in cards if c["vendor"] == "1002"]
            gpus = []
            if self._rocm:
                try:
                    # --showproductname --json is stable in service envs; the
                    # non-JSON form crashes on multiprocessing.Lock().
                    out = subprocess.run(
                        [self._rocm, "--showuse", "--showmemuse",
                         "--showtemp", "--showclocks", "--showproductname",
                         "--json"],
                        capture_output=True, text=True, timeout=6).stdout
                    parsed = json.loads(out[out.index("{"):])
                    keys = sorted(parsed.keys(), key=lambda k: int(k[4:]))
                    for i, key in enumerate(keys):
                        kv = parsed[key]
                        series = str(kv.get("Card Series", "")).strip()
                        if series and series != "N/A":
                            self.model = series
                        g = {
                            "name": self.model,
                            "kind": "amd",
                            "use": _f(kv.get("GPU use (%)")),
                            "vram_pct": _f(kv.get("GPU Memory Allocated (VRAM%)")),
                            "temp": _f(kv.get("Temperature (Sensor edge) (C)")),
                            "temp_junc": _f(kv.get("Temperature (Sensor junction) (C)")),
                        }
                        for k, label in (("fclk clock speed:", "gfx_clk_mhz"),
                                         ("mclk clock speed:", "mem_clk_mhz")):
                            m = re.search(r"\((\d+)Mhz\)", str(kv.get(k, "")))
                            g[label] = int(m.group(1)) if m else None
                        sfs = amd_sysfs[i] if i < len(amd_sysfs) else None
                        if sfs:
                            if g["use"] is None:
                                g["use"] = sfs["busy"]
                            if sfs["vram_used"] is not None and sfs["vram_total"]:
                                g["vram_used"] = int(sfs["vram_used"])
                                g["vram_total"] = int(sfs["vram_total"])
                                if g["vram_pct"] is None:
                                    g["vram_pct"] = round(
                                        sfs["vram_used"] * 100.0
                                        / sfs["vram_total"], 1)
                            if not g["name"]:
                                g["name"] = amd_pci_name(
                                    sfs["pci_id"], sfs.get("subsys", ""))
                            g.update(_amd_fan(sfs))
                        if not g["name"]:
                            g["name"] = "AMD GPU"
                        gpus.append(g)
                except Exception as e:
                    log(f"rocm-smi error: {e}")
            # non-AMD DRM cards that expose stats (e.g. iGPUs)
            for c in cards:
                if c["vendor"] == "1002":
                    continue
                if c["busy"] is None and c["vram_total"] is None:
                    continue
                kind = "intel" if c["vendor"] == "8086" else "sysfs"
                gpus.append({
                    "name": "Intel iGPU" if kind == "intel" else f"GPU {c['card']}",
                    "kind": kind,
                    "use": c["busy"],
                    "vram_pct": round(c["vram_used"] * 100.0 / c["vram_total"], 1)
                    if (c["vram_used"] is not None and c["vram_total"]) else None,
                    "vram_used": int(c["vram_used"]) if c["vram_used"] is not None else None,
                    "vram_total": int(c["vram_total"]) if c["vram_total"] is not None else None,
                    "temp": None,
                })
            if gpus:
                self.data = gpus
            time.sleep(5)


def shutil_which(prog):
    dirs = os.environ.get("PATH", "/usr/bin:/bin").split(os.pathsep)
    dirs += ["/opt/rocm/bin", "/usr/local/bin"]
    for d in dirs:
        try:
            p = Path(d) / prog
            if p.is_file() and os.access(p, os.X_OK):
                return str(p)
        except OSError:
            continue
    return None


def _f(v):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


# PCI vendor:device[:subsystem] -> marketing name, for cases where the
# firmware name query is unavailable (e.g. GPU in a low-power state).
AMD_PCI_NAMES = {
    ("1002", "744c", "1da2:e471"): "AMD Radeon RX 7900 XTX",
    ("1002", "744c", "1da2:e46e"): "AMD Radeon RX 7900 XT",
    ("1002", "744c", "1da2:e470"): "AMD Radeon RX 7900 GRE",
}


def amd_pci_name(pci_id, subsys):
    vid, _, did = pci_id.partition(":")
    key = (vid.lower(), did.lower(), subsys.lower())
    if key in AMD_PCI_NAMES:
        return AMD_PCI_NAMES[key]
    if vid.lower() == "1002" and did.lower() in ("744c", "73ff"):
        return "AMD Navi 31 GPU"
    if vid.lower() == "1002":
        return f"AMD GPU (PCI {pci_id.upper()})"
    return None


def _sysfs_cards():
    """All DRM controller cards (card0, card1, ...; connector entries like
    card0-DP-3 are excluded), with identity from the device uevent."""
    cards = []
    for card in sorted(Path("/sys/class/drm").glob("card*")):
        if not card.name[4:].isdigit():
            continue
        dev = card / "device"
        if not dev.is_dir():
            continue
        uevent = {}
        try:
            for line in (dev / "uevent").read_text().splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    uevent[k] = v
        except OSError:
            pass
        pci_id = uevent.get("PCI_ID", ":")
        hwmon = next(iter(sorted((dev / "hwmon").glob("hwmon*"))), None)
        cards.append({
            "card": card.name,
            "vendor": pci_id.split(":")[0].lower(),
            "pci_id": pci_id.lower(),
            "subsys": uevent.get("PCI_SUBSYS_ID", ":").lower(),
            "hwmon": hwmon,
            "fan_curve": dev / "gpu_od" / "fan_ctrl" / "fan_curve",
            "busy": rfloat(dev / "gpu_busy_percent"),
            "vram_used": rfloat(dev / "mem_info_vram_used"),
            "vram_total": rfloat(dev / "mem_info_vram_total"),
        })
    return cards


AMD_FAN_PRESETS = {
    "balanced": ((35, 20), (50, 30), (65, 45), (80, 65), (95, 100)),
    "cool": ((30, 25), (45, 40), (60, 60), (75, 80), (90, 100)),
    "aggressive": ((25, 40), (40, 55), (55, 70), (70, 85), (85, 100)),
}


def _fan_curve_points(path):
    data = rfile(path) or ""
    return tuple((int(temp), int(speed)) for _, temp, speed in
                 re.findall(r"^\s*(\d+):\s*(\d+)C\s*(\d+)%", data, re.M))


def _amd_fan(card):
    """Fan telemetry and firmware-curve state for one AMD DRM card."""
    hwmon = card.get("hwmon")
    if not hwmon:
        return {}
    pwm, enable = hwmon / "pwm1", hwmon / "pwm1_enable"
    if not pwm.exists() or not enable.exists():
        return {}
    raw = rfloat(pwm)
    maximum = rfloat(hwmon / "pwm1_max") or 255
    mode = rfloat(enable)
    curve = card["fan_curve"]
    points = _fan_curve_points(curve) if curve.exists() else ()
    preset = "auto" if ((points and not any(t or p for t, p in points))
                        or (not curve.exists() and mode == 2)) else "custom"
    for name, expected in AMD_FAN_PRESETS.items():
        if points == expected:
            preset = name
            break
    return {
        "fan_pct": round(raw * 100 / maximum) if raw is not None else None,
        "fan_rpm": int(rfloat(hwmon / "fan1_input") or 0),
        "fan_auto": preset == "auto",
        "fan_control": curve.exists(),
        "fan_writable": curve.exists() and os.access(curve, os.W_OK),
        "fan_preset": preset,
    }


def set_amd_fan(index, auto, preset=None):
    """Reset to firmware Auto or apply a validated firmware fan curve."""
    cards = [c for c in _sysfs_cards() if c["vendor"] == "1002"]
    if index < 0 or index >= len(cards):
        raise ValueError("no such AMD GPU")
    curve = cards[index]["fan_curve"]
    if not curve.exists():
        raise ValueError("this AMD GPU does not expose firmware fan curves")
    try:
        if auto:
            curve.write_text("r")
            curve.write_text("c")
            return {"auto": True, "preset": "auto"}
        preset = str(preset or "")
        points = AMD_FAN_PRESETS.get(preset)
        if not points:
            raise ValueError("fan preset must be balanced, cool or aggressive")
        try:
            for i, (temp, speed) in enumerate(points):
                curve.write_text(f"{i} {temp} {speed}")
            curve.write_text("c")
        except Exception:
            try:
                curve.write_text("r")
                curve.write_text("c")
            except OSError:
                pass
            raise
        return {"auto": False, "preset": preset}
    except PermissionError:
        raise PermissionError(
            "fan presets need write access to the AMD firmware fan curve")


# ---------------------------------------------------------------- devices

def pci_list():
    out = []
    prog = shutil_which("lspci")
    if prog:
        try:
            data = subprocess.run([prog], capture_output=True, text=True,
                                  timeout=8).stdout
            for line in data.splitlines():
                if line.strip():
                    out.append(line.strip())
            return out
        except Exception:
            pass
    for d in sorted(Path("/sys/bus/pci/devices").iterdir()):
        cls = (d / "class").read_text().strip() if (d / "class").exists() else "?"
        out.append(f"{d.name}  class={cls}")
    return out


def usb_list():
    out = []
    try:
        entries = sorted(Path("/sys/bus/usb/devices").iterdir())
    except OSError:
        return out
    for d in entries:
        if not re.fullmatch(r"\d+-\d+", d.name):
            continue
        vendor = (d / "idVendor").read_text().strip() if (d / "idVendor").exists() else "?"
        product = (d / "idProduct").read_text().strip() if (d / "idProduct").exists() else "?"
        name = None
        try:
            name = (d / "product").read_text().strip()
        except OSError:
            pass
        out.append({"port": d.name, "id": f"{vendor}:{product}",
                    "name": name or f"usb {vendor}:{product}"})
    return out


# ---------------------------------------------------------------- docker
# Docker Engine API over the unix socket: stdlib http.client, no CLI, no
# pip. The agent never needs sudo — if the agent user can read/write
# /var/run/docker.sock (e.g. is in the `docker` group), that is all it
# needs. Socket candidates are re-probed until one appears (so a freshly
# installed/started docker daemon is picked up without restarting us).

DOCKER_API = "/v1.41"
DOCKER_SOCKETS = ("/var/run/docker.sock", "/run/docker.sock")


class DockerApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


class _DockerConn(http.client.HTTPConnection):
    """HTTP/1.1 connection to the Engine API over a unix domain socket."""

    def __init__(self, sock_path, timeout=10):
        super().__init__("docker.localhost")
        self.sock_path = sock_path
        self.timeout = timeout

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self.sock_path)
        self.sock = s


def docker_api_call(sock_path, method, path, body=None, timeout=10):
    """One Engine API request. Returns parsed JSON ({} for empty bodies);
    raises DockerApiError(code, msg) for status >= 300, OSError for
    connection problems."""
    conn = _DockerConn(sock_path, timeout)
    try:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if data else {}
        conn.request(method, path, body=data, headers=headers)
        r = conn.getresponse()
        raw = r.read()
        if r.status >= 300:
            msg = None
            try:
                msg = json.loads(raw.decode()).get("message")
            except Exception:
                pass
            raise DockerApiError(r.status, msg or r.reason or f"HTTP {r.status}")
        if not raw:
            return {}
        try:
            return json.loads(raw.decode())
        except Exception:
            return {"raw": raw.decode("utf-8", "replace")[:300]}
    finally:
        conn.close()


class DockerMonitor(threading.Thread):
    """Background thread polling the Docker Engine API (5s cycle, 15s when
    no socket is present yet).

    Publishes the "docker" snapshot block:
      installed   bool  — socket found or docker CLI on PATH
      daemon      "running" | "down" | None (None: not installed)
      version     engine version (last known)
      ts          epoch seconds of last refresh
      containers  [{id, name, image, state, status, created,
                   cpu, mem, mem_limit, net_rx, net_tx, ports}]
      images      [{id, ref, size, created}]
    The last good container/image lists are kept while the daemon is down
    so the UI still shows what was there.
    """

    POLL_OK = 5.0
    POLL_NO_SOCKET = 15.0

    def __init__(self):
        super().__init__(daemon=True)
        self._lock = threading.Lock()
        self._sock = None
        self._installed = None
        self._version = None
        self._containers = []
        self._images = []
        self._down_logged = False
        self.data = {"installed": False, "daemon": None, "version": None,
                     "ts": 0, "containers": [], "images": []}

    # -- socket handling
    def _find_socket(self):
        for p in DOCKER_SOCKETS:
            try:
                if os.path.exists(p) and os.access(p, os.R_OK | os.W_OK):
                    return p
            except OSError:
                continue
        return None

    def current_sock(self):
        with self._lock:
            return self._sock

    # -- field helpers
    @staticmethod
    def _short_id(iid):
        if isinstance(iid, str) and iid.startswith("sha256:"):
            iid = iid[7:]
        return (iid or "")[:12]

    @staticmethod
    def _fmt_ports(ports):
        out = []
        for p in ports:
            if not p.get("PublicPort"):
                continue
            ip = p.get("IP") or ""
            host = f"{ip}:" if ip and ip not in ("0.0.0.0", "::") else ""
            out.append(f"{host}{p['PublicPort']}->{p['PrivatePort']}/{p.get('Type', 'tcp')}")
        return ", ".join(out)

    @staticmethod
    def _cpu_pct(st, ncpu):
        # one-shot stats?stream=false returns cpu_stats + precpu_stats,
        # already differenced by the daemon over its sample window
        try:
            cpu_delta = (st["cpu_stats"]["cpu_usage"]["total_usage"]
                         - st["precpu_stats"]["cpu_usage"]["total_usage"])
            sys_delta = (st["cpu_stats"]["system_cpu_usage"]
                         - st["precpu_stats"]["system_cpu_usage"])
        except (KeyError, TypeError):
            return 0.0
        if sys_delta <= 0 or cpu_delta < 0:
            return 0.0
        return round(cpu_delta * 100.0 * ncpu / sys_delta, 1)

    def _publish(self, daemon):
        with self._lock:
            self.data = {
                "installed": bool(self._installed),
                "daemon": daemon,
                "version": self._version,
                "ts": int(time.time()),
                "containers": [dict(c) for c in self._containers],
                "images": [dict(i) for i in self._images],
            }

    def snapshot(self):
        with self._lock:
            d = dict(self.data)
            d["containers"] = [dict(c) for c in d["containers"]]
            d["images"] = [dict(i) for i in d["images"]]
            return d

    # -- one poll cycle; returns seconds to wait before the next
    def _refresh(self):
        if self._sock is None:
            self._sock = self._find_socket()
        if self._sock is None:
            if self._installed is None:
                self._installed = shutil_which("docker") is not None
                log("docker: no accessible socket — "
                    + ("docker CLI present but daemon not running?"
                       if self._installed else "not installed"))
            self._publish("down" if self._installed else None)
            return self.POLL_NO_SOCKET
        self._installed = True
        try:
            ver = docker_api_call(self._sock, "GET", DOCKER_API + "/version")
            self._version = ver.get("Version")
            raw_cs = docker_api_call(
                self._sock, "GET", DOCKER_API + "/containers/json?all=1")
            try:
                ncpu = os.cpu_count() or 1
            except (ValueError, OSError):
                ncpu = 1
            containers = []
            running = []  # (index into containers, cid) of running ones
            for c in raw_cs:
                cid = (c.get("Id") or "")[:12]
                if not cid:
                    continue
                state = c.get("State") or "unknown"
                info = {
                    "id": cid,
                    "name": (c.get("Names") or [""])[0].lstrip("/"),
                    "image": c.get("Image") or "",
                    "state": state,
                    "status": c.get("Status") or "",
                    "created": int(c.get("Created") or 0),
                    "cpu": 0.0,
                    "mem": 0,
                    "mem_limit": None,
                    "net_rx": 0,
                    "net_tx": 0,
                    "ports": self._fmt_ports(c.get("Ports") or []),
                }
                for nif in (((c.get("NetworkSettings") or {})
                             .get("Networks")) or {}).values():
                    info["net_rx"] += int(nif.get("RXBytes") or 0)
                    info["net_tx"] += int(nif.get("TXBytes") or 0)
                if state == "running":
                    running.append((len(containers), cid))
                containers.append(info)
            # One stats sample per running container, fetched in parallel —
            # each call takes ~1s, and sequential would stall a busy
            # 14-container host well past the poll interval.
            if running:
                def _one(i, cid):
                    try:
                        return i, docker_api_call(
                            self._sock, "GET",
                            f"{DOCKER_API}/containers/{cid}/stats?stream=false",
                            timeout=5)
                    except (DockerApiError, OSError):
                        return i, None
                with ThreadPoolExecutor(
                        max_workers=min(8, len(running))) as pool:
                    for fut in [pool.submit(_one, i, cid)
                                for i, cid in running]:
                        i, st = fut.result()
                        if not st:
                            continue
                        info = containers[i]
                        info["cpu"] = self._cpu_pct(st, ncpu)
                        ms = st.get("memory_stats") or {}
                        info["mem"] = int(ms.get("usage") or 0)
                        lim = int(ms.get("limit") or 0)
                        info["mem_limit"] = lim if lim > 0 else None
            containers.sort(key=lambda x: x["name"].lower())
            raw_im = docker_api_call(self._sock, "GET", DOCKER_API + "/images/json")
            images = []
            for im in raw_im:
                refs = [r for r in (im.get("RepoTags") or [])
                        if r != "<none>:<none>"]
                if not refs:
                    continue  # skip dangling/untagged layers
                images.append({
                    "id": self._short_id(im.get("Id")),
                    "ref": refs[0],
                    "size": int(im.get("Size") or 0),
                    "created": int(im.get("Created") or 0),
                })
            images.sort(key=lambda x: x["ref"].lower())
            self._containers = containers
            self._images = images
            if self._down_logged:
                log("docker: daemon reachable again")
            self._down_logged = False
            self._publish("running")
            return self.POLL_OK
        except Exception as e:
            if not self._down_logged:
                log(f"docker: daemon down ({e})")
            self._down_logged = True
            self._publish("down")
            return self.POLL_OK

    def run(self):
        while True:
            t0 = time.time()
            interval = self._refresh()
            time.sleep(max(0.5, interval - (time.time() - t0)))


# ---------------------------------------------------------------- llama.cpp
#
# Detects a running llama-server / llama-cli from the process table and
# exposes start/stop controls. Presets (named full command lines) live in
# ~/pulse/llama_presets.json, a JSON array like:
#   [ { "name": "Qwen 27B Q5",
#       "args": "/opt/llama/llama-server -m /opt/models/qwen.gguf -ngl 99 -c 32768 --port 8080" } ]
# The file is re-read whenever it changes — no agent restart needed.

LLAMA_PROCS = ("llama-server", "llama-cli")
LLAMA_PRESETS = "llama_presets.json"
LLAMA_LOG = "llama-server.log"


def _llama_pid():
    """Pid of a running llama-server/llama-cli, or None."""
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        stat = rfile(f"/proc/{entry}/stat")
        if not stat:
            continue
        try:
            comm = stat[stat.index("(") + 1:stat.rindex(")")]
        except ValueError:
            continue
        if comm in LLAMA_PROCS:
            return int(entry)
    return None


def _proc_uid(pid):
    """Numeric uid from /proc/<pid>/status, or None if unreadable."""
    try:
        return int(re.search(r"^Uid:\s*(\d+)",
                             rfile(f"/proc/{pid}/status"), re.M).group(1))
    except Exception:
        return None


def _llama_ready(port, timeout=1.0):
    """TCP probe: is the port accepting connections yet?
    The process can exist well before that (model load), so the
    dashboard's "started" state is keyed on this, not on process presence."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def read_llama(procs, presets=None):
    """llama.cpp status block for the snapshot."""
    out = {"running": False, "pid": None, "cmd": None, "model": None,
           "port": None, "ready": False, "start": None,
           "presets": presets or []}
    pid = _llama_pid()
    if not pid:
        return out
    meta = next((p for p in procs if p["pid"] == pid), None)
    raw = rfile(f"/proc/{pid}/cmdline")
    argv = [x for x in (raw or "").split("\0") if x]
    model = port = None
    for i, a in enumerate(argv):
        if a in ("-m", "--model") and i + 1 < len(argv):
            model = argv[i + 1]
        elif a.startswith("--model="):
            model = a.split("=", 1)[1]
        elif a == "--port" and i + 1 < len(argv) and argv[i + 1].isdigit():
            port = int(argv[i + 1])
        elif a.startswith("--port=") and a.split("=", 1)[1].isdigit():
            port = int(a.split("=", 1)[1])
    out.update({"running": True, "pid": pid,
                "cmd": " ".join(argv)[:600],
                "model": model, "port": port,
                # no port (e.g. llama-cli) = nothing to wait for
                "ready": True if port is None else _llama_ready(port),
                "start": meta["start"] if meta else None})
    return out


# ---------------------------------------------------------------- action API

class ActionHandler(BaseHTTPRequestHandler):
    server_version = "PulseAgent/1.0"
    action_token = ""
    agent_name = ""
    docker_monitor = None

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, {"ok": True, "name": self.agent_name,
                             "version": AGENT_VERSION, "uptime": int(time.time() - BOOT_TIME)})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/action"):
            return self._send(404, {"ok": False, "error": "not found"})
        tok = self.headers.get("X-Action-Token", "")
        if not self.action_token or \
                not hmac.compare_digest(tok, self.action_token):
            return self._send(401, {"ok": False, "error": "bad token"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"ok": False, "error": "bad body"})
        if isinstance(body.get("docker"), dict):
            return self._docker_action(body["docker"])
        if isinstance(body.get("llama"), dict):
            return self._llama_action(body["llama"])
        if isinstance(body.get("gpu"), dict):
            return self._gpu_action(body["gpu"])
        try:
            pid = int(body["pid"])
            sig = int(body.get("sig", 15))
        except Exception:
            return self._send(400, {"ok": False, "error": "bad body"})
        if sig not in (1, 15, 9):
            return self._send(400, {"ok": False, "error": "sig must be 1/15/9"})
        st = rfile(f"/proc/{pid}/stat")
        if not st:
            return self._send(404, {"ok": False, "error": "no such process"})
        try:
            uid = int(re.search(r"^Uid:\s*(\d+)", rfile(f"/proc/{pid}/status"), re.M).group(1))
        except Exception:
            return self._send(400, {"ok": False, "error": "cannot read owner"})
        if uid != os.getuid() and os.geteuid() != 0:
            return self._send(403, {"ok": False,
                                    "error": "not your process (agent runs as "
                                             f"uid {os.getuid()})"})
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            return self._send(404, {"ok": False, "error": "process gone"})
        except PermissionError:
            return self._send(403, {"ok": False, "error": "permission denied"})
        self._send(200, {"ok": True, "pid": pid, "sig": sig})

    def _gpu_action(self, d):
        if d.get("cmd") != "fan":
            return self._send(200, {"ok": False, "error": "unknown GPU command"})
        try:
            index = int(d.get("index", 0))
            auto = bool(d.get("auto"))
            result = set_amd_fan(index, auto, d.get("preset"))
            return self._send(200, {"ok": True, **result})
        except (TypeError, ValueError, PermissionError, RuntimeError, OSError) as e:
            return self._send(200, {"ok": False, "error": str(e)})

    # -- docker controls
    # Body: {"docker": {"cmd": "start|stop|restart", "container": name}}
    #       {"docker": {"cmd": "remove", "container": name, "force": bool}}
    #       {"docker": {"cmd": "rmi", "image": ref, "force": bool}}
    # Expected engine failures (404/409/...) come back as HTTP 200 with
    # {"ok": false, "error": ...} so the server can relay them to the UI.
    def _docker_action(self, d):
        cmd = d.get("cmd")
        mon = self.docker_monitor
        sock = mon.current_sock() if mon else None
        if not sock:
            return self._send(200, {"ok": False,
                                    "error": "docker not available on this node"})
        q = urllib.parse.quote
        try:
            if cmd in ("start", "stop", "restart"):
                name = str(d.get("container") or "")
                if not name:
                    return self._send(200, {"ok": False, "error": "missing container"})
                path = f"{DOCKER_API}/containers/{q(name, safe='')}/{cmd}"
                if cmd in ("stop", "restart"):
                    path += "?t=10"
                try:
                    docker_api_call(sock, "POST", path, timeout=30)
                except DockerApiError as e:
                    if e.code == 304:
                        return self._send(200, {"ok": True, "note": "already running"})
                    return self._send(200, {"ok": False, "error": e.msg})
                return self._send(200, {"ok": True})
            if cmd == "remove":
                name = str(d.get("container") or "")
                if not name:
                    return self._send(200, {"ok": False, "error": "missing container"})
                force = 1 if d.get("force") else 0
                docker_api_call(sock, "DELETE",
                                f"{DOCKER_API}/containers/{q(name, safe='')}?force={force}",
                                timeout=30)
                return self._send(200, {"ok": True})
            if cmd == "rmi":
                ref = str(d.get("image") or "")
                if not ref:
                    return self._send(200, {"ok": False, "error": "missing image"})
                force = 1 if d.get("force") else 0
                docker_api_call(sock, "DELETE",
                                f"{DOCKER_API}/images/{q(ref, safe='/:')}?force={force}",
                                timeout=30)
                return self._send(200, {"ok": True})
            return self._send(200, {"ok": False, "error": f"unknown docker cmd: {cmd}"})
        except DockerApiError as e:
            return self._send(200, {"ok": False, "error": e.msg})
        except OSError as e:
            return self._send(200, {"ok": False,
                                    "error": f"docker unreachable: {e}"})

    # -- llama.cpp controls
    # Body: {"llama": {"cmd": "start", "args": "<full command line>"}}
    #       {"llama": {"cmd": "stop", "force": bool}}
    # Start spawns the command detached (logs go to ~/pulse/llama-server.log)
    # and returns as soon as the process exists; model loading continues
    # in the background. If the process is already dead ~2 s after spawn
    # (bad device flag, missing binary, port in use, ...) the start is
    # reported as failed with the last line of the log — a dead-on-arrival
    # launch must not come back as "started (pid N)".
    # Args may contain newlines/extra whitespace — they
    # are collapsed to single spaces. Only one instance runs: start stops
    # the current one first (SIGTERM, SIGKILL after 15 s if needed).
    # Stop sends SIGTERM (SIGKILL with force).
    def _llama_action(self, d):
        cmd = d.get("cmd")
        if cmd == "start":
            # Multi-line input (dashboard textareas) becomes one line.
            args = re.sub(r"\s+", " ", str(d.get("args") or "")).strip()
            if not args:
                return self._send(200, {"ok": False, "error": "missing args"})
            try:
                argv = shlex.split(args)
            except ValueError as e:
                return self._send(200, {"ok": False, "error": f"bad args: {e}"})
            if not argv:
                return self._send(200, {"ok": False, "error": "missing args"})
            # Only one instance at a time: stop a running one first.
            replaced = None
            running = _llama_pid()
            if running:
                uid = _proc_uid(running)
                if uid is None or (uid != os.getuid() and os.geteuid() != 0):
                    return self._send(200, {"ok": False,
                        "error": f"running instance (pid {running}) belongs to another user"})
                try:
                    os.kill(running, 15)
                except ProcessLookupError:
                    running = None
                if running:
                    deadline = time.time() + 15
                    while time.time() < deadline and _llama_pid() == running:
                        time.sleep(0.2)
                    if _llama_pid() == running:
                        try:
                            os.kill(running, 9)
                        except ProcessLookupError:
                            pass
                        time.sleep(0.5)
                if _llama_pid():
                    return self._send(200, {"ok": False,
                        "error": f"running instance (pid {_llama_pid()}) would not stop"})
                replaced = running
            try:
                home = Path.home() / "pulse"
                with open(home / LLAMA_LOG, "ab") as lp:
                    proc = subprocess.Popen(
                        argv, stdin=subprocess.DEVNULL,
                        stdout=lp, stderr=subprocess.STDOUT,
                        cwd=str(home), start_new_session=True)
            except OSError as e:
                return self._send(200, {"ok": False,
                                        "error": f"start failed: {e}"})
            # Liveness probe: startup errors (invalid device flag, port in
            # use, ...) kill the process within a second. A successful
            # spawn that is already dead is a failed start — report the
            # actual reason from the log tail.
            time.sleep(2.0)
            rc = proc.poll()
            if rc is not None:
                tail = self._llama_log_tail()
                return self._send(200, {"ok": False,
                    "error": f"exited immediately (code {rc})"
                             + (f": {tail}" if tail else "")})
            note = ("replaced running instance (pid %s) — " % replaced
                    if replaced else "") + "model load takes a moment"
            return self._send(200, {"ok": True, "pid": proc.pid, "note": note})
        if cmd == "stop":
            pid = _llama_pid()
            if not pid:
                return self._send(200, {"ok": False, "error": "not running"})
            uid = _proc_uid(pid)
            if uid is None:
                return self._send(200, {"ok": False, "error": "cannot read owner"})
            if uid != os.getuid() and os.geteuid() != 0:
                return self._send(200, {"ok": False,
                                        "error": "not your process (agent runs as "
                                                 f"uid {os.getuid()})"})
            sig = 9 if d.get("force") else 15
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                return self._send(200, {"ok": False, "error": "process gone"})
            except PermissionError:
                return self._send(200, {"ok": False, "error": "permission denied"})
            return self._send(200, {"ok": True, "pid": pid, "sig": sig})
        if cmd == "log":
            # Read-only tail of ~/pulse/llama-server.log (dashboard console).
            try:
                raw = (Path.home() / "pulse" / LLAMA_LOG).read_bytes()[-16384:]
            except OSError:
                return self._send(200, {"ok": True, "log": "", "exists": False})
            text = raw.decode("utf-8", "replace")
            if len(raw) == 16384 and "\n" in text:
                text = text.split("\n", 1)[1]   # we chopped the first line mid-way
            lines = [l for l in text.splitlines() if l.strip()][-400:]
            return self._send(200, {"ok": True, "log": "\n".join(lines),
                                    "exists": True})
        if cmd == "add_preset":
            return self._llama_add_preset(d)
        if cmd == "del_preset":
            return self._llama_del_preset(d)
        return self._send(200, {"ok": False, "error": f"unknown llama cmd: {cmd}"})

    @staticmethod
    def _llama_log_tail(max_bytes=4096, max_chars=280):
        """Last non-empty line of the llama log (for error reporting)."""
        try:
            fp = Path.home() / "pulse" / LLAMA_LOG
            with open(fp, "rb") as lf:
                lf.seek(0, os.SEEK_END)
                size = lf.tell()
                lf.seek(max(0, size - max_bytes))
                data = lf.read().decode("utf-8", "replace")
        except OSError:
            return ""
        lines = [l.strip() for l in data.splitlines() if l.strip()]
        return lines[-1][:max_chars] if lines else ""

    @staticmethod
    def _llama_presets_file():
        return Path.home() / "pulse" / LLAMA_PRESETS

    @staticmethod
    def _llama_presets_read(fp):
        """Preset list from disk, or None if the file is missing/broken."""
        try:
            data = json.loads(fp.read_text())
        except (ValueError, OSError):
            return None
        if isinstance(data, dict):
            data = data.get("presets")
        if not isinstance(data, list):
            return None
        out = []
        for e in data:
            if isinstance(e, dict) and e.get("name") and str(e.get("args", "")).strip():
                out.append({"name": str(e["name"]), "args": str(e["args"]).strip()})
        return out

    @staticmethod
    def _llama_presets_write(fp, presets):
        tmp = fp.with_name(LLAMA_PRESETS + ".tmp")
        tmp.write_text(json.dumps(presets, indent=2) + "\n")
        os.replace(tmp, fp)

    def _llama_add_preset(self, d):
        """Add a preset. Same name (or old_name given) = update in place,
        which also covers rename: old_name keeps the entry's position."""
        name = str(d.get("name") or "").strip()
        args = re.sub(r"\s+", " ", str(d.get("args") or "")).strip()
        old = str(d.get("old_name") or "").strip()
        if not name or not args:
            return self._send(200, {"ok": False, "error": "name and args are required"})
        if len(name) > 120 or len(args) > 4000:
            return self._send(200, {"ok": False, "error": "name or args too long"})
        try:
            shlex.split(args)
        except ValueError as e:
            return self._send(200, {"ok": False, "error": f"bad args: {e}"})
        fp = self._llama_presets_file()
        fp.parent.mkdir(parents=True, exist_ok=True)
        presets = self._llama_presets_read(fp)
        if presets is None:
            presets = []
        for i, p in enumerate(presets):
            if p["name"].lower() == name.lower() or (old and p["name"].lower() == old.lower()):
                note = (f"renamed from {p['name']}" if p["name"].lower() != name.lower()
                        else "existing preset updated")
                presets[i] = {"name": name, "args": args}
                self._llama_presets_write(fp, presets)
                return self._send(200, {"ok": True, "preset": name, "note": note})
        presets.append({"name": name, "args": args})
        self._llama_presets_write(fp, presets)
        return self._send(200, {"ok": True, "preset": name})

    def _llama_del_preset(self, d):
        name = str(d.get("name") or "").strip()
        if not name:
            return self._send(200, {"ok": False, "error": "name is required"})
        fp = self._llama_presets_file()
        presets = self._llama_presets_read(fp)
        if presets is None:
            return self._send(200, {"ok": False, "error": "no presets file yet"})
        for i, p in enumerate(presets):
            if p["name"].lower() == name.lower():
                del presets[i]
                self._llama_presets_write(fp, presets)
                return self._send(200, {"ok": True, "preset": name})
        return self._send(200, {"ok": False,
                                "error": f"no preset named “{name}”"})


# ---------------------------------------------------------------- main agent

class PulseAgent:
    def __init__(self, cfg):
        self.cfg = cfg
        self.name = cfg.get("NAME") or socket.gethostname()
        self.server_url = cfg["SERVER_URL"].rstrip("/")
        self.token = cfg["TOKEN"]
        self.interval = float(cfg.get("INTERVAL", "2"))
        self.action_port = int(cfg.get("ACTION_PORT", "9611"))
        key_file = Path.home() / ".pulse" / "agent.key"
        key_file.parent.mkdir(parents=True, exist_ok=True)
        if key_file.exists():
            self.action_token = key_file.read_text().strip()
        else:
            self.action_token = secrets.token_hex(16)
            key_file.write_text(self.action_token + "\n")
            key_file.chmod(0o600)
        self.lan_ip = lan_ip_for(self.server_url.split("//")[-1].split(":")[0])
        self.action_url = f"http://{self.lan_ip}:{self.action_port}"
        self.prev_procs = {}
        self.prev_cpu = None
        self.prev_cpu_ts = 0.0
        self.prev_disk = None
        self.prev_disk_ts = 0.0
        self.prev_net = None
        self.prev_net_ts = 0.0
        self.gpu = GpuCollector()
        self.gpu.start()
        self.docker = DockerMonitor()
        self.docker.start()
        self._llama_preset_key = None
        self._llama_preset_cache = []
        self.pci = pci_list()
        self.usb = usb_list()
        self.cpufreq = None
        try:
            self.cpufreq = int(rfloat("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq") or 0) // 1000
        except Exception:
            pass
        self.model = None
        data = rfile("/proc/cpuinfo")
        if data:
            m = re.search(r"model name\s*:\s*(.+)", data)
            if m:
                self.model = m.group(1).strip()
        self.n_cpu = os.cpu_count() or 1
        self.fail_streak = 0

    def read_llama_presets(self):
        """Named command lines from ~/pulse/llama_presets.json.

        Re-read whenever the file's mtime/size changes; a broken file
        falls back to the last good list.
        """
        fp = Path.home() / "pulse" / LLAMA_PRESETS
        try:
            st = fp.stat()
        except OSError:
            return []
        key = (st.st_mtime_ns, st.st_size)
        if key == self._llama_preset_key:
            return self._llama_preset_cache
        try:
            data = json.loads(fp.read_text())
        except (ValueError, OSError):
            return self._llama_preset_cache
        if isinstance(data, dict):
            data = data.get("presets")
        out = []
        if isinstance(data, list):
            for e in data:
                if isinstance(e, dict) and e.get("name") and str(e.get("args", "")).strip():
                    out.append({"name": str(e["name"]),
                                "args": str(e["args"]).strip()})
        self._llama_preset_key = key
        self._llama_preset_cache = out
        return out

    # -- one snapshot
    def collect(self):
        t = now()
        cpu_raw, per_core = read_cpu_raw()
        mi = read_meminfo()
        load = read_loadavg() or {}
        psi = read_psi()
        if not mi:
            return None
        total_mem = mi.get("MemTotal", 0)
        free = mi.get("MemFree", 0)
        avail = mi.get("MemAvailable", free)
        used = total_mem - mi.get("MemFree", 0) - mi.get("Buffers", 0) \
            - mi.get("Cached", 0) - mi.get("SReclaimable", 0)
        if used < 0:
            used = total_mem - free
        swap_total = mi.get("SwapTotal", 0)
        swap_free = mi.get("SwapFree", 0)

        # CPU deltas
        cpu_pct = 0.0
        per_core_pct = []
        if self.prev_cpu and cpu_raw:
            pt, pper, pt0 = self.prev_cpu
            wall = t - pt0
            if wall > 0.05:
                dt = sum(cpu_raw) - sum(pt)
                di = (cpu_raw[3] + cpu_raw[4]) - (pt[3] + pt[4])
                cpu_pct = round(100.0 * (dt - di) / dt, 1) if dt > 0 else 0.0
                for i, core in enumerate(per_core):
                    if i >= len(pper):
                        break
                    d = sum(core) - sum(pper[i])
                    di_ = (core[3] + core[4]) - (pper[i][3] + pper[i][4])
                    per_core_pct.append(round(100.0 * (d - di_) / d, 1) if d > 0 else 0.0)
        self.prev_cpu = (cpu_raw, per_core, t) if cpu_raw else None

        # disk io
        disk = read_diskstats()
        disk_io = {}
        if self.prev_disk and disk:
            wall = t - self.prev_disk_ts
            if wall > 0.05:
                for name, (sr, sw) in disk.items():
                    p = self.prev_disk.get(name)
                    if p:
                        r_bps = max(0, (sr - p[0]) * 512) / wall
                        w_bps = max(0, (sw - p[1]) * 512) / wall
                        disk_io[name] = {"r": round(r_bps, 1), "w": round(w_bps, 1)}
        self.prev_disk = disk
        self.prev_disk_ts = t

        # net io
        net = read_netdev()
        net_io = {}
        if self.prev_net and net:
            wall = t - self.prev_net_ts
            if wall > 0.05:
                for name, (rx, tx) in net.items():
                    p = self.prev_net.get(name)
                    if p:
                        net_io[name] = {
                            "rx": round(max(0, rx - p[0]) / wall, 1),
                            "tx": round(max(0, tx - p[1]) / wall, 1),
                            "rx_total": rx, "tx_total": tx,
                        }
        self.prev_net = net
        self.prev_net_ts = t

        procs = read_procs(self.prev_procs, t - (self.last_collect_ts or t - self.interval), total_mem)
        self.last_collect_ts = t

        mounts = read_mount_usage(read_mounts())
        temps = read_thermals()

        return {
            "ts": t,
            "host": {
                "name": self.name,
                "hostname": socket.gethostname(),
                "ip": self.lan_ip,
                "os": _os_release(),
                "kernel": os.uname().release,
                "cpu_model": self.model,
                "n_cpu": self.n_cpu,
                "cpu_max_mhz": self.cpufreq,
                "mem_total": total_mem,
                "boot_time": int(BOOT_EPOCH),
                "uptime": int(t - BOOT_EPOCH),
            },
            "cpu": {
                "pct": cpu_pct,
                "per_core": per_core_pct,
                "load": load,
                "psi": psi,
            },
            "mem": {
                "total": total_mem, "used": used, "available": avail,
                "free": free,
                "swap_total": swap_total,
                "swap_used": swap_total - swap_free,
            },
            "disk_io": disk_io,
            "net_io": net_io,
            "mounts": mounts,
            "temps": temps,
            "gpu": self.gpu.data,
            "pci": self.pci,
            "usb": self.usb,
            "procs": procs,
            "docker": self.docker.snapshot(),
            "llama": read_llama(procs, self.read_llama_presets()),
        }

    last_collect_ts = 0.0

    # -- push
    def push(self, snap):
        payload = {
            "v": 1, "name": self.name, "agent": AGENT_VERSION,
            "action_url": self.action_url, "action_token": self.action_token,
            "snap": snap,
        }
        req = urllib.request.Request(
            self.server_url + "/api/ingest",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "X-Pulse-Token": self.token},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                r.read()
            if self.fail_streak:
                log(f"server reachable again (after {self.fail_streak} failed pushes)")
            self.fail_streak = 0
            return True
        except Exception as e:
            self.fail_streak += 1
            if self.fail_streak in (1, 10, 60, 300):
                log(f"push failed ({self.fail_streak}x): {e}")
            return False

    # -- run
    def run(self):
        log(f"starting v{AGENT_VERSION} node={self.name} -> {self.server_url} "
            f"(every {self.interval}s, action api on :{self.action_port})")
        # warm-up first sample (so first real snapshot has deltas)
        self.collect()
        ActionHandler.action_token = self.action_token
        ActionHandler.agent_name = self.name
        ActionHandler.docker_monitor = self.docker
        try:
            httpd = ThreadingHTTPServer(("0.0.0.0", self.action_port), ActionHandler)
            httpd.daemon_threads = True
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            log(f"action API listening on 0.0.0.0:{self.action_port}")
        except OSError as e:
            log(f"action API not started: {e}")
        while True:
            t0 = time.time()
            snap = self.collect()
            if snap:
                self.push(snap)
            dt = time.time() - t0
            time.sleep(max(0.2, self.interval - dt))


def _os_release():
    data = rfile("/etc/os-release") or ""
    name = version = ""
    for line in data.splitlines():
        if line.startswith("PRETTY_NAME="):
            name = line.split("=", 1)[1].strip('"')
    return name or "Linux"


def load_config(path):
    cfg = {}
    p = Path(path)
    if p.exists():
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip().strip('"')
    for k in ("SERVER_URL", "TOKEN"):
        if k in os.environ:
            cfg[k] = os.environ[k]
    if not cfg.get("SERVER_URL"):
        sys.exit("missing SERVER_URL (config file or $SERVER_URL)")
    if not cfg.get("TOKEN"):
        sys.exit("missing TOKEN (config file or $TOKEN)")
    return cfg


def main():
    import argparse
    ap = argparse.ArgumentParser(description="Pulse monitoring agent")
    ap.add_argument("--config", default=str(Path.home() / "pulse" / "agent.conf"))
    args = ap.parse_args()
    cfg = load_config(args.config)
    PulseAgent(cfg).run()


if __name__ == "__main__":
    main()
