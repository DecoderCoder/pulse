/* ============================================================
   Pulse dashboard — vanilla JS, no dependencies
   ============================================================ */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

const POLL_MS = 2000;  // default UI refresh interval (ms)
let pollMs = POLL_MS;  // live value; adjustable from the top bar, persisted
try {
  const _v = parseInt(localStorage.getItem("pulse.pollMs"), 10);
  if (_v >= 100 && _v <= 60000) pollMs = _v;
} catch (e) {}
const CHART_WINDOW_S = 15 * 60;  // chart window in SECONDS (all ts are seconds)
const BUF_POINTS = 500;  // ~16 min at 2s cadence (covers the 15-min window)

const COLORS = {
  cpu: "rgb(34,211,238)",
  mem: "rgb(167,139,250)",
  load1: "rgb(251,191,36)",
  load5: "rgb(253,224,71)",
  load15: "rgb(217,180,60)",
  drio: "rgb(52,211,153)",
  driw: "rgb(244,114,182)",
  nrx: "rgb(34,211,238)",
  ntx: "rgb(167,139,250)",
  temp: "rgb(251,146,60)",
  gpu: "rgb(167,139,250)",
  swap: "rgb(100,116,139)",
};

/* ---------------- icons (inline svg, stroke = currentColor) ---------------- */

const ICONS = {
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><line x1="7" y1="7.5" x2="7.01" y2="7.5"/><line x1="7" y1="16.5" x2="7.01" y2="16.5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><line x1="9" y1="3" x2="9" y2="6"/><line x1="12" y1="3" x2="12" y2="6"/><line x1="15" y1="3" x2="15" y2="6"/><line x1="9" y1="18" x2="9" y2="21"/><line x1="12" y1="18" x2="12" y2="21"/><line x1="15" y1="18" x2="15" y2="21"/><line x1="3" y1="9" x2="6" y2="9"/><line x1="3" y1="12" x2="6" y2="12"/><line x1="3" y1="15" x2="6" y2="15"/><line x1="18" y1="9" x2="21" y2="9"/><line x1="18" y1="12" x2="21" y2="12"/><line x1="18" y1="15" x2="21" y2="15"/>',
  memory: '<rect x="3" y="7" width="18" height="10" rx="1.5"/><line x1="7" y1="10" x2="7" y2="14"/><line x1="11" y1="10" x2="11" y2="14"/><line x1="15" y1="10" x2="15" y2="14"/><line x1="7" y1="17" x2="7" y2="19"/><line x1="11" y1="17" x2="11" y2="19"/><line x1="15" y1="17" x2="15" y2="19"/>',
  activity: '<polyline points="3 12 8 12 11 5 14 19 17 12 21 12"/>',
  swap: '<line x1="4" y1="9" x2="20" y2="9"/><polyline points="17 6 20 9 17 12"/><line x1="20" y1="15" x2="4" y2="15"/><polyline points="7 12 4 15 7 18"/>',
  disk: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
  network: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><line x1="3" y1="12" x2="21" y2="12"/>',
  temp: '<path d="M12 3a2 2 0 0 0-2 2v8.3a4 4 0 1 0 4 0V5a2 2 0 0 0-2-2z"/>',
  gpu: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.8"/>',
  box: '<path d="M12 3l8.5 4.9v8.2L12 21l-8.5-4.9V7.9z"/><path d="M12 12l8.5-4.9"/><path d="M12 12v9"/><path d="M12 12L3.5 7.1"/>',
  chart: '<line x1="4" y1="20" x2="20" y2="20"/><polyline points="6 14 10 10 14 13 18 7"/>',
  list: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><line x1="4.5" y1="6" x2="4.51" y2="6"/><line x1="4.5" y1="12" x2="4.51" y2="12"/><line x1="4.5" y1="18" x2="4.51" y2="18"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
  zap: '<polygon points="13 3 5 13 12 13 11 21 19 11 12 11 13 3"/>',
  alert: '<path d="M12 4l9 16H3z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="21" y2="21"/>',
  play: '<polygon points="7 4 20 12 7 20 7 4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  restart: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
};

function icon(name, size = 15, cls = "") { const p = ICONS[name]; if (!p) return ""; return '<svg class="ic' + (cls ? " " + cls : "") + '" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + "</svg>"; }

const state = {
  nodes: {},
  view: null,
  serverTs: 0,
  online: false,
  ddns: null,   // compact Cloudflare DDNS status from /api/state
  wol: null,    // compact Wake-on-LAN status from /api/state
  install: null, // {url, token} — server LAN URL + ingest token for the Install tab
};
const liveBuf = {};   // node -> {cpu:[[ts,val]], mem:[], ...}
const tm = { sortKey: "cpu", sortDir: -1, q: "", node: null, lastData: null };
const devCache = {};  // node -> json string of devices (skip re-render when unchanged)
const dkCache = {};   // node -> key of last rendered docker block (structure only — cpu floats every tick)
const llCache = {};   // node -> key of last rendered llama block
const stCache = {};   // node -> key of last rendered Strata block

/* ---------------- formatting ---------------- */

function withAlpha(rgb, a) {
  return rgb.replace("rgb(", "rgba(").replace(")", `,${a})`);
}

function fmtBytes(n, d = 1) {
  if (n == null || isNaN(n)) return "—";
  n = Number(n);
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n < 10 ? n.toFixed(d) : Math.round(n)) + " " + u[i];
}
const fmtPS = (n) => fmtBytes(n) + "/s";

function fmtDur(s) {
  if (s == null) return "—";
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${String(h).padStart(2, "0")}h`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

function ago(ts) {
  if (!ts) return "never";
  return fmtDur((Date.now() / 1000 - ts)) + " ago";
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return "—";
  return (n >= 100 ? Math.round(n) : +n.toFixed(1)) + "%";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ---------------- api key ---------------- */

const KEY_STORAGE = "pulse.key";
let apiKey = "";
try { apiKey = localStorage.getItem(KEY_STORAGE) || ""; } catch (e) {}

function setApiKey(k) {
  apiKey = String(k || "").trim();
  try { localStorage.setItem(KEY_STORAGE, apiKey); } catch (e) {}
}

// A fresh `?key=...` in the URL (first open, or after a key change) takes
// over and is stripped from the address bar so it is not shared by accident.
(function grabUrlKey() {
  const m = location.search.match(/[?&]key=([^&]+)/);
  if (m) {
    setApiKey(decodeURIComponent(m[1]));
    try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
  }
})();

function showKeyPrompt() {
  if (document.getElementById("key-gate")) return;
  const d = document.createElement("div");
  d.id = "key-gate";
  d.innerHTML = `
    <div class="kg-card">
      <div class="kg-title"><span class="kg-dot"></span> Pulse — API key required</div>
      <p class="kg-sub">This panel is private. Enter the panel API key
        (<span class="mono">PULSE_API_KEY</span>) to open it.</p>
      <form id="kg-form">
        <input id="kg-input" type="password" autocomplete="off"
               placeholder="API key" spellcheck="false">
        <button type="submit">Unlock</button>
      </form>
      <div class="kg-hint">Stored only in this browser (localStorage) and
        sent as an <span class="mono">Authorization</span> header on every request.</div>
    </div>`;
  document.body.appendChild(d);
  const inp = d.querySelector("#kg-input");
  inp.focus();
  d.querySelector("#kg-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!inp.value.trim()) return;
    setApiKey(inp.value);
    d.remove();
    tick();
  });
  inp.addEventListener("keydown", (e) => { if (e.key === "Escape") d.remove(); });
}

/* ---------------- api ---------------- */

async function api(path, opts) {
  const headers = Object.assign({}, (opts && opts.headers) || {});
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
  const r = await fetch(path, { credentials: "same-origin", ...opts, headers });
  if (r.status === 401) { showKeyPrompt(); throw new Error("unauthorized"); }
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
const getState = () => api("/api/state");
const getSeries = (node, points = 2000, window = CHART_WINDOW_S) =>
  api(`/api/series?node=${encodeURIComponent(node)}&points=${points}&window=${window}`);
const sendAction = (node, pid, sig) =>
  api("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node, pid, sig }),
  });
const sendDockerAction = (node, act) =>
  api("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node, docker: act }),
  });
const sendLlamaAction = (node, act) =>
  api("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node, llama: act }),
  });
const sendStrataAction = (node, act) =>
  api("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node, strata: act }),
  });
const sendGpuAction = (node, act) =>
  api("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node, gpu: act }),
  });
const getDDNS = () => api("/api/ddns");
const saveDDNS = (cfg) =>
  api("/api/ddns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  });
const applyDDNS = () => api("/api/ddns/apply", { method: "POST" });
const testDDNS = () => api("/api/ddns/test", { method: "POST" });
const getWOL = () => api("/api/wol");
const saveWOL = (devices) =>
  api("/api/wol", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ devices }),
  });
const wakeWOL = (name) =>
  api("/api/wol/wake/" + encodeURIComponent(name), { method: "POST" });

/* metrics computed client-side from a snapshot (mirrors server extract_metrics) */
function metricFromSnap(s) {
  const cpu = (s.cpu && s.cpu.pct) || 0;
  const mem = s.mem || {};
  const load = (s.cpu && s.cpu.load) || {};
  const dio = s.disk_io || {};
  const nio = s.net_io || {};
  const temps = (s.temps || []).map(t => t.c).filter(v => v != null);
  const gpus = s.gpu || [];
  return {
    cpu: +cpu,
    mem: mem.total ? +(mem.used * 100 / mem.total).toFixed(1) : 0,
    swap: mem.swap_total ? +((mem.swap_used || 0) * 100 / mem.swap_total).toFixed(1) : 0,
    load1: load.load1 || 0, load5: load.load5 || 0, load15: load.load15 || 0,
    drio: +Object.values(dio).reduce((a, v) => a + (v.r || 0), 0).toFixed(1),
    driw: +Object.values(dio).reduce((a, v) => a + (v.w || 0), 0).toFixed(1),
    nrx: +Object.values(nio).reduce((a, v) => a + (v.rx || 0), 0).toFixed(1),
    ntx: +Object.values(nio).reduce((a, v) => a + (v.tx || 0), 0).toFixed(1),
    temp: temps.length ? Math.max(...temps) : 0,
    gpu: gpus.length && gpus[0].use != null ? gpus[0].use : 0,
  };
}

/* ---------------- charts (canvas) ---------------- */

function prepCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return null;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawChart(cv, series, opts = {}) {
  const p = prepCanvas(cv);
  if (!p) return;
  const { ctx, w, h } = p;
  const all = series.flatMap(s => s.data).filter(x => Array.isArray(x));
  if (all.length < 2) return;
  const nowS = Date.now() / 1000;
  const tMax = Math.max(nowS, ...all.map(x => x[0]));  // right edge = now
  const tMin = tMax - (opts.window || CHART_WINDOW_S);
  const vals = all.map(x => x[1]);
  let yMin = opts.min, yMax = opts.max;
  if (yMin == null) yMin = Math.min(0, ...vals);
  if (yMax == null) { yMax = Math.max(0.5, ...vals) * 1.15; }
  if (yMax <= yMin) yMax = yMin + 1;

  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = Math.round(h * i / 4) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,255,255,0.30)";
  ctx.font = "9.5px " + getComputedStyle(document.body).fontFamily;
  ctx.textAlign = "right";
  ctx.fillText(opts.yFmt ? opts.yFmt(yMax) : (yMax >= 1000 ? fmtBytes(yMax) : yMax.toFixed(yMax < 10 ? 1 : 0)), w - 3, 10);

  const X = t => ((t - tMin) / (tMax - tMin)) * w;
  const Y = v => (h - 3) - ((v - yMin) / (yMax - yMin)) * (h - 8);

  series.forEach((s, si) => {
    const pts = s.data.filter(x => x[0] >= tMin);
    if (pts.length < 2) return;
    const path = () => {
      ctx.beginPath();
      pts.forEach((x, i) => (i ? ctx.lineTo(X(x[0]), Y(x[1])) : ctx.moveTo(X(x[0]), Y(x[1]))));
    };
    if (si === 0 && s.fill !== false) {
      path();
      ctx.lineTo(X(pts[pts.length - 1][0]), h);
      ctx.lineTo(X(pts[0][0]), h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, withAlpha(s.color, 0.22));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fill();
    }
    path();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    ctx.stroke();
    const lp = pts[pts.length - 1];
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(X(lp[0]), Y(lp[1]), 2.3, 0, 7);
    ctx.fill();
  });
}

function drawSpark(cv, data, color) {
  const p = prepCanvas(cv);
  if (!p) return;
  const { ctx, w, h } = p;
  if (!data || data.length < 2) return;
  let mn = Math.min(...data), mx = Math.max(...data);
  if (mx - mn < 0.001) { mx += 1; mn -= 0.5; }
  const X = i => (i / (data.length - 1)) * w;
  const Y = v => (h - 2) - ((v - mn) / (mx - mn)) * (h - 5);
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(0), Y(v))));
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, withAlpha(color, 0.30));
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(0), Y(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.stroke();
}

/* ---------------- toasts + modal ---------------- */

function toast(msg, ok = true, ttl = 4200) {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = "toast" + (ok ? "" : " err");
  el.innerHTML = `<span class="t-ico">${ok ? "✓" : "✕"}</span><span>${esc(msg)}</span>`;
  root.appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 350); }, ttl);
}

function openModal(html) {
  const root = $("#modal-root");
  root.innerHTML =
    `<div class="modal-overlay"><div class="modal">${html}</div></div>`;
  const ov = $(".modal-overlay", root);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeModal(); });
  document.addEventListener("keydown", escClose);
}
function closeModal() {
  $("#modal-root").innerHTML = "";
  document.removeEventListener("keydown", escClose);
}
function escClose(e) { if (e.key === "Escape") closeModal(); }

function confirmKill(node, proc) {
  openModal(`
    <h3>Kill process?</h3>
    <p><b class="mono">${esc(proc.name)}</b> — pid <span class="mono">${proc.pid}</span>, user <span class="mono">${esc(proc.user)}</span></p>
    <div class="mono-line">${esc(proc.cmd)}</div>
    <p style="color:var(--faint);font-size:11.5px">Only processes owned by the agent user can be killed. SIGTERM is graceful; SIGKILL is immediate.</p>
    <div class="m-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-danger" data-act="15">SIGTERM</button>
      <button class="btn btn-kilo" data-act="9">SIGKILL</button>
    </div>`);
  $$(".m-actions .btn").forEach(b =>
    b.addEventListener("click", async () => {
      const act = b.dataset.act;
      if (act === "cancel") return closeModal();
      b.disabled = true;
      try {
        const r = await sendAction(node, proc.pid, +act);
        closeModal();
        toast(r.ok ? `${proc.name} (pid ${proc.pid}) → signal ${act} sent` : (r.error || "action failed"), !!r.ok);
      } catch (e) {
        closeModal();
        toast("action failed: " + e.message, false);
      }
    }));
}

/* ---------------- topbar ---------------- */

function renderPills() {
  // Patch pills in place — never rebuild the DOM on every 2s tick,
  // so hover/focus/scroll state stays stable and only real changes paint.
  const nav = $("#node-pills");
  const names = Object.keys(state.nodes).sort();
  const byName = new Map();
  for (const el of [...nav.children]) if (el.dataset && el.dataset.name) byName.set(el.dataset.name, el);
  names.forEach(n => {
    const nd = state.nodes[n];
    const s = nd.latest;
    const cpu = s && s.cpu ? s.cpu.pct : null;
    const isActive = state.view && state.view.type === "node" && state.view.name === n;
    const dotCls = "pdot " + (nd.online ? "on" : "off");
    const stat = cpu != null ? cpu + "%" : "—";
    let el = byName.get(n);
    if (!el) {
      el = document.createElement("a");
      el.className = "pill";
      el.dataset.name = n;
      el.href = "#/node/" + encodeURIComponent(n);
      el.innerHTML = `<span class="${dotCls}"></span>${icon("server", 13)}${esc(n)}<span class="pstat"><b class="pstat-v">${stat}</b> cpu</span>`;
      nav.appendChild(el);
    } else {
      const dot = el.firstElementChild;
      if (dot && dot.className !== dotCls) dot.className = dotCls;
      if (el.classList.contains("active") !== !!isActive) el.classList.toggle("active", !!isActive);
      const pv = $(".pstat-v", el);
      if (pv && pv.textContent !== stat) pv.textContent = stat;
    }
  });
  for (const [n, el] of byName) if (!state.nodes[n]) el.remove();
  const named = [...nav.children].filter(el => el.dataset && el.dataset.name);
  if (named.length !== names.length || named.some((el, i) => el.dataset.name !== names[i]))
    names.forEach(n => nav.appendChild(byName.get(n)));  // rare: reorder only when it changed
  const mainPill = $("#pill-main");
  if (mainPill)
    mainPill.classList.toggle("active", !!(state.view && state.view.type === "main"));
  const installPill = $("#pill-install");
  if (installPill)
    installPill.classList.toggle("active", !!(state.view && state.view.type === "install"));
}

/* ---------------- mobile burger menu ---------------- */
// On phones the pill row + right-side controls don't fit in the header, so it
// collapses to logo + burger and those controls slide into a drawer. The DOM
// nodes are relocated (not duplicated) between header and drawer, so
// renderPills() and the clock keep patching them in place wherever they live.
const mqMobile = window.matchMedia("(max-width: 768px)");
let menuOpen = false;

function setMenu(open) {
  menuOpen = open;
  document.body.classList.toggle("menu-open", open);
  const burger = $("#burger");
  if (burger) {
    burger.setAttribute("aria-expanded", String(open));
    burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }
  const menu = $("#m-menu");
  if (menu) menu.setAttribute("aria-hidden", String(!open));
}

function syncMenuLayout() {
  const nav = $("#node-pills");
  const extra = $(".top-right");
  if (!nav || !extra) return;
  if (mqMobile.matches) {
    $("#mm-nav").appendChild(nav);
    $("#mm-extra").appendChild(extra);
  } else {
    setMenu(false);
    $("#tb-nav").appendChild(nav);
    $("#tb-extra").appendChild(extra);
  }
}

(function initBurgerMenu() {
  syncMenuLayout();
  $("#burger").addEventListener("click", () => setMenu(!menuOpen));
  $("#m-backdrop").addEventListener("click", () => setMenu(false));
  $("#mm-close").addEventListener("click", () => setMenu(false));
  $("#m-menu").addEventListener("click", (e) => {
    if (e.target.closest("a")) setMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuOpen) setMenu(false);
  });
  const onBreakpoint = () => syncMenuLayout();
  if (mqMobile.addEventListener) mqMobile.addEventListener("change", onBreakpoint);
  else mqMobile.addListener(onBreakpoint);  // old Safari
})();

setInterval(() => {
  const c = $("#clock");
  if (c) c.textContent = new Date().toLocaleTimeString([], { hour12: false });
}, 1000);

/* ---------------- overview view ---------------- */

function openOverview() {
  state.view = { type: "overview" };
  const v = $("#view");
  v.innerHTML = `
    <div class="page-title"><h1>Overview</h1><span class="sub" id="ov-sub"></span></div>
    <div class="summary" id="ov-summary"></div>
    <div class="cards" id="ov-cards"></div>`;
  buildOverviewCards();
  // fetch history for sparklines
  Object.keys(state.nodes).forEach(n => loadSeries(n));
}

function buildOverviewCards() {
  const wrap = $("#ov-cards");
  wrap.innerHTML = Object.keys(state.nodes).sort().map(n => {
    const nd = state.nodes[n];
    const s = nd.latest;
    if (!s) {
      return `<div class="off-banner">${icon("alert", 16)}<span><b>${esc(n)}</b> — waiting for first snapshot from agent…</span></div>`;
    }
    const h = s.host || {};
    const gpus = s.gpu || [];
    const root = (s.mounts || []).find(m => m.mount === "/") || (s.mounts || [])[0];
    return `<div class="card ${nd.online ? "" : "offline"}" id="card-${esc(n)}">
      <div class="card-head">
        <span class="status-dot ${nd.online ? "on" : "off"}"></span>
        <div>
          <div class="card-name">${esc(n)}</div>
          <div class="card-meta">${esc(h.ip || "")} · ${esc(h.os || "")}</div>
        </div>
        <span class="spacer"></span>
        <span class="uptime-chip" id="ov-up-${esc(n)}">up ${fmtDur(h.uptime)}</span>
        <span id="ov-dk-${esc(n)}"></span>
      </div>
      <div class="card-grid">
        <div class="meter-block">
          <div class="mb-head"><span class="mb-lbl">${icon("cpu", 13)}CPU</span><span class="mb-val" id="ov-cpu-${esc(n)}">—</span></div>
          <canvas class="spark" id="ov-cpuspark-${esc(n)}"></canvas>
          <div class="corebars" id="ov-cores-${esc(n)}"></div>
        </div>
        <div class="meter-block">
          <div class="mb-head"><span class="mb-lbl">${icon("memory", 13)}Memory</span><span class="mb-val" id="ov-mem-${esc(n)}">—</span></div>
          <div class="bar"><i id="ov-membar-${esc(n)}" style="width:0%"></i></div>
          <div class="t-sub" id="ov-memsub-${esc(n)}"></div>
        </div>
        <div class="meter-block">
          <div class="mb-head"><span class="mb-lbl">${icon("disk", 13)}Disk ${root ? esc(root.mount) : ""}</span><span class="mb-val" id="ov-disk-${esc(n)}">—</span></div>
          <div class="bar"><i id="ov-diskbar-${esc(n)}" style="width:0%"></i></div>
          <div class="t-sub" id="ov-disksub-${esc(n)}"></div>
        </div>
        <div class="meter-block">
          <div class="mb-head"><span class="mb-lbl">${icon("network", 13)}Network</span><span class="mb-val" id="ov-net-${esc(n)}">—</span></div>
          <canvas class="spark" id="ov-netspark-${esc(n)}"></canvas>
          <div class="t-sub" id="ov-netsub-${esc(n)}"></div>
        </div>
      </div>
      ${gpus.length ? `<div class="temp-chips" id="ov-gpu-${esc(n)}" style="margin-top:12px"></div>` : ""}
      <div class="mini-procs" id="ov-top-${esc(n)}"></div>
      <div class="card-foot">
        <span class="foot-stat" id="ov-load-${esc(n)}"></span>
        <span class="open">Open node →</span>
      </div>
    </div>`;
  }).join("");
  $$("#ov-cards .card").forEach(el =>
    el.addEventListener("click", () => {
      location.hash = "#/node/" + encodeURIComponent(el.id.replace("card-", ""));
    }));
  updateOverviewCards();
}

function barClass(v) { return v >= 90 ? "bad" : v >= 70 ? "warn" : ""; }

function updateOverviewCards() {
  const wrap = $("#ov-cards");
  if (!wrap) return;
  // summary strip
  const names = Object.keys(state.nodes).sort();
  let totMem = 0, totMemUsed = 0, online = 0, cpus = [];
  let maxDisk = 0, maxDiskName = "";
  let dkUp = 0, dkTot = 0;
  names.forEach(n => {
    const nd = state.nodes[n];
    if (!nd.online || !nd.latest) return;
    online++;
    const s = nd.latest, h = s.host || {};
    totMem += h.mem_total || 0;
    totMemUsed += (s.mem || {}).used || 0;
    if ((s.cpu || {}).pct != null) cpus.push(s.cpu.pct);
    (s.mounts || []).forEach(m => {
      if (m.mount === "/" && m.pct > maxDisk) { maxDisk = m.pct; maxDiskName = n; }
    });
    const dk = s.docker || {};
    if (dk.installed && dk.daemon === "running") {
      dkTot += (dk.containers || []).length;
      dkUp += (dk.containers || []).filter(c => c.state === "running").length;
    }
  });
  const avgCpu = cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : 0;
  $("#ov-summary").innerHTML = `
    <div class="sum-cell"><div class="lbl">Nodes</div><div class="val">${online}<small> / ${names.length} online</small></div></div>
    <div class="sum-cell"><div class="lbl">CPU (avg)</div><div class="val">${fmtPct(avgCpu)}</div></div>
    <div class="sum-cell"><div class="lbl">Memory pool</div><div class="val">${fmtBytes(totMemUsed, 0)}<small> / ${fmtBytes(totMem, 0)}</small></div></div>
    <div class="sum-cell"><div class="lbl">Hottest disk</div><div class="val">${maxDisk ? maxDisk + "<small>% on " + esc(maxDiskName) + "</small>" : "—"}</div></div>
    <div class="sum-cell"><div class="lbl">Docker</div><div class="val">${dkTot ? dkUp + "<small> / " + dkTot + " up</small>" : "—"}</div></div>
    <div class="sum-cell"><div class="lbl">Agent interval</div><div class="val">2s</div></div>`;

  names.forEach(n => {
    const nd = state.nodes[n];
    const s = nd.latest;
    const el = document.getElementById("card-" + n);
    if (!s || !el) return;
    const h = s.host || {}, m = s.mem || {}, cpu = s.cpu || {};
    const gpus = s.gpu || [];

    $("#ov-up-" + n).textContent = "up " + fmtDur(h.uptime);
    const dkov = s.docker || {};
    const dke = document.getElementById("ov-dk-" + n);
    if (dke) {
      if (!dkov.installed) dke.innerHTML = "";
      else if (dkov.daemon !== "running") dke.innerHTML = `<span class="dchip off">⚓ down</span>`;
      else {
        const dcs = dkov.containers || [];
        dke.innerHTML = `<span class="dchip on">⚓ ${dcs.filter(c => c.state === "running").length}/${dcs.length}</span>`;
      }
    }
    $("#ov-cpu-" + n).innerHTML = fmtPct(cpu.pct) + ` <small>${(cpu.load || {}).load1 ?? "—"} load</small>`;
    const cores = (cpu.per_core || []).map(v =>
      `<i style="height:${Math.max(6, v)}%" class="${v >= 90 ? "hot" : ""}" title="core: ${v}%"></i>`).join("");
    $("#ov-cores-" + n).innerHTML = cores;
    const buf = liveBuf[n];
    if (buf) {
      drawSpark($("#ov-cpuspark-" + n), buf.cpu.slice(-60).map(x => x[1]), COLORS.cpu);
      drawSpark($("#ov-netspark-" + n), buf.nrx.slice(-60).map(x => x[1]), COLORS.nrx);
    }
    const memPct = m.total ? m.used * 100 / m.total : 0;
    $("#ov-mem-" + n).innerHTML = fmtPct(memPct);
    const mb = $("#ov-membar-" + n);
    mb.style.width = Math.min(100, Math.max(0, memPct)) + "%";
    mb.className = barClass(memPct);
    $("#ov-memsub-" + n).textContent = `${fmtBytes(m.used, 0)} / ${fmtBytes(m.total, 0)} · ${fmtBytes(m.available, 0)} avail`;

    const root = (s.mounts || []).find(x => x.mount === "/") || (s.mounts || [])[0];
    if (root) {
      $("#ov-disk-" + n).innerHTML = root.pct + "%";
      const db = $("#ov-diskbar-" + n);
      db.style.width = Math.min(100, Math.max(0, root.pct)) + "%";
      db.className = barClass(root.pct);
      const dio = Object.values(s.disk_io || {}).reduce((a, v) => a + (v.r || 0), 0);
      const diw = Object.values(s.disk_io || {}).reduce((a, v) => a + (v.w || 0), 0);
      $("#ov-disksub-" + n).textContent =
        `${fmtBytes(root.used, 0)} / ${fmtBytes(root.total, 0)} · R ${fmtPS(dio)} · W ${fmtPS(diw)}`;
    }
    const nrx = Object.values(s.net_io || {}).reduce((a, v) => a + (v.rx || 0), 0);
    const ntx = Object.values(s.net_io || {}).reduce((a, v) => a + (v.tx || 0), 0);
    $("#ov-net-" + n).innerHTML = `↓ ${fmtPS(nrx)} <small>↑ ${fmtPS(ntx)}</small>`;
    const nio = Object.values(s.net_io || {});
    $("#ov-netsub-" + n).textContent = nio.length
      ? "Σ " + nio.map(v => fmtBytes(v.rx_total, 0) + " in / " + fmtBytes(v.tx_total, 0) + " out").join(" · ")
      : "";

    if (gpus.length) {
      $("#ov-gpu-" + n).innerHTML = gpus.map(g =>
        `<span class="temp-chip"><span class="t-ico">▣</span>${esc(g.name || "GPU")}
         <span class="t-val">${g.use != null ? Math.round(g.use) + "%" : "—"}</span>
         ${g.temp != null ? `<span class="t-val">${Math.round(g.temp)}°C</span>` : ""}</span>`).join("");
    }
    const top = (s.procs || []).slice().sort((a, b) => b.cpu - a.cpu).slice(0, 3);
    $("#ov-top-" + n).innerHTML = top.map(p =>
      `<div class="mini-proc"><span class="mp-cpu">${p.cpu.toFixed(1)}%</span><span class="mp-name">${esc(p.name)} <span style="color:var(--faint)">${esc(p.cmd.slice(0, 48))}</span></span></div>`).join("");
    const load = cpu.load || {};
    $("#ov-load-" + n).textContent = `load ${load.load1 ?? "—"} ${load.load5 ?? ""} ${load.load15 ?? ""}`;
  });
}

/* ---------------- main view (extensible sections) ----------------
   Top-level page at #/main: a hub of sections. To add one, append an
   object to MAIN_SECTIONS — openMain() renders its shell and
   updateMain() calls its update on every poll, so the new section comes
   alive automatically. */

const MAIN_SECTIONS = [
  { id: "servers", label: "Servers", icon: "server", build: buildMainServers, update: updateMainServers },
  { id: "cloudflare", label: "Cloudflare DDNS", icon: "cloud", build: buildMainCloudflare, update: updateMainCloudflare },
  { id: "wol", label: "Wake-on-LAN", icon: "zap", build: buildMainWOL, update: updateMainWOL },
];

function openMain() {
  state.view = { type: "main" };
  const v = $("#view");
  v.innerHTML = `
    <div class="main-hero">
      <div class="mh-left">
        <h1 class="mh-title">Main</h1>
        <p class="mh-sub">Fleet overview &amp; services</p>
      </div>
      <div class="mh-stats" id="mh-stats"></div>
    </div>
    ${MAIN_SECTIONS.map(sec => `
      <section class="main-sec">
        <div class="section-head">
          <span class="ic-tile">${icon(sec.icon, 14)}</span>
          <h2>${esc(sec.label)}</h2>
          <span class="sec-hint" id="mn-hint-${sec.id}"></span>
          <div class="line"></div>
        </div>
        <div id="main-body-${sec.id}"></div>
      </section>`).join("")}`;
  MAIN_SECTIONS.forEach(sec => sec.build());
  updateMainHero();
}

function updateMain() {
  MAIN_SECTIONS.forEach(sec => sec.update());
  updateMainHero();
}

/* ---------------- install view (static docs, no live data) ---------------- */

function installOneLiner() {
  // The server tells us its LAN base URL + ingest token via /api/state.
  // Node data flows over the LAN only, so even a dashboard opened through
  // the public domain renders one-liners pointing at the LAN URL.
  const inst = state.install || {};
  const base = String(inst.url || location.origin).replace(/\/+$/, "");
  const token = inst.token || "";
  return {
    base,
    token,
    server: "curl -fsSL " + base + "/install.sh | bash -s -- server",
    client: "curl -fsSL " + base + "/install.sh | bash -s -- client " + base +
      (token ? " " + token : ""),
  };
}

async function copyCmd(btn) {
  const text = btn.dataset.copy || "";
  let ok = true;
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch (e2) { ok = false; }
  }
  if (ok) {
    btn.classList.add("ok"); btn.textContent = "copied";
    toast("Command copied", true, 1800);
    setTimeout(() => { btn.classList.remove("ok"); btn.textContent = "copy"; }, 1600);
  } else {
    toast("Copy failed — select the text manually", false);
  }
}

function openInstall() {
  state.view = { type: "install" };
  const one = installOneLiner();
  const serverCmd = one.server;
  const clientCmd = one.client;
  const v = $("#view");
  v.innerHTML = `
    <div class="main-hero">
      <div class="mh-left">
        <h1 class="mh-title">Install</h1>
        <p class="mh-sub">One line, from zero — agent or full server</p>
      </div>
    </div>
    <section class="main-sec">
      <div class="section-head">
        <span class="ic-tile">${icon("server", 14)}</span>
        <h2>Central server</h2>
        <span class="sec-hint">server + local agent on the same box</span>
        <div class="line"></div>
      </div>
      <div class="cmd-card"><code>${esc(serverCmd)}</code>
        <button type="button" class="cmd-copy" data-copy="${esc(serverCmd)}">copy</button>
      </div>
      <p class="inst-p">Installs the central server <span class="mono">pulse-server</span> <em>and</em> a local agent on the same machine. The agent token and the dashboard API key are generated automatically — the key is printed <b>once</b>, at the end of the install. Afterwards, add any number of other machines with the client one-liner below.</p>
    </section>
    <section class="main-sec">
      <div class="section-head">
        <span class="ic-tile">${icon("activity", 14)}</span>
        <h2>Agent (client)</h2>
        <span class="sec-hint">agent only, reports to the server</span>
        <div class="line"></div>
      </div>
      <div class="cmd-card"><code>${esc(clientCmd)}</code>
        <button type="button" class="cmd-copy" data-copy="${esc(clientCmd)}">copy</button>
      </div>
      <p class="inst-p">Agent-only install for another machine <b>on the same LAN</b>: it reports to the central server every 2 seconds and exposes the action API (process kill, Docker, llama.cpp). The command above already contains the server URL and the ingest <span class="mono">TOKEN</span> — node data only ever flows over the LAN, never through the public endpoint. Arguments: <span class="mono">client [SERVER_URL] [TOKEN]</span>.</p>
    </section>
    <section class="main-sec">
      <div class="section-head">
        <span class="ic-tile">${icon("list", 14)}</span>
        <h2>What the installer does</h2>
        <div class="line"></div>
      </div>
      <ol class="inst-steps">
        <li>Checks prerequisites: <span class="mono">python3</span> (installed via the distro package manager if missing), <span class="mono">curl</span> or <span class="mono">wget</span>, and a systemd user session. Run it as a regular user — sudo is only needed when a package has to be installed.</li>
        <li>Downloads the current code straight from the server (<span class="mono">client</span>: agent; <span class="mono">server</span>: server, agent and dashboard files).</li>
        <li>Writes <span class="mono">~/pulse/</span> with the code and configs (mode 600). Server mode generates a token + API key when nothing exists; client mode uses the token from the command (or one already on the box) and never invents one. Re-running is idempotent.</li>
        <li>Installs the systemd user units <span class="mono">pulse-agent</span> (plus <span class="mono">pulse-server</span> in server mode), enables and starts them.</li>
        <li>Prints the service status. In server mode it also prints the dashboard URL and the API key — last chance, it is not shown again.</li>
      </ol>
    </section>
    <section class="main-sec">
      <div class="section-head">
        <span class="ic-tile">${icon("grid", 14)}</span>
        <h2>Arguments &amp; flags</h2>
        <div class="line"></div>
      </div>
      <table class="inst-tbl">
        <tr><th>arg</th><th>meaning</th></tr>
        <tr><td><span class="mono">server</span></td><td>central server + local agent on this box (required first argument)</td></tr>
        <tr><td><span class="mono">client</span></td><td>agent only on this box (required first argument)</td></tr>
        <tr><td><span class="mono">SERVER_URL</span></td><td>client mode — where the agent reports; default: this server's LAN URL</td></tr>
        <tr><td><span class="mono">TOKEN</span></td><td>client mode — the shared ingest token, shown in the command above; never generated on the client</td></tr>
        <tr><td><span class="mono">PORT</span></td><td>server mode — server port; default 8090</td></tr>
        <tr><td><span class="mono">--dry-run</span></td><td>download everything and show what would be done, change nothing</td></tr>
      </table>
    </section>
    <section class="main-sec">
      <div class="section-head">
        <span class="ic-tile">${icon("zap", 14)}</span>
        <h2>After install</h2>
        <div class="line"></div>
      </div>
      <p class="inst-p">Dashboard: <span class="mono">${esc(location.origin)}/</span> (key-gated — enter the API key printed at the end of the install). To keep the services running after you log out of the machine:</p>
      <div class="cmd-card"><code>sudo loginctl enable-linger $USER</code>
        <button type="button" class="cmd-copy" data-copy="sudo loginctl enable-linger $USER">copy</button>
      </div>
      <p class="inst-p">Source code and full docs: <a href="https://github.com/DecoderCoder/pulse" target="_blank" rel="noopener">github.com/DecoderCoder/pulse</a>. For fleet-style deploys, <span class="mono">deploy.sh</span> in the repo still works as before.</p>
    </section>`;
  v.querySelectorAll(".cmd-copy").forEach(b => b.addEventListener("click", () => copyCmd(b)));
}

/* live summary chips in the hero (fleet + DDNS health) */
function updateMainHero() {
  const box = $("#mh-stats");
  if (!box) return;
  const nodes = Object.values(state.nodes);
  const online = nodes.filter(n => n.online).length;
  const d = state.ddns || null;
  const w = state.wol || null;
  let dot = "", val, lbl;
  if (!d || !d.enabled) {
    val = "ddns off"; lbl = "not configured";
  } else if (d.lastError) {
    dot = "err"; val = "ddns error"; lbl = "last error " + ago(d.lastErrorTs);
  } else {
    if (d.lastUpdate && Date.now() / 1000 - d.lastUpdate < 600) dot = "on";
    val = "ddns active";
    lbl = d.lastUpdate ? "pushed " + ago(d.lastUpdate) : "waiting for first push";
  }
  box.innerHTML = `
    <div class="mh-stat">
      <span class="mh-stat-ico">${icon("server", 16)}</span>
      <div><b>${online} / ${nodes.length}</b><span class="mh-lbl">servers online</span></div>
    </div>
    <div class="mh-stat">
      <span class="mh-stat-ico purple">${icon("cloud", 16)}</span>
      <div><b class="${dot === "err" ? "err" : ""}">${val}</b><span class="mh-lbl">${lbl}</span></div>
      <span class="mh-dot ${dot}"></span>
    </div>
    <div class="mh-stat">
      <span class="mh-stat-ico">${icon("zap", 16)}</span>
      <div><b>${w ? w.devices + " device" + (w.devices === 1 ? "" : "s") : "wol off"}</b><span class="mh-lbl">${w && w.lastWake ? "last wake " + ago(w.lastWake) : "wake-on-lan"}</span></div>
      <span class="mh-dot ${w && w.lastError ? "err" : w && w.lastWake && Date.now() / 1000 - w.lastWake < 120 ? "on" : ""}"></span>
    </div>`;
  const hs = $("#mn-hint-servers");
  if (hs) hs.textContent = nodes.length ? nodes.length + " reporting" : "";
  const hc = $("#mn-hint-cloudflare");
  if (hc) hc.textContent = (d && d.enabled && d.zone) ? d.zone : "not configured";
  const hw = $("#mn-hint-wol");
  if (hw) hw.textContent = w && w.devices ? w.devices + " device" + (w.devices === 1 ? "" : "s") : "no devices";
}

/* -- section: servers (live fleet cards) -- */

function buildMainServers() {
  const el = $("#main-body-servers");
  if (!el) return;
  const names = Object.keys(state.nodes).sort();
  if (!names.length) {
    el.innerHTML = `<div class="dk-none">${icon("server", 15)}No servers reporting yet.</div>`;
    return;
  }
  el.innerHTML = `<div class="mn-grid">` + names.map(n => `
    <a class="mn-card" id="mncard-${esc(n)}" href="#/node/${encodeURIComponent(n)}">
      <div class="mn-top">
        <span class="dst off"></span>
        <span class="mn-name">${esc(n)}</span>
        <span class="mn-os">—</span>
      </div>
      <div class="mn-meta mono"><span class="mn-ip">—</span><span class="mn-up"></span></div>
      <div class="mn-meter">
        <div class="mn-meter-head"><span>CPU</span><b class="mn-cpu mono">—</b></div>
        <div class="bar"><i class="mn-cpu-bar" style="width:0%"></i></div>
      </div>
      <div class="mn-meter">
        <div class="mn-meter-head"><span>Memory</span><b class="mn-mem mono">—</b></div>
        <div class="bar"><i class="mem mn-mem-bar" style="width:0%"></i></div>
        <div class="mn-meter-sub mono mn-mem-sub"></div>
      </div>
      <div class="mn-foot">
        <span class="mn-av mono">—</span>
        <span class="mn-seen">—</span>
        <span class="mn-open">open →</span>
      </div>
    </a>`).join("") + `</div>`;
  updateMainServers();
}

function updateMainServers() {
  const el = $("#main-body-servers");
  if (!el) return;
  const names = Object.keys(state.nodes).sort();
  const cards = $$("#main-body-servers .mn-card").map(c => c.id.replace("mncard-", ""));
  if (cards.length !== names.length || cards.some((n, i) => n !== names[i]))
    return buildMainServers();  // node set changed
  names.forEach(n => {
    const nd = state.nodes[n];
    const s = nd.latest;
    const card = $("#mncard-" + n);
    if (!card) return;
    $(".dst", card).className = "dst " + (nd.online ? "on" : "off");
    const set = (sel, v) => { const e = $(sel, card); if (e) e.textContent = v; };
    if (!s) {
      set(".mn-os", "offline");
      set(".mn-ip", "—");
      set(".mn-up", "");
      set(".mn-cpu", "—");
      set(".mn-mem", "—");
      set(".mn-mem-sub", "");
      const cb = $(".mn-cpu-bar", card);
      cb.className = "mn-cpu-bar"; cb.style.width = "0%";
      const mb = $(".mn-mem-bar", card);
      mb.className = "mem mn-mem-bar"; mb.style.width = "0%";
    } else {
      const h = s.host || {}, m = s.mem || {}, cpu = s.cpu || {};
      const memPct = m.total ? m.used * 100 / m.total : 0;
      set(".mn-os", h.os || "—");
      set(".mn-ip", h.ip || "—");
      set(".mn-up", "   ·   up " + fmtDur(h.uptime));
      set(".mn-cpu", fmtPct(cpu.pct));
      set(".mn-mem", fmtPct(memPct));
      set(".mn-mem-sub", fmtBytes(m.used, 0) + " / " + fmtBytes(m.total, 0) + " used");
      const cb = $(".mn-cpu-bar", card);
      cb.className = "mn-cpu-bar " + barClass(cpu.pct);
      cb.style.width = Math.min(100, cpu.pct || 0) + "%";
      const mb = $(".mn-mem-bar", card);
      mb.className = "mem mn-mem-bar " + barClass(memPct);
      mb.style.width = Math.min(100, memPct) + "%";
    }
    set(".mn-av", "agent " + (nd.agent_version || "—"));
    set(".mn-seen", "seen " + ago(nd.last_seen));
  });
}

/* -- section: Cloudflare DDNS (server-side engine in pulse_server.py;
   config + live status via /api/ddns + /api/state) -- */

const ddnsUi = { cfg: null, busy: false };

function buildMainCloudflare() {
  const el = $("#main-body-cloudflare");
  if (!el) return;
  el.innerHTML = `<div class="dk-none">${icon("cloud", 15)}loading Cloudflare config…</div>`;
  getDDNS().then(d => {
    if (!state.view || state.view.type !== "main") return;
    ddnsUi.cfg = d.enabled ? d.config : null;
    paintCloudflare();
  }).catch(e => {
    if (!state.view || state.view.type !== "main") return;
    el.innerHTML = `<div class="dk-banner bad">${icon("alert", 14)}${esc(e.message)}</div>`;
  });
}

function paintCloudflare() {
  const el = $("#main-body-cloudflare");
  if (!el) return;
  const c = ddnsUi.cfg;
  if (!c) {
    el.innerHTML = `
      <div class="cf-setup-hero">
        <div class="cf-setup-ico">${icon("cloud", 26)}</div>
        <div>
          <h3>Set up Cloudflare DDNS</h3>
          <p>Keep your Cloudflare records in sync from this panel: zone + API token,
             the record names to track, then <b>Save</b>. The server pushes the current
             public IP automatically — on every change and on a 5-minute self-refresh
             (router <span class="mono">/nic/update</span> pushes count too).</p>
        </div>
      </div>
      <div class="cf-2col">
        ${cfRecordsCardHtml({})}
        ${cfSettingsCardHtml(null)}
      </div>`;
    wireCfForm();
    return;
  }
  el.innerHTML = `
    <div id="mn-cf-status">${cfStatusHtml(state.ddns)}</div>
    <div class="cf-2col">
      ${cfRecordsCardHtml(c)}
      ${cfSettingsCardHtml(c)}
    </div>`;
  wireCfForm();
}

function updateMainCloudflare() {
  const box = $("#mn-cf-status");
  if (box && state.ddns) box.innerHTML = cfStatusHtml(state.ddns);
}

/* live status bar: big pushed IP + source + key facts */
function cfStatusHtml(st) {
  st = st || {};
  const ips = st.lastIps || {};
  const main = ips.v4 || ips.v6;
  const fresh = st.lastUpdate && Date.now() / 1000 - st.lastUpdate < 600;
  const srcLbl = st.lastIpSource === "router" ? "router push"
    : st.lastIpSource === "detected" ? "auto-detected" : "source unknown";
  const srcTxt = ddnsUi.busy ? "syncing…"
    : st.lastUpdate ? `${srcLbl} · pushed ${ago(st.lastUpdate)}`
    : "waiting for first push…";
  const lastReq = st.lastRequest
    ? `${esc(st.lastRequestIp || "—")} · ${ago(st.lastRequest)}`
    : "never";
  return `
    <div class="cf-status">
      <div class="cf-ip">
        <div class="cf-ip-lbl">Pushed to Cloudflare</div>
        <div class="cf-ip-main ${main ? "" : "dim"}">${main ? esc(ips.v4 || ips.v6) : "no IP known yet"}</div>
        ${ips.v6 && ips.v4 ? `<div class="cf-ip-v6 mono">${esc(ips.v6)}</div>` : ""}
        <div class="cf-ip-src">
          ${ddnsUi.busy ? `<span class="cf-spin"></span>`
            : `<span class="cf-src-dot ${st.lastError ? "err" : fresh ? "on" : ""}"></span>`}
          ${srcTxt}
        </div>
      </div>
      <div class="cf-facts">
        <div class="cf-fact"><span class="k">Zone</span><span class="v">${esc(st.zone || "—")}${st.zoneId ? ` <small>${esc(st.zoneId.slice(0, 8))}…</small>` : ""}</span></div>
        <div class="cf-fact"><span class="k">Record types</span><span class="v">
          <span class="fchip ${st.a ? "on" : ""}">A · v4</span>
          <span class="fchip ${st.aaaa ? "on v6" : ""}">AAAA · v6</span>
        </span></div>
        <div class="cf-fact"><span class="k">Last update</span><span class="v">${st.lastUpdate ? ago(st.lastUpdate) : "never"}</span></div>
        <div class="cf-fact"><span class="k">Router push</span><span class="v">${lastReq}</span></div>
        <div class="cf-fact"><span class="k">This run</span><span class="v">${st.updates || 0} updates <small>· ${st.accepted || 0} accepted / ${st.requests || 0} requests</small></span></div>
        <div class="cf-fact"><span class="k">Last error</span><span class="v">${st.lastError ? `<span class="cf-errtxt" title="${ago(st.lastErrorTs)}">${esc(st.lastError)}</span>` : "<small>none</small>"}</span></div>
      </div>
    </div>`;
}

/* editable "DNS records to keep updated" card (re-rendered only on user
   actions, so typing in a name field never loses focus) */
function cfRecordsCardHtml(c) {
  c = c || {};
  const rows = (c.records || []).map(r => cfRecRow(r.name, r.proxied)).join("");
  return `
    <div class="cf-card">
      <div class="cf-card-h">${icon("list", 13)}DNS records<span class="cf-count">${(c.records || []).length}</span>
        <button class="btn" id="cf-rec-add" type="button">+ add record</button>
      </div>
      <div id="mn-cf-records">${rows || `<div class="dk-none" style="margin-bottom:8px">no records yet — add the names to keep updated</div>`}</div>
      <p class="cf-note">Every refresh writes <b>A</b>${c.enableAAAA ? " and <b>AAAA</b>" : ""} records for each name at the current
        public IP (TTL ${c.ttl != null ? c.ttl : 30} s). <b>Proxied</b> = orange-cloud, traffic routed through Cloudflare.</p>
    </div>`;
}

function cfRecRow(name, proxied) {
  const c = ddnsUi.cfg || {};
  return `
    <div class="cf-rec">
      <span class="cf-rec-types">
        <i class="cf-t a4 ${c.enableA !== false ? "on" : ""}">A</i>
        <i class="cf-t a6 ${c.enableAAAA ? "on" : ""}">AAAA</i>
      </span>
      <input class="cf-rec-name" type="text" value="${esc(name)}" placeholder="name.yourzone.com" autocomplete="off" spellcheck="false">
      <label class="cf-rec-prox"><input type="checkbox" class="cf-rec-proxied cf-switch" ${proxied ? "checked" : ""}><span>proxied</span></label>
      <button class="cf-rec-del" type="button" title="remove record">✕</button>
    </div>`;
}

function cfSettingsCardHtml(c) {
  c = c || {};
  return `
    <div class="cf-card">
      <div class="cf-card-h">${icon("zap", 13)}Settings</div>
      <div class="cf-fields">
        <label class="cf-field"><span>Zone name</span>
          <input id="cf-zone" type="text" value="${esc(c.zoneName || "")}" placeholder="example.com" autocomplete="off" spellcheck="false"></label>
        <label class="cf-field"><span>API token</span>
          <input id="cf-token" type="password" value="${esc(c.cfApiToken || "")}" placeholder="${c.cfApiTokenSet ? "token stored — leave blank to keep" : "paste Cloudflare API token"}" autocomplete="off"></label>
        <label class="cf-field ttl"><span>TTL (sec)</span>
          <input id="cf-ttl" type="number" min="1" max="86400" step="1" value="${c.ttl != null ? c.ttl : 30}"></label>
      </div>
      <div class="cf-toggles">
        <label class="cf-toggle"><input type="checkbox" id="cf-ena" class="cf-switch" ${c.enableA !== false ? "checked" : ""}>
          <div><div class="tl">Update A records</div><div class="td">IPv4 address</div></div></label>
        <label class="cf-toggle"><input type="checkbox" id="cf-ena4" class="cf-switch" ${c.enableAAAA ? "checked" : ""}>
          <div><div class="tl">Update AAAA records</div><div class="td">IPv6 address</div></div></label>
        <label class="cf-toggle"><input type="checkbox" id="cf-proxied" class="cf-switch" ${c.proxied ? "checked" : ""}>
          <div><div class="tl">Proxied by default</div><div class="td">orange-cloud for new records</div></div></label>
        <label class="cf-toggle"><input type="checkbox" id="cf-del" class="cf-switch" ${c.deleteDisabledRecords ? "checked" : ""}>
          <div><div class="tl">Clean up disabled types</div><div class="td">delete records when a type is turned off</div></div></label>
      </div>
      <div class="cf-actions">
        <span class="cf-hint">blank token keeps the stored one</span>
        <div class="m-actions">
          <button class="btn" id="cf-test" type="button">Test</button>
          <button class="btn" id="cf-apply" type="button">Apply now</button>
          <button class="btn btn-primary" id="cf-save" type="button">Save</button>
        </div>
      </div>
    </div>`;
}

function wireCfForm() {
  const zone = $("#cf-zone");
  if (zone) zone.addEventListener("keydown", e => { if (e.key === "Enter") cfSave(); });
  $("#cf-rec-add")?.addEventListener("click", () => {
    const box = $("#mn-cf-records");
    const empty = $(".dk-none", box);
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.innerHTML = cfRecRow("", ddnsUi.cfg ? !!ddnsUi.cfg.proxied : false);
    const add = row.firstElementChild;
    box.appendChild(add);
    const input = $(".cf-rec-name", add);
    input.focus();
    input.select();
  });
  $$("#mn-cf-records .cf-rec").forEach(row => {
    $(".cf-rec-del", row).addEventListener("click", () => {
      row.remove();
      if (!$("#mn-cf-records .cf-rec").length)
        $("#mn-cf-records").innerHTML = `<div class="dk-none" style="margin-bottom:8px">no records yet — add the names to keep updated</div>`;
    });
  });
  const save = $("#cf-save"), applyB = $("#cf-apply"), test = $("#cf-test");
  if (save) save.addEventListener("click", cfSave);
  if (applyB) applyB.addEventListener("click", cfApplyNow);
  if (test) test.addEventListener("click", cfTest);
}

function cfSetBusy(b) {
  ddnsUi.busy = b;
  ["#cf-save", "#cf-apply", "#cf-test"].forEach(id => {
    const e2 = $(id);
    if (e2) e2.disabled = b;
  });
  const box = $("#mn-cf-status");
  if (box && state.ddns) box.innerHTML = cfStatusHtml(state.ddns);
}

async function cfSave() {
  if (ddnsUi.busy) return;
  const read = id => { const e2 = $(id); return e2 ? e2.value : ""; };
  const checked = id => { const e2 = $(id); return e2 ? e2.checked : false; };
  const records = $$("#mn-cf-records .cf-rec").map(row => ({
    name: $(".cf-rec-name", row).value.trim(),
    proxied: $(".cf-rec-proxied", row).checked,
  })).filter(r => r.name);
  cfSetBusy(true);
  try {
    const d = await saveDDNS({
      zoneName: read("#cf-zone"),
      cfApiToken: read("#cf-token"),
      ttl: parseInt(read("#cf-ttl"), 10) || 1,
      proxied: checked("#cf-proxied"),
      enableA: checked("#cf-ena"),
      enableAAAA: checked("#cf-ena4"),
      deleteDisabledRecords: checked("#cf-del"),
      recordNames: records,
    });
    ddnsUi.cfg = d.enabled ? d.config : null;
    paintCloudflare();
    updateMainHero();
    toast("Cloudflare DDNS saved — re-applying in the background");
  } catch (e) {
    toast("save failed: " + e.message, false, 8000);
  } finally {
    cfSetBusy(false);
  }
}

async function cfApplyNow() {
  if (ddnsUi.busy) return;
  cfSetBusy(true);
  try {
    const d = await applyDDNS();
    toast(d.ok ? "Re-apply started (detect public IP + write records)"
               : (d.error || "apply failed"), !!d.ok);
  } catch (e) {
    toast("apply failed: " + e.message, false, 8000);
  } finally {
    cfSetBusy(false);
  }
}

async function cfTest() {
  if (ddnsUi.busy) return;
  cfSetBusy(true);
  try {
    const d = await testDDNS();
    const rows = (d.records || []).map(r => `
      <tr><td>${r.type}</td><td class="uname">${esc(r.name)}</td><td>${esc(r.content || "—")}</td>
      <td>${r.proxied ? '<span class="dchip on">proxied</span>' : '<span class="dchip off">DNS only</span>'}</td><td>${r.ttl}</td></tr>`).join("")
      || `<tr><td colspan="5" class="faint">no records found for the configured names</td></tr>`;
    openModal(`
      <h3>${icon("cloud", 15)}Cloudflare check</h3>
      <p class="faint">Zone <b>${esc(d.zone || "")}</b> (id <span class="mono faint">${esc(d.zoneId || "")}</span> — token OK.</p>
      <div class="table-wrap" style="max-height:260px"><div class="table-scroll"><table>
        <thead><tr><th>Type</th><th>Name</th><th>Content</th><th>Proxied</th><th>TTL</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>
      <div class="m-actions"><button class="btn" data-act="close">Close</button></div>`);
    $$(".m-actions .btn").forEach(b => b.addEventListener("click", closeModal));
  } catch (e) {
    toast("Cloudflare check failed: " + e.message, false, 8000);
  } finally {
    cfSetBusy(false);
  }
}

/* -- section: Wake-on-LAN (server-side engine in pulse_server.py;
   config + live status via /api/wol + /api/state) -- */

const wolUi = { devices: [], busy: false };
const WOL_MAC_RE = /^([0-9a-f]{2}[:-]?){5}[0-9a-f]{2}$/i;

function buildMainWOL() {
  const el = $("#main-body-wol");
  if (!el) return;
  el.innerHTML = `<div class="dk-none">${icon("zap", 15)}loading devices…</div>`;
  getWOL().then(d => {
    if (!state.view || state.view.type !== "main") return;
    wolUi.devices = (d.enabled && d.config) ? d.config.devices : [];
    paintWOL(d);
  }).catch(e => {
    if (!state.view || state.view.type !== "main") return;
    el.innerHTML = `<div class="dk-banner bad">${icon("alert", 14)}${esc(e.message)}</div>`;
  });
}

function paintWOL(d) {
  const el = $("#main-body-wol");
  if (!el) return;
  d = d || {};
  const devices = wolUi.devices || [];
  const rows = devices.map(wolRow).join("");
  const ifs = (d.status && d.status.interfaces) || [];
  el.innerHTML = `
    ${d.enabled ? "" : `
      <div class="cf-setup-hero">
        <div class="cf-setup-ico">${icon("zap", 26)}</div>
        <div>
          <h3>Add Wake-on-LAN devices</h3>
          <p>Wake agent-less devices on the LAN — printers, a NAS, a spare
             machine. Add a name + MAC address, hit <b>Save</b>, and the
             <b>wake</b> button fires the magic packet from the server to
             the LAN broadcast for you.</p>
        </div>
      </div>`}
    <div id="mn-wol-status">${wolStatusHtml(state.wol)}</div>
    <div class="cf-card">
      <div class="cf-card-h">${icon("list", 13)}Devices<span class="cf-count">${devices.length}</span>
        <button class="btn" id="wol-add" type="button">+ add device</button>
      </div>
      <div id="mn-wol-devices">${rows || `<div class="dk-none" style="margin-bottom:8px">no devices yet — add a name + MAC address</div>`}</div>
      <p class="cf-note">Waking sends the magic packet (6×<span class="mono">0xFF</span> + MAC ×16) over UDP to the LAN
        broadcast (ports 9 + 7)${ifs.length ? " from " + esc(ifs.join(", ")) : ""} — so it works
        for devices without a Pulse agent. An optional <b>IP</b> also sends a copy
        straight to that host (useful for NICs that ignore broadcasts).</p>
    </div>`;
  wireWOLForm();
}

function wolRow(dev) {
  return `
    <div class="wol-row">
      <input class="wol-name" type="text" value="${esc(dev.name)}" placeholder="Printer" autocomplete="off" spellcheck="false">
      <input class="wol-mac" type="text" value="${esc(dev.mac)}" placeholder="aa:bb:cc:dd:ee:ff" autocomplete="off" spellcheck="false">
      <input class="wol-ip" type="text" value="${esc(dev.ip || "")}" placeholder="IP (optional)" autocomplete="off" spellcheck="false">
      <button class="btn btn-primary wol-wake" type="button" title="send the magic packet">${icon("zap", 11)} wake</button>
      <button class="wol-del" type="button" title="remove device">✕</button>
    </div>`;
}

function wireWOLForm() {
  $("#wol-add")?.addEventListener("click", () => {
    const box = $("#mn-wol-devices");
    const empty = $(".dk-none", box);
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.innerHTML = wolRow({ name: "", mac: "", ip: "" });
    const add = row.firstElementChild;
    box.appendChild(add);
    wireWolRow(add);
    $(".wol-name", add).focus();
  });
  $$("#mn-wol-devices .wol-row").forEach(wireWolRow);
}

function wireWolRow(row) {
  $(".wol-del", row)?.addEventListener("click", () => {
    row.remove();
    if (!$("#mn-wol-devices .wol-row").length)
      $("#mn-wol-devices").innerHTML = `<div class="dk-none" style="margin-bottom:8px">no devices yet — add a name + MAC address</div>`;
  });
  $(".wol-wake", row)?.addEventListener("click", e => wolWake(e.currentTarget));
  row.querySelectorAll("input").forEach(inp =>
    inp.addEventListener("keydown", e => { if (e.key === "Enter") wolSave(); }));
}

/* live status bar: last wake + counters + send interfaces */
function wolStatusHtml(st) {
  st = st || {};
  return `
    <div class="cf-status">
      <div class="cf-ip">
        <div class="cf-ip-lbl">Last magic packet</div>
        <div class="cf-ip-main ${st.lastWake ? "" : "dim"}">${st.lastWake ? esc(st.lastWakeDevice) : "never"}</div>
        <div class="cf-ip-src">${st.lastWake ? "sent " + ago(st.lastWake) : "none sent yet — use the wake button on a device"}</div>
      </div>
      <div class="cf-facts">
        <div class="cf-fact"><span class="k">Devices</span><span class="v">${st.devices != null ? st.devices : (wolUi.devices || []).length}</span></div>
        <div class="cf-fact"><span class="k">Total wakes</span><span class="v">${st.wakes || 0}</span></div>
        <div class="cf-fact"><span class="k">Sent from</span><span class="v">${(st.interfaces || []).join(", ") || "—"}</span></div>
        <div class="cf-fact"><span class="k">Last error</span><span class="v">${st.lastError ? `<span class="cf-errtxt" title="${ago(st.lastErrorTs)}">${esc(st.lastError)}</span>` : "<small>none</small>"}</span></div>
      </div>
    </div>`;
}

function updateMainWOL() {
  const box = $("#mn-wol-status");
  if (box && state.wol) box.innerHTML = wolStatusHtml(state.wol);
}

async function wolWake(btn) {
  if (btn.disabled) return;
  const row = btn.closest(".wol-row");
  const name = $(".wol-name", row).value.trim();
  const mac = ($(".wol-mac", row).value || "").trim();
  if (!name) { toast("enter a device name first", false); return; }
  if (!WOL_MAC_RE.test(mac)) { toast("invalid MAC address — expected aa:bb:cc:dd:ee:ff", false, 8000); return; }
  const saved = (wolUi.devices || []).find(d =>
    d.name.toLowerCase() === name.toLowerCase() &&
    (d.mac || "").replace(/[^0-9a-f]/gi, "") === mac.replace(/[^0-9a-f]/gi, ""));
  if (!saved) { toast("save the device list first, then wake", false); return; }
  btn.disabled = true;
  try {
    const d = await wakeWOL(saved.name);
    toast(`magic packet sent for ${d.name} → ${d.sent.length} destination(s)`);
  } catch (e) {
    toast("wake failed: " + e.message, false, 8000);
  } finally {
    btn.disabled = false;
  }
}

async function wolSave() {
  if (wolUi.busy) return;
  const devices = $$("#mn-wol-devices .wol-row").map(row => ({
    name: $(".wol-name", row).value.trim(),
    mac: $(".wol-mac", row).value.trim(),
    ip: $(".wol-ip", row).value.trim(),
  })).filter(r => r.name || r.mac);
  for (const d of devices) {
    if (!d.name) d.name = d.mac;
    if (!WOL_MAC_RE.test(d.mac)) {
      toast(`invalid MAC address: ${d.mac} — expected aa:bb:cc:dd:ee:ff`, false, 8000);
      return;
    }
  }
  wolUi.busy = true;
  const add = $("#wol-add");
  if (add) add.disabled = true;
  try {
    const r = await saveWOL(devices);
    wolUi.devices = (r.enabled && r.config) ? r.config.devices : [];
    paintWOL(r);
    updateMainHero();
    toast(`Wake-on-LAN saved — ${wolUi.devices.length} device(s)`);
  } catch (e) {
    toast("save failed: " + e.message, false, 8000);
  } finally {
    wolUi.busy = false;
    if (add) add.disabled = false;
  }
}

/* ---------------- node view (tabbed) ---------------- */

/* Tabs of the node page. To add a tab, append an object here — the
   shell, the hash router (#/node/<name>/<tab>) and the poll loop pick
   it up automatically; only the active tab is rendered each tick. */
const NODE_TABS = [
  { id: "system", label: "System", icon: "cpu", build: buildSystemTab, update: updateSystemTab },
  { id: "docker", label: "Docker", icon: "box", build: buildDockerTab, update: updateDockerTab },
  { id: "llama", label: "Llama.cpp", icon: "zap", build: buildLlamaTab, update: updateLlamaTab },
  { id: "strata", label: "Strata", icon: "activity", build: buildStrataTab, update: updateStrataTab },
];
const nodeTab = (id) => NODE_TABS.find(t => t.id === id) || NODE_TABS[0];
const nodeTabUrl = (name, tab) =>
  "#/node/" + encodeURIComponent(name) + (tab === NODE_TABS[0].id ? "" : "/" + encodeURIComponent(tab));

function openNode(name, tabId) {
  const tab = nodeTab(tabId);
  state.view = { type: "node", name, tab: tab.id };
  const nd = state.nodes[name];
  const v = $("#view");
  if (!nd || !nd.latest) {
    v.innerHTML = `<div class="empty"><div class="e-big">⌁</div>No data for “${esc(name)}” yet.</div>`;
    return;
  }
  const s = nd.latest, h = s.host || {};
  v.innerHTML = `
    <a class="backlink" href="#/">← All nodes</a>
    <div class="page-title">
      <h1>${esc(name)}</h1>
      <span class="sub" id="nd-sub"></span>
    </div>
    <div class="ntabs" id="node-tabs">
      ${NODE_TABS.map(t =>
        `<button class="ntab" type="button" data-tab="${t.id}">${icon(t.icon, 13)}${esc(t.label)}</button>`).join("")}
    </div>
    <div id="node-tab-body"></div>`;

  $("#nd-sub").textContent =
    `${h.ip || ""} · ${h.os || ""} · kernel ${h.kernel || "?"} · ${h.cpu_model || ""} (${h.n_cpu} cores)`;

  $$("#node-tabs .ntab").forEach(btn =>
    btn.addEventListener("click", () => {
      const t = btn.dataset.tab;
      if (t === state.view.tab) return;
      location.hash = nodeTabUrl(name, t);  // hashchange → route() → openNode
    }));
  renderNodeTabs();

  tm.node = name;
  buildNodeTab(tab.id);
  loadSeries(name, () => {
    if (state.view && state.view.type === "node" && state.view.name === name)
      updateNodeView();
  });
  updateNodeView();
}

function renderNodeTabs() {
  const active = state.view && state.view.type === "node" ? state.view.tab : null;
  $$("#node-tabs .ntab").forEach(b => b.classList.toggle("active", b.dataset.tab === active));
}

/* (Re)build one tab's DOM. Clear that tab's render cache so the next
   update pass paints into the fresh DOM immediately. */
function buildNodeTab(tabId) {
  const name = state.view.name;
  if (tabId === "system") devCache[name] = "";
  if (tabId === "docker") dkCache[name] = "";
  if (tabId === "llama") llCache[name] = "";
  if (tabId === "strata") stCache[name] = "";
  nodeTab(tabId).build();
}

/* System tab: everything except docker — tiles, metrics, task manager, devices. */
function buildSystemTab() {
  $("#node-tab-body").innerHTML = `
    <div class="tiles" id="nd-tiles"></div>
    <div class="section">
      <div class="section-head"><h2>${icon("chart", 14)}Metrics</h2><span class="line"></span><span class="hint">last 15 min · 2s samples</span></div>
      <div class="charts">
        <div class="chart-card"><div class="c-head"><span class="c-title">${icon("cpu", 13)}CPU</span><span class="c-val" id="ch-cpu-v"></span></div><canvas id="ch-cpu"></canvas></div>
        <div class="chart-card"><div class="c-head"><span class="c-title">${icon("memory", 13)}Memory</span><span class="c-val" id="ch-mem-v"></span></div><canvas id="ch-mem"></canvas></div>
        <div class="chart-card"><div class="c-head"><span class="c-title">${icon("activity", 13)}Load average</span><span class="c-val" id="ch-load-v"></span></div><canvas id="ch-load"></canvas></div>
        <div class="chart-card"><div class="c-head"><span class="c-title">${icon("disk", 13)}Disk I/O</span><span class="c-val" id="ch-dio-v"></span></div><canvas id="ch-dio"></canvas></div>
        <div class="chart-card"><div class="c-head"><span class="c-title">${icon("network", 13)}Network I/O</span><span class="c-val" id="ch-net-v"></span></div><canvas id="ch-net"></canvas></div>
        <div class="chart-card"><div class="c-head"><span class="c-title">${icon("temp", 13)}Temperature / GPU</span><span class="c-val" id="ch-temp-v"></span></div><canvas id="ch-temp"></canvas></div>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>${icon("list", 14)}Task Manager</h2><span class="line"></span><span class="hint" id="tm-hint"></span></div>
      <div class="table-wrap">
        <div class="tm-toolbar">
          ${icon("search", 14)}<input class="tm-search" id="tm-search" type="text" placeholder="filter by name, command, user, pid…" spellcheck="false">
          <span class="tm-count" id="tm-count"></span>
          <span class="tm-note">${icon("zap", 13)}kill works on the agent user's processes</span>
        </div>
        <div class="table-scroll">
          <table id="tm-table">
            <thead><tr>
              <th class="sortable" data-k="pid">PID<span class="arr"></span></th>
              <th class="sortable" data-k="user">USER<span class="arr"></span></th>
              <th class="sortable" data-k="cpu">%CPU<span class="arr"></span></th>
              <th class="sortable" data-k="mem">%MEM<span class="arr"></span></th>
              <th class="sortable" data-k="rss_kb">RSS<span class="arr"></span></th>
              <th>STATE</th>
              <th class="sortable" data-k="threads">TH<span class="arr"></span></th>
              <th class="sortable" data-k="nice">NICE<span class="arr"></span></th>
              <th class="sortable" data-k="start">AGE<span class="arr"></span></th>
              <th>COMMAND</th>
              <th></th>
            </tr></thead>
            <tbody id="tm-body"></tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>${icon("grid", 14)}Devices</h2><span class="line"></span></div>
      <div id="nd-devices"></div>
    </div>`;

  const search = $("#tm-search");
  search.addEventListener("input", () => { tm.q = search.value; updateTM(); });
  search.addEventListener("keydown", e => e.stopPropagation());
  $$("#tm-table th.sortable").forEach(th =>
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      if (tm.sortKey === k) tm.sortDir *= -1;
      else { tm.sortKey = k; tm.sortDir = k === "user" ? 1 : -1; }
      updateTM();
    }));
  $$("#tm-table th").forEach(th => {
    const arr = $(".arr", th);
    if (arr) arr.textContent = "";
  });
}

function updateNodeView() {
  if (!state.view || state.view.type !== "node") return;
  nodeTab(state.view.tab).update();
}

function loadSeries(name, onReady) {
  getSeries(name).then(d => {
    liveBuf[name] = {};
    Object.keys(d.series || {}).forEach(k => { liveBuf[name][k] = d.series[k]; });
    if (onReady) onReady();
  }).catch(() => {});
}

function appendLive(name, snap) {
  const m = metricFromSnap(snap);
  const ts = snap.ts || Date.now() / 1000;  // seconds, like /api/series
  if (!liveBuf[name]) liveBuf[name] = {};
  const b = liveBuf[name];
  for (const k of Object.keys(m)) {
    if (!Array.isArray(b[k])) b[k] = [];
    b[k].push([ts, m[k]]);
    if (b[k].length > BUF_POINTS) b[k].splice(0, b[k].length - BUF_POINTS);
  }
}

function updateSystemTab() {
  const name = state.view.name;
  const nd = state.nodes[name];
  if (!nd || !nd.latest) return;
  const s = nd.latest, h = s.host || {}, m = s.mem || {}, cpu = s.cpu || {};
  const gpus = s.gpu || [];

  // tiles
  const load = cpu.load || {};
  const nrx = Object.values(s.net_io || {}).reduce((a, v) => a + (v.rx || 0), 0);
  const ntx = Object.values(s.net_io || {}).reduce((a, v) => a + (v.tx || 0), 0);
  const dio = Object.values(s.disk_io || {}).reduce((a, v) => a + (v.r || 0), 0);
  const diw = Object.values(s.disk_io || {}).reduce((a, v) => a + (v.w || 0), 0);
  const temps = (s.temps || []).filter(t => t.c != null);
  const maxT = temps.length ? Math.max(...temps.map(t => t.c)) : null;
  const root = (s.mounts || []).find(x => x.mount === "/") || (s.mounts || [])[0];
  const memPct = m.total ? m.used * 100 / m.total : 0;
  const gpu0 = gpus[0] || {};
  const dk = s.docker || {};
  let dkVal = "—", dkSub = "no data yet", dkOff = true;
  if (dk.installed) {
    if (dk.daemon === "running") {
      const dcs = dk.containers || [];
      dkVal = `${dcs.filter(c => c.state === "running").length}<small>/${dcs.length} up</small>`;
      dkSub = `${dk.version ? "engine " + dk.version + " · " : ""}${(dk.images || []).length} images`;
      dkOff = false;
    } else {
      dkVal = "down";
      dkSub = dk.version ? "engine " + dk.version + " · unreachable" : "daemon unreachable";
    }
  } else {
    dkVal = "absent";
    dkSub = "docker not installed";
  }

  $("#nd-tiles").innerHTML = `
    <div class="tile"><div class="t-lbl">${icon("cpu", 13)}CPU</div>
      <div class="t-val">${fmtPct(cpu.pct)}</div>
      <div class="corebars" style="height:14px;margin-top:10px">${(cpu.per_core || []).map(v => `<i style="height:${Math.max(8, v)}%" class="${v >= 90 ? "hot" : ""}"></i>`).join("")}</div>
      <div class="t-sub">${h.n_cpu} cores · ${h.cpu_max_mhz ? h.cpu_max_mhz + " MHz max" : ""}</div>
    </div>
    <div class="tile"><div class="t-lbl">${icon("memory", 13)}Memory</div>
      <div class="t-val">${fmtBytes(m.used, 0)} <small>/ ${fmtBytes(m.total, 0)} · ${fmtPct(memPct)}</small></div>
      <div class="bar t-bar"><i class="${barClass(memPct)}" style="width:${Math.min(100, Math.max(0, memPct))}%"></i></div>
      <div class="t-sub">${fmtBytes(m.available, 0)} available</div>
    </div>
    <div class="tile"><div class="t-lbl">${icon("activity", 13)}Load</div>
      <div class="t-val">${(load.load1 ?? 0).toFixed(2)}</div>
      <div class="t-sub">5m ${(load.load5 ?? 0).toFixed(2)} · 15m ${(load.load15 ?? 0).toFixed(2)} · ${h.n_cpu} cores</div>
    </div>
    <div class="tile"><div class="t-lbl">${icon("swap", 13)}Swap</div>
      <div class="t-val">${fmtBytes(m.swap_used, 0)} <small>/ ${fmtBytes(m.swap_total, 0)}</small></div>
      <div class="t-sub">${m.swap_total ? Math.round((m.swap_used || 0) * 100 / m.swap_total) + "%" : "no swap"}</div>
    </div>
    <div class="tile"><div class="t-lbl">${icon("disk", 13)}Disk ${root ? esc(root.mount) : ""}</div>
      <div class="t-val">${root ? root.pct + "%" : "—"}</div>
      <div class="bar t-bar"><i class="${root ? barClass(root.pct) : ""}" style="width:${root ? Math.min(100, Math.max(0, root.pct)) : 0}%"></i></div>
      <div class="t-sub">R ${fmtPS(dio)} · W ${fmtPS(diw)}</div>
    </div>
    <div class="tile"><div class="t-lbl">${icon("network", 13)}Network</div>
      <div class="t-val" style="font-size:17px">↓ ${fmtPS(nrx)} <small>↑ ${fmtPS(ntx)}</small></div>
      <div class="t-sub">${Object.keys(s.net_io || {}).length} interfaces · eno1 1 Gbps</div>
    </div>
    <div class="tile"><div class="t-lbl">${icon("temp", 13)}Max temp</div>
      <div class="t-val">${maxT != null ? Math.round(maxT) + "°C" : "—"}</div>
      <div class="t-sub">${temps.length} sensors</div>
    </div>
    <div class="tile"><div class="t-lbl">${icon("gpu", 13)}GPU</div>
      <div class="t-val">${gpu0.use != null ? Math.round(gpu0.use) + "%" : "—"}</div>
      <div class="t-sub">${gpu0.name || "no gpu"}</div>
    </div>
    <div class="tile ${dkOff ? "tile-off" : ""}"><div class="t-lbl">${icon("box", 13)}Docker</div>
      <div class="t-val">${dkVal}</div>
      <div class="t-sub">${esc(dkSub)}</div>
    </div>`;

  // charts
  const b = liveBuf[name] || {};
  const nowMs = Date.now();
  drawChart($("#ch-cpu"), [{ data: b.cpu || [], color: COLORS.cpu, fill: true }], { min: 0, max: 100 });
  $("#ch-cpu-v").textContent = fmtPct(cpu.pct);
  drawChart($("#ch-mem"), [{ data: b.mem || [], color: COLORS.mem, fill: true }], { min: 0, max: 100 });
  $("#ch-mem-v").textContent = fmtPct(memPct);
  drawChart($("#ch-load"),
    [{ data: b.load1 || [], color: COLORS.load1, fill: false },
     { data: b.load5 || [], color: COLORS.load5, fill: false },
     { data: b.load15 || [], color: COLORS.load15, fill: false }],
    { min: 0 });
  $("#ch-load-v").textContent = `${(load.load1 ?? 0).toFixed(2)} / ${(load.load5 ?? 0).toFixed(2)} / ${(load.load15 ?? 0).toFixed(2)}`;
  drawChart($("#ch-dio"),
    [{ data: b.drio || [], color: COLORS.drio, fill: true },
     { data: b.driw || [], color: COLORS.driw, fill: false }],
    { min: 0, yFmt: fmtBytes });
  $("#ch-dio-v").textContent = `R ${fmtPS(dio)} · W ${fmtPS(diw)}`;
  drawChart($("#ch-net"),
    [{ data: b.nrx || [], color: COLORS.nrx, fill: true },
     { data: b.ntx || [], color: COLORS.ntx, fill: false }],
    { min: 0, yFmt: fmtBytes });
  $("#ch-net-v").textContent = `↓ ${fmtPS(nrx)} · ↑ ${fmtPS(ntx)}`;
  drawChart($("#ch-temp"),
    [{ data: b.temp || [], color: COLORS.temp, fill: false },
     { data: b.gpu || [], color: COLORS.gpu, fill: false }],
    { min: 0, max: 90, yFmt: v => v + "°C" });
  $("#ch-temp-v").textContent = maxT != null ? Math.round(maxT) + "°C" : "—";

  updateTM();
  updateDevices();
}

/* ---------------- task manager ---------------- */

function updateTM() {
  if (!state.view || state.view.type !== "node") return;
  const nd = state.nodes[tm.node];
  if (!nd || !nd.latest) return;
  const procs = nd.latest.procs || [];
  tm.lastData = procs;

  let list = procs.slice();
  const q = tm.q.trim().toLowerCase();
  if (q) {
    list = list.filter(p =>
      (p.name + " " + p.cmd + " " + p.user + " " + p.pid).toLowerCase().includes(q));
  }
  const k = tm.sortKey, d = tm.sortDir;
  list.sort((a, b) => {
    let va = a[k], vb = b[k];
    if (typeof va === "string") return va.localeCompare(vb) * d;
    return ((va ?? -1e18) - (vb ?? -1e18)) * d;
  });

  const top = Math.max(...procs.map(p => p.cpu), 0);
  const rows = list.map(p => {
    const cpuCls = p.cpu >= 50 ? "cpu-top" : p.cpu >= 20 ? "cpu-hi" : "";
    return `<tr>
      <td class="num">${p.pid}</td>
      <td><span class="uname">${esc(p.user)}</span></td>
      <td class="num ${cpuCls}">${p.cpu.toFixed(1)}</td>
      <td class="num">${p.mem.toFixed(1)}</td>
      <td class="num">${fmtBytes(p.rss_kb * 1024, 0)}</td>
      <td><span class="state-chip ${esc(p.state)}">${esc(p.state)}</span></td>
      <td class="num">${p.threads}</td>
      <td class="num">${p.nice || 0}</td>
      <td class="num">${fmtDur(Date.now() / 1000 - (p.start || Date.now() / 1000))}</td>
      <td title="${esc(p.cmd)}"><span class="cmd">${esc(p.cmd)}</span></td>
      <td style="text-align:right"><button class="kill-btn" data-pid="${p.pid}">⚡ kill</button></td>
    </tr>`;
  }).join("");
  $("#tm-body").innerHTML = rows || `<tr><td colspan="11" style="text-align:center;color:var(--faint);padding:24px">no matching processes</td></tr>`;
  $("#tm-count").textContent = `${list.length} / ${procs.length} processes`;
  $$("#tm-body .kill-btn").forEach(btn =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pid = +btn.dataset.pid;
      const p = procs.find(x => x.pid === pid);
      if (p) confirmKill(tm.node, p);
    }));
  // sort indicators
  $$("#tm-table th").forEach(th => {
    th.classList.toggle("sorted", th.dataset.k === k);
    const arr = $(".arr", th);
    if (arr && th.dataset.k === k) arr.textContent = d === -1 ? "▼" : "▲";
  });
  $("#tm-hint").textContent = `${new Date().toLocaleTimeString([], { hour12: false })} · ${procs.length} procs`;
}

/* ---------------- devices ---------------- */

const GPU_FAN_PRESETS = [
  { id: "balanced", name: "Balanced", note: "Everyday" },
  { id: "cool", name: "Cool", note: "Lower temps" },
  { id: "aggressive", name: "Aggressive", note: "Max airflow" },
];

function updateDevices() {
  const nd = state.nodes[tm.node];
  if (!nd || !nd.latest) return;
  const s = nd.latest;
  const h = s.host || {};
  const key = JSON.stringify([s.mounts, s.net_io, s.disk_io, s.gpu, s.temps, h]);
  if (devCache[tm.node] === key) return;
  devCache[tm.node] = key;

  const root = $("#nd-devices");
  if (!root) return;
  const devOpen = $$("details.dev-details", root).map(d => d.open);  // keep sections expanded across re-renders

  const disks = (s.mounts || []).map(m => `
    <tr>
      <td>${esc(m.mount)}</td>
      <td>${esc(m.fs)}</td>
      <td>${esc(m.dev)}</td>
      <td class="num">${fmtBytes(m.total, 0)}</td>
      <td class="num">${m.pct}%</td>
      <td class="num">${fmtBytes(m.free, 0)} free</td>
    </tr>`).join("");
  const disksBar = (s.mounts || []).map(m => `
    <div class="bar bar-thin" style="margin-top:6px"><i class="${barClass(m.pct)}" style="width:${Math.min(100, Math.max(0, m.pct))}%"></i></div>`).join("");

  const nets = Object.entries(s.net_io || {}).map(([n, v]) => `
    <tr>
      <td>${esc(n)}</td>
      <td class="num">↓ ${fmtPS(v.rx)}</td>
      <td class="num">↑ ${fmtPS(v.tx)}</td>
      <td class="num">${fmtBytes(v.rx_total, 0)}</td>
      <td class="num">${fmtBytes(v.tx_total, 0)}</td>
    </tr>`).join("");

  let amdIndex = -1;
  const gpus = (s.gpu || []).map(g => {
    if (g.kind === "amd") amdIndex++;
    const tempCls = (g.temp || 0) >= 80 ? "crit" : (g.temp || 0) >= 65 ? "hot" : "";
    const selectedPreset = GPU_FAN_PRESETS.some(p => p.id === g.fan_preset) ? g.fan_preset : "balanced";
    const fan = g.kind === "amd" ? `
      <div class="gpu-fan ${g.fan_control ? "" : "unavailable"}">
        <div class="gf-head">
          <span><b>Fan curve</b>${g.fan_rpm ? `<small>${g.fan_rpm} RPM · ${Math.round(g.fan_pct || 0)}%</small>` : ""}</span>
          <label class="gf-auto">
            <input type="checkbox" data-gpu-auto="${amdIndex}" ${g.fan_auto !== false ? "checked" : ""} ${g.fan_control && g.fan_writable ? "" : "disabled"}>
            <span class="gf-switch" aria-hidden="true"></span><span>Auto</span>
          </label>
        </div>
        <div class="gf-presets" role="group" aria-label="Fan curve preset">
          ${GPU_FAN_PRESETS.map(p => `<button type="button" class="gf-preset ${!g.fan_auto && selectedPreset === p.id ? "active" : ""}"
            data-gpu-preset="${amdIndex}" data-preset="${p.id}" aria-pressed="${!g.fan_auto && selectedPreset === p.id}"
            ${g.fan_auto !== false || !g.fan_control || !g.fan_writable ? "disabled" : ""}>
            <span>${p.name}</span><small>${p.note}</small></button>`).join("")}
        </div>
        ${!g.fan_control ? `<div class="gf-note">Firmware fan curves are not exposed by this GPU driver.</div>` :
          (!g.fan_writable ? `<div class="gf-note">Read-only until firmware curve permission is granted on this node.</div>` :
          (g.fan_preset === "custom" ? `<div class="gf-note">A custom driver curve is active.</div>` : ""))}
      </div>` : "";
    return `<div class="gpu-card">
      <div class="g-head">
        <span class="t-ico" style="font-size:15px">▣</span>
        <span class="g-name">${esc(g.name || "GPU")}</span>
        <span class="g-badge">${esc(g.kind || "")}</span>
      </div>
      <div class="gpu-row"><span class="g-lbl">Usage</span>
        <div class="bar"><i class="${g.use >= 90 ? "bad" : ""}" style="width:${g.use != null ? g.use : 0}%"></i></div>
        <span class="g-val">${g.use != null ? Math.round(g.use) + "%" : "—"}</span></div>
      ${g.vram_pct != null ? `<div class="gpu-row"><span class="g-lbl">VRAM</span>
        <div class="bar"><i class="${g.vram_pct >= 95 ? "warn" : ""}" style="width:${g.vram_pct}%"></i></div>
        <span class="g-val">${Math.round(g.vram_pct)}%${g.vram_total ? " (" + fmtBytes(g.vram_used || 0, 1) + "/" + fmtBytes(g.vram_total, 0) + ")" : ""}</span></div>` : ""}
      <div class="gpu-row"><span class="g-lbl">Temp</span>
        <div class="bar"><i class="${(g.temp || 0) >= 80 ? "bad" : (g.temp || 0) >= 65 ? "warn" : ""}" style="width:${Math.min(100, (g.temp || 0))}%"></i></div>
        <span class="g-val ${tempCls}">${g.temp != null ? Math.round(g.temp) + "°C" : "—"}</span></div>
      ${g.temp_junc != null ? `<div class="gpu-row"><span class="g-lbl">Junction</span><div></div><span class="g-val">${Math.round(g.temp_junc)}°C</span></div>` : ""}
      <div class="g-clocks">
        ${g.gfx_clk_mhz ? `<span>gfx <b>${g.gfx_clk_mhz} MHz</b></span>` : ""}
        ${g.mem_clk_mhz ? `<span>mem <b>${g.mem_clk_mhz} MHz</b></span>` : ""}
      </div>
      ${fan}
    </div>`;
  }).join("");

  const temps = (s.temps || []).map(t =>
    `<span class="temp-chip ${(t.c || 0) >= 80 ? "crit" : (t.c || 0) >= 65 ? "hot" : ""}">
      <span class="t-ico">🌡</span>${esc(t.name)}${t.label && t.label !== "thermal" ? " · " + esc(t.label) : ""}
      <span class="t-val">${Math.round(t.c)}°C</span></span>`).join("");

  const pci = (s.pci || []).map(p => `<div>${esc(p)}</div>`).join("") || "<div>unavailable</div>";
  const usb = (s.usb || []).map(u =>
    `<div>${esc(u.port)}  ${esc(u.name)}  <span style="color:var(--faint)">[${esc(u.id)}]</span></div>`).join("") || "<div>none detected</div>";

  root.innerHTML = `
    <div class="dev-grid">
      <div class="table-wrap">
        <div class="section-head" style="padding:13px 14px 0"><h2 style="font-size:11px">Filesystems</h2><span class="line"></span></div>
        <div class="table-scroll" style="max-height:280px">
          <table>
            <thead><tr><th>Mount</th><th>FS</th><th>Device</th><th>Size</th><th>Used</th><th>Free</th></tr></thead>
            <tbody>${disks}</tbody>
          </table>
        </div>
        <div style="padding:10px 14px 14px; display:grid; gap:7px">${disksBar}</div>
      </div>
      <div class="table-wrap">
        <div class="section-head" style="padding:13px 14px 0"><h2 style="font-size:11px">Network interfaces</h2><span class="line"></span></div>
        <div class="table-scroll" style="max-height:280px">
          <table>
            <thead><tr><th>Interface</th><th>RX now</th><th>TX now</th><th>RX total</th><th>TX total</th></tr></thead>
            <tbody>${nets || "<tr><td colspan=5 style='color:var(--faint)'>no data</td></tr>"}</tbody>
          </table>
        </div>
      </div>
      ${gpus ? `<div style="display:flex;flex-direction:column;gap:14px">${gpus}</div>` : ""}
    </div>
    ${temps ? `<div class="section-head" style="margin:16px 0 10px"><h2 style="font-size:11px">Temperatures</h2><span class="line"></span></div>
    <div class="temp-chips">${temps}</div>` : ""}
    <details class="dev-details"><summary>PCI devices (${(s.pci || []).length})</summary><div class="dd-body">${pci}</div></details>
    <details class="dev-details"><summary>USB devices (${(s.usb || []).length})</summary><div class="dd-body">${usb}</div></details>`;
  $$("details.dev-details", root).forEach((d, i) => { if (devOpen[i]) d.open = true; });
  $$("[data-gpu-auto]", root).forEach(box => box.addEventListener("change", async () => {
    const buttons = $$(`[data-gpu-preset="${box.dataset.gpuAuto}"]`, root);
    buttons.forEach(b => { b.disabled = box.checked; });
    let active = buttons.find(b => b.classList.contains("active"));
    if (box.checked) {
      buttons.forEach(b => { b.classList.remove("active"); b.setAttribute("aria-pressed", "false"); });
    }
    if (!box.checked && !active) {
      active = buttons.find(b => b.dataset.preset === "balanced");
      active.classList.add("active");
      active.setAttribute("aria-pressed", "true");
    }
    await setGpuFan(tm.node, +box.dataset.gpuAuto, box.checked, active?.dataset.preset || "balanced");
  }));
  $$("[data-gpu-preset]", root).forEach(btn => btn.addEventListener("click", async () => {
    const index = btn.dataset.gpuPreset;
    $$(`[data-gpu-preset="${index}"]`, root).forEach(b => {
      const active = b === btn;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    });
    await setGpuFan(tm.node, +index, false, btn.dataset.preset);
  }));
}

async function setGpuFan(node, index, auto, preset) {
  try {
    const r = await sendGpuAction(node, { cmd: "fan", index, auto, preset });
    const label = GPU_FAN_PRESETS.find(p => p.id === preset)?.name || preset;
    toast(r.ok ? (auto ? "AMD fan returned to firmware Auto" : `AMD fan curve: ${label}`) : (r.error || "fan action failed"), !!r.ok);
    if (!r.ok) devCache[node] = "";
  } catch (e) {
    toast("fan action failed: " + e.message, false);
    devCache[node] = "";
  }
}

/* ---------------- docker ---------------- */

const DSTATE = {
  running: "on", created: "warn", paused: "warn",
  restarting: "warn", removing: "warn", dead: "bad", exited: "off",
};

/* Docker tab. */
function buildDockerTab() {
  $("#node-tab-body").innerHTML = `
    <div class="section">
      <div class="section-head"><h2>${icon("box", 14)}Docker</h2><span class="line"></span><span class="hint" id="dk-hint"></span></div>
      <div id="nd-docker"></div>
    </div>`;
}

function updateDockerTab() {
  if (!state.view || state.view.type !== "node") return;
  const name = state.view.name;
  const nd = state.nodes[name];
  if (!nd || !nd.latest) return;
  const dk = nd.latest.docker || {};
  const root = $("#nd-docker");
  if (!root) return;
  // cpu floats every tick — key the re-render on structure only
  const key = JSON.stringify([dk.installed, dk.daemon, dk.version,
    (dk.containers || []).map(c => [c.id, c.state, c.name]),
    (dk.images || []).map(i => i.id)]);
  if (dkCache[name] === key) return;
  dkCache[name] = key;

  const hint = $("#dk-hint");
  if (!dk.installed) {
    root.innerHTML = `<div class="dk-none">${icon("box", 15)} docker is not installed on this node</div>`;
    if (hint) hint.textContent = "";
    return;
  }
  const down = dk.daemon !== "running";
  const cs = (dk.containers || []).slice().sort((a, b) =>
    (b.state === "running") - (a.state === "running") || a.name.localeCompare(b.name));
  const rows = cs.map(c => {
    const st = DSTATE[c.state] || "off";
    const running = c.state === "running";
    const mem = running
      ? fmtBytes(c.mem, 0) + (c.mem_limit ? ` <small style="color:var(--faint)">/ ${fmtBytes(c.mem_limit, 0)}</small>` : "")
      : "—";
    const net = running && (c.net_rx || c.net_tx)
      ? `↓${fmtBytes(c.net_rx, 0)} ↑${fmtBytes(c.net_tx, 0)}` : "—";
    const cpuCls = running && c.cpu >= 50 ? "cpu-top" : running && c.cpu >= 20 ? "cpu-hi" : "";
    return `<tr>
      <td><span class="dst ${st}" title="${esc(c.state)}"></span></td>
      <td><span class="dk-name">${esc(c.name)}</span><div class="dk-status">${esc(c.status || c.state)}</div></td>
      <td title="${esc(c.image)}"><span class="cmd dk-img">${esc(c.image)}</span></td>
      <td class="num">${c.created ? ago(c.created) : "—"}</td>
      <td class="num"><span class="${cpuCls}">${running ? (c.cpu != null ? c.cpu.toFixed(1) + "%" : "—") : "—"}</span></td>
      <td class="num">${mem}</td>
      <td class="num" style="font-size:10.5px">${net}</td>
      <td title="${esc(c.ports)}"><span class="cmd dk-ports">${c.ports ? esc(c.ports) : "—"}</span></td>
      <td style="text-align:right"><span class="dctl-row">
        <button class="dctl ${running ? "" : "ok"}" title="start ${esc(c.name)}" data-act="start" data-name="${esc(c.name)}">${icon("play", 10)}start</button>
        <button class="dctl" title="stop ${esc(c.name)}" data-act="stop" data-name="${esc(c.name)}">${icon("stop", 10)}stop</button>
        <button class="dctl" title="restart ${esc(c.name)}" data-act="restart" data-name="${esc(c.name)}">${icon("restart", 10)}restart</button>
        <button class="dctl danger" title="remove ${esc(c.name)}" data-act="remove" data-name="${esc(c.name)}">${icon("trash", 10)}remove</button>
      </span></td>
    </tr>`;
  }).join("");
  const imgs = (dk.images || []).map(im => `<tr>
      <td title="${esc(im.ref)}"><span class="uname">${esc(im.ref)}</span></td>
      <td style="font-size:10.5px;color:var(--faint)">${esc(im.id)}</td>
      <td class="num">${fmtBytes(im.size, 1)}</td>
      <td class="num">${im.created ? ago(im.created) : "—"}</td>
      <td style="text-align:right"><button class="dctl danger" title="delete image ${esc(im.ref)}" data-act="rmi" data-ref="${esc(im.ref)}">${icon("trash", 10)}delete</button></td>
    </tr>`).join("");

  root.innerHTML = `
    <div class="dk-banner ${down ? "bad" : ""}">${icon("box", 13)}
      <span>${down
        ? "docker daemon is down — controls disabled, last known state below"
        : `engine ${esc(dk.version || "?")} · ${cs.filter(c => c.state === "running").length}/${cs.length} containers running`}</span>
    </div>
    <div class="table-wrap" style="margin-bottom:14px">
      <div class="tm-note" style="padding:10px 14px 0">Containers (${cs.length})</div>
      <table>
        <thead><tr><th style="width:26px"></th><th>NAME</th><th>IMAGE</th><th>AGE</th><th>CPU</th><th>MEM</th><th>NET Σ</th><th>PORTS</th><th style="width:330px"></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="9" style="text-align:center;color:var(--faint);padding:20px">no containers</td></tr>`}</tbody>
      </table>
    </div>
    <div class="table-wrap">
      <div class="tm-note" style="padding:10px 14px 0">Images (${(dk.images || []).length})</div>
      <table>
        <thead><tr><th>REF</th><th>ID</th><th>SIZE</th><th>AGE</th><th style="width:90px"></th></tr></thead>
        <tbody>${imgs || `<tr><td colspan="5" style="text-align:center;color:var(--faint);padding:20px">no images</td></tr>`}</tbody>
      </table>
    </div>`;
  if (hint) hint.textContent = down ? "daemon down" : new Date().toLocaleTimeString([], { hour12: false });

  $$("#nd-docker .dctl").forEach(btn => {
    if (down) btn.disabled = true;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.dataset.act === "remove") return confirmDockerContainer(name, btn.dataset.name);
      if (btn.dataset.act === "rmi") return confirmDockerImage(name, btn.dataset.ref);
      doDockerAction(name, { cmd: btn.dataset.act, container: btn.dataset.name });
    });
  });
}

async function doDockerAction(node, act) {
  try {
    const r = await sendDockerAction(node, act);
    const what = act.container || act.image || act.cmd;
    toast(r.ok ? `${act.cmd} ${what} — ${r.note || "ok"}` : (r.error || `${act.cmd} failed`), !!r.ok);
    dkCache[node] = "";  // force re-render on the next tick
    return r;
  } catch (e) {
    toast(`${act.cmd} failed: ` + e.message, false);
    return { ok: false, error: e.message };
  }
}

function confirmDockerContainer(node, cname) {
  const nd = state.nodes[node];
  const c = (nd && nd.latest && nd.latest.docker
    ? (nd.latest.docker.containers || []) : []).find(x => x.name === cname);
  const running = !!(c && c.state === "running");
  openModal(`
    <h3>Remove container?</h3>
    <p><b class="mono">${esc(cname)}</b> — image <span class="mono">${esc(c ? c.image : "?")}</span>${running ? " · <b style='color:var(--warn)'>currently running</b>" : ""}</p>
    <p style="color:var(--faint);font-size:11.5px">The container and its writable layer are deleted.${running ? " It will be force-stopped first — whatever only it serves goes down with it." : ""}</p>
    <div class="m-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-danger" data-act="remove">Remove${running ? " (force)" : ""}</button>
    </div>`);
  $$(".m-actions .btn").forEach(b =>
    b.addEventListener("click", async () => {
      if (b.dataset.act === "cancel") return closeModal();
      b.disabled = true;
      await doDockerAction(node, { cmd: "remove", container: cname, force: running });
      closeModal();
    }));
}

function confirmDockerImage(node, ref) {
  openModal(`
    <h3>Delete image?</h3>
    <p><b class="mono">${esc(ref)}</b></p>
    <p style="color:var(--faint);font-size:11.5px">A plain delete fails while any container still uses the image. “Force” deletes it anyway — containers built from it break on their next start.</p>
    <div class="m-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-danger" data-act="rmi">Delete</button>
      <button class="btn btn-kilo" data-act="rmi-force">Delete (force)</button>
    </div>`);
  $$(".m-actions .btn").forEach(b =>
    b.addEventListener("click", async () => {
      if (b.dataset.act === "cancel") return closeModal();
      b.disabled = true;
      await doDockerAction(node, { cmd: "rmi", image: ref, force: b.dataset.act === "rmi-force" });
      closeModal();
    }));
}

/* ---------------- llama.cpp tab ---------------- */

/* Start/stop progress animation — a cosmetic banner + bar that stays up
   until the status actually flips (starting → running, stopping → gone).
   The safety timeouts only fire if the status never flips (e.g. the process
   died after the agent's 2 s liveness probe), so the banner cannot linger
   forever. */
const llAnim = {};   // node -> {phase, preset, t0, safety, tick}

function llAnimSet(node, phase, preset) {
  llAnimEnd(node);
  const a = { phase, preset: preset || null, t0: Date.now() };
  a.safety = setTimeout(() => {
    llAnimEnd(node);
    toast(phase === "starting"
      ? `still starting after 5 min — check llama-server.log on ${node}`
      : `still stopping after 1 min — try Stop (force)`, false);
  }, phase === "starting" ? 300000 : 60000);
  a.tick = setInterval(() => {
    const el = document.getElementById("ll-wait-" + llAnimId(node));
    if (el) el.textContent = llAnimAge(a.t0);
  }, 1000);
  llAnim[node] = a;
  llCache[node] = "";   // force a re-render
  updateNodeView();     // ...and render it right away
}
function llAnimEnd(node) {
  const a = llAnim[node];
  if (!a) return;
  clearTimeout(a.safety);
  clearInterval(a.tick);
  llAnim[node] = null;
}
function llAnimId(node) { return "ll" + node.replace(/[^a-zA-Z0-9]/g, ""); }
function llAnimAge(t0) {
  const s = Math.max(0, Math.floor((Date.now() - t0) / 1000));
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
}
function llAnimBox(a, pid, node) {
  const wait = `<span class="ll-wait" id="ll-wait-${llAnimId(node)}">${llAnimAge(a.t0)}</span>`;
  if (a.phase === "starting") return `
    <div class="dk-banner"><span class="dst warn live"></span>
      <span><b style="color:var(--warn)">STARTING</b> · ${esc(a.preset || "preset")}
        <span class="ll-anim-dots"><i></i><i></i><i></i></span></span>
      <span class="ll-anim-sub">model load takes a moment</span>
      <span style="flex:1"></span>${wait}
    </div>
    <div class="ll-bar"><div class="ll-bar-fill load"></div><i class="ll-sheen"></i></div>`;
  return `
    <div class="dk-banner bad"><span class="dst bad live"></span>
      <span><b style="color:var(--bad)">STOPPING</b>${pid ? ` · pid ${pid}` : ""}
        <span class="ll-anim-dots bad"><i></i><i></i><i></i></span></span>
      <span class="ll-anim-sub">waiting for it to exit</span>
      <span style="flex:1"></span>${wait}
    </div>
    <div class="ll-bar"><div class="ll-bar-fill drain"></div><i class="ll-sheen"></i></div>`;
}

/* Collapsible live console — tail of ~/pulse/llama-server.log on the node.
   Polls every 2 s, but only while open and this tab is the one on screen. */
let llConsoleOpen = false;
let llConsoleBusy = false;

function llConsoleToggle(node) {
  const pre = $("#ll-console-pre"), tog = $("#ll-console-toggle");
  if (!pre || !tog) return;
  llConsoleOpen = !llConsoleOpen;
  pre.hidden = !llConsoleOpen;
  tog.setAttribute("aria-expanded", String(llConsoleOpen));
  const chev = $("#ll-console-chev");
  if (chev) chev.textContent = llConsoleOpen ? "▾" : "▸";
  if (llConsoleOpen) { pre.textContent = ""; llConsoleFetch(node); }
  else { const st = $("#ll-console-state"); if (st) st.textContent = ""; }
}

async function llConsoleFetch(node) {
  if (!llConsoleOpen || llConsoleBusy) return;
  if (!state.view || state.view.type !== "node" ||
      state.view.tab !== "llama" || state.view.name !== node) return;
  llConsoleBusy = true;
  try {
    const r = await sendLlamaAction(node, { cmd: "log" });
    const pre = $("#ll-console-pre");
    if (!pre || !llConsoleOpen) return;   // tab went away mid-request
    const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
    pre.textContent = (r.ok && r.log) ? r.log + "\n"
      : (r.ok ? "" : "(error: " + (r.error || "unknown") + ")");
    const st = $("#ll-console-state");
    if (st) st.textContent = (r.ok && !r.log) ? "no log yet" : "";
    if (stick) pre.scrollTop = pre.scrollHeight;
  } catch (e) {
    const pre = $("#ll-console-pre");
    if (pre && llConsoleOpen) pre.textContent = "(fetch failed: " + e.message + ")";
  } finally {
    llConsoleBusy = false;
  }
}

function buildLlamaTab() {
  $("#node-tab-body").innerHTML = `
    <div class="section">
      <div class="section-head"><h2>${icon("zap", 14)}llama.cpp server</h2><span class="line"></span><span class="hint" id="ll-hint"></span></div>
      <div id="ll-status"></div>
      <div class="ll-console">
        <button class="ll-console-toggle" id="ll-console-toggle" type="button" aria-expanded="false">
          <span id="ll-console-chev">▸</span>
          <span>console — llama-server.log</span>
          <span class="ll-console-state" id="ll-console-state"></span>
        </button>
        <pre id="ll-console-pre" class="ll-console-pre" hidden></pre>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>${icon("list", 14)}Presets</h2><span class="line"></span><span class="hint">stored in ~/pulse/llama_presets.json on this node</span></div>
      <div id="ll-presets"></div>
      <div class="ll-add">
        <input id="llp-name" type="text" maxlength="120" placeholder="Preset name — e.g. Qwen 27B Q4, 32k ctx" autocomplete="off">
        <textarea id="llp-args" rows="5" spellcheck="false" placeholder="Command line — one flag per line:&#10;/home/decode/LLM/bin_rocm/llama-server&#10;-m /path/to/model.gguf&#10;-ngl 99&#10;-c 32768&#10;--port 8080"></textarea>
        <div class="ll-add-row">
          <span class="ll-add-hint">lines are joined with spaces when launched</span>
          <button class="btn btn-primary" id="llp-add">+ Add preset</button>
        </div>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>${icon("chart", 14)}Memory calculator</h2><span class="line"></span><span class="hint">rough estimate — pure client-side, nothing is sent anywhere</span></div>
      <div class="ll-calc">
        <div class="ll-calc-grid">
          <label>Model params (B)<input type="number" id="llc-params" value="27" min="0.1" step="0.1"></label>
          <label>Quantization
            <select id="llc-quant">
              <option value="16">F16 (16.0 bpw)</option>
              <option value="8.5">Q8_0 (8.5 bpw)</option>
              <option value="6.5625">Q6_K (6.56 bpw)</option>
              <option value="5.6875">Q5_K_M (5.69 bpw)</option>
              <option value="5.4375">Q5_K_S (5.44 bpw)</option>
              <option value="4.84375" selected>Q4_K_M (4.84 bpw)</option>
              <option value="4.59375">Q4_K_S (4.59 bpw)</option>
              <option value="4.5">Q4_0 (4.5 bpw)</option>
              <option value="4.25">IQ4_XS (4.25 bpw)</option>
              <option value="3.84375">Q3_K_M (3.84 bpw)</option>
              <option value="3.4375">IQ3_XXS (3.44 bpw)</option>
            </select>
          </label>
          <label>Context (tokens)<input type="number" id="llc-ctx" value="32768" min="256" step="1024"></label>
          <label>Layers<input type="number" id="llc-layers" value="64" min="1" step="1"></label>
          <label>KV heads<input type="number" id="llc-kvh" value="8" min="1" step="1"></label>
          <label>Head dim<input type="number" id="llc-hd" value="128" min="16" step="8"></label>
          <label>KV cache dtype
            <select id="llc-kv">
              <option value="2" selected>f16 (2 B/element)</option>
              <option value="1.0625">q8_0 (1.06 B/element)</option>
              <option value="0.5625">q4_0 (0.56 B/element)</option>
            </select>
          </label>
          <label>Overhead (GiB)<input type="number" id="llc-over" value="1.5" min="0" step="0.5"></label>
          <label><button class="btn btn-primary" id="llc-go" style="width:100%">${icon("zap", 12)}Calculate</button></label>
        </div>
        <div id="llc-out" class="llc-out"></div>
      </div>
    </div>`;
  $("#llc-go").addEventListener("click", llCalc);
  $("#llp-add").addEventListener("click", () => addLlamaPreset(state.view.name));
  const llcTog = $("#ll-console-toggle"), llcChev = $("#ll-console-chev"),
        llcPre = $("#ll-console-pre");
  if (llcTog && llcChev && llcPre) {
    llcPre.hidden = !llConsoleOpen;
    llcChev.textContent = llConsoleOpen ? "▾" : "▸";
    llcTog.setAttribute("aria-expanded", String(llConsoleOpen));
    llcTog.addEventListener("click", () => llConsoleToggle(state.view.name));
    if (llConsoleOpen) { llcPre.textContent = ""; llConsoleFetch(state.view.name); }
  }
}

function updateLlamaTab() {
  const name = state.view.name;
  const nd = state.nodes[name];
  if (!nd || !nd.latest) return;
  const ll = nd.latest.llama || {};
  const presets = ll.presets || [];
  const key = JSON.stringify([ll.running, ll.pid, ll.model, ll.port, ll.ready,
    presets.map(p => p.name + "|" + p.args)]);
  if (llCache[name] === key) return;
  llCache[name] = key;

  const st = $("#ll-status");
  if (!st) return;
  const host = nd.latest.host || {};
  // Resolve the cosmetic start/stop animation against the live status:
  // it stays up until the action is really done — starting waits for the
  // server's port to accept connections (ll.ready: the model may still be
  // loading while the process is up), stopping waits for the process to
  // disappear (ll.running).
  let anim = null;
  const a = llAnim[name];
  if (a) {
    if ((a.phase === "starting" && !ll.ready) || (a.phase === "stopping" && ll.running)) {
      anim = a;
    } else {
      llAnimEnd(name);
      if (a.phase === "starting" && ll.ready) toast(`${a.preset || "llama.cpp"} — ready`, true);
    }
  }
  if (anim) {
    st.innerHTML = llAnimBox(anim, ll.pid, name);
  } else if (ll.running) {
    const loading = !ll.ready;
    const mname = ll.model ? ll.model.split("/").pop() : "unknown model";
    st.innerHTML = `
      <div class="dk-banner"><span class="dst ${loading ? "warn live" : "on"}"></span>
        <span><b style="color:var(--${loading ? "warn" : "good"})">${loading ? "LOADING" : "RUNNING"}</b> · pid ${ll.pid} · up ${ago(ll.start)}${loading ? " — model not ready yet" : ""}</span>
        <span style="flex:1"></span>
        ${ll.port && host.ip ? `<a class="btn" href="http://${host.ip}:${ll.port}" target="_blank" rel="noopener">web ui ↗</a>` : ""}
        <button class="btn btn-danger" id="ll-stop">${icon("stop", 12)}Stop</button>
      </div>
      <div class="ll-model">
        <span class="ll-model-name" title="${esc(ll.model || "no -m flag")}">${icon("box", 13)}${esc(mname)}</span>
        ${ll.model && ll.model !== mname ? `<span class="ll-model-path" title="${esc(ll.model)}">${esc(ll.model)}</span>` : ""}
      </div>
      <div class="mono-line" title="${esc(ll.cmd || "")}">${esc(ll.cmd || "")}</div>`;
    $("#ll-stop").addEventListener("click", () => confirmLlamaStop(name, ll));
  } else {
    st.innerHTML = `
      <div class="dk-banner bad"><span class="dst off"></span>
        <span>llama.cpp server is <b>not running</b> — start one from a preset below</span></div>`;
  }

  const pr = $("#ll-presets");
  if (!pr) return;
  if (!presets.length) {
    pr.innerHTML = `<div class="dk-none">${icon("box", 15)}no presets yet — add one with the form below</div>`;
    return;
  }
  pr.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>NAME</th><th>ARGS</th><th style="width:235px"></th></tr></thead>
      <tbody>${presets.map(p => `<tr>
        <td><span class="dk-name">${esc(p.name)}</span></td>
        <td title="${esc(p.args)}"><span class="cmd">${esc(p.args)}</span></td>
        <td style="text-align:right;white-space:nowrap"><button class="btn btn-primary ll-start" data-name="${esc(p.name)}" data-args="${esc(p.args)}">${icon("play", 11)}Start</button><button class="btn ll-edit-btn" data-name="${esc(p.name)}">${icon("list", 11)}Edit</button><button class="dctl danger ll-del" title="Remove preset">${icon("trash", 10)}</button></td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  $$("#ll-presets .ll-start").forEach(btn =>
    btn.addEventListener("click", () => {
      if (llAnim[name]) { toast("one moment — a start/stop is in progress", false); return; }
      if (ll.running) confirmLlamaStart(name, ll, btn.dataset.name, btn.dataset.args);
      else startLlamaPreset(name, btn.dataset.name, btn.dataset.args, btn);
    }));
  $$("#ll-presets .ll-edit-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      const p = presets.find(x => x.name === btn.dataset.name);
      if (p) editLlamaPreset(name, p);
    }));
  $$("#ll-presets .ll-del").forEach(btn =>
    btn.addEventListener("click", () => confirmLlamaDelete(name, btn.dataset.name)));
}

async function doLlamaAction(node, act) {
  try {
    const r = await sendLlamaAction(node, act);
    llCache[node] = "";   // force a re-render on the next tick
    return r;
  } catch (e) {
    toast(`${act.cmd} failed: ` + e.message, false);
    return { ok: false, error: e.message };
  }
}

async function addLlamaPreset(node) {
  const nEl = $("#llp-name"), aEl = $("#llp-args");
  const name = nEl.value.trim(), args = aEl.value.trim();
  if (!name || !args) { toast("Preset name and command line are both required", false); return; }
  const btn = $("#llp-add");
  btn.disabled = true;
  const r = await doLlamaAction(node, { cmd: "add_preset", name, args });
  btn.disabled = false;
  if (r.ok) {
    toast(r.note ? `${r.preset} — ${r.note}` : `preset “${r.preset}” added`, true);
    nEl.value = ""; aEl.value = "";
  } else {
    toast(r.error || "could not add preset", false);
  }
}

function confirmLlamaDelete(node, pname) {
  openModal(`
    <h3>Remove preset?</h3>
    <p><b class="mono">${esc(pname)}</b></p>
    <p style="color:var(--faint);font-size:11.5px">Only the entry is removed from <span class="mono">~/pulse/llama_presets.json</span> on this node — nothing else is touched.</p>
    <div class="m-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-danger" data-act="del">${icon("trash", 12)}Remove</button>
    </div>`);
  $$(".m-actions .btn").forEach(b =>
    b.addEventListener("click", async () => {
      if (b.dataset.act === "cancel") return closeModal();
      b.disabled = true;
      const r = await doLlamaAction(node, { cmd: "del_preset", name: pname });
      toast(r.ok ? `preset “${r.preset}” removed` : (r.error || "could not remove preset"), !!r.ok);
      closeModal();
    }));
}

async function startLlamaPreset(node, pname, args, btn) {
  if (llAnim[node]) { toast("already starting or stopping — one moment", false); return; }
  if (btn) btn.disabled = true;
  const r = await doLlamaAction(node, { cmd: "start", args });
  if (btn) btn.disabled = false;
  if (r.ok) {
    llAnimSet(node, "starting", pname);
    toast(`${pname} — starting (pid ${r.pid})`, true);
  } else {
    toast(r.error || "start failed", false);
  }
}

function confirmLlamaStart(node, ll, pname, args) {
  const model = (ll.model || "the current model").split("/").pop();
  openModal(`
    <h3>Start “${esc(pname)}”?</h3>
    <p style="color:var(--faint);font-size:11.5px">Only one server can run: <b class="mono">${esc(model)}</b> (pid ${ll.pid}) will be <b>stopped first</b>, then the new preset launches.</p>
    <div class="m-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" data-act="go">${icon("restart", 12)}Stop &amp; start</button>
    </div>`);
  $$(".m-actions .btn").forEach(b =>
    b.addEventListener("click", () => {
      if (b.dataset.act === "cancel") return closeModal();
      closeModal();
      startLlamaPreset(node, pname, args);
    }));
}

function editLlamaPreset(node, p) {
  openModal(`
    <h3>Edit preset</h3>
    <p style="color:var(--faint);font-size:11.5px">Saving under a new name renames the preset. Lines are joined with spaces when launched.</p>
    <div class="ll-edit">
      <input id="lle-name" type="text" maxlength="120" value="${esc(p.name)}">
      <textarea id="lle-args" rows="8" spellcheck="false">${esc(p.args)}</textarea>
    </div>
    <div class="m-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" data-act="save">Save</button>
    </div>`);
  $$(".m-actions .btn").forEach(b =>
    b.addEventListener("click", async () => {
      if (b.dataset.act === "cancel") return closeModal();
      const name = $("#lle-name").value.trim();
      const args = $("#lle-args").value.trim();
      if (!name || !args) { toast("name and command line are both required", false); return; }
      b.disabled = true;
      const act = { cmd: "add_preset", name, args };
      if (name.toLowerCase() !== p.name.toLowerCase()) act.old_name = p.name;
      const r = await doLlamaAction(node, act);
      toast(r.ok ? (r.note ? `${r.preset} — ${r.note}` : `preset “${r.preset}” updated`) : (r.error || "could not save preset"), !!r.ok);
      closeModal();
    }));
}

function confirmLlamaStop(node, ll) {
  openModal(`
    <h3>Stop llama.cpp server?</h3>
    <p><b class="mono">${esc((ll.model || "unknown model").split("/").pop())}</b> — pid ${ll.pid}</p>
    <p style="color:var(--faint);font-size:11.5px">SIGTERM first. Anything talking to it loses the connection mid-stream; if it refuses to die, force sends SIGKILL.</p>
    <div class="m-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-danger" data-act="stop">Stop</button>
      <button class="btn btn-kilo" data-act="stop9">Stop (force)</button>
    </div>`);
  $$(".m-actions .btn").forEach(b =>
    b.addEventListener("click", async () => {
      if (b.dataset.act === "cancel") return closeModal();
      b.disabled = true;
      const r = await doLlamaAction(node, { cmd: "stop", force: b.dataset.act === "stop9" });
      toast(r.ok ? `stopping (pid ${r.pid}, sig ${r.sig})` : (r.error || "stop failed"), !!r.ok);
      if (r.ok) llAnimSet(node, "stopping");
      closeModal();
    }));
}

/* Memory calculator — pure client-side estimate, llama.cpp-style math:
   weights  = params × bits-per-weight / 8
   kv cache = 2 (K+V) × layers × kv_heads × head_dim × ctx × kv bytes/element
   total    = weights + kv cache + overhead (compute buffers, runtime) */
function llCalc() {
  const num = (id, dflt) => {
    const v = parseFloat($("#" + id).value);
    return isFinite(v) && v > 0 ? v : dflt;
  };
  const params = num("llc-params", 27);
  const bpw = parseFloat($("#llc-quant").value);
  const ctx = num("llc-ctx", 32768);
  const layers = num("llc-layers", 64);
  const kvh = num("llc-kvh", 8);
  const hd = num("llc-hd", 128);
  const kvb = parseFloat($("#llc-kv").value);
  const over = num("llc-over", 0);

  const GiB = 2 ** 30;
  const weights = params * 1e9 * bpw / 8 / GiB;
  const kv = 2 * layers * kvh * hd * ctx * kvb / GiB;
  const total = weights + kv + over;
  const f = v => (v >= 10 ? Math.round(v) : +v.toFixed(2)) + " GiB";

  $("#llc-out").innerHTML = `
    <div class="llc-row"><span>Weights — ${params}B @ ${bpw} bpw</span><b>${f(weights)}</b></div>
    <div class="llc-row"><span>KV cache — ctx ${Math.round(ctx).toLocaleString()}</span><b>${f(kv)}</b></div>
    <div class="llc-row"><span>Overhead — compute buffers, runtime</span><b>${f(over)}</b></div>
    <div class="llc-row llc-total"><span>Total</span><b>${f(total)}</b></div>
    <div class="llc-note">Full offload (<span class="mono">-ngl all</span>): want VRAM ≥ total. Partial offload: RAM ≥ total, VRAM ≈ the weights you move plus your share of the KV cache. Estimates assume a block-quantized GGUF — see the llama.cpp wiki for the underlying math.</div>`;
}

/* ---------------- Strata tab ---------------- */

let stConsoleOpen = false;
let stConsoleBusy = false;
const stPending = {};  // node -> starting | stopping

function buildStrataTab() {
  $("#node-tab-body").innerHTML = `
    <div class="section">
      <div class="section-head"><h2>${icon("activity", 14)}Strata server</h2><span class="line"></span><span class="hint">Qwen3.8-Flash-Next · IQ2_XS</span></div>
      <div id="st-status"></div>
      <div class="ll-console">
        <button class="ll-console-toggle" id="st-console-toggle" type="button" aria-expanded="false">
          <span id="st-console-chev">▸</span>
          <span>engine log — strata-iq2_xs.log</span>
          <span class="ll-console-state" id="st-console-state"></span>
        </button>
        <pre id="st-console-pre" class="ll-console-pre" hidden></pre>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>${icon("chart", 14)}Live telemetry</h2><span class="line"></span><span class="hint">read from Strata on localhost; API key stays on the node</span></div>
      <div id="st-metrics"></div>
    </div>
    <div class="section">
      <div class="section-head"><h2>${icon("list", 14)}Profile</h2><span class="line"></span><span class="hint">managed by the installed Strata config</span></div>
      <div id="st-profile"></div>
    </div>`;
  const toggle = $("#st-console-toggle"), pre = $("#st-console-pre"),
        chev = $("#st-console-chev");
  pre.hidden = !stConsoleOpen;
  chev.textContent = stConsoleOpen ? "▾" : "▸";
  toggle.setAttribute("aria-expanded", String(stConsoleOpen));
  toggle.addEventListener("click", () => stConsoleToggle(state.view.name));
  if (stConsoleOpen) stConsoleFetch(state.view.name);
}

function stConsoleToggle(node) {
  const pre = $("#st-console-pre"), toggle = $("#st-console-toggle");
  if (!pre || !toggle) return;
  stConsoleOpen = !stConsoleOpen;
  pre.hidden = !stConsoleOpen;
  toggle.setAttribute("aria-expanded", String(stConsoleOpen));
  $("#st-console-chev").textContent = stConsoleOpen ? "▾" : "▸";
  if (stConsoleOpen) { pre.textContent = ""; stConsoleFetch(node); }
  else { const s = $("#st-console-state"); if (s) s.textContent = ""; }
}

async function stConsoleFetch(node) {
  if (!stConsoleOpen || stConsoleBusy || !state.view ||
      state.view.type !== "node" || state.view.tab !== "strata" ||
      state.view.name !== node) return;
  stConsoleBusy = true;
  try {
    const r = await sendStrataAction(node, { cmd: "log" });
    const pre = $("#st-console-pre");
    if (!pre || !stConsoleOpen) return;
    const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
    pre.textContent = (r.ok && r.log) ? r.log + "\n"
      : (r.ok ? "" : "(error: " + (r.error || "unknown") + ")");
    const s = $("#st-console-state");
    if (s) s.textContent = (r.ok && !r.log) ? "no log yet" : "";
    if (stick) pre.scrollTop = pre.scrollHeight;
  } catch (e) {
    const pre = $("#st-console-pre");
    if (pre && stConsoleOpen) pre.textContent = "(fetch failed: " + e.message + ")";
  } finally {
    stConsoleBusy = false;
  }
}

const stVal = (v, suffix = "") => v == null ? "—" : `${v}${suffix}`;
const stGiB = mib => mib == null ? "—" : `${(mib / 1024).toFixed(1)} GiB`;

function updateStrataTab() {
  const name = state.view.name;
  const nd = state.nodes[name];
  if (!nd || !nd.latest) return;
  const st = nd.latest.strata || { installed: false, running: false };
  if (stPending[name] === "starting" && st.ready) delete stPending[name];
  if (stPending[name] === "stopping" && !st.running) delete stPending[name];
  const key = JSON.stringify([st, stPending[name] || null]);
  if (stCache[name] === key) return;
  stCache[name] = key;
  const status = $("#st-status"), metrics = $("#st-metrics"), profile = $("#st-profile");
  if (!status || !metrics || !profile) return;
  const host = nd.latest.host || {};
  const pending = stPending[name];

  if (!st.installed) {
    status.innerHTML = `<div class="dk-banner bad"><span class="dst off"></span>
      <span>Strata is <b>not installed</b> on this node.</span></div>`;
  } else if (!st.running) {
    status.innerHTML = `<div class="dk-banner bad"><span class="dst off"></span>
      <span>Strata is <b>not running</b> — the configured IQ2_XS profile is ready to launch.</span>
      <span style="flex:1"></span><button class="btn btn-primary" id="st-start" ${pending ? "disabled" : ""}>${icon("play", 12)}${pending === "starting" ? "Starting…" : "Start Strata"}</button></div>`;
    $("#st-start")?.addEventListener("click", () => confirmStrataStart(name, nd.latest.llama || {}));
  } else {
    const loading = !st.ready;
    const busy = !!st.busy;
    const label = loading ? "LOADING" : (busy ? "BUSY" : "READY");
    const tone = loading ? "warn" : (busy ? "acc1" : "good");
    const dot = loading ? "warn live" : (busy ? "warn live" : "on");
    const phase = busy ? ` · ${esc(st.phase || st.state || "working")}` : "";
    status.innerHTML = `<div class="dk-banner"><span class="dst ${dot}"></span>
      <span><b style="color:var(--${tone})">${label}</b> · pid ${st.pid} · up ${ago(st.start)}${phase}</span>
      <span style="flex:1"></span>
      ${st.port && host.ip ? `<a class="btn" href="http://${host.ip}:${st.port}" target="_blank" rel="noopener">web ui ↗</a>` : ""}
      <button class="btn btn-danger" id="st-stop" ${pending ? "disabled" : ""}>${icon("stop", 12)}${pending === "stopping" ? "Stopping…" : "Stop"}</button></div>
      ${loading ? `<div class="ll-bar"><div class="ll-bar-fill load"></div><i class="ll-sheen"></i></div>` : ""}`;
    $("#st-stop")?.addEventListener("click", () => confirmStrataStop(name, st));
  }

  const vram = (st.gpu_mem_used != null && st.gpu_mem_total)
    ? `${(st.gpu_mem_used / 2 ** 30).toFixed(1)} / ${(st.gpu_mem_total / 2 ** 30).toFixed(1)} GiB` : "—";
  const ram = (st.ram_used != null && st.ram_total)
    ? `${(st.ram_used / 2 ** 30).toFixed(1)} / ${(st.ram_total / 2 ** 30).toFixed(1)} GiB` : "—";
  metrics.innerHTML = st.running ? `<div class="st-grid">
    <div class="st-metric"><span>Decode</span><b>${stVal(st.tok_s == null ? null : +st.tok_s.toFixed(1), " tok/s")}</b><small>mean ${stVal(st.tok_s_mean == null ? null : +st.tok_s_mean.toFixed(1), " tok/s")}</small></div>
    <div class="st-metric"><span>Request</span><b>${st.busy ? esc(st.phase || st.state || "busy") : "idle"}</b><small>${stVal(st.generated, " generated")} · ${stVal(st.queued, " queued")}</small></div>
    <div class="st-metric"><span>Context</span><b>${stVal(st.prompt_tokens == null ? null : Number(st.prompt_tokens).toLocaleString())}</b><small>of ${stVal(st.max_context == null ? null : Number(st.max_context).toLocaleString())} tokens</small></div>
    <div class="st-metric"><span>Expert cache</span><b>${stGiB(st.expert_cache_mib)}</b><small>${stGiB(st.vram_free_mib)} VRAM free · ${stVal(st.file_blobs, " file-tier blobs")}</small></div>
    <div class="st-metric"><span>GPU</span><b>${stVal(st.gpu_util, "%")}</b><small>${vram}</small></div>
    <div class="st-metric"><span>RAM</span><b>${ram}</b><small>${stVal(st.requests, " requests total")}</small></div>
  </div>` : `<div class="dk-none">${icon("activity", 15)}telemetry appears after the model server is running</div>`;

  profile.innerHTML = `<div class="st-profile">
    <div><span>Model</span><b>${esc(st.model || "qwen3.8-flash-next-iq2_xs")}</b></div>
    <div><span>Engine</span><b>${esc(st.engine_version || "—")}</b></div>
    <div><span>Context</span><b>${stVal(st.max_context == null ? null : Number(st.max_context).toLocaleString(), " tokens")}</b></div>
    <div><span>KV cache</span><b>${esc(st.kv || "—")}</b></div>
    <div><span>Vision</span><b>${st.images ? "GPU reader enabled" : (st.ready ? "disabled" : "—")}</b></div>
    <div><span>Profile</span><b class="mono">~/.local/share/strata/install/strata-iq2_xs.json</b></div>
  </div>`;
}

async function doStrataAction(node, act) {
  try {
    const r = await sendStrataAction(node, act);
    stCache[node] = "";
    return r;
  } catch (e) {
    toast(`${act.cmd} failed: ${e.message}`, false);
    return { ok: false, error: e.message };
  }
}

function confirmStrataStart(node, llama) {
  const replacing = llama.running
    ? `<p class="st-warning">llama.cpp pid ${llama.pid} will be stopped first. Both engines share the GPU and port 8080.</p>` : "";
  openModal(`<h3>Start Strata?</h3>
    <p><b>Qwen3.8-Flash-Next IQ2_XS</b> · 210,944-token context · vision enabled</p>
    ${replacing}<p style="color:var(--faint);font-size:11.5px">Startup loads the configured profile and can take a moment. The API key remains local to this node.</p>
    <div class="m-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="go">${icon("play", 12)}Start</button></div>`);
  $$(".m-actions .btn").forEach(btn => btn.addEventListener("click", async () => {
    if (btn.dataset.act === "cancel") return closeModal();
    btn.disabled = true;
    const r = await doStrataAction(node, { cmd: "start" });
    if (r.ok) { stPending[node] = "starting"; toast(`Strata starting (pid ${r.pid})`, true); }
    else toast(r.error || "start failed", false);
    closeModal();
  }));
}

function confirmStrataStop(node, st) {
  openModal(`<h3>Stop Strata?</h3><p><b class="mono">${esc(st.model || "Strata")}</b> — pid ${st.pid}</p>
    <p style="color:var(--faint);font-size:11.5px">SIGTERM is allowed 15 seconds before escalation. Active requests lose their connection.</p>
    <div class="m-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn btn-danger" data-act="stop">Stop</button><button class="btn btn-kilo" data-act="stop9">Stop (force)</button></div>`);
  $$(".m-actions .btn").forEach(btn => btn.addEventListener("click", async () => {
    if (btn.dataset.act === "cancel") return closeModal();
    btn.disabled = true;
    const r = await doStrataAction(node, { cmd: "stop", force: btn.dataset.act === "stop9" });
    if (r.ok) { stPending[node] = "stopping"; toast(`Strata stopped (pid ${r.pid}, sig ${r.sig})`, true); }
    else toast(r.error || "stop failed", false);
    closeModal();
  }));
}

/* ---------------- poll + router ---------------- */

function setLiveBadge() {
  const live = $(".live");
  if (!live) return;
  const t = $(".live-txt", live);
  if (t) t.textContent = state.online ? "LIVE" : "OFFLINE";
  live.classList.toggle("off", !state.online);
}

async function tick() {
  try {
    const d = await getState();
    state.online = true;
    state.nodes = d.nodes;
    state.serverTs = d.ts;
    state.ddns = d.ddns || null;
    state.wol = d.wol || null;
    state.install = d.install || null;
    Object.values(d.nodes).forEach(nd => {
      if (nd.latest && nd.latest.ts) appendLive(Object.keys(d.nodes).find(n => d.nodes[n] === nd), nd.latest);
    });
  } catch (e) {
    state.online = false;
    setLiveBadge();
    $("#view").innerHTML = `<div class="empty"><div class="e-big">⌁</div>
      ${esc(e.message === "unauthorized" ? "API key required — enter the panel API key in the dialog to continue." : "Cannot reach the Pulse server. Is it running?")}</div>`;
    return;
  }
  setLiveBadge();
  renderPills();
  if (!state.view) route();
  else if (state.view.type === "overview") {
    // cards may need rebuilding if node set changed
    if ($$("#ov-cards .card").length !== Object.keys(state.nodes).filter(n => state.nodes[n].latest).length)
      buildOverviewCards();
    else updateOverviewCards();
  } else if (state.view.type === "node") {
    updateNodeView();
  } else if (state.view.type === "main") {
    updateMain();
  }
}

function route() {
  const h = location.hash || "#/";
  if (h.startsWith("#/node/")) {
    const parts = h.slice(7).split("/");
    openNode(decodeURIComponent(parts[0] || ""), parts.length > 1 ? decodeURIComponent(parts[1]) : "system");
  }
  else if (h === "#/main" || h.startsWith("#/main/")) openMain();
  else if (h === "#/install" || h.startsWith("#/install/")) openInstall();
  else openOverview();
  renderPills();  // active pill should not wait for the next tick
}

window.addEventListener("hashchange", route);
window.addEventListener("resize", () => {
  if (state.view && state.view.type === "overview") updateOverviewCards();
  else if (state.view && state.view.type === "node") updateNodeView();
  else if (state.view && state.view.type === "main") updateMain();
});

/* self-rescheduling poll loop: re-reads pollMs every cycle so the
   top-bar interval input takes effect immediately; never stacks ticks */
let tickBusy = false;
function scheduleTick() {
  setTimeout(async () => {
    if (!tickBusy) {
      tickBusy = true;
      try { await tick(); } finally { tickBusy = false; }
    }
    scheduleTick();
  }, pollMs);
}

/* refresh interval — custom dropdown (100ms … 10s), persisted in localStorage */
const POLL_OPTS = [100, 500, 1000, 2000, 5000, 10000];
const pollBtn = $("#poll-btn");
const pollDrop = $("#poll-drop");
const pollLabel = $("#poll-label");
function fmtPoll(ms) { return ms >= 1000 ? (ms / 1000) + "s" : ms + "ms"; }
function closePollDrop() {
  if (!pollDrop || pollDrop.hidden) return;
  pollDrop.hidden = true;
  if (pollBtn) pollBtn.setAttribute("aria-expanded", "false");
}
function setPollMs(v) {
  v = Math.min(60000, Math.max(100, Math.round(v)));
  pollMs = v;
  if (pollLabel) pollLabel.textContent = fmtPoll(v);
  if (pollDrop) $$(".pd-opt", pollDrop).forEach(b => {
    const sel = +b.dataset.ms === v;
    b.classList.toggle("sel", sel);
    b.setAttribute("aria-selected", sel ? "true" : "false");
  });
  try { localStorage.setItem("pulse.pollMs", String(v)); } catch (e) {}
}
if (pollBtn && pollDrop) {
  if (!POLL_OPTS.includes(pollMs))  // legacy custom value → snap to nearest preset
    pollMs = POLL_OPTS.reduce((a, b) => Math.abs(b - pollMs) < Math.abs(a - pollMs) ? b : a);
  setPollMs(pollMs);
  pollBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = pollDrop.hidden;
    pollDrop.hidden = !open;
    pollBtn.setAttribute("aria-expanded", String(open));
  });
  pollDrop.addEventListener("click", (e) => {
    const b = e.target.closest(".pd-opt");
    if (!b) return;
    setPollMs(+b.dataset.ms);
    closePollDrop();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#pollctl")) closePollDrop();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePollDrop(); });
}

setInterval(() => {
  if (llConsoleOpen && state.view && state.view.type === "node" &&
      state.view.tab === "llama") llConsoleFetch(state.view.name);
  if (stConsoleOpen && state.view && state.view.type === "node" &&
      state.view.tab === "strata") stConsoleFetch(state.view.name);
}, 2000);

scheduleTick();
tick();
