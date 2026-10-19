#!/usr/bin/env python3
"""Local dev fake agent — generates plausible snapshots (no /proc needed,
works on Windows) and pushes them to a local pulse server. Also runs a
mini action API so /api/action can be exercised end-to-end."""

import json
import math
import random
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SERVER = "http://127.0.0.1:8090"
TOKEN = "localtest"
NODE = "server-1"
GPU_FAN = {"auto": True, "preset": "auto", "percent": 34}
PROCS = [
    ("systemd", "root", 0.3, 0.6, "systemd --system"),
    ("llama-server", "decode", 180, 18.5, "/home/decode/LLM/bin_rocm/llama-server -m Qwen3.8-27B --port 8080"),
    ("sshd", "root", 1.1, 0.1, "sshd: decode@pts/0"),
    ("snapd", "root", 0.4, 0.5, "snapd"),
    ("postgres", "postgres", 5.2, 6.1, "postgres: writer"),
    ("caddy", "root", 0.2, 0.3, "caddy run --config /etc/caddy/Caddyfile"),
    ("dockerd", "root", 0.7, 0.8, "dockerd --host=unix:///var/run/docker.sock"),
    ("node", "root", 2.4, 1.2, "next-server (v15.1.0)"),
    ("searxng", "root", 1.8, 0.9, "searxng worker-1"),
]

# ── fake docker state ─────────────────────────────────────────────────
DOCKER = {
    "version": "29.8.1",
    "containers": {
        "a1b2c3d4e5f6": {
            "name": "pulse-web", "image": "nginx:1.27",
            "state": "running", "cpu": 12.0,
            "mem": 52 * 1024 ** 2, "mem_limit": 512 * 1024 ** 2,
            "net_rx": 1.2e7, "net_tx": 3.4e6,
            "ports": "80->80/tcp", "created": None, "started": None, "exit_code": 0,
        },
        "b2c3d4e5f6a7": {
            "name": "pulse-db", "image": "postgres:16",
            "state": "running", "cpu": 24.0,
            "mem": 210 * 1024 ** 2, "mem_limit": 1024 * 1024 ** 2,
            "net_rx": 4.8e7, "net_tx": 2.1e7,
            "ports": "5432->5432/tcp", "created": None, "started": None, "exit_code": 0,
        },
        "c3d4e5f6a7b8": {
            "name": "pulse-redis", "image": "redis:7",
            "state": "exited", "cpu": 0.0,
            "mem": 0, "mem_limit": None,
            "net_rx": 9.1e6, "net_tx": 8.8e6,
            "ports": "6379->6379/tcp", "created": None, "started": None, "exit_code": 0,
        },
        "d4e5f6a7b8c9": {
            "name": "pulse-worker", "image": "python:3.13-slim",
            "state": "running", "cpu": 6.5,
            "mem": 88 * 1024 ** 2, "mem_limit": None,
            "net_rx": 7.5e5, "net_tx": 4.2e5,
            "ports": "", "created": None, "started": None, "exit_code": 0,
        },
    },
    "images": {
        "deadbeef0001": {"ref": "nginx:1.27", "size": 187 * 1024 ** 2, "created": None},
        "deadbeef0002": {"ref": "postgres:16", "size": 451 * 1024 ** 2, "created": None},
        "deadbeef0003": {"ref": "redis:7", "size": 122 * 1024 ** 2, "created": None},
        "deadbeef0004": {"ref": "python:3.13-slim", "size": 145 * 1024 ** 2, "created": None},
    },
}


def _fmt_age(s):
    if s < 3600:
        m = max(1, s // 60)
        return f"{m} minute{'s' if m != 1 else ''}"
    h = s // 3600
    if h < 48:
        return f"{h} hour{'s' if h != 1 else ''}"
    d = s // 86400
    return f"{d} day{'s' if d != 1 else ''}"


def _docker_status(c, t):
    age = max(0, int(t) - c["created"])
    if c["state"] == "running":
        return "Up " + _fmt_age(max(0, int(t) - c["started"]))
    return f"Exited ({c['exit_code']}) " + _fmt_age(max(0, int(t) - c["started"])) + " ago"


def docker_snapshot(t):
    ph = t / 37.0
    cs = []
    for cid, c in DOCKER["containers"].items():
        if c["state"] == "running":
            cpu = max(0.0, min(95.0, c["cpu"] + random.uniform(-6, 6)))
            net_rx = c["net_rx"] + random.uniform(1e5, 9e5)
            net_tx = c["net_tx"] + random.uniform(5e4, 4e5)
        else:
            cpu, net_rx, net_tx = 0.0, c["net_rx"], c["net_tx"]
        cs.append({
            "id": cid[:12], "name": c["name"], "image": c["image"],
            "state": c["state"], "status": _docker_status(c, t),
            "created": c["created"], "cpu": round(cpu, 1),
            "mem": c["mem"], "mem_limit": c["mem_limit"],
            "net_rx": int(net_rx), "net_tx": int(net_tx),
            "ports": c["ports"],
        })
    cs.sort(key=lambda x: x["name"])
    ims = []
    for iid, im in DOCKER["images"].items():
        ims.append({"id": iid[:12], "ref": im["ref"], "size": im["size"], "created": im["created"]})
    ims.sort(key=lambda x: x["ref"])
    return {"installed": True, "daemon": "running", "version": DOCKER["version"],
            "ts": int(t), "containers": cs, "images": ims}


def snap(t):
    ph = t / 37.0
    cpu = 30 + 22 * math.sin(ph) + random.uniform(-4, 4)
    cpu = max(1, min(99, cpu))
    per_core = [max(0, min(100, cpu + random.uniform(-18, 18))) for _ in range(6)]
    mem_used = 5.0e9 + 1.2e9 * math.sin(ph / 3)
    return {
        "ts": t,
        "host": {
            "name": NODE, "hostname": NODE, "ip": "127.0.0.1",
            "os": "Ubuntu 26.04.1 LTS (Resolute Raccoon)",
            "kernel": "7.0.0-31-generic",
            "cpu_model": "Intel(R) Core(TM) i5-9400 CPU @ 2.90GHz",
            "n_cpu": 6, "cpu_max_mhz": 4100,
            "mem_total": 30 * 1024**3,
            "boot_time": int(t) - 7600, "uptime": 7600 + int(t - 0) % 1,
        },
        "cpu": {"pct": round(cpu, 1), "per_core": [round(x, 1) for x in per_core],
                "load": {"load1": round(11 + math.sin(ph / 2), 2),
                         "load5": round(9 + math.sin(ph / 2 + 1), 2),
                         "load15": round(6 + math.sin(ph / 2 + 2), 2)},
                "psi": {"cpu": round(max(0, 4 * math.sin(ph / 5)), 1)}},
        "mem": {"total": 30 * 1024**3, "used": int(mem_used),
                "available": int(30 * 1024**3 - mem_used - 26 * 1024**3 // 2),
                "free": int(0.4 * 1024**3),
                "swap_total": 8 * 1024**3, "swap_used": 40 * 1024**2},
        "disk_io": {"nvme0n1": {"r": round(1e6 * abs(math.sin(ph / 7)) + random.uniform(0, 5e4), 1),
                                "w": round(4e5 * abs(math.cos(ph / 9)) + random.uniform(0, 2e4), 1)}},
        "net_io": {"eno1": {"rx": round(3e5 * abs(math.sin(ph / 4)) + random.uniform(0, 1e4), 1),
                            "tx": round(8e4 * abs(math.cos(ph / 5)) + random.uniform(0, 3e3), 1),
                            "rx_total": int(4.2e10 + t * 3e5),
                            "tx_total": int(9e9 + t * 8e4)}},
        "mounts": [
            {"mount": "/", "fs": "ext4", "dev": "/dev/mapper/ubuntu--vg-ubuntu--lv",
             "total": 231 * 1024**3, "used": int(49e9 + t * 200), "free": int(171e9), "pct": 23.0},
            {"mount": "/boot", "fs": "ext4", "dev": "/dev/nvme0n1p2",
             "total": 2 * 1024**3, "used": 191 * 1024**2, "free": 1.6 * 1024**3, "pct": 11.0},
        ],
        "temps": [
            {"name": "coretemp", "label": "Package id 0", "c": round(48 + 3 * math.sin(ph / 8), 1)},
            {"name": "cpu_thermal", "label": "soc", "c": round(41 + 2 * math.cos(ph / 8), 1)},
        ],
        "gpu": [
            {"name": "AMD Radeon RX 7900 XTX", "kind": "amd",
             "use": round(max(0, min(100, 78 * abs(math.sin(ph / 6)) + random.uniform(-5, 5))), 1),
             "vram_pct": 96.0, "temp": round(65 + 8 * math.sin(ph / 10), 1),
             "temp_junc": round(71 + 8 * math.sin(ph / 10), 1),
             "gfx_clk_mhz": 2000, "mem_clk_mhz": 1249,
             "fan_pct": GPU_FAN["percent"], "fan_rpm": GPU_FAN["percent"] * 43,
             "fan_auto": GPU_FAN["auto"], "fan_preset": GPU_FAN["preset"],
             "fan_control": True, "fan_writable": True},
            {"name": "card0 (iGPU)", "kind": "sysfs", "use": 0.0,
             "vram_pct": 97.0, "vram_used": 24.8 * 1024**3, "vram_total": 25.7 * 1024**3,
             "temp": None},
        ],
        "pci": [
            "00:02.0 VGA compatible controller: Intel Corporation CoffeeLake-S GT2 [UHD Graphics 630]",
            "00:1f.6 Ethernet controller: Intel Corporation Ethernet Connection (7) I219-V (rev 10)",
            "03:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XT/7900 XTX/7900 GRE/7900M] (rev c8)",
            "04:00.0 Non-Volatile memory controller: Samsung Electronics Co Ltd NVMe SSD Controller SM961/PM961/SM963",
        ],
        "usb": [
            {"port": "1-1", "id": "80ee:0021", "name": "USB2.0 Hub"},
            {"port": "2-1", "id": "046d:c077", "name": "Dell USB Keyboard"},
        ],
        "procs": [
            {
                "pid": 1000 + i * 7, "ppid": 1, "user": u,
                "name": name, "cmd": cmd,
                "state": random.choice(["S", "S", "S", "R"]),
                "threads": random.randint(1, 32),
                "nice": 0,
                "rss_kb": int(mb * 1024),
                "cpu": round(max(0, base_cpu + random.uniform(-15, 15)), 1),
                "mem": round(mb * 1024 * 1024 * 100 / (30 * 1024**3), 2),
                "start": int(t) - random.randint(300, 7000),
            }
            for i, (name, u, base_cpu, mb, cmd) in enumerate(PROCS)
        ],
        "docker": docker_snapshot(t),
    }


class Action(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _docker_action(self, d):
        cmd = d.get("cmd")
        now = time.time()
        if cmd in ("start", "stop", "restart"):
            hit = next((c for c in DOCKER["containers"].values()
                        if c["name"] == d.get("container")), None)
            if hit is None:
                return {"ok": False, "error": f"no such container: {d.get('container')}"}
            if cmd == "start":
                if hit["state"] == "running":
                    return {"ok": True, "note": "already running"}
                hit["state"], hit["started"] = "running", now
                return {"ok": True}
            if cmd == "stop":
                if hit["state"] != "running":
                    return {"ok": True, "note": "already stopped"}
                hit["state"], hit["exit_code"] = "exited", 0
                return {"ok": True}
            hit["state"], hit["started"], hit["exit_code"] = "running", now, 0
            return {"ok": True}
        if cmd == "remove":
            hit = next((c for c in DOCKER["containers"].values()
                        if c["name"] == d.get("container")), None)
            if hit is None:
                return {"ok": False, "error": f"no such container: {d.get('container')}"}
            if hit["state"] == "running" and not d.get("force"):
                return {"ok": False, "error": "container is running; use force to remove"}
            cid = next(cid for cid, c in DOCKER["containers"].items() if c is hit)
            DOCKER["containers"].pop(cid)
            return {"ok": True}
        if cmd == "rmi":
            ref = d.get("image")
            used = [c for c in DOCKER["containers"].values() if c["image"] == ref]
            if used and not d.get("force"):
                return {"ok": False,
                        "error": f"image is in use by {len(used)} container(s); use force to remove"}
            removed = [iid for iid, im in DOCKER["images"].items() if im["ref"] == ref]
            if not removed:
                return {"ok": False, "error": f"no such image: {ref}"}
            for iid in removed:
                DOCKER["images"].pop(iid)
            return {"ok": True}
        return {"ok": False, "error": f"unknown docker cmd: {cmd}"}

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        if isinstance(body.get("docker"), dict):
            self._send(self._docker_action(body["docker"]))
            return
        if isinstance(body.get("gpu"), dict):
            d = body["gpu"]
            if d.get("cmd") != "fan":
                return self._send({"ok": False, "error": "unknown GPU command"})
            if d.get("auto"):
                GPU_FAN.update(auto=True, preset="auto", percent=34)
            else:
                preset = str(d.get("preset") or "")
                speeds = {"balanced": 45, "cool": 60, "aggressive": 70}
                if preset not in speeds:
                    return self._send({"ok": False, "error": "unknown fan preset"})
                GPU_FAN.update(auto=False, preset=preset, percent=speeds[preset])
            return self._send({"ok": True, **GPU_FAN})
        self._send({"ok": True, "pid": body.get("pid"), "sig": body.get("sig")})


def main():
    t0 = time.time()
    DOCKER["containers"]["a1b2c3d4e5f6"].update(created=t0 - 172800, started=t0 - 7200)
    DOCKER["containers"]["b2c3d4e5f6a7"].update(created=t0 - 259200, started=t0 - 86400)
    DOCKER["containers"]["c3d4e5f6a7b8"].update(created=t0 - 432000, started=t0 - 14400)
    DOCKER["containers"]["d4e5f6a7b8c9"].update(created=t0 - 90000, started=t0 - 54000)
    for im in DOCKER["images"].values():
        im["created"] = int(t0 - 2500000)
    httpd = ThreadingHTTPServer(("127.0.0.1", 9611), Action)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    t0 = time.time()
    i = 0
    while True:
        t = time.time()
        payload = {"v": 1, "name": NODE, "agent": "1.0.0-test",
                   "action_url": "http://127.0.0.1:9611",
                   "action_token": "faketesttoken", "snap": snap(t)}
        req = urllib.request.Request(
            SERVER + "/api/ingest", data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "X-Pulse-Token": TOKEN},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=4) as r:
                r.read()
            i += 1
            if i % 15 == 0:
                print(f"fake agent: pushed {i} snapshots", flush=True)
        except Exception as e:
            print(f"fake agent push failed: {e}", flush=True)
        time.sleep(2)


if __name__ == "__main__":
    main()
