/* =============================================================================
   SSC AI — Frontend Application Logic
   Synergy Science Circle — "United by Logic, Driven by Science"
   Vanilla JS, no build step. Talks to the SSC AI backend over SSE.
   ============================================================================= */
"use strict";

/* ---------------------------------------------------------------------------
   0. CONFIG + STATE
--------------------------------------------------------------------------- */
const DEFAULTS = {
  // Pre-configured so the app works with zero setup. If you deploy your own
  // backend (see backend/README.md), change this to your own Render URL —
  // or just paste it once into Settings → General → Backend URL, which is
  // saved locally and always takes priority over this default.
  backendUrl: localStorage.getItem("ssc_backend_url") || "https://ssc-ai.onrender.com",
  theme: localStorage.getItem("ssc_theme") || "dark",
  persona: "researcher",
  model: "gemini-2.5-flash",
  language: "en",
};

const PERSONAS = [
  { id: "researcher", name: "Researcher", desc: "Rigorous, evidence-first, cites reasoning" },
  { id: "educator", name: "Educator", desc: "Clear, patient, builds from fundamentals" },
  { id: "innovator", name: "Innovator", desc: "Novel angles, practical inventiveness" },
  { id: "philosopher", name: "Philosopher", desc: "Probes assumptions, explores frameworks" },
  { id: "critical-thinker", name: "Critical Thinker", desc: "Stress-tests arguments and evidence" },
  { id: "custom", name: "Custom", desc: "Your own persona prompt (Settings → General)" },
];

const MODELS = [
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", short: "Flash", desc: "Fast, balanced default" },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", short: "Flash Lite", desc: "Lightweight & quick" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", short: "2.0 Flash", desc: "Prior generation, reliable" },
  { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", short: "1.5 Flash", desc: "Fallback model" },
];

const LANGUAGES = [
  { id: "en", name: "English" }, { id: "fr", name: "French" }, { id: "es", name: "Spanish" },
  { id: "ar", name: "Arabic" }, { id: "zh", name: "Chinese" }, { id: "ha", name: "Hausa" },
  { id: "yo", name: "Yoruba" }, { id: "ig", name: "Igbo" },
];

const state = {
  backendUrl: DEFAULTS.backendUrl,
  theme: DEFAULTS.theme,
  persona: localStorage.getItem("ssc_persona") || DEFAULTS.persona,
  customPersonaPrompt: localStorage.getItem("ssc_custom_persona") || "",
  systemPromptOverride: localStorage.getItem("ssc_system_override") || "",
  model: localStorage.getItem("ssc_model") || DEFAULTS.model,
  language: localStorage.getItem("ssc_language") || DEFAULTS.language,
  webSearch: localStorage.getItem("ssc_websearch") === "1",
  deepThink: localStorage.getItem("ssc_deepthink") === "1",
  mastermind: localStorage.getItem("ssc_mastermind") === "1",
  temperature: parseFloat(localStorage.getItem("ssc_temperature") || "0.7"),
  maxTokens: parseInt(localStorage.getItem("ssc_maxtokens") || "2048", 10),
  showThinking: localStorage.getItem("ssc_showthinking") !== "0",

  sessions: [],          // [{id,title,pinned,createdAt,messages:[]}]
  currentSessionId: null,
  pinnedMessages: JSON.parse(localStorage.getItem("ssc_pinned_msgs") || "[]"),

  generating: false,
  abortController: null,
  analytics: JSON.parse(localStorage.getItem("ssc_analytics") || '{"requests":0,"tokens":0}'),
  cache: new Map(),      // prompt-hash -> {text, ts}
  attachedFiles: [],     // files staged for the next send
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue; // skip null/undefined so conditional attrs (selected, checked...) aren't stringified to "null"
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "selected" || k === "disabled" || k === "readonly") { if (v) node.setAttribute(k, ""); node[k] = !!v; }
    else node.setAttribute(k, v);
  }
  children.flat().forEach((c) => {
    if (c == null) return;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return node;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const approxTokens = (s) => Math.ceil((s || "").length / 4);

function toast(msg, type = "info") {
  const host = $("#toast-host");
  const t = el("div", { class: "toast" }, msg);
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, 2600);
}

// Shared clipboard helper: some WebView/browser contexts restrict clipboard
// access, in which case navigator.clipboard.writeText rejects. Handle that
// gracefully with a clear toast instead of a silent/uncaught rejection.
function copyToClipboard(text, successMessage = "Copied to clipboard") {
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    toast("Clipboard isn't available in this browser");
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => toast(successMessage),
    () => toast("Couldn't copy — clipboard access was blocked")
  );
}

/* ---------------------------------------------------------------------------
   1. THEME
--------------------------------------------------------------------------- */
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("ssc_theme", theme);
  const icon = $("#theme-icon");
  icon.innerHTML =
    theme === "dark"
      ? '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>'
      : '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>';
}
$("#theme-toggle").addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));

/* ---------------------------------------------------------------------------
   2. PARTICLE BACKGROUND (subtle gold/silver drift, matches crest atom motif)
--------------------------------------------------------------------------- */
(function particles() {
  const canvas = $("#particles");
  const ctx = canvas.getContext("2d");
  let w, h, particlesArr;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  function makeParticles() {
    const count = Math.min(70, Math.floor((w * h) / 22000));
    particlesArr = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.6 + 0.4,
      vx: (Math.random() - 0.5) * 0.12,
      vy: (Math.random() - 0.5) * 0.12,
      hue: Math.random() > 0.5 ? "217,179,77" : "185,194,207",
      a: Math.random() * 0.5 + 0.15,
    }));
  }
  function tick() {
    ctx.clearRect(0, 0, w, h);
    for (const p of particlesArr) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.hue},${p.a})`;
      ctx.fill();
    }
    requestAnimationFrame(tick);
  }
  window.addEventListener("resize", () => { resize(); makeParticles(); });
  resize(); makeParticles(); tick();
})();

/* ---------------------------------------------------------------------------
   3. STORAGE — sessions, backed by IndexedDB
   IndexedDB comfortably holds tens of MB (vs. localStorage's ~5-10MB cap),
   which matters once conversations include pasted file content. state.sessions
   stays as the in-memory source of truth (so the rest of the app can keep
   reading/writing it synchronously); persistSessions() writes through to
   IndexedDB asynchronously in the background. A one-time migration pulls in
   any sessions saved by older versions of SSC AI that used localStorage.
--------------------------------------------------------------------------- */
const SESSIONS_KEY = "ssc_sessions_v1"; // legacy localStorage key, used for migration only
const MAX_SESSIONS = 30;
const IDB_NAME = "ssc_ai_db";
const IDB_VERSION = 1;
const IDB_STORE = "sessions";
const IDB_RECORD_KEY = "all_sessions";

let idbHandle = null; // cached open IDBDatabase, or null if unavailable
function openIdb() {
  return new Promise((resolve) => {
    if (idbHandle) return resolve(idbHandle);
    if (!("indexedDB" in window)) return resolve(null);
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => { idbHandle = req.result; resolve(idbHandle); };
      req.onerror = () => resolve(null); // IndexedDB unavailable (e.g. private browsing) — caller falls back
    } catch { resolve(null); }
  });
}
async function idbGet(key) {
  const db = await openIdb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}
async function idbSet(key, value) {
  const db = await openIdb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch { resolve(false); }
  });
}

async function loadSessions() {
  try {
    const fromIdb = await idbGet(IDB_RECORD_KEY);
    if (Array.isArray(fromIdb)) {
      state.sessions = fromIdb;
      return;
    }
    // Nothing in IndexedDB yet — migrate any legacy localStorage data once.
    const legacy = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
    state.sessions = Array.isArray(legacy) ? legacy : [];
    if (state.sessions.length) {
      await idbSet(IDB_RECORD_KEY, state.sessions);
      localStorage.removeItem(SESSIONS_KEY); // migration complete, free the space
    }
  } catch {
    state.sessions = [];
  }
}
function persistSessions() {
  // Keep newest 30 (pinned always kept, oldest unpinned dropped first)
  let sessions = [...state.sessions];
  if (sessions.length > MAX_SESSIONS) {
    const pinned = sessions.filter((s) => s.pinned);
    const unpinned = sessions.filter((s) => !s.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
    sessions = [...pinned, ...unpinned].slice(0, MAX_SESSIONS);
    state.sessions = sessions;
  }
  // Fire-and-forget async write; state.sessions (in-memory) is already the
  // source of truth for everything the UI reads synchronously.
  idbSet(IDB_RECORD_KEY, sessions).then((ok) => {
    if (!ok) {
      // IndexedDB unavailable — fall back to localStorage so history still
      // survives a reload, within its smaller size limit.
      try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions)); } catch { /* storage full/unavailable */ }
    }
  });
}
function getCurrentSession() {
  return state.sessions.find((s) => s.id === state.currentSessionId);
}
function createSession() {
  const s = {
    id: uid(), title: "New Conversation", titleAuto: true, pinned: false,
    createdAt: Date.now(), updatedAt: Date.now(), messages: [],
    settings: {
      persona: state.persona, model: state.model, language: state.language,
      webSearch: state.webSearch, deepThink: state.deepThink, mastermind: state.mastermind,
    },
  };
  state.sessions.unshift(s);
  state.currentSessionId = s.id;
  persistSessions();
  return s;
}
// Applies a session's saved settings snapshot to the active/global state and
// refreshes the top bar to reflect it. Falls back gracefully for sessions
// created before this feature existed (no `settings` field yet).
function applySessionSettings(session) {
  if (!session) return;
  const defaults = { persona: state.persona, model: state.model, language: state.language, webSearch: state.webSearch, deepThink: state.deepThink, mastermind: state.mastermind };
  const s = session.settings || defaults;
  state.persona = s.persona ?? defaults.persona;
  state.model = s.model ?? defaults.model;
  state.language = s.language ?? defaults.language;
  state.webSearch = s.webSearch ?? defaults.webSearch;
  state.deepThink = s.deepThink ?? defaults.deepThink;
  state.mastermind = s.mastermind ?? defaults.mastermind;
  if (!session.settings) session.settings = { ...defaults };
  refreshTopbarLabels();
}
function syncCurrentSessionSettings() {
  const s = getCurrentSession();
  if (!s) return;
  s.settings = { persona: state.persona, model: state.model, language: state.language, webSearch: state.webSearch, deepThink: state.deepThink, mastermind: state.mastermind };
  persistSessions();
}
function saveCurrentSession() {
  const s = getCurrentSession();
  if (!s) return;
  s.updatedAt = Date.now();
  persistSessions();
}

/* ---------------------------------------------------------------------------
   4. POPOVER (generic dropdown) + MODAL + CONFIRM system
--------------------------------------------------------------------------- */
const popover = $("#popover");
let popoverCloseHandler = null;

function openPopover(anchorEl, items, { selectedId, onSelect, width } = {}) {
  popover.innerHTML = "";
  if (width) popover.style.minWidth = width;
  items.forEach((item) => {
    if (item.divider) { popover.appendChild(el("div", { class: "popover-divider" })); return; }
    const row = el(
      "div",
      { class: "popover-item" + (item.id === selectedId ? " selected" : ""), onclick: () => { onSelect(item.id); closePopover(); } },
      el("b", {}, item.name, item.id === selectedId ? "✓" : ""),
      item.desc ? el("span", {}, item.desc) : null
    );
    popover.appendChild(row);
  });
  const rect = anchorEl.getBoundingClientRect();
  popover.classList.add("show");
  const pw = popover.offsetWidth || 220;
  let left = rect.left;
  if (left + pw > window.innerWidth - 10) left = window.innerWidth - pw - 10;
  popover.style.top = rect.bottom + 8 + "px";
  popover.style.left = Math.max(10, left) + "px";

  popoverCloseHandler = (e) => {
    if (!popover.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) closePopover();
  };
  setTimeout(() => document.addEventListener("click", popoverCloseHandler), 0);
}
function closePopover() {
  popover.classList.remove("show");
  if (popoverCloseHandler) document.removeEventListener("click", popoverCloseHandler);
}

function openModal(id) { $("#" + id).classList.add("show"); }
function closeModal(id) { $("#" + id).classList.remove("show"); }
$$("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(b.dataset.close)));
$$(".modal-overlay").forEach((ov) => ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.remove("show"); }));

function confirmDialog({ title, message, confirmLabel = "Delete", danger = true, onConfirm }) {
  $("#confirm-body").innerHTML = "";
  $("#confirm-body").appendChild(
    el(
      "div",
      {},
      el("svg", { class: "warn-ico", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", html: '<circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/>' }),
      el("p", { style: "font-weight:600;color:var(--text);" }, title),
      el("p", {}, message)
    )
  );
  const foot = $("#confirm-foot");
  foot.innerHTML = "";
  const cancelBtn = el("button", { class: "btn", onclick: () => closeModal("confirm-overlay") }, "Cancel");
  const okBtn = el("button", { class: "btn " + (danger ? "danger" : "primary"), onclick: () => { closeModal("confirm-overlay"); onConfirm(); } }, confirmLabel);
  foot.appendChild(cancelBtn); foot.appendChild(okBtn);
  openModal("confirm-overlay");
}

/* ---------------------------------------------------------------------------
   5. TOP BAR DROPDOWNS: persona / model, and toggle chips
--------------------------------------------------------------------------- */
function refreshTopbarLabels() {
  $("#persona-label").textContent = PERSONAS.find((p) => p.id === state.persona)?.name || "Persona";
  $("#model-label").textContent = MODELS.find((m) => m.id === state.model)?.short || "Model";
  $("#websearch-toggle").classList.toggle("on", state.webSearch);
  $("#deepthink-toggle").classList.toggle("on", state.deepThink);
  $("#mastermind-toggle").classList.toggle("on", state.mastermind);
}
$("#persona-trigger").addEventListener("click", () =>
  openPopover($("#persona-trigger"), PERSONAS, {
    selectedId: state.persona,
    onSelect: (id) => { state.persona = id; localStorage.setItem("ssc_persona", id); refreshTopbarLabels(); syncCurrentSessionSettings(); },
  })
);
$("#model-trigger").addEventListener("click", () =>
  openPopover($("#model-trigger"), MODELS, {
    selectedId: state.model,
    onSelect: (id) => { state.model = id; localStorage.setItem("ssc_model", id); refreshTopbarLabels(); syncCurrentSessionSettings(); },
    width: "260px",
  })
);
$("#websearch-toggle").addEventListener("click", () => { state.webSearch = !state.webSearch; localStorage.setItem("ssc_websearch", state.webSearch ? "1" : "0"); refreshTopbarLabels(); syncCurrentSessionSettings(); });
$("#deepthink-toggle").addEventListener("click", () => { state.deepThink = !state.deepThink; localStorage.setItem("ssc_deepthink", state.deepThink ? "1" : "0"); refreshTopbarLabels(); syncCurrentSessionSettings(); });
$("#mastermind-toggle").addEventListener("click", () => { state.mastermind = !state.mastermind; localStorage.setItem("ssc_mastermind", state.mastermind ? "1" : "0"); refreshTopbarLabels(); syncCurrentSessionSettings(); });

/* ---------------------------------------------------------------------------
   6. SIDEBAR — session list rendering
--------------------------------------------------------------------------- */
function renderSessionList(filter = "") {
  const list = $("#session-list");
  list.innerHTML = "";
  const q = filter.trim().toLowerCase();
  const sorted = [...state.sessions].sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  const filtered = q
    ? sorted.filter((s) => s.title.toLowerCase().includes(q) || new Date(s.createdAt).toLocaleDateString().includes(q))
    : sorted;

  if (filtered.length === 0) {
    list.appendChild(el("div", { style: "padding:20px 10px;text-align:center;color:var(--text-dim);font-size:12px;" }, "No conversations yet."));
    return;
  }

  filtered.forEach((s) => {
    const row = el(
      "div",
      { class: "session-item" + (s.id === state.currentSessionId ? " active" : "") + (s.pinned ? " pinned" : ""),
        onclick: () => { loadSession(s.id); if (window.innerWidth <= 800) closeSidebar(); } },
      el("svg", { class: "pin-ico", viewBox: "0 0 24 24", fill: s.pinned ? "currentColor" : "none", stroke: "currentColor", "stroke-width": "2", html: '<path d="M12 17v5M9 3h6l-1 7 4 3H6l4-3-1-7z"/>' }),
      el("span", { class: "stitle" }, s.title || "Untitled")
    );
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); openSessionContextMenu(e, s); });
    let pressTimer;
    row.addEventListener("touchstart", () => { pressTimer = setTimeout(() => openSessionContextMenu({ clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 }, s), 550); });
    row.addEventListener("touchend", () => clearTimeout(pressTimer));
    list.appendChild(row);
  });
}
$("#session-search").addEventListener("input", (e) => renderSessionList(e.target.value));

function openSessionContextMenu(e, session) {
  const items = [
    { id: "rename", name: "Rename", desc: "Edit conversation title" },
    { id: "regen-title", name: "Regenerate title", desc: "Ask SSC AI for a fresh title", disabled: session.messages.length === 0 },
    { id: "summarize", name: "Summarize conversation", desc: "AI-generated bullet summary", disabled: session.messages.length === 0 },
    { id: "pin", name: session.pinned ? "Unpin" : "Pin", desc: session.pinned ? "Remove from pinned" : "Keep at top of list" },
    { id: "export-txt", name: "Export as .txt", desc: "Plain text transcript" },
    { id: "export-md", name: "Export as .md", desc: "Markdown transcript" },
    { divider: true },
    { id: "delete", name: "Delete conversation", desc: "This cannot be undone" },
  ];
  const fakeAnchor = document.body;
  popover.innerHTML = "";
  items.forEach((item) => {
    if (item.divider) { popover.appendChild(el("div", { class: "popover-divider" })); return; }
    popover.appendChild(
      el("div", {
        class: "popover-item" + (item.disabled ? " disabled" : ""),
        style: item.disabled ? "opacity:.4;pointer-events:none;" : "",
        onclick: () => { handleSessionAction(item.id, session); closePopover(); },
      },
        el("b", { style: item.id === "delete" ? "color:var(--danger)" : "" }, item.name),
        item.desc ? el("span", {}, item.desc) : null)
    );
  });
  popover.classList.add("show");
  popover.style.top = Math.min(e.clientY, window.innerHeight - 260) + "px";
  popover.style.left = Math.min(e.clientX, window.innerWidth - 240) + "px";
  setTimeout(() => document.addEventListener("click", popoverCloseHandler = (ev) => { if (!popover.contains(ev.target)) closePopover(); }), 0);
}
function handleSessionAction(action, session) {
  if (action === "rename") {
    const newTitle = prompt("Rename conversation:", session.title);
    if (newTitle && newTitle.trim()) { session.title = newTitle.trim(); session.titleAuto = false; persistSessions(); renderSessionList(); if (session.id === state.currentSessionId) $("#topbar-title").textContent = session.title; }
  } else if (action === "regen-title") {
    if (session.messages.length === 0) return;
    session.titleAuto = true; // re-allow auto title to apply the result
    toast("Regenerating title…");
    generateSmartTitle(session);
  } else if (action === "summarize") {
    if (session.messages.length === 0) return;
    summarizeSession(session);
  } else if (action === "pin") {
    session.pinned = !session.pinned; persistSessions(); renderSessionList();
  } else if (action === "export-txt" || action === "export-md") {
    exportSession(session, action === "export-md" ? "md" : "txt");
  } else if (action === "delete") {
    confirmDialog({
      title: "Delete this conversation?",
      message: `"${session.title}" and all its messages will be permanently removed.`,
      onConfirm: () => {
        state.sessions = state.sessions.filter((s) => s.id !== session.id);
        persistSessions();
        if (state.currentSessionId === session.id) { state.currentSessionId = null; startNewChat(); }
        renderSessionList();
        toast("Conversation deleted");
      },
    });
  }
}
function exportSession(session, format) {
  let content;
  if (format === "md") {
    content = `# ${session.title}\n\n` + session.messages.map((m) => `**${m.role === "user" ? "You" : "SSC AI"}:**\n\n${m.content}\n`).join("\n---\n\n");
  } else {
    content = session.messages.map((m) => `${m.role === "user" ? "You" : "SSC AI"}: ${m.content}`).join("\n\n");
  }
  const blob = new Blob([content], { type: "text/plain" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `${session.title.replace(/[^\w-]+/g, "_")}.${format}` });
  document.body.appendChild(a); a.click(); a.remove();
}

function closeSidebar() { $("#sidebar").classList.remove("open"); }
function openSidebar() { $("#sidebar").classList.add("open"); }
$("#menu-toggle").addEventListener("click", openSidebar);
$("#sidebar-scrim").addEventListener("click", closeSidebar);

/* ---------------------------------------------------------------------------
   7. MESSAGE RENDERING — markdown, code, math, thinking blocks, tables
--------------------------------------------------------------------------- */
marked.setOptions({ breaks: true, gfm: true });

function renderMarkdownToHtml(raw) {
  // Pull out <thinking>...</thinking> blocks before markdown parsing
  let thinkingHtml = "";
  let text = raw.replace(/<thinking>([\s\S]*?)<\/thinking>/gi, (_, inner) => {
    if (state.showThinking) {
      thinkingHtml += `<details class="thinking-block"><summary>SSC AI reasoning</summary><div>${escapeHtml(inner.trim())}</div></details>`;
    }
    return "";
  });

  // Protect math segments from markdown/HTML mangling using placeholders
  const mathStore = [];
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => { mathStore.push({ tex: m, display: true }); return `@@MATH${mathStore.length - 1}@@`; });
  text = text.replace(/\$([^\n$]+?)\$/g, (_, m) => { mathStore.push({ tex: m, display: false }); return `@@MATH${mathStore.length - 1}@@`; });

  let html = marked.parse(text);

  mathStore.forEach((m, i) => {
    let rendered;
    try { rendered = katex.renderToString(m.tex, { throwOnError: false, displayMode: m.display }); }
    catch { rendered = escapeHtml(m.tex); }
    html = html.replace(`@@MATH${i}@@`, rendered);
  });

  return thinkingHtml + html;
}

function enhanceCodeBlocks(container) {
  $$("pre code", container).forEach((block) => {
    if (block.dataset.enhanced) return;
    block.dataset.enhanced = "1";
    hljs.highlightElement(block);
    const pre = block.parentElement;
    const lang = (block.className.match(/language-(\w+)/) || [, "text"])[1];
    const wrap = el("div", { class: "codeblock" });
    const head = el(
      "div", { class: "codeblock-head", onclick: (e) => { if (e.target.tagName !== "BUTTON") wrap.classList.toggle("collapsed"); } },
      el("span", {}, lang),
      el("div", { class: "cb-actions" },
        el("button", { onclick: (e) => { e.stopPropagation(); copyToClipboard(block.textContent, "Code copied"); } }, "Copy"),
        el("button", { onclick: (e) => { e.stopPropagation(); wrap.classList.toggle("collapsed"); } }, "Toggle"))
    );
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(head);
    wrap.appendChild(pre);
  });
}

function formatMarkdownTables(container) {
  // marked+gfm already handles standard pipe tables; nothing extra required,
  // styling is handled in CSS (.bubble table).
}

/* ---------------------------------------------------------------------------
   8. FILE HANDLING — upload, PDF.js / Mammoth.js extraction
--------------------------------------------------------------------------- */
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const FILE_TRUNCATE_LIMIT = 50000;

async function extractFileText(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "pdf") {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((it) => it.str).join(" ") + "\n";
      if (text.length > FILE_TRUNCATE_LIMIT) break;
    }
    return text;
  }
  if (ext === "docx") {
    const buf = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buf });
    return result.value;
  }
  // plain-text-like formats
  return await file.text();
}

async function handleFiles(fileList) {
  for (const file of Array.from(fileList)) {
    try {
      const text = (await extractFileText(file)).slice(0, FILE_TRUNCATE_LIMIT);
      state.attachedFiles.push({ name: file.name, size: file.size, text });
      renderAttachRow();
    } catch (err) {
      toast(`Couldn't read ${file.name}: ${err.message}`);
    }
  }
}
function renderAttachRow() {
  const row = $("#attach-row");
  row.innerHTML = "";
  state.attachedFiles.forEach((f, idx) => {
    row.appendChild(
      el("div", { class: "file-chip" },
        el("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", html: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>' }),
        el("span", { class: "fname" }, `${f.name} · ${(f.size / 1024).toFixed(0)}KB`),
        el("button", { style: "background:none;border:none;color:inherit;cursor:pointer;margin-left:4px;", onclick: () => { state.attachedFiles.splice(idx, 1); renderAttachRow(); } }, "✕"))
    );
  });
}
$("#attach-btn").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (e) => { handleFiles(e.target.files); e.target.value = ""; });

const dropZone = $("#composer");
["dragover", "dragenter"].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.style.borderColor = "var(--gold)"; }));
["dragleave", "drop"].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.style.borderColor = "var(--border)"; }));
dropZone.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

/* ---------------------------------------------------------------------------
   9. CHAT RENDERING
--------------------------------------------------------------------------- */
const chatInner = $("#chat-inner");

function aiAvatarSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="#151008" stroke-width="2"><circle cx="12" cy="12" r="2.2" fill="#151008"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/></svg>';
}
function userAvatarSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>';
}

function renderWelcome() {
  chatInner.innerHTML = "";
  chatInner.appendChild(
    el("div", { class: "welcome" },
      el("div", { class: "atom-mark", html: `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="#d9b34d" stroke-width="1.4"><circle cx="12" cy="12" r="1.8" fill="#f6d774"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/></svg>` }),
      el("h1", {}, "SSC AI"),
      el("p", {}, "United by Logic, Driven by Science. Ask me anything — research, code, math, or a question about the world."),
      el("div", { class: "suggest-row" },
        ...["Explain quantum entanglement simply", "Help me debug a Python function", "Summarize this week's AI news", "Draft a research abstract outline"]
          .map((q) => el("div", { class: "suggest-chip", onclick: () => { $("#msg-input").value = q; sendMessage(); } }, q)))
    )
  );
}

function scrollToBottom() { $("#chat-scroll").scrollTop = $("#chat-scroll").scrollHeight; }

/* ---- Scroll-to-bottom FAB: appears when the user has scrolled up away
   from the latest message (e.g. to read earlier context while a response
   is streaming), and jumps back down on click. ---- */
(function scrollFab() {
  const scrollEl = $("#chat-scroll");
  const fab = $("#scroll-bottom-fab");
  const isNearBottom = () => scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120;
  scrollEl.addEventListener("scroll", () => { fab.classList.toggle("show", !isNearBottom()); });
  fab.addEventListener("click", () => { scrollToBottom(); fab.classList.remove("show"); });
})();

function renderAllMessages() {
  const s = getCurrentSession();
  chatInner.innerHTML = "";
  if (!s || s.messages.length === 0) { renderWelcome(); return; }
  s.messages.forEach((m) => chatInner.appendChild(buildMessageRow(m)));
  $$(".bubble", chatInner).forEach((b) => { enhanceCodeBlocks(b); });
  scrollToBottom();
}

function buildMessageRow(m) {
  const isUser = m.role === "user";
  const row = el("div", { class: "msg-row " + (isUser ? "user" : "ai"), "data-mid": m.id });
  const avatar = el("div", { class: "avatar" + (isUser ? "" : " ai"), html: isUser ? userAvatarSvg() : aiAvatarSvg() });

  const bubble = el("div", { class: "bubble" });
  if (m.isErrorPlaceholder) {
    bubble.appendChild(
      el("div", { class: "error-placeholder" },
        el("span", {}, "⚠ " + m.content),
        el("button", { class: "btn", style: "margin-top:8px;", onclick: () => retryMessage(m) }, "Retry"))
    );
  } else {
    bubble.innerHTML = renderMarkdownToHtml(m.content || "");
  }

  const PROVIDER_LABELS = { google: "Google", duckduckgo: "DDG" };
  const sourcesRow = (!isUser && m.sources && m.sources.length)
    ? (() => {
        const chipsWrap = el("div", { class: "sources-chips" },
          ...m.sources.slice(0, 8).map((s) =>
            el("a", { class: "source-chip", href: s.uri, target: "_blank", rel: "noopener noreferrer", title: s.uri },
              s.provider && PROVIDER_LABELS[s.provider] ? el("span", { class: "provider-badge" }, PROVIDER_LABELS[s.provider]) : null,
              (s.title || s.uri || "").slice(0, 40))));
        const wrap = el("div", { class: "sources-row" });
        const toggle = el("button", { class: "sources-toggle", onclick: () => wrap.classList.toggle("expanded") },
          el("svg", { class: "chev", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "3", html: '<path d="M6 9l6 6 6-6"/>' }),
          el("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", html: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 010 20 15 15 0 010-20z"/>' }),
          `Sources (${m.sources.length})`);
        wrap.appendChild(toggle);
        wrap.appendChild(chipsWrap);
        return wrap;
      })()
    : null;

  const meta = el("div", { class: "msg-meta" },
    el("span", {}, new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
    !isUser && m.model ? el("span", {}, "· " + m.model) : null
  );

  const actions = el("div", { class: "msg-actions" });
  actions.appendChild(iconActionBtn("copy", () => copyToClipboard(m.content)));
  if (isUser) {
    actions.appendChild(iconActionBtn("edit", () => beginEditMessage(m, bubble)));
  } else {
    actions.appendChild(iconActionBtn("retry", () => retryMessage(m)));
    actions.appendChild(iconActionBtn("speak", () => speakText(m.content)));
    actions.appendChild(iconActionBtn("like", () => toggleFeedback(m, "like"), m.feedback === "like"));
    actions.appendChild(iconActionBtn("dislike", () => toggleFeedback(m, "dislike"), m.feedback === "dislike"));
    actions.appendChild(iconActionBtn("fork", () => forkConversation(m)));
  }
  actions.appendChild(iconActionBtn("pin", () => togglePinMessage(m), state.pinnedMessages.includes(m.id)));
  actions.appendChild(iconActionBtn("delete", () => deleteMessage(m)));

  meta.appendChild(actions);
  row.appendChild(avatar);
  const col = el("div", { class: "msg-col" }, bubble);
  if (sourcesRow) col.appendChild(sourcesRow);
  col.appendChild(meta);
  row.appendChild(col);
  return row;
}

const ICONS = {
  copy: '<path d="M9 9h10v10H9zM5 15V5h10"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  retry: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0114.6-3.4L23 10M1 14l4.9 4.9A9 9 0 0020.5 15"/>',
  speak: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M19 5a12 12 0 010 14M15.5 8.5a7 7 0 010 7"/>',
  like: '<path d="M14 9V5a3 3 0 00-6 0v4H4l1.5 9a2 2 0 002 2h9a2 2 0 002-1.6L20 9h-6z"/>',
  dislike: '<path d="M10 15v4a3 3 0 006 0v-4h4l-1.5-9a2 2 0 00-2-2h-9a2 2 0 00-2 1.6L4 15h6z"/>',
  fork: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M6 8.5V12a4 4 0 004 4M18 8.5V12a4 4 0 01-4 4"/>',
  pin: '<path d="M12 17v5M9 3h6l-1 7 4 3H6l4-3-1-7z"/>',
  delete: '<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/>',
};
function iconActionBtn(kind, onclick, active = false) {
  return el("button", { class: active ? "active" : "", title: kind, onclick },
    el("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", html: ICONS[kind] }));
}

/* ---- message action implementations ---- */
function beginEditMessage(m, bubble) {
  bubble.classList.add("editing");
  bubble.innerHTML = "";
  const ta = el("textarea", {}, m.content);
  const btnRow = el("div", { style: "display:flex;gap:8px;margin-top:8px;justify-content:flex-end;" },
    el("button", { class: "btn", onclick: () => renderAllMessages() }, "Cancel"),
    el("button", { class: "btn primary", onclick: () => { commitEditMessage(m, ta.value); } }, "Save & Resend"));
  bubble.appendChild(ta); bubble.appendChild(btnRow);
  ta.focus();
}
function commitEditMessage(m, newText) {
  const s = getCurrentSession();
  const idx = s.messages.findIndex((x) => x.id === m.id);
  if (idx === -1) return;
  // Truncate everything after this message, update content, resend.
  s.messages = s.messages.slice(0, idx + 1);
  s.messages[idx].content = newText;
  persistSessions(); saveCurrentSession();
  renderAllMessages();
  streamAssistantReply();
}
function retryMessage(m) {
  const s = getCurrentSession();
  const idx = s.messages.findIndex((x) => x.id === m.id);
  if (idx === -1) return;
  s.messages = s.messages.slice(0, idx); // drop this AI message and anything after
  persistSessions(); saveCurrentSession();
  renderAllMessages();
  streamAssistantReply();
}
function deleteMessage(m) {
  confirmDialog({
    title: "Delete this message?",
    message: "This message will be removed from the conversation history.",
    onConfirm: () => {
      const s = getCurrentSession();
      s.messages = s.messages.filter((x) => x.id !== m.id);
      persistSessions(); saveCurrentSession();
      renderAllMessages();
    },
  });
}
function togglePinMessage(m) {
  const idx = state.pinnedMessages.indexOf(m.id);
  if (idx === -1) state.pinnedMessages.push(m.id); else state.pinnedMessages.splice(idx, 1);
  localStorage.setItem("ssc_pinned_msgs", JSON.stringify(state.pinnedMessages));
  renderAllMessages();
}
function toggleFeedback(m, kind) {
  m.feedback = m.feedback === kind ? null : kind;
  saveCurrentSession();
  renderAllMessages();
}
function forkConversation(m) {
  const s = getCurrentSession();
  const idx = s.messages.findIndex((x) => x.id === m.id);
  const forked = {
    id: uid(), title: s.title + " (fork)", titleAuto: false, pinned: false,
    createdAt: Date.now(), updatedAt: Date.now(),
    messages: JSON.parse(JSON.stringify(s.messages.slice(0, idx + 1))),
    settings: s.settings ? { ...s.settings } : undefined,
  };
  state.sessions.unshift(forked);
  state.currentSessionId = forked.id;
  applySessionSettings(forked);
  persistSessions(); renderSessionList(); renderAllMessages();
  $("#topbar-title").textContent = forked.title;
  toast("Conversation forked");
}

let speechSynthUtterance = null;
function speakText(text) {
  if (!("speechSynthesis" in window)) { toast("Text-to-speech isn't supported on this device"); return; }
  window.speechSynthesis.cancel();
  const plain = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").replace(/[#*_`>]/g, "");
  speechSynthUtterance = new SpeechSynthesisUtterance(plain);
  window.speechSynthesis.speak(speechSynthUtterance);
}

/* ---------------------------------------------------------------------------
   9b. RESPONSE CACHE — up to 15 entries, 5-minute TTL, keyed by the exact
       request payload (same messages + same generation settings).
--------------------------------------------------------------------------- */
const RESPONSE_CACHE_LIMIT = 15;
const RESPONSE_CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKeyFor(payload) {
  return JSON.stringify({
    m: payload.messages, p: payload.persona, cp: payload.customPersonaPrompt,
    so: payload.systemPromptOverride, l: payload.language, dt: payload.deepThink,
    mm: payload.mastermind, ws: payload.webSearchEnabled, t: payload.temperature,
    mt: payload.maxTokens, mdl: payload.model,
  });
}
function cacheGet(key) {
  const entry = state.cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > RESPONSE_CACHE_TTL_MS) { state.cache.delete(key); return null; }
  return entry;
}
function cacheSet(key, value) {
  if (state.cache.size >= RESPONSE_CACHE_LIMIT) {
    let oldestKey = null, oldestTs = Infinity;
    for (const [k, v] of state.cache.entries()) { if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; } }
    if (oldestKey) state.cache.delete(oldestKey);
  }
  state.cache.set(key, { ...value, ts: Date.now() });
}

/* ---------------------------------------------------------------------------
   10. SENDING MESSAGES + SSE STREAMING
--------------------------------------------------------------------------- */
const msgInput = $("#msg-input");
const sendBtn = $("#send-btn");

msgInput.addEventListener("input", () => {
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(180, msgInput.scrollHeight) + "px";
  const chars = msgInput.value.length;
  $("#char-counter").textContent = `${chars} chars · ~${approxTokens(msgInput.value)} tokens`;
});
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  else if (e.key === "Escape") { if (state.generating) stopGeneration(); else msgInput.value = ""; }
});
sendBtn.addEventListener("click", () => { if (state.generating) stopGeneration(); else sendMessage(); });

function buildUserContentWithFiles(text) {
  if (state.attachedFiles.length === 0) return text;
  const fileBlocks = state.attachedFiles.map((f) => `[FILE: ${f.name}]\n${f.text}\n[/FILE]`).join("\n\n");
  return `${text}\n\n${fileBlocks}`;
}

function sendMessage() {
  const raw = msgInput.value.trim();
  if (!raw && state.attachedFiles.length === 0) return;
  if (state.generating) return;

  let s = getCurrentSession();
  if (!s) s = createSession();

  const content = buildUserContentWithFiles(raw || "(see attached file)");
  const userMsg = { id: uid(), role: "user", content, ts: Date.now() };
  s.messages.push(userMsg);
  state.attachedFiles = [];
  renderAttachRow();
  msgInput.value = ""; msgInput.style.height = "auto";
  $("#char-counter").textContent = "0 chars · ~0 tokens";

  if (s.messages.length === 1 && s.titleAuto) {
    // Instant, offline-safe fallback so the session is never left as
    // "New Conversation" even if the network/title API is unavailable —
    // this gets replaced by the smarter AI-generated title once the first
    // reply completes (see finishGeneration).
    s.title = fallbackTitleFromText(raw) || s.title;
    renderSessionList();
    $("#topbar-title").textContent = s.title;
  }

  persistSessions(); saveCurrentSession();
  renderAllMessages();
  streamAssistantReply();
}

// Simple, instant, no-network title: first few words of the user's message,
// title-cased and truncated. Used as an immediate placeholder and as the
// final fallback if the AI title-generation call fails.
function fallbackTitleFromText(text) {
  const cleaned = (text || "").replace(/\[FILE:[\s\S]*?\[\/FILE\]/gi, "").trim();
  if (!cleaned) return null;
  const words = cleaned.split(/\s+/).slice(0, 7).join(" ");
  return words.length > 48 ? words.slice(0, 48).trim() + "…" : words;
}

function streamAssistantReply() {
  const s = getCurrentSession();
  state.generating = true;
  updateSendStopButton();
  $("#continue-bar").style.display = "none";

  const aiMsg = { id: uid(), role: "assistant", content: "", ts: Date.now(), model: null };
  s.messages.push(aiMsg);
  const row = buildMessageRow(aiMsg);
  chatInner.appendChild(row);
  const bubble = $(".bubble", row);
  bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  scrollToBottom();

  state.abortController = new AbortController();

  const payload = {
    messages: s.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
    persona: state.persona,
    customPersonaPrompt: state.customPersonaPrompt,
    systemPromptOverride: state.systemPromptOverride,
    language: state.language,
    deepThink: state.deepThink,
    mastermind: state.mastermind,
    webSearchEnabled: state.webSearch,
    temperature: state.temperature,
    maxTokens: state.maxTokens,
    model: state.model,
  };

  let buffer = "";
  let gotFirstChunk = false;
  let renderScheduled = false;
  const scheduleRender = () => {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      bubble.innerHTML = renderMarkdownToHtml(buffer);
      enhanceCodeBlocks(bubble);
      scrollToBottom();
    });
  };

  const cacheKey = cacheKeyFor(payload);
  const cached = cacheGet(cacheKey);
  if (cached) {
    aiMsg.content = cached.text;
    aiMsg.model = cached.model;
    aiMsg.sources = cached.sources || [];
    bubble.innerHTML = renderMarkdownToHtml(cached.text);
    enhanceCodeBlocks(bubble);
    toast("Loaded from cache");
    finishGeneration(s, aiMsg, cached.text);
    return;
  }

  fetch(state.backendUrl.replace(/\/$/, "") + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: state.abortController.signal,
  })
    .then(async (res) => {
      if (!res.ok || !res.body) throw new Error(`Backend responded ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        const events = sseBuf.split("\n\n");
        sseBuf = events.pop(); // last partial chunk stays in buffer
        for (const evt of events) {
          const lines = evt.split("\n");
          const eventType = (lines.find((l) => l.startsWith("event:")) || "").replace("event:", "").trim();
          const dataLine = (lines.find((l) => l.startsWith("data:")) || "").replace("data:", "").trim();
          if (!dataLine) continue;
          let data; try { data = JSON.parse(dataLine); } catch { continue; }

          if (eventType === "chunk") {
            if (!gotFirstChunk) { bubble.innerHTML = ""; gotFirstChunk = true; }
            buffer += data.text;
            scheduleRender();
          } else if (eventType === "reset") {
            // Backend discarded a partial attempt and is retrying with a
            // fallback key/model — wipe local buffer so text doesn't garble.
            buffer = "";
            gotFirstChunk = false;
            bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
          } else if (eventType === "status") {
            if (!gotFirstChunk) {
              const labels = {
                "grounding": "Searching the web…",
                "mastermind-pass-1": "Analyzing the problem…",
                "mastermind-pass-2": "Composing final answer…",
              };
              const label = labels[data.stage] || "Thinking…";
              bubble.innerHTML = `<div class="typing-status"><div class="typing-dots"><span></span><span></span><span></span></div><span class="typing-label">${escapeHtml(label)}</span></div>`;
            }
          } else if (eventType === "sources") {
            aiMsg.sources = Array.isArray(data.sources) ? data.sources : [];
          } else if (eventType === "done") {
            aiMsg.model = data.modelUsed;
            if (buffer) {
              aiMsg.content = buffer;
              state.analytics.requests++; state.analytics.tokens += approxTokens(buffer);
              localStorage.setItem("ssc_analytics", JSON.stringify(state.analytics));
              cacheSet(cacheKey, { text: buffer, model: data.modelUsed, sources: aiMsg.sources || [] });
            } else {
              // Safety net: a successful call that still produced no visible
              // text (rare now that the backend disables invisible Gemini
              // "thinking" tokens and auto-retries across every key/model on
              // empty output, but shown clearly rather than a blank bubble
              // if it ever happens).
              aiMsg.isErrorPlaceholder = true;
              aiMsg.content = "SSC AI didn't return any visible text for this prompt. Try rephrasing, or retry.";
            }
            finishGeneration(s, aiMsg, buffer);
          } else if (eventType === "error") {
            if (data.type === "quota" && typeof data.retryAfterSeconds === "number" && data.retryAfterSeconds > 0) {
              renderQuotaCountdown(aiMsg, data.retryAfterSeconds);
            } else {
              aiMsg.isErrorPlaceholder = true;
              aiMsg.content = data.message || "Something went wrong.";
            }
            finishGeneration(s, aiMsg, buffer, true);
          } else if (eventType === "aborted") {
            aiMsg.content = buffer || "(stopped)";
            finishGeneration(s, aiMsg, buffer);
          }
        }
      }
      if (!aiMsg.content) { aiMsg.isErrorPlaceholder = true; aiMsg.content = "SSC AI didn't return any visible text for this prompt. Try rephrasing, or retry."; finishGeneration(s, aiMsg, buffer); }
    })
    .catch((err) => {
      if (err.name === "AbortError") {
        aiMsg.content = buffer || "(stopped)";
      } else {
        aiMsg.isErrorPlaceholder = true;
        aiMsg.content = `Network/backend error: ${err.message}. Check your backend URL in Settings.`;
      }
      finishGeneration(s, aiMsg, buffer, true);
    });
}

function finishGeneration(s, aiMsg, buffer, isError = false) {
  state.generating = false;
  updateSendStopButton();
  persistSessions(); saveCurrentSession();
  refreshTopbarLabels();
  renderAllMessages();
  checkIfLooksTruncated(buffer);
  if (!isError && buffer) fetchSuggestions(s);
  // Now that the first exchange is complete, ask the AI for a sharper title
  // (it has both the question and the answer to work with). Only do this
  // once, and only if the user hasn't already renamed the conversation.
  if (!isError && buffer && s.titleAuto && s.messages.filter((m) => m.role === "assistant").length === 1) {
    generateSmartTitle(s);
  }
}

// Renders a live countdown (updating every second) in a message bubble when
// the backend tells us how long until a rate-limited key/model should be
// available again, instead of a generic "try again shortly" message.
// Keeps aiMsg.content in sync on every tick (as plain text) so that any
// subsequent full re-render (renderAllMessages) reflects the current
// countdown state instead of the message's original empty content, and
// looks up the live bubble element by message id each tick since a
// re-render replaces DOM nodes wholesale.
function renderQuotaCountdown(aiMsg, seconds) {
  let remaining = Math.ceil(seconds);
  const textFor = (r) => r > 0
    ? `⚠ All keys are rate-limited right now. Try again in ${r}s…`
    : `⚠ You can try sending your message again now.`;
  const render = () => {
    aiMsg.content = textFor(remaining);
    const liveBubble = document.querySelector(`[data-mid="${aiMsg.id}"] .bubble`);
    if (liveBubble) liveBubble.innerHTML = `<span style="color:var(--danger)">${escapeHtml(aiMsg.content)}</span>`;
  };
  render();
  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) { remaining = 0; render(); clearInterval(interval); return; }
    render();
  }, 1000);
}

function updateSendStopButton() {
  sendBtn.classList.toggle("stop", state.generating);
  sendBtn.innerHTML = state.generating
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
    : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
}
function stopGeneration() {
  if (state.abortController) state.abortController.abort();
}

function checkIfLooksTruncated(text) {
  const trimmed = (text || "").trim();
  const looksCut = trimmed.length > 200 && !/[.!?"'`)\]}»]$/.test(trimmed) && !/```\s*$/.test(trimmed);
  $("#continue-bar").style.display = looksCut ? "flex" : "none";
}
$("#continue-btn").addEventListener("click", () => {
  $("#continue-bar").style.display = "none";
  const s = getCurrentSession();
  s.messages.push({ id: uid(), role: "user", content: "Please continue exactly where you left off.", ts: Date.now() });
  renderAllMessages();
  streamAssistantReply();
});

/* ---- AI-generated suggestion chips after a reply ---- */
async function fetchSuggestions(s) {
  try {
    const conversationText = s.messages.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 6000);
    const res = await fetch(state.backendUrl.replace(/\/$/, "") + "/api/suggestions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationText }),
    });
    if (!res.ok) return;
    const { suggestions } = await res.json();
    if (!suggestions || !suggestions.length) return;
    const row = el("div", { class: "suggest-row", style: "justify-content:flex-start;margin:-6px 0 4px 44px;" },
      ...suggestions.map((q) => el("div", { class: "suggest-chip", onclick: () => { msgInput.value = q; sendMessage(); } }, q)));
    chatInner.appendChild(row);
    scrollToBottom();
  } catch { /* non-critical */ }
}

async function generateSmartTitle(session) {
  try {
    const conversationText = session.messages.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 3000);
    const res = await fetch(state.backendUrl.replace(/\/$/, "") + "/api/title", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationText }),
    });
    if (!res.ok) return;
    const { title } = await res.json();
    // The user may have manually renamed this session (or it may have been
    // deleted) while the request was in flight — don't clobber their choice.
    if (title && session.titleAuto && state.sessions.some((s) => s.id === session.id)) {
      session.title = title;
      persistSessions();
      renderSessionList();
      if (state.currentSessionId === session.id) $("#topbar-title").textContent = title;
    }
  } catch { /* network unavailable — the instant fallback title set in sendMessage() remains */ }
}

async function summarizeSession(session) {
  toast("Summarizing conversation…");
  try {
    const conversationText = session.messages.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 20000);
    const res = await fetch(state.backendUrl.replace(/\/$/, "") + "/api/summarize", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationText }),
    });
    if (!res.ok) throw new Error("Backend returned " + res.status);
    const { summary } = await res.json();
    showSummaryModal(session.title, summary || "SSC AI didn't return a summary for this conversation.");
  } catch (err) {
    toast("Couldn't summarize: " + err.message);
  }
}
function showSummaryModal(title, summaryText) {
  $("#confirm-body").innerHTML = "";
  $("#confirm-body").appendChild(
    el("div", { style: "text-align:left;" },
      el("p", { style: "font-weight:600;color:var(--gold-bright);margin:0 0 10px;font-family:var(--font-brand);font-size:13px;" }, "Summary — " + title),
      el("div", { style: "font-size:13px;line-height:1.6;color:var(--text);white-space:pre-wrap;max-height:40vh;overflow-y:auto;" }, summaryText))
  );
  const foot = $("#confirm-foot");
  foot.innerHTML = "";
  foot.appendChild(el("button", { class: "btn", onclick: () => copyToClipboard(summaryText, "Summary copied") }, "Copy"));
  foot.appendChild(el("button", { class: "btn primary", onclick: () => closeModal("confirm-overlay") }, "Close"));
  openModal("confirm-overlay");
}

/* ---------------------------------------------------------------------------
   11. VOICE INPUT (Web Speech API)
--------------------------------------------------------------------------- */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null, isRecording = false;
if (SpeechRec) {
  recognizer = new SpeechRec();
  recognizer.continuous = false;
  recognizer.interimResults = false;
  recognizer.onresult = (e) => { msgInput.value += (msgInput.value ? " " : "") + e.results[0][0].transcript; msgInput.dispatchEvent(new Event("input")); };
  recognizer.onend = () => { isRecording = false; $("#mic-btn").classList.remove("recording"); };
  recognizer.onerror = () => { isRecording = false; $("#mic-btn").classList.remove("recording"); };
}
$("#mic-btn").addEventListener("click", () => {
  if (!recognizer) { toast("Voice input isn't supported in this browser"); return; }
  recognizer.lang = { en: "en-US", fr: "fr-FR", es: "es-ES", ar: "ar-SA", zh: "zh-CN", ha: "ha-NG", yo: "yo-NG", ig: "ig-NG" }[state.language] || "en-US";
  if (isRecording) { recognizer.stop(); return; }
  isRecording = true; $("#mic-btn").classList.add("recording"); recognizer.start();
});

/* ---------------------------------------------------------------------------
   12. BACKEND HEALTH CHECK
--------------------------------------------------------------------------- */
async function checkBackendHealth() {
  const dot = $("#status-dot");
  dot.className = "status-dot pending";
  try {
    const res = await fetch(state.backendUrl.replace(/\/$/, "") + "/api/health", { method: "GET" });
    dot.className = "status-dot " + (res.ok ? "" : "off");
  } catch { dot.className = "status-dot off"; }
}

/* ---------------------------------------------------------------------------
   13. SETTINGS MODAL (General / Language / Templates / Chat / Generation /
       Export / Share / Analytics)
--------------------------------------------------------------------------- */
const SETTINGS_TABS = ["General", "Language", "Templates", "Chat", "Generation", "Export", "Share", "Analytics"];
let activeSettingsTab = "General";

function renderSettingsTabs() {
  const bar = $("#settings-tabs");
  bar.innerHTML = "";
  SETTINGS_TABS.forEach((t) => {
    bar.appendChild(el("button", { class: "tab-btn" + (t === activeSettingsTab ? " active" : ""), onclick: () => { activeSettingsTab = t; renderSettingsTabs(); renderSettingsBody(); } }, t));
  });
}

function getTemplates() { try { return JSON.parse(localStorage.getItem("ssc_templates") || "[]"); } catch { return []; } }
function saveTemplates(list) { localStorage.setItem("ssc_templates", JSON.stringify(list)); }

function renderSettingsBody() {
  const body = $("#settings-body");
  body.innerHTML = "";

  if (activeSettingsTab === "General") {
    body.appendChild(fieldBlock("Backend URL", inputEl("text", state.backendUrl, (v) => { state.backendUrl = v; localStorage.setItem("ssc_backend_url", v); checkBackendHealth(); }), "Where your SSC AI backend is deployed (Render/Railway/etc)."));
    body.appendChild(fieldBlock("System prompt override", textareaEl(state.systemPromptOverride, (v) => { state.systemPromptOverride = v; localStorage.setItem("ssc_system_override", v); }), "Extra instructions appended to every conversation."));
    body.appendChild(fieldBlock("Custom persona prompt", textareaEl(state.customPersonaPrompt, (v) => { state.customPersonaPrompt = v; localStorage.setItem("ssc_custom_persona", v); }), 'Used when Persona = "Custom" in the top bar.'));
  }

  if (activeSettingsTab === "Language") {
    const sel = el("select", { onchange: (e) => { state.language = e.target.value; localStorage.setItem("ssc_language", e.target.value); syncCurrentSessionSettings(); } });
    LANGUAGES.forEach((l) => sel.appendChild(el("option", { value: l.id, selected: l.id === state.language ? "selected" : null }, l.name)));
    body.appendChild(fieldBlock("AI response language", sel, "SSC AI will answer in this language by default."));
  }

  if (activeSettingsTab === "Templates") {
    const list = getTemplates();
    const listWrap = el("div", {});
    list.forEach((t, i) => listWrap.appendChild(el("div", { class: "template-item" },
      el("span", {}, t.name),
      el("div", {},
        el("button", { class: "btn", style: "margin-right:6px;", onclick: () => { msgInput.value = t.prompt; msgInput.dispatchEvent(new Event("input")); closeModal("settings-overlay"); } }, "Use"),
        el("button", { class: "btn danger", onclick: () => { list.splice(i, 1); saveTemplates(list); renderSettingsBody(); } }, "Delete")))));
    body.appendChild(listWrap);
    const nameIn = inputEl("text", "", null, "Template name");
    const promptIn = textareaEl("", null, null, "Prompt text");
    body.appendChild(fieldBlock("New template name", nameIn));
    body.appendChild(fieldBlock("Prompt", promptIn));
    body.appendChild(el("button", { class: "btn primary", onclick: () => { if (!nameIn.value.trim()) return; list.push({ name: nameIn.value.trim(), prompt: promptIn.value }); saveTemplates(list); renderSettingsBody(); } }, "Save Template"));
  }

  if (activeSettingsTab === "Chat") {
    const searchIn = inputEl("text", "", (v) => highlightInChatSearch(v), "Search within current chat...");
    body.appendChild(fieldBlock("Search this conversation", searchIn));
    body.appendChild(el("div", { style: "margin-top:16px;" }, el("b", { style: "font-size:12px;color:var(--text-dim);" }, "PINNED MESSAGES")));
    const s = getCurrentSession();
    const pinned = s ? s.messages.filter((m) => state.pinnedMessages.includes(m.id)) : [];
    if (pinned.length === 0) body.appendChild(el("p", { style: "color:var(--text-dim);font-size:12.5px;" }, "No pinned messages yet. Use the pin icon on any message."));
    pinned.forEach((m) => body.appendChild(el("div", { class: "template-item", style: "align-items:flex-start;" }, el("span", { style: "max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" }, m.content))));
  }

  if (activeSettingsTab === "Generation") {
    body.appendChild(fieldBlock(`Max tokens: <span class="range-val">${state.maxTokens}</span>`, rangeEl(1, 8192, state.maxTokens, (v) => { state.maxTokens = v; localStorage.setItem("ssc_maxtokens", v); renderSettingsBody(); }), null, true));
    body.appendChild(fieldBlock(`Temperature: <span class="range-val">${state.temperature.toFixed(2)}</span>`, rangeEl(0, 1, state.temperature, (v) => { state.temperature = v; localStorage.setItem("ssc_temperature", v); renderSettingsBody(); }, 0.01), null, true));
    body.appendChild(switchRow("Show <thinking> reasoning blocks", "Display SSC AI's step-by-step reasoning when Deep Think is on", state.showThinking, (v) => { state.showThinking = v; localStorage.setItem("ssc_showthinking", v ? "1" : "0"); }));
  }

  if (activeSettingsTab === "Export") {
    const s = getCurrentSession();
    body.appendChild(el("p", { style: "color:var(--text-dim);font-size:12.5px;" }, "Export the current conversation."));
    body.appendChild(el("div", { style: "display:flex;gap:10px;flex-wrap:wrap;" },
      el("button", { class: "btn", onclick: () => s && exportSession(s, "txt") }, "Export .txt"),
      el("button", { class: "btn", onclick: () => s && exportSession(s, "md") }, "Export .md"),
      el("button", { class: "btn", onclick: () => s && exportSessionPdf(s) }, "Export .pdf")));
  }

  if (activeSettingsTab === "Share") {
    const s = getCurrentSession();
    body.appendChild(el("p", { style: "color:var(--text-dim);font-size:12.5px;" }, "Generate a shareable link that encodes this conversation as base64. Anyone who opens it (in this same app) can view the transcript."));
    const out = textareaEl("", null, null, "Shareable link will appear here");
    out.readOnly = true;
    body.appendChild(fieldBlock("Share link", out));
    body.appendChild(el("button", { class: "btn primary", onclick: () => {
      if (!s) return;
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify({ title: s.title, messages: s.messages.map((m) => ({ role: m.role, content: m.content })) }))));
      out.value = location.origin + location.pathname + "#share=" + encoded;
    } }, "Generate Link"));
  }

  if (activeSettingsTab === "Analytics") {
    const grid = el("div", { class: "stat-grid" },
      statCard(state.analytics.requests, "Requests today"),
      statCard(state.analytics.tokens, "Tokens used"),
      statCard(MODELS.find((m) => m.id === state.model)?.short || "-", "Active model"),
      statCard((getCurrentSession()?.messages.length) || 0, "Messages in chat"));
    body.appendChild(grid);
    body.appendChild(el("div", { style: "margin-top:14px;font-size:12px;color:var(--text-dim);" }, "Backend: ", el("span", { id: "analytics-backend-status" }, "checking...")));
    fetch(state.backendUrl.replace(/\/$/, "") + "/api/health").then((r) => r.json()).then((d) => { $("#analytics-backend-status").textContent = `online · ${d.models?.join(", ")}`; }).catch(() => { $("#analytics-backend-status").textContent = "offline"; });
  }
}
function statCard(value, label) { return el("div", { class: "stat-card" }, el("b", {}, String(value)), el("span", {}, label)); }
function fieldBlock(labelHtml, inputNode, hint, isRange = false) {
  const wrap = el("div", { class: "field" }, el("label", { html: labelHtml }));
  wrap.appendChild(inputNode);
  if (hint) wrap.appendChild(el("div", { style: "font-size:11px;color:var(--text-dim);margin-top:5px;" }, hint));
  return wrap;
}
function inputEl(type, value, onInput, placeholder = "") {
  const i = el("input", { type, value, placeholder, oninput: onInput ? (e) => onInput(e.target.value) : null });
  return i;
}
function textareaEl(value, onInput, _unused, placeholder = "") {
  const t = el("textarea", { placeholder, oninput: onInput ? (e) => onInput(e.target.value) : null });
  t.value = value;
  return t;
}
function rangeEl(min, max, value, onInput, step = 1) {
  return el("input", { type: "range", min, max, step, value, oninput: (e) => onInput(parseFloat(e.target.value)) });
}
function switchRow(label, sub, checked, onChange) {
  const cb = el("input", { type: "checkbox", checked: checked ? "checked" : null, onchange: (e) => onChange(e.target.checked) });
  return el("div", { class: "switch-row" }, el("div", {}, el("div", { class: "lbl" }, label), sub ? el("div", { class: "sub" }, sub) : null), el("label", { class: "switch" }, cb, el("span", { class: "slider-tog" })));
}
function highlightInChatSearch(q) {
  $$(".bubble", chatInner).forEach((b) => { b.style.outline = ""; });
  if (!q) return;
  $$(".msg-row", chatInner).forEach((row) => {
    const bubble = $(".bubble", row);
    if (bubble.textContent.toLowerCase().includes(q.toLowerCase())) { bubble.style.outline = "2px solid var(--gold)"; row.scrollIntoView({ block: "center" }); }
  });
}

$("#settings-btn").addEventListener("click", () => { activeSettingsTab = "General"; renderSettingsTabs(); renderSettingsBody(); openModal("settings-overlay"); });
$("#pinned-btn").addEventListener("click", () => { activeSettingsTab = "Chat"; renderSettingsTabs(); renderSettingsBody(); openModal("settings-overlay"); });
$("#analytics-btn").addEventListener("click", () => { activeSettingsTab = "Analytics"; renderSettingsTabs(); renderSettingsBody(); openModal("settings-overlay"); });

async function exportSessionPdf(session) {
  // Lightweight print-to-PDF path: opens a print-ready window using the
  // browser's native "Save as PDF" — zero extra dependencies, works offline.
  const w = window.open("", "_blank");
  const bodyHtml = session.messages.map((m) => `<p><b>${m.role === "user" ? "You" : "SSC AI"}:</b><br>${renderMarkdownToHtml(m.content)}</p>`).join("<hr>");
  w.document.write(`<html><head><title>${session.title}</title><style>body{font-family:sans-serif;padding:30px;max-width:700px;margin:auto;} hr{border:none;border-top:1px solid #ccc;margin:16px 0;}</style></head><body><h2>${session.title}</h2>${bodyHtml}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 400);
}

/* ---------------------------------------------------------------------------
   14. NEW CHAT / INIT
--------------------------------------------------------------------------- */
function startNewChat() {
  const s = createSession();
  applySessionSettings(s);
  renderSessionList();
  renderAllMessages();
  $("#topbar-title").textContent = s.title;
  if (window.innerWidth <= 800) closeSidebar();
}
function loadSession(id) {
  state.currentSessionId = id;
  applySessionSettings(getCurrentSession());
  renderSessionList();
  renderAllMessages();
  const s = getCurrentSession();
  $("#topbar-title").textContent = s ? s.title : "New Conversation";
}
$("#new-chat-btn").addEventListener("click", startNewChat);

function loadFromShareLink() {
  const hash = location.hash;
  if (!hash.startsWith("#share=")) return;
  try {
    const decoded = JSON.parse(decodeURIComponent(escape(atob(hash.slice(7)))));
    const s = { id: uid(), title: "(Shared) " + (decoded.title || "Conversation"), pinned: false, createdAt: Date.now(), updatedAt: Date.now(), messages: decoded.messages.map((m) => ({ ...m, id: uid(), ts: Date.now() })) };
    state.sessions.unshift(s);
    persistSessions();
    state.currentSessionId = s.id;
    toast("Loaded shared conversation");
  } catch { /* ignore malformed share link */ }
}

async function init() {
  applyTheme(state.theme);
  await loadSessions();
  refreshTopbarLabels();
  loadFromShareLink();
  if (!state.currentSessionId) {
    if (state.sessions.length > 0) state.currentSessionId = state.sessions[0].id;
    else createSession();
  }
  applySessionSettings(getCurrentSession());
  renderSessionList();
  renderAllMessages();
  const s = getCurrentSession();
  $("#topbar-title").textContent = s ? s.title : "New Conversation";
  checkBackendHealth();
  setInterval(checkBackendHealth, 60000);
}
init();

/* ---------------------------------------------------------------------------
   15. OFFLINE SUPPORT — service worker registration + connectivity banner
--------------------------------------------------------------------------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* offline-first is a nice-to-have, not a hard requirement — fail silently */
    });
  });
}

(function connectivityBanner() {
  let banner = null;
  const show = (message, isOffline) => {
    if (banner) banner.remove();
    banner = el("div", {
      style: `position:fixed; top:0; left:0; right:0; z-index:400; text-align:center; padding:7px; font-size:12px; font-family:var(--font-mono); color:${isOffline ? "#2a1810" : "#0f2818"}; background:${isOffline ? "var(--gold)" : "var(--success)"};`,
    }, message);
    document.body.appendChild(banner);
    if (!isOffline) setTimeout(() => { banner?.remove(); banner = null; }, 2500);
  };
  window.addEventListener("offline", () => show("You're offline — SSC AI will reconnect automatically once you're back online.", true));
  window.addEventListener("online", () => { show("Back online.", false); checkBackendHealth(); });
})();
