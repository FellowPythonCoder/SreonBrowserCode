// app.js — tabs, workspaces, navigation, and the shell UI.
(function () {
  "use strict";

  let isTauri = typeof window.__TAURI__ !== "undefined";
  let brandInjectTimer = null;

  // ---------------------------------------------------------------------
  // Encrypted local stores — saved logins, bookmarks, and history are all
  // encrypted at rest with AES-256-GCM (see crypto.js / secure-store.js)
  // using a key scoped to the *current workspace*. Personal and Work each
  // get their own key, so a password on one workspace never protects (or
  // exposes) the other's data. What lands in localStorage is only ever
  // ciphertext — never plain JSON.
  // ---------------------------------------------------------------------
  function makeEncryptedStore(storageKeyFor, defaultValue) {
    async function currentKey() {
      const req = workspaceRequiresPassword(activeWorkspaceId);
      return SecureStore.keyFor(activeWorkspaceId, req);
    }
    async function load() {
      const raw = localStorage.getItem(storageKeyFor(activeWorkspaceId));
      if (!raw) return structuredCloneSafe(defaultValue);
      try {
        const key = await currentKey();
        return await SreonCrypto.decryptJSON(key, raw);
      } catch {
        // Wrong/missing key, or corrupted blob — fail closed, not open.
        return structuredCloneSafe(defaultValue);
      }
    }
    async function save(value) {
      const key = await currentKey();
      const blob = await SreonCrypto.encryptJSON(key, value);
      localStorage.setItem(storageKeyFor(activeWorkspaceId), blob);
    }
    return { load, save };
  }

  function structuredCloneSafe(v) {
    return JSON.parse(JSON.stringify(v));
  }

  // Re-encrypts a workspace's saved logins, bookmarks, and history from
  // one AES key to another. This has to run every time a workspace's
  // password is set, changed, or removed — otherwise the data stays
  // encrypted under the *old* key while Sreon starts asking SecureStore for
  // the *new* one, and it silently fails closed (looks like your saved
  // logins/bookmarks/history vanished, even though nothing was deleted).
  async function migrateWorkspaceStorage(wsId, oldKey, newKey) {
    const keys = [`sreon:passwords:${wsId}`, `sreon:history:${wsId}`, `sreon:bookmarks:${wsId}`];
    for (const k of keys) {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      try {
        const data = await SreonCrypto.decryptJSON(oldKey, raw);
        const blob = await SreonCrypto.encryptJSON(newKey, data);
        localStorage.setItem(k, blob);
      } catch {
        // Already unreadable under the old key (corrupted or never set) —
        // nothing safe to migrate, leave it as-is.
      }
    }
  }

  // Filled in once workspaces (below) know which ones have a password set.
  const workspacePasswordFlags = {}; // wsId -> bool
  function workspaceRequiresPassword(wsId) {
    return !!workspacePasswordFlags[wsId];
  }

  const VaultStore = makeEncryptedStore((ws) => `sreon:passwords:${ws}`, []);
  const Vault = {
    list: async () => VaultStore.load(),
    add: async (site, username, password) => {
      const list = await VaultStore.load();
      const idx = list.findIndex((e) => e.site === site && e.username === username);
      const entry = { site, username, password, updated: Date.now() };
      if (idx >= 0) list[idx] = entry; else list.unshift(entry);
      await VaultStore.save(list);
      return list;
    },
    remove: async (site, username) => {
      const list = (await VaultStore.load()).filter((e) => !(e.site === site && e.username === username));
      await VaultStore.save(list);
      return list;
    },
    clear: async () => VaultStore.save([]),
  };

  // ---------------------------------------------------------------------
  // History — recently visited pages, most-recent first, capped at 500.
  // ---------------------------------------------------------------------
  const HistoryEncStore = makeEncryptedStore((ws) => `sreon:history:${ws}`, []);
  const CAP_HISTORY = 500;
  const HistoryStore = {
    list: async () => HistoryEncStore.load(),
    add: async (url, title) => {
      if (!url || url === "about:start" || url.startsWith("sreon://")) return;
      const list = await HistoryEncStore.load();
      list.unshift({ url, title: title || url, time: Date.now() });
      await HistoryEncStore.save(list.slice(0, CAP_HISTORY));
    },
    remove: async (time) => {
      const list = (await HistoryEncStore.load()).filter((e) => e.time !== time);
      await HistoryEncStore.save(list);
    },
    clear: async () => HistoryEncStore.save([]),
  };

  // ---------------------------------------------------------------------
  // Bookmarks — color-tagged, per workspace, encrypted like everything else.
  // ---------------------------------------------------------------------
  const BOOKMARK_COLORS = ["#3d8bff", "#22c55e", "#f97316", "#8b5cf6", "#ef4444", "#eab308", "#14b8a6", "#ec4899"];
  const BookmarkEncStore = makeEncryptedStore((ws) => `sreon:bookmarks:${ws}`, []);
  const Bookmarks = {
    list: async () => BookmarkEncStore.load(),
    add: async (url, title, color) => {
      const list = await BookmarkEncStore.load();
      const idx = list.findIndex((e) => e.url === url);
      const entry = { url, title: title || url, color: color || BOOKMARK_COLORS[0], added: Date.now() };
      if (idx >= 0) list[idx] = entry; else list.unshift(entry);
      await BookmarkEncStore.save(list);
      return list;
    },
    remove: async (url) => {
      const list = (await BookmarkEncStore.load()).filter((e) => e.url !== url);
      await BookmarkEncStore.save(list);
      return list;
    },
    setColor: async (url, color) => {
      const list = await BookmarkEncStore.load();
      const e = list.find((b) => b.url === url);
      if (e) { e.color = color; await BookmarkEncStore.save(list); }
      return list;
    },
    isBookmarked: async (url) => (await BookmarkEncStore.load()).some((e) => e.url === url),
  };

  function logHistory(tab) {
    if (!tab || !tab.url || tab.url === "about:start") return;
    HistoryStore.add(tab.url, tab.display || tab.url).catch(() => {});
  }

  // Tauri v2 may inject window.__TAURI__ after the page script runs if
  // `app.withGlobalTauri` isn't enabled at build-time. Poll briefly so that
  // the app can detect a late injection and enable native-webview code paths
  // instead of silently falling back to iframe-based preview.
  (function waitForTauriInjection() {
    if (isTauri) return;
    let checks = 0;
    const maxChecks = 100; // ~5s at 50ms intervals
    const id = setInterval(() => {
      if (typeof window.__TAURI__ !== "undefined") {
        isTauri = true;
        console.info("Tauri runtime detected (late injection). Enabling native paths.");
        clearInterval(id);
      } else if (++checks >= maxChecks) {
        clearInterval(id);
      }
    }, 50);
  })();

  function tauriInvoke(cmd, args) {
    const t = window.__TAURI__;
    if (!t) return Promise.reject(new Error("tauri-not-available"));
    const invokeFn = (t.core && t.core.invoke) || (t.tauri && t.tauri.invoke) || t.invoke;
    if (!invokeFn) return Promise.reject(new Error("tauri-invoke-not-found"));
    return invokeFn(cmd, args);
  }

  async function openInSystemBrowser(url) {
    if (isTauri) {
      try {
        await tauriInvoke("open_in_system_browser", { url });
        return;
      } catch (err) {
        console.warn("Tauri invoke failed, falling back to window.open", err);
      }
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }
  window.openInSystemBrowser = openInSystemBrowser;

  // ---------- Native per-tab webviews (Tauri build only) ----------
  //
  // Real desktop builds no longer embed pages via <iframe> — an iframe
  // is subject to a site's own X-Frame-Options / CSP frame-ancestors
  // policy, and most real sites (search engines included) set one
  // specifically to refuse being framed. That's what made normal
  // searches and sites like google.com fail to load before.
  //
  // Instead each tab gets a real native child webview positioned over
  // the content area — a genuine top-level navigation done by the
  // OS's browser engine, exactly like a normal browser tab, so those
  // headers don't apply. Only one is ever shown at a time.
  //
  // Those native views always paint ON TOP of Sreon's own HTML, so any
  // time Sreon needs to show its own UI over the content area (command
  // palette, settings, the About panel, the focused address bar) the
  // active tab's view has to be explicitly hidden first, then shown
  // again after.

  let activeNativeTabId = null;
  // Pixels to inset the viewing area from the top so floating UI remains visible
  const VIEW_TOP_INSET = 40;

  // Multiple overlays (settings, command palette, the AI panel, the address
  // bar's own focus/blur handling, lock screen, etc.) each independently
  // call withdraw-on-open / restore-on-close. Those used to just hide/show
  // the native tab view unconditionally, with no idea whether some OTHER
  // overlay was still open. Concretely: focus the address bar, then before
  // its 200ms blur-restore timer fires, open Settings — the timer still
  // fires, unconditionally calls show_tab_view, and the native page view
  // (which always paints ABOVE Sreon's own HTML) pops back on top of the
  // Settings panel you just opened. That's the "screen bugs out when I
  // open settings or something new" glitch. A depth counter fixes it:
  // the tab view is only actually restored once every overlay that
  // withdrew it has also released it.
  let overlayDepth = 0;

  function getViewBounds() {
    const r = document.getElementById("view-stack").getBoundingClientRect();
    const x = Math.round(r.left);
    const y = Math.round(r.top + VIEW_TOP_INSET);
    const width = Math.round(r.width);
    const height = Math.max(0, Math.round(r.height - VIEW_TOP_INSET));
    return { x, y, width, height };
  }

  function hideTabView(id) {
    if (!id) return;
    tauriInvoke("hide_tab_view", { id }).catch(() => {});
  }

  function withdrawActiveViewForOverlay() {
    overlayDepth++;
    if (isTauri) hideTabView(activeNativeTabId);
  }

  function restoreActiveViewFromOverlay() {
    overlayDepth = Math.max(0, overlayDepth - 1);
    if (overlayDepth > 0) return; // another overlay is still open — stay hidden
    if (isTauri && activeNativeTabId) {
      tauriInvoke("show_tab_view", { id: activeNativeTabId }).catch(() => {});
    }
  }

  // Expose helpers so non-UI modules (lock.js) can hide/restore native views
  // when showing overlays — native webviews paint on top of the DOM otherwise.
  window.withdrawActiveViewForOverlay = withdrawActiveViewForOverlay;
  window.restoreActiveViewFromOverlay = restoreActiveViewFromOverlay;

  async function showTabView(tab) {
    const b = getViewBounds();
    if (!tab.viewCreated) {
      try {
        await tauriInvoke("create_tab_view", {
          id: tab.id,
          url: tab.url,
          adBlock: effectiveSiteSetting(hostOf(tab.url), "adBlock") !== false,
          privacyMode: !!effectiveSiteSetting(hostOf(tab.url), "privacyMode"),
          proxyUrl: Settings.get().proxyUrl || "",
          ...b,
        });
        tab.viewCreated = true;
      } catch (err) {
        // Previously this only surfaced an error when a proxy was set, and
        // marked the tab as "created" even on failure — so on a plain
        // failed navigation (bad URL, blocked host, anything) the tab
        // content area was just left showing nothing at all, forever,
        // with zero feedback and no way to retry. Now it always tells you
        // what happened, and leaves the tab retryable (viewCreated stays
        // false, so re-selecting the tab or hitting reload tries again).
        console.warn("create_tab_view failed", err);
        finishLoadProgress();
        await SreonDialog.alert(`That page couldn't be opened.\n\n${err}`, { title: "Couldn't load" });
      }
    } else {
      try {
        await tauriInvoke("set_tab_bounds", { id: tab.id, ...b });
        await tauriInvoke("show_tab_view", { id: tab.id });
      } catch (err) {
        console.warn("show_tab_view failed", err);
      }
    }
    activeNativeTabId = tab.id;
  }

  // ---------- Known-blocked hosts ----------
  // These sites' own CSP/X-Frame-Options headers refuse to render inside
  // ANY embedded browser view — not just Sreon. Waiting on the iframe to
  // "fail" is unreliable for them (some just render a blank white page
  // forever instead of firing a detectable error), so we skip the
  // attempt entirely and go straight to the fallback UI.
  const KNOWN_BLOCKED_HOSTS = [
    /(^|\.)google\.[a-z.]+$/i,
    /(^|\.)accounts\.google\.com$/i,
    /(^|\.)facebook\.com$/i,
    /(^|\.)instagram\.com$/i,
    /(^|\.)twitter\.com$/i,
    /(^|\.)x\.com$/i,
    /(^|\.)linkedin\.com$/i,
    /(^|\.)netflix\.com$/i,
    /(^|\.)chase\.com$/i,
    /(^|\.)paypal\.com$/i,
  ];

  function isKnownBlocked(url) {
    try {
      const host = new URL(url).hostname;
      return KNOWN_BLOCKED_HOSTS.some((re) => re.test(host));
    } catch {
      return false;
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const TRACKING_PARAMS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id", "utm_name",
    "fbclid", "gclid", "gclsrc", "dclid", "msclkid", "mc_eid", "mc_cid",
    "igshid", "yclid", "twclid", "ttclid", "vero_id", "ref_src", "ref",
    "_ga", "_gl", "si", "s_cid", "spm", "trk", "elqTrackId",
  ];

  function stripTrackingParams(url) {
    try {
      const u = new URL(url);
      let changed = false;
      TRACKING_PARAMS.forEach((p) => {
        if (u.searchParams.has(p)) { u.searchParams.delete(p); changed = true; }
      });
      return changed ? u.toString() : url;
    } catch {
      return url;
    }
  }

  function normalizeInput(raw) {
    const value = raw.trim();
    if (!value) return null;
    if (value === "sreon://start" || value === "glass://start") {
      return { url: "about:start", isStart: true };
    }

    const looksLikeUrl =
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
      (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(value) && !value.includes(" "));

    if (looksLikeUrl) {
      const raw2 = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
      const url = stripTrackingParams(raw2);
      return { url, isStart: false, isSearch: false, display: url };
    }
    // Not a URL — treat as a Sreon search. The real request still goes to
    // the configured search backend, but the address bar and tab title
    // only ever show "Sreon" + the query, never the backend's own domain.
    return { url: Settings.searchUrl(value), isStart: false, isSearch: true, display: value };
  }

  // ---------- State ----------

  let workspaces = [
    { id: "personal", name: "Personal", tabs: [], activeTabId: null, color: "#3d8bff" },
    { id: "work", name: "Work", tabs: [], activeTabId: null, color: "#f97316" },
  ];
  let activeWorkspaceId = workspaces[0].id;

  // Per-workspace color, persisted independently of the tab-session
  // restore setting so it survives even with "Restore tabs" off.
  function loadWorkspaceColors() {
    workspaces.forEach((w) => {
      const saved = localStorage.getItem(`sreon:ws-color:${w.id}`);
      if (saved) w.color = saved;
    });
  }
  function setWorkspaceColor(id, color) {
    const w = workspaces.find((x) => x.id === id);
    if (w) w.color = color;
    localStorage.setItem(`sreon:ws-color:${id}`, color);
  }

  /**
   * Switches into a workspace, prompting for that workspace's password
   * first if one is set and it isn't already unlocked this session. Only
   * that workspace's saved logins/bookmarks/history become readable once
   * unlocked — the other workspace's encrypted data is untouched.
   */
  async function switchWorkspace(id) {
    if (id === activeWorkspaceId) return;
    // Ask live, not from the cached flag — the cache is only populated by
    // an async check that runs shortly after boot, and switching before it
    // resolves used to skip the password prompt entirely (the cached flag
    // read as "no password" simply because it hadn't loaded yet).
    let requiresPassword = false;
    if (window.Lock) {
      try {
        requiresPassword = await window.Lock.hasWorkspacePassword(id);
      } catch (e) {
        console.warn('hasWorkspacePassword failed, assuming password required:', e);
        requiresPassword = true;
      }
    }
    workspacePasswordFlags[id] = requiresPassword;
    // Always re-prompt on every switch into a password-protected workspace —
    // previously this skipped the prompt once SecureStore.isUnlockedWithPassword(id)
    // was true for the session, so after the first correct entry you could
    // freely flip back and forth with no password at all. Re-verifying the
    // password each time doesn't re-decrypt anything extra — SecureStore
    // already caches the derived key — it's just the UI gate that's stricter now.
    if (requiresPassword) {
      // Hide native/webview content so the lock overlay (which lives in
      // the web UI) can appear above it. withdrawActiveViewForOverlay
      // hides the active native view when running inside Tauri.
      try {
        withdrawActiveViewForOverlay();
      } catch {}

      const target = workspaces.find((w) => w.id === id);
      try {
        const ok = window.Lock ? await window.Lock.unlockWorkspace(id, target ? target.name : id) : true;
        if (!ok) {
          // User cancelled unlock; restore view.
          try { restoreActiveViewFromOverlay(); } catch {}
          return;
        }
      } catch (e) {
        console.warn('unlockWorkspace failed:', e);
        try { restoreActiveViewFromOverlay(); } catch {}
        return;
      }
    }
    activeWorkspaceId = id;
    renderWorkspaces();
    renderTabs();
    renderActiveView();
    renderVaultList();
    renderHistoryList();
    renderBookmarkList();
  }
  let tabSeq = 0;
  let frameBlockTimer = null;
  let draggedTabId = null;

  function activeWorkspace() {
    return workspaces.find((w) => w.id === activeWorkspaceId);
  }

  function makeTab(url, title) {
    tabSeq += 1;
    return {
      id: `t${tabSeq}`,
      url: url || "about:start",
      title: title || "New Tab",
      isSearch: false,
      display: url || "about:start",
      viewCreated: false,
    };
  }

  // ---------- Session persistence (opt-in via Settings) ----------

  let saveSessionTimer = null;
  function saveSession() {
    if (!Settings.get().restoreSession) return;
    clearTimeout(saveSessionTimer);
    saveSessionTimer = setTimeout(() => {
      try {
        localStorage.setItem(
          "sreon:session",
          JSON.stringify({ workspaces, activeWorkspaceId })
        );
      } catch {
        /* storage full or unavailable — not fatal */
      }
    }, 300);
  }

  function loadSession() {
    if (!Settings.get().restoreSession) return false;
    try {
      const raw = localStorage.getItem("sreon:session");
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.workspaces)) return false;
      workspaces = parsed.workspaces.map((w) => ({ ...w, tabs: w.tabs || [] }));
      activeWorkspaceId = parsed.activeWorkspaceId || workspaces[0]?.id;
      tabSeq = workspaces.reduce((max, w) => {
        w.tabs.forEach((t) => {
          const n = Number(String(t.id).replace("t", ""));
          if (!Number.isNaN(n)) max = Math.max(max, n);
        });
        return max;
      }, 0);
      return workspaces.some((w) => w.tabs.length > 0);
    } catch {
      return false;
    }
  }

  // ---------- Ad blocker test ----------
  // A fully local, self-contained test page (no network calls — it's a
  // data: URL) that opens in a REAL tab so the same ad-block init script
  // every normal site gets is actually exercised: it checks that the
  // popup blocker stops a known ad host, that the CSS-hiding rule hides
  // a real .adsbygoogle-style element, that notification permission is
  // denied, and it live-updates from the genuine session block counter.
  const ADBLOCK_TEST_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Sreon Ad Blocker Test</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0e1116;color:#e7ebf0;padding:40px 32px;max-width:640px;margin:0 auto;}
  h1{font-size:22px;margin:0 0 6px;} p.lead{color:#9aa6b5;margin:0 0 24px;line-height:1.5;}
  .row{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;margin:10px 0;border-radius:12px;background:#1a1f27;border:1px solid #262c36;}
  .pass{color:#22c55e;font-weight:700;} .fail{color:#ef4444;font-weight:700;} .pending{color:#9aa6b5;}
  .adsbygoogle,#div-gpt-ad-test{display:block;width:100%;height:36px;background:#ef4444;color:#fff;text-align:center;line-height:36px;border-radius:8px;margin-top:18px;font-size:13px;}
  .counter{font-size:15px;color:#9aa6b5;margin-top:28px;}
  .counter b{color:#e7ebf0;font-size:20px;}
</style></head>
<body>
  <h1>Sreon Ad Blocker Test</h1>
  <p class="lead">Everything on this page runs locally in this tab — nothing is sent anywhere. It exercises Sreon's real ad/tracker blocking the same way any normal site would.</p>
  <div class="row"><span>Known ad-host popup blocked</span><span id="t-popup" class="pending">Checking…</span></div>
  <div class="row"><span>Ad container hidden by CSS rule</span><span id="t-css" class="pending">Checking…</span></div>
  <div class="row"><span>Site notification pop-ups denied</span><span id="t-notif" class="pending">Checking…</span></div>
  <div class="adsbygoogle" id="ad1">AD PLACEHOLDER — should be hidden if blocking is on</div>
  <div id="div-gpt-ad-test">AD PLACEHOLDER — should be hidden if blocking is on</div>
  <p class="counter">Blocked so far this session: <b id="t-count">0</b></p>
  <script>
    function set(id, ok) { var el = document.getElementById(id); el.textContent = ok ? 'PASS' : 'FAIL — turn on Ad & tracker blocking in Settings'; el.className = ok ? 'pass' : 'fail'; }
    try {
      var popup = window.open('https://doubleclick.net/sreon-adblock-test', '_blank');
      set('t-popup', !popup);
    } catch (e) { set('t-popup', true); }
    setTimeout(function () {
      try {
        var ad1 = document.getElementById('ad1');
        set('t-css', ad1 && getComputedStyle(ad1).display === 'none');
      } catch (e) { set('t-css', false); }
    }, 350);
    try {
      if (window.Notification) {
        Notification.requestPermission(function (p) { set('t-notif', p === 'denied'); });
      } else { set('t-notif', true); }
    } catch (e) { set('t-notif', true); }
    try {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.listen('sreon://block-count', function (e) {
          document.getElementById('t-count').textContent = e.payload;
        });
      }
    } catch (e) {}
  <\/script>
</body></html>`;

  function openAdBlockTest() {
    createTab("data:text/html;charset=utf-8," + encodeURIComponent(ADBLOCK_TEST_HTML));
  }
  window.SreonAdBlockTest = { open: openAdBlockTest };

  // ---------- Tabs ----------

  function createTab(url) {
    const ws = activeWorkspace();
    const tab = makeTab(url);
    ws.tabs.push(tab);
    renderTabs();
    activateTab(tab.id);
    return tab;
  }

  function closeTab(id) {
    const ws = activeWorkspace();
    const idx = ws.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const wasActive = ws.tabs[idx].id === ws.activeTabId;
    if (isTauri) {
      if (ws.tabs[idx].viewCreated) tauriInvoke("close_tab_view", { id }).catch(() => {});
      if (activeNativeTabId === id) activeNativeTabId = null;
    } else {
      document.getElementById(`frame-${id}`)?.remove();
    }
    ws.tabs.splice(idx, 1);
    if (wasActive) {
      const next = ws.tabs[idx] || ws.tabs[idx - 1];
      ws.activeTabId = next ? next.id : null;
    }
    renderTabs();
    renderActiveView();
    saveSession();
  }

  function activateTab(id) {
    activeWorkspace().activeTabId = id;
    renderTabs();
    renderActiveView();
    saveSession();
  }

  function currentTab() {
    const ws = activeWorkspace();
    return ws.tabs.find((t) => t.id === ws.activeTabId) || null;
  }

  // ---------- Sliding tab indicator ----------

  function updateTabIndicator() {
    const indicator = document.getElementById("tab-indicator");
    const list = document.getElementById("tab-list");
    const activeEl = list.querySelector(".tab-item.active");
    if (!activeEl) {
      indicator.classList.remove("show");
      return;
    }
    const listRect = list.getBoundingClientRect();
    const rect = activeEl.getBoundingClientRect();
    indicator.style.transform = `translateY(${rect.top - listRect.top}px)`;
    indicator.style.height = `${rect.height}px`;
    indicator.classList.add("show");
  }

  // ---------- Drag-to-reorder tabs (with FLIP animation) ----------

  function reorderTab(draggedId, targetId, before) {
    const ws = activeWorkspace();
    const from = ws.tabs.findIndex((t) => t.id === draggedId);
    if (from === -1) return;
    const [moved] = ws.tabs.splice(from, 1);
    let to = ws.tabs.findIndex((t) => t.id === targetId);
    if (to === -1) to = ws.tabs.length;
    ws.tabs.splice(before ? to : to + 1, 0, moved);
    renderTabsAnimated();
    saveSession();
  }

  function renderTabsAnimated() {
    const list = document.getElementById("tab-list");
    const items = [...list.querySelectorAll(".tab-item")];
    const firstRects = new Map(items.map((el) => [el.dataset.id, el.getBoundingClientRect()]));

    renderTabs();

    const newItems = [...list.querySelectorAll(".tab-item")];
    newItems.forEach((el) => {
      const first = firstRects.get(el.dataset.id);
      if (!first) return;
      const last = el.getBoundingClientRect();
      const dy = first.top - last.top;
      if (dy) {
        el.style.transition = "none";
        el.style.transform = `translateY(${dy}px)`;
        requestAnimationFrame(() => {
          el.style.transition = `transform var(--dur-med) var(--ease-spring)`;
          el.style.transform = "";
        });
      }
    });
  }

  function renderTabs() {
    const list = document.getElementById("tab-list");
    const ws = activeWorkspace();
    // Keep the indicator element — only replace the tab items themselves.
    list.querySelectorAll(".tab-item").forEach((el) => el.remove());

    ws.tabs.forEach((tab) => {
      const el = document.createElement("div");
      el.className = "tab-item" + (tab.id === ws.activeTabId ? " active" : "");
      el.dataset.id = tab.id;
      el.draggable = true;
      const icon = tab.isStart ? "✦" : tab.isSearch ? "⌕" : "◌";
      el.innerHTML = `
        <span class="tab-favicon">${icon}</span>
        <span class="tab-title">${escapeHtml(tab.title || tab.display || tab.url)}</span>
        <span class="tab-close" title="Close tab">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </span>`;

      el.addEventListener("click", (e) => {
        if (e.target.closest(".tab-close")) {
          closeTab(tab.id);
        } else {
          activateTab(tab.id);
        }
      });

      el.addEventListener("dragstart", (e) => {
        draggedTabId = tab.id;
        el.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", tab.id); } catch {}
      });
      el.addEventListener("dragend", () => {
        el.classList.remove("dragging");
        list.querySelectorAll(".tab-item").forEach((n) => n.classList.remove("drag-target-before", "drag-target-after"));
        draggedTabId = null;
      });
      el.addEventListener("dragover", (e) => {
        if (!draggedTabId || draggedTabId === tab.id) return;
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const before = e.clientY - rect.top < rect.height / 2;
        el.classList.toggle("drag-target-before", before);
        el.classList.toggle("drag-target-after", !before);
      });
      el.addEventListener("dragleave", () => {
        el.classList.remove("drag-target-before", "drag-target-after");
      });
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!draggedTabId || draggedTabId === tab.id) return;
        const rect = el.getBoundingClientRect();
        const before = e.clientY - rect.top < rect.height / 2;
        reorderTab(draggedTabId, tab.id, before);
      });

      list.appendChild(el);
    });

    updateTabIndicator();
  }

  function updateNavButtonsState(tab) {
    const onPage = !!tab && tab.url !== "about:start";
    ["back-btn", "fwd-btn", "reload-btn", "open-system-btn"].forEach((id) => {
      document.getElementById(id).disabled = !onPage;
    });
  }

  function renderActiveView() {
    const searchBar = document.getElementById("search-brand-bar");
    const tab = currentTab();
    searchBar.classList.remove("show");
    updateNavButtonsState(tab);
    updateBookmarkButton();

    if (isTauri) {
      renderActiveViewTauri(tab, searchBar);
    } else {
      renderActiveViewIframe(tab, searchBar);
    }
  }

  // Real desktop build: position/show the current tab's native webview,
  // hiding whichever one was showing before.
  //
  // IMPORTANT (perf): this script gets re-sent into the page with
  // `tab_eval` on a timer (see injectBrand below). Everything inside is
  // guarded by `window.__sreonBrandInit` so the expensive one-time setup
  // (creating the overlay/style/bar, and — critically — the
  // MutationObserver) only ever runs ONCE per page load. Earlier builds
  // created a brand-new MutationObserver on every single tick without
  // ever disconnecting the previous ones, so the longer a tab stayed
  // open the more overlapping observers piled up, each one doing a full
  // page DOM walk on every mutation — that compounding cost was the
  // main source of Sreon feeling laggy the longer you browsed. Now only
  // the cheap `replace()` pass re-runs on each tick/mutation; the
  // observer itself is created exactly once.
  function buildSreonBrandingScript(accent) {
    return [
      "(() => {",
      "  try {",
      "    if (!document || !document.location || !document.location.href) return;",
      "    if (String(document.location.href) === 'about:blank') return;",
      "    const rgba = (hex, alpha) => {",
      "      const clean = String(hex || '#3d8bff').replace('#', '');",
      "      const full = clean.length === 3 ? clean.split('').map((ch) => ch + ch).join('') : clean;",
      "      const value = Number.parseInt(full, 16) || 0x3d8bff;",
      "      const r = (value >> 16) & 255;",
      "      const g = (value >> 8) & 255;",
      "      const b = value & 255;",
      "      return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';",
      "    };",
      "    const replace = () => {",
      "      const selectors = ['img[alt*=\'Google\']', 'img[alt=\'Google\']', 'img[alt=\'Google Search\']', '#hplogo', '.lnXdpd', '.google-logo', '.logo', '[aria-label*=\'Google\']', 'img[src*=\'google\']'];",
      "      selectors.forEach((selector) => {",
      "        document.querySelectorAll(selector).forEach((el) => {",
      "          try {",
      "            if (el.tagName === 'IMG') {",
      "              el.src = logoUrlGlobal;",
      "              el.alt = 'Sreon';",
      "            } else {",
      "              el.innerHTML = '<img src=\"' + logoUrlGlobal + '\" alt=\"Sreon\" style=\"height:40px;display:block;max-height:40px;\">';",
      "            }",
      "          } catch (e) {}",
      "        });",
      "      });",
      "      ['hplogo', 'logo', 'lga'].forEach((id) => {",
      "        const el = document.getElementById(id);",
      "        if (!el) return;",
      "        try {",
      "          if (el.tagName === 'IMG') {",
      "            el.src = logoUrlGlobal;",
      "            el.alt = 'Sreon';",
      "          } else {",
      "            el.innerHTML = '<img src=\"' + logoUrlGlobal + '\" alt=\"Sreon\" style=\"height:40px;display:block;max-height:40px;\">';",
      "          }",
      "        } catch (e) {}",
      "      });",
      "      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, null);",
      "      while (walker.nextNode()) {",
      "        const node = walker.currentNode;",
      "        if (node && node.nodeType === 3 && /Google/gi.test(node.nodeValue)) {",
      "          node.nodeValue = node.nodeValue.replace(/Google/gi, 'Sreon');",
      "        }",
      "      }",
      "    };",
      "    const svg = '<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 160 42\"><text x=\"4\" y=\"29\" font-family=\"Arial, Helvetica, sans-serif\" font-weight=\"700\" font-size=\"28\" fill=\"' + accent + '\">Sreon</text></svg>';",
      "    const logoUrlGlobal = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);",
      "    if (window.__sreonBrandInit) { replace(); return; }",
      "    window.__sreonBrandInit = true;",
      "    const style = document.createElement('style');",
      "    style.id = 'sreon-brand-style';",
      "    style.textContent = 'html, body { background: #faf4e6 !important; background-color: #faf4e6 !important; color-scheme: light !important; } a, a:visited, a:link { color: ' + accent + ' !important; } a:hover { color: ' + accent + 'cc !important; } ::selection { background: ' + accent + ' !important; color: #fff !important; } #hplogo, .lnXdpd, .logo, .google-logo, [aria-label=\"Google\"], [aria-label*=\"Google\"], svg[aria-label*=\"Google\"], img[alt*=\"Google\"], img[src*=\"googlelogo\"], img[srcset*=\"googlelogo\"], a[href*=\"/webhp\"] img, a[href=\"https://www.google.com/\"] img { display: none !important; visibility: hidden !important; }';",
      "    document.head && document.head.appendChild(style);",
      "    const overlay = document.createElement('div');",
      "    overlay.id = 'sreon-tint-overlay';",
      "    overlay.style.position = 'fixed';",
      "    overlay.style.inset = '0';",
      "    overlay.style.zIndex = '200';",
      "    overlay.style.pointerEvents = 'none';",
      "    overlay.style.opacity = '0.12';",
      "    overlay.style.mixBlendMode = 'normal';",
      "    overlay.style.background = 'radial-gradient(circle at top left, ' + rgba(accent, 0.12) + ', transparent 65%), linear-gradient(180deg, ' + rgba(accent, 0.08) + ', transparent 30%)';",
      "    document.documentElement.appendChild(overlay);",
      "    const bar = document.createElement('div');",
      "    bar.id = 'sreon-inject-brandbar';",
      "    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:46px;z-index:201;display:flex;align-items:center;gap:10px;padding:0 16px;background:' + accent + ';color:#fff;font:700 16px -apple-system,Segoe UI,Roboto,sans-serif;pointer-events:none;';",
      "    bar.innerHTML = '<img src=\"' + logoUrlGlobal.replace(accent, '%23ffffff') + '\" style=\"height:22px;filter:brightness(0) invert(1);\"><span>Sreon</span>';",
      "    document.documentElement.appendChild(bar);",
      "    if (document.body) document.body.style.marginTop = '46px';",
      "    replace();",
      "    try {",
      "      let scheduled = false;",
      "      const observer = new MutationObserver(() => {",
      "        if (scheduled) return;",
      "        scheduled = true;",
      "        setTimeout(() => { scheduled = false; replace(); }, 150);",
      "      });",
      "      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'alt', 'class', 'style'] });",
      "    } catch (e) {}",
      "  } catch (e) {}",
      "})();",
    ].join('');
  }

  // ---------- Load progress bar ----------
  // A lightweight, JS-only "feels fast" indicator — since Sreon doesn't yet
  // wire a real did-finish-navigation event from the Rust side back to
  // the UI, this uses the same honest fake-progress pattern most browsers'
  // own UI chrome uses (ramp to ~78% immediately, then settle): it gives
  // instant feedback the moment you hit Enter instead of the address bar
  // just sitting there with no response until the page appears.
  let loadProgressTimer = null;
  function startLoadProgress() {
    const bar = document.getElementById("load-progress");
    if (!bar) return;
    if (loadProgressTimer) clearTimeout(loadProgressTimer);
    bar.style.transition = "none";
    bar.style.width = "0%";
    void bar.offsetWidth; // force reflow so the width change below animates
    bar.style.transition = "";
    bar.classList.add("show");
    requestAnimationFrame(() => { bar.style.width = "78%"; });
    loadProgressTimer = setTimeout(finishLoadProgress, 900);
  }
  function finishLoadProgress() {
    const bar = document.getElementById("load-progress");
    if (!bar) return;
    if (loadProgressTimer) { clearTimeout(loadProgressTimer); loadProgressTimer = null; }
    bar.style.width = "100%";
    setTimeout(() => { bar.classList.remove("show"); bar.style.width = "0%"; }, 220);
  }

  function renderActiveViewTauri(tab, searchBar) {
    const startPage = document.getElementById("start-page");

    if (activeNativeTabId && (!tab || activeNativeTabId !== tab.id)) {
      hideTabView(activeNativeTabId);
      activeNativeTabId = null;
    }

    if (!tab || tab.url === "about:start") {
      startPage.classList.add("active");
      document.getElementById("addr-input").value = "";
      if (brandInjectTimer) { clearInterval(brandInjectTimer); brandInjectTimer = null; }
      return;
    }
    startPage.classList.remove("active");
    document.getElementById("addr-input").value = tab.isSearch ? `Sreon — ${tab.display}` : tab.display;
    if (tab.isSearch) {
      document.getElementById("search-brand-query").textContent = tab.display;
      searchBar.classList.add("show");
    }
    startLoadProgress();
    showTabView(tab);
    if (brandInjectTimer) { clearInterval(brandInjectTimer); brandInjectTimer = null; }
    // IMPORTANT: only re-skin Sreon's OWN search-results tabs. This used to
    // run on every page you visited, full stop — including Gmail, Google
    // Sign-In, Drive, and any other real site. It force-replaced every
    // occurrence of the text "Google" anywhere on the page, hid logos,
    // pinned a 46px bar to the top (shifting the whole page down), and
    // forced a light background + custom link colors every 4 seconds. On
    // real sites that's not rebranding, it's active corruption of the
    // page — it's what was breaking Google sign-in and making unrelated
    // sites look/behave wrong. Sreon's look belongs on Sreon's own UI
    // (the search bar/backend results it builds itself), never injected
    // into third-party pages.
    if (tab.isSearch) {
      const injectBrand = () => {
        try {
          const accent = (Settings && Settings.get && Settings.get().accentColor) || '#3d8bff';
          const script = buildSreonBrandingScript(accent);
          tauriInvoke('tab_eval', { id: tab.id, script }).catch(() => {});
        } catch (e) {}
      };
      // Fire once shortly after navigation so first paint gets branded, then
      // keep re-applying on a light interval as a fallback for anything the
      // MutationObserver (set up once inside the injected script, see
      // buildSreonBrandingScript) doesn't happen to catch. This interval used
      // to run every 1.2s, and — combined with the old per-tick observer
      // creation bug — was the main cause of Sreon feeling laggy the longer a
      // tab was open. Now that the observer is created only once and each
      // tick just re-runs the cheap `replace()` pass, a slower fallback is
      // plenty and costs far less CPU.
      setTimeout(injectBrand, 220);
      brandInjectTimer = setInterval(injectBrand, 4000);
    }
    logHistory(tab);
  }

  // Browser-preview build (no Tauri backend available): the original
  // <iframe> embed. Real sites with framing protections will still
  // refuse to load here — that's only fixable inside the actual
  // desktop app, which uses real native webviews instead (see above).
  function renderActiveViewIframe(tab, searchBar) {
    const stack = document.getElementById("view-stack");
    const startPage = document.getElementById("start-page");
    const blocked = document.getElementById("frame-blocked");
    const loading = document.getElementById("frame-loading");

    stack.querySelectorAll(".view-frame").forEach((f) => f.classList.remove("active"));
    blocked.classList.remove("show");
    loading.classList.remove("show");
    clearTimeout(frameBlockTimer);

    if (!tab || tab.url === "about:start") {
      startPage.classList.add("active");
      document.getElementById("addr-input").value = "";
      return;
    }
    startPage.classList.remove("active");
    // Never show the search backend's own URL — the address bar reflects
    // either the real site URL, or "Sreon — <query>" for search results.
    document.getElementById("addr-input").value = tab.isSearch ? `Sreon — ${tab.display}` : tab.display;

    // Sreon-branded strip pinned above results for search tabs, so a
    // search always reads as "Sreon" first rather than the backend's
    // own logo/chrome underneath it.
    if (tab.isSearch) {
      document.getElementById("search-brand-query").textContent = tab.display;
      searchBar.classList.add("show");
    }

    let frame = document.getElementById(`frame-${tab.id}`);
    if (!frame && isKnownBlocked(tab.url)) {
      // Don't even attempt the embed for sites known to refuse it —
      // avoids the "stuck on white" wait entirely.
      showBlocked(tab);
      return;
    }
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = `frame-${tab.id}`;
      frame.className = "view-frame";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation");
      frame.referrerPolicy = "no-referrer-when-downgrade";
      if (tab.isSearch) frame.classList.add("has-search-bar");
      // Lower iframe by VIEW_TOP_INSET so it doesn't overlap floating UI
      frame.style.top = `${VIEW_TOP_INSET}px`;
      frame.style.height = `calc(100% - ${VIEW_TOP_INSET}px)`;
      stack.insertBefore(frame, blocked);

      let settled = false;
      loading.classList.add("show");
      frame.addEventListener("load", () => {
        settled = true;
        loading.classList.remove("show");
        document.getElementById("reload-btn").classList.remove("loading");
        // Sites that refuse to be framed (X-Frame-Options / CSP
        // frame-ancestors) still fire `load` — the navigation gets
        // aborted and the frame is left on about:blank rather than
        // erroring. That's same-origin to us, so we CAN read its
        // location (a real cross-origin success would throw here).
        try {
          const href = frame.contentWindow && frame.contentWindow.location.href;
          if (href === "about:blank") {
            showBlocked(tab);
            return;
          }
        } catch {
          // Threw = cross-origin = the real site actually loaded. Fine.
        }

        // Try to inject branding into same-origin iframes (best-effort).
        // Scoped to Sreon's own search-result tabs only — never on a real
        // site the person actually navigated to (see the matching note in
        // renderActiveViewTauri above for why: this used to run on every
        // page, including Google Sign-In and other login flows, and could
        // visibly break them).
        try {
          if (!tab.isSearch) throw new Error("skip-branding-non-search-tab");
          const accent = (Settings && Settings.get && Settings.get().accentColor) || '#3d8bff';
          const doc = frame.contentDocument || frame.contentWindow.document;
          if (doc) {
            const rgba = (hex, alpha) => {
              const clean = String(hex || '#3d8bff').replace('#', '');
              const full = clean.length === 3 ? clean.split('').map((ch) => ch + ch).join('') : clean;
              const value = Number.parseInt(full, 16) || 0x3d8bff;
              const r = (value >> 16) & 255;
              const g = (value >> 8) & 255;
              const b = value & 255;
              return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
            };
            const style = doc.createElement('style');
            style.id = 'sreon-brand-style';
            style.textContent = `html, body { background: #faf4e6 !important; background-color: #faf4e6 !important; color-scheme: light !important; } a { color: ${accent} !important; } #hplogo, .lnXdpd, .logo, .google-logo, [aria-label="Google"], [aria-label*="Google"], svg[aria-label*="Google"], img[alt*="Google"], img[src*="googlelogo"], img[srcset*="googlelogo"], a[href*="/webhp"] img, a[href="https://www.google.com/"] img { display: none !important; visibility: hidden !important; }`;
            const oldStyle = doc.getElementById('sreon-brand-style');
            if (oldStyle) oldStyle.remove();
            doc.head && doc.head.appendChild(style);

            const overlay = doc.createElement('div');
            overlay.id = 'sreon-tint-overlay';
            overlay.style.position = 'fixed';
            overlay.style.inset = '0';
            overlay.style.pointerEvents = 'none';
            overlay.style.zIndex = '199';
            overlay.style.opacity = '0.12';
            overlay.style.background = `radial-gradient(circle at top left, ${rgba(accent, 0.12)}, transparent 55%), linear-gradient(180deg, ${rgba(accent, 0.06)}, transparent 30%)`;
            const oldOverlay = doc.getElementById('sreon-tint-overlay');
            if (oldOverlay) oldOverlay.remove();
            doc.documentElement.appendChild(overlay);

            const logoUrl = (() => {
              const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 42"><text x="4" y="29" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="28" fill="${accent}">Sreon</text></svg>`;
              return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
            })();
            const replaceLogo = () => {
              doc.querySelectorAll('img[alt*="Google"], img[alt="Google"], img[alt="Google Search"], #hplogo, .lnXdpd, .google-logo, .logo, [aria-label*="Google"], img[src*="google"]').forEach((img) => {
                try {
                  img.src = logoUrl;
                  img.alt = 'Sreon';
                } catch (e) {}
              });
              ['hplogo', 'logo', 'lga'].forEach((id) => {
                const el = doc.getElementById(id);
                if (!el) return;
                try {
                  if (el.tagName === 'IMG') {
                    el.src = logoUrl;
                    el.alt = 'Sreon';
                  } else {
                    el.innerHTML = '<img src="' + logoUrl + '" alt="Sreon" style="height:40px;display:block;max-height:40px;">';
                  }
                } catch (e) {}
              });
              const walker = doc.createTreeWalker(doc.body || doc.documentElement, 4, null);
              while (walker.nextNode()) {
                const node = walker.currentNode;
                if (node && node.nodeType === 3 && /Google/gi.test(node.nodeValue)) {
                  node.nodeValue = node.nodeValue.replace(/Google/gi, 'Sreon');
                }
              }
            };
            replaceLogo();
          }
        } catch (e) {
          // cross-origin or DOM access blocked — ignore
        }
      });
      frame.addEventListener("error", () => showBlocked(tab));
      try {
        setTimeout(() => {
          try {
            if (!tab.isSearch) return; // never touch a real site's DOM, only Sreon's own search tabs
            const doc = frame.contentDocument || frame.contentWindow.document;
            if (!doc) return;
            const accent = (Settings && Settings.get && Settings.get().accentColor) || '#3d8bff';
            const rgba = (hex, alpha) => {
              const clean = String(hex || '#3d8bff').replace('#', '');
              const full = clean.length === 3 ? clean.split('').map((ch) => ch + ch).join('') : clean;
              const value = Number.parseInt(full, 16) || 0x3d8bff;
              const r = (value >> 16) & 255;
              const g = (value >> 8) & 255;
              const b = value & 255;
              return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
            };
            const light = rgba(accent, 0.06);
            doc.documentElement.style.backgroundColor = light;
            if (doc.body) doc.body.style.backgroundColor = light;
            const url = (() => {
              const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 42"><text x="4" y="29" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="28" fill="${accent}">Sreon</text></svg>`;
              return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
            })();
            ['hplogo', 'logo', 'lga'].forEach((id) => {
              try {
                const el = doc.getElementById(id);
                if (!el) return;
                if (el.tagName === 'IMG') {
                  el.src = url;
                  el.alt = 'Sreon';
                } else {
                  el.innerHTML = '<img src="' + url + '" alt="Sreon" style="height:40px;display:block;max-height:40px;">';
                }
              } catch (e) {}
            });
            doc.querySelectorAll('img[alt*="Google"]').forEach((img) => {
              try {
                img.src = url;
                img.alt = 'Sreon';
              } catch (e) {}
            });
          } catch (e) {}
        }, 180);
      } catch (e) {}
      frame.src = tab.url;

      // 3.5s is plenty for a same-machine embed attempt to either
      // start painting or get silently aborted by the site's framing
      // policy — waiting longer just leaves a blank pane on screen.
      frameBlockTimer = setTimeout(() => {
        if (!settled && frame.classList.contains("active")) showBlocked(tab);
      }, 3500);    } else if (!document.getElementById("reload-btn").classList.contains("loading")) {
      loading.classList.remove("show");
    }
    frame.classList.add("active");
  }

  function showBlocked(tab) {
    document.getElementById("frame-loading").classList.remove("show");
    document.getElementById("search-brand-bar").classList.remove("show");
    document.getElementById("frame-blocked").classList.add("show");
    document.getElementById("frame-blocked-open").onclick = () => openInSystemBrowser(tab.url);
  }

  function navigate(rawInput) {
    const parsed = normalizeInput(rawInput);
    if (!parsed) return;
    let tab = currentTab();
    // On a fresh window (no tabs yet) this creates the first tab, but the
    // search/display/title fields below still need to be applied to it —
    // previously this returned early right here, so a person's very first
    // search of a session loaded the right URL but never got marked as a
    // search (no "Sreon — <query>" address bar, no branded results strip),
    // which read as the search having silently failed.
    if (!tab) {
      tab = createTab(parsed.isStart ? null : parsed.url);
    }
    tab.url = parsed.isStart ? "about:start" : parsed.url;
    tab.isSearch = !!parsed.isSearch;
    tab.display = parsed.isStart ? "about:start" : parsed.display;
    tab.title = parsed.isStart
      ? "New Tab"
      : parsed.isSearch
        ? parsed.display
        : parsed.url.replace(/^https?:\/\//, "");
    if (isTauri) {
      if (tab.viewCreated && tab.url !== "about:start") {
        tauriInvoke("navigate_tab_view", { id: tab.id, url: tab.url }).catch(() => {});
      } else if (tab.url === "about:start" && tab.viewCreated) {
        // Going back to the start page — drop the native view entirely
        // rather than leaving a stale page loaded behind it.
        tauriInvoke("close_tab_view", { id: tab.id }).catch(() => {});
        tab.viewCreated = false;
        if (activeNativeTabId === tab.id) activeNativeTabId = null;
      }
    } else {
      document.getElementById(`frame-${tab.id}`)?.remove();
    }
    renderTabs();
    renderActiveView();
    saveSession();
  }

  // ---------- Search suggestions ----------

  function wireSuggestions(inputEl, dropdownEl, formEl) {
    let debounceTimer = null;
    let items = [];
    let highlighted = -1;

    function hide() {
      dropdownEl.classList.remove("show");
      dropdownEl.innerHTML = "";
      items = [];
      highlighted = -1;
    }

    function select(text) {
      inputEl.value = text;
      hide();
      navigate(text);
    }

    function render() {
      dropdownEl.innerHTML = items
        .map(
          (s, i) => `
        <button type="button" class="suggest-item${i === highlighted ? " highlighted" : ""}" data-i="${i}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          ${escapeHtml(s)}
        </button>`
        )
        .join("");
      dropdownEl.querySelectorAll(".suggest-item").forEach((btn) => {
        btn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          select(items[Number(btn.dataset.i)]);
        });
      });
      dropdownEl.classList.toggle("show", items.length > 0);
    }

    async function fetchSuggestions(q) {
      try {
        const res = await fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`);
        if (!res.ok) throw new Error("bad response");
        const data = await res.json();
        items = Array.isArray(data) ? data.map((d) => d.phrase).filter(Boolean).slice(0, 6) : [];
        highlighted = -1;
        render();
      } catch {
        // Network unavailable, endpoint blocked, or offline — fail silent,
        // the address bar still works fine without suggestions.
        hide();
      }
    }

    inputEl.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      const q = inputEl.value.trim();
      const isUrlLike = /^[a-z][a-z0-9+.-]*:\/\//i.test(q) || q === "sreon://start";
      const settings = Settings.get();
      if (!settings.searchSuggestions || settings.privacyMode || !q || isUrlLike) {
        hide();
        return;
      }
      debounceTimer = setTimeout(() => fetchSuggestions(q), 180);
    });

    inputEl.addEventListener("keydown", (e) => {
      if (!items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        highlighted = (highlighted + 1) % items.length;
        render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlighted = (highlighted - 1 + items.length) % items.length;
        render();
      } else if (e.key === "Enter" && highlighted >= 0) {
        e.preventDefault();
        select(items[highlighted]);
      } else if (e.key === "Escape") {
        hide();
      }
    });

    inputEl.addEventListener("blur", () => setTimeout(hide, 120));
    formEl?.addEventListener("submit", hide);
  }

  // ---------- Workspaces ----------

  function renderWorkspaces() {
    const wrap = document.getElementById("workspace-pills");
    wrap.innerHTML = workspaces
      .map(
        (w) => `
      <button class="ws-pill${w.id === activeWorkspaceId ? " active" : ""}" data-id="${w.id}">
        <span class="ws-dot" style="--ws-color:${escapeHtml(w.color || "var(--accent)")}"></span>${escapeHtml(w.name)}
        ${workspaceRequiresPassword(w.id) ? '<svg class="ws-lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>' : ""}
      </button>`
      )
      .join("");
    wrap.querySelectorAll(".ws-pill").forEach((btn) => {
      btn.addEventListener("click", () => switchWorkspace(btn.dataset.id));
    });
  }

  // ---------- Command palette ----------

  function getCommands() {
    const ws = activeWorkspace();
    const cmds = [
      { label: "New Tab", hint: "⌘T", icon: "plus", run: () => createTab(null) },
      { label: "Test Ad Blocker", hint: "", icon: "shield", run: () => openAdBlockTest() },
      { label: "Close Tab", hint: "⌘W", icon: "close", run: () => { const t = currentTab(); if (t) closeTab(t.id); } },
      { label: "Reload Page", hint: "", icon: "reload", run: () => document.getElementById("reload-btn").click() },
      { label: "Go Back", hint: "", icon: "back", run: () => document.getElementById("back-btn").click() },
      { label: "Go Forward", hint: "", icon: "fwd", run: () => document.getElementById("fwd-btn").click() },
      { label: "Focus Address Bar", hint: "⌘L", icon: "search", run: () => { document.getElementById("addr-input").focus(); document.getElementById("addr-input").select(); } },
      { label: "Toggle Sidebar", hint: "", icon: "sidebar", run: () => document.getElementById("shell").classList.toggle("collapsed") },
      { label: "Open Settings", hint: "", icon: "settings", run: () => document.getElementById("settings-btn").click() },
      { label: "Open in System Browser", hint: "", icon: "external", run: () => { const t = currentTab(); if (t && t.url !== "about:start") openInSystemBrowser(t.url); } },
      { label: "Bookmark This Page", hint: "⌘D", icon: "earth", run: () => toggleBookmarkCurrentTab() },
      { label: "About Sreon", hint: "", icon: "earth", run: () => openAbout() },
    ];
    workspaces.forEach((w) => {
      if (w.id === activeWorkspaceId) return;
      cmds.push({
        label: `Switch to ${w.name}`,
        hint: "",
        icon: "workspace",
        run: () => switchWorkspace(w.id),
      });
    });
    ws.tabs.forEach((t) => {
      if (t.id === ws.activeTabId) return;
      cmds.push({
        label: `Go to tab: ${t.title || t.display || t.url}`,
        hint: "",
        icon: "tab",
        run: () => activateTab(t.id),
      });
    });
    return cmds;
  }

  const CMDK_ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    reload: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>',
    back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    fwd: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82"/>',
    external: '<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
    earth: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.6 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z"/>',
    workspace: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    tab: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
  };

  let cmdkHighlighted = 0;
  let cmdkFiltered = [];

  function renderCmdk(query) {
    const all = getCommands();
    const q = query.trim().toLowerCase();
    cmdkFiltered = q ? all.filter((c) => c.label.toLowerCase().includes(q)) : all;
    cmdkHighlighted = 0;

    const list = document.getElementById("cmdk-list");
    if (!cmdkFiltered.length) {
      list.innerHTML = `<div class="cmdk-empty">No matching commands</div>`;
      return;
    }
    list.innerHTML = cmdkFiltered
      .map(
        (c, i) => `
      <div class="cmdk-item${i === cmdkHighlighted ? " highlighted" : ""}" data-i="${i}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${CMDK_ICONS[c.icon] || ""}</svg>
        <span class="cmdk-label">${escapeHtml(c.label)}</span>
        ${c.hint ? `<kbd class="cmdk-hint">${c.hint}</kbd>` : ""}
      </div>`
      )
      .join("");
    list.querySelectorAll(".cmdk-item").forEach((el) => {
      el.addEventListener("click", () => runCmdk(Number(el.dataset.i)));
      el.addEventListener("mouseenter", () => {
        cmdkHighlighted = Number(el.dataset.i);
        list.querySelectorAll(".cmdk-item").forEach((n) => n.classList.remove("highlighted"));
        el.classList.add("highlighted");
      });
    });
  }

  function runCmdk(i) {
    const cmd = cmdkFiltered[i];
    closeCmdk();
    if (cmd) cmd.run();
  }

  function openCmdk() {
    withdrawActiveViewForOverlay();
    const overlay = document.getElementById("cmdk-overlay");
    const panel = document.getElementById("cmdk-panel");
    const input = document.getElementById("cmdk-input");
    overlay.classList.add("show");
    panel.classList.add("show");
    input.value = "";
    renderCmdk("");
    setTimeout(() => input.focus(), 10);
  }

  function closeCmdk() {
    document.getElementById("cmdk-overlay").classList.remove("show");
    document.getElementById("cmdk-panel").classList.remove("show");
    restoreActiveViewFromOverlay();
  }

  function wireCmdk() {
    document.getElementById("cmdk-btn").addEventListener("click", openCmdk);
    document.getElementById("cmdk-overlay").addEventListener("click", closeCmdk);
    document.getElementById("cmdk-input").addEventListener("input", (e) => renderCmdk(e.target.value));
    document.getElementById("cmdk-form").addEventListener("submit", (e) => {
      e.preventDefault();
      runCmdk(cmdkHighlighted);
    });
    document.getElementById("cmdk-input").addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeCmdk(); return; }
      if (!cmdkFiltered.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        cmdkHighlighted = (cmdkHighlighted + 1) % cmdkFiltered.length;
        renderCmdk(document.getElementById("cmdk-input").value);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        cmdkHighlighted = (cmdkHighlighted - 1 + cmdkFiltered.length) % cmdkFiltered.length;
        renderCmdk(document.getElementById("cmdk-input").value);
      }
    });
  }

  // ---------- About / Sreonfetch panel ----------

  function openAbout() {
    const ws = activeWorkspace();
    const totalTabs = workspaces.reduce((n, w) => n + w.tabs.length, 0);
    const accent = Settings.get().accentColor;

    document.getElementById("about-body").innerHTML = `
      <div class="fetch-row">
        <img class="fetch-logo earth-cartoon" src="assets/sreon-logo.png" alt="Sreon" />
        <div class="fetch-info">
          <div class="fetch-title">sreon@browser</div>
          <div class="fetch-sub">Minimal light glass, rebuilt for speed</div>
          <div class="fetch-line"><span class="fetch-key">Theme</span><span class="fetch-val">${escapeHtml(document.getElementById("theme-badge")?.textContent || "Earth Glass")}</span></div>
          <div class="fetch-line"><span class="fetch-key">Accent</span><span class="fetch-val">${escapeHtml(accent)}</span></div>
          <div class="fetch-line"><span class="fetch-key">Workspace</span><span class="fetch-val">${escapeHtml(ws.name)} (${ws.tabs.length} tab${ws.tabs.length === 1 ? "" : "s"})</span></div>
          <div class="fetch-line"><span class="fetch-key">Total tabs</span><span class="fetch-val">${totalTabs}</span></div>
          <div class="fetch-line"><span class="fetch-key">Shortcuts</span><span class="fetch-val">⌘K ⌘T ⌘W ⌘L</span></div>
          <div class="fetch-palette">
            <span style="background:var(--accent)"></span>
            <span style="background:var(--accent-strong)"></span>
            <span style="background:var(--accent-soft)"></span>
            <span style="background:var(--glass-border-bright)"></span>
            <span style="background:var(--text-primary)"></span>
          </div>
        </div>
      </div>`;

    withdrawActiveViewForOverlay();
    document.getElementById("about-overlay").classList.add("show");
    document.getElementById("about-panel").classList.add("show");
  }

  function closeAbout() {
    document.getElementById("about-overlay").classList.remove("show");
    document.getElementById("about-panel").classList.remove("show");
    restoreActiveViewFromOverlay();
  }

  function wireAbout() {
    document.getElementById("brand-btn").addEventListener("click", openAbout);
    document.getElementById("about-close").addEventListener("click", closeAbout);
    document.getElementById("about-overlay").addEventListener("click", closeAbout);
  }

  // ---------- Wiring ----------

  // Per-site settings: clicking the address-bar lock icon shows a small
  // popover for the current site, letting Ad block / Dark mode / Privacy
  // mode be overridden just for that host (stored under Settings'
  // siteOverrides, keyed by hostname). Applying a change closes and
  // recreates that tab's webview so the new init script takes effect
  // immediately, since those settings are baked in at webview creation.
  function hostOf(url) {
    try { return new URL(url).hostname || null; } catch { return null; }
  }
  function currentHost() {
    const tab = currentTab();
    return tab ? hostOf(tab.url) : null;
  }

  async function reloadActiveTabWithNewSettings() {
    const tab = currentTab();
    if (!tab) return;
    if (isTauri && tab.viewCreated) {
      await tauriInvoke("close_tab_view", { id: tab.id }).catch(() => {});
      tab.viewCreated = false;
      await showTabView(tab);
    }
  }
  window.SreonTabs = { reloadActiveTabWithNewSettings };

  function effectiveSiteSetting(host, key) {
    const base = Settings.get()[key];
    const override = host ? Settings.getSiteOverride(host)[key] : undefined;
    return override === undefined ? base : override;
  }

  function wireSiteSettingsPopover() {
    const trigger = document.getElementById("addr-lock");
    if (!trigger) return;
    trigger.style.cursor = "pointer";
    trigger.setAttribute("title", "Site settings");

    let popover = null;
    function closePopover() {
      if (popover) { popover.remove(); popover = null; }
      document.removeEventListener("click", onOutsideClick, true);
    }
    function onOutsideClick(e) {
      if (popover && !popover.contains(e.target) && e.target !== trigger) closePopover();
    }

    function rowHtml(key, label) {
      return `<label class="toggle-row" style="padding:6px 0;">
        <span>${label}</span>
        <span class="switch"><input type="checkbox" data-site-key="${key}" /><span class="switch-track"></span></span>
      </label>`;
    }

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (popover) { closePopover(); return; }

      const host = currentHost();
      popover = document.createElement("div");
      popover.className = "glass site-popover";
      popover.innerHTML = `
        <div class="site-popover-title">${host || "This page"}</div>
        <p class="field-hint" style="margin:2px 0 8px;">Overrides your general settings just for this site.</p>
        ${rowHtml("adBlock", "Ad & tracker blocking")}
        ${rowHtml("privacyMode", "Privacy mode")}
        <button class="btn-secondary" id="site-popover-reset" style="width:100%; margin-top:8px;">Reset to general settings</button>
        <button class="btn-secondary" id="site-popover-full" style="width:100%; margin-top:6px;">Open full Settings…</button>
      `;
      document.body.appendChild(popover);
      const r = trigger.getBoundingClientRect();
      popover.style.position = "fixed";
      popover.style.top = `${r.bottom + 8}px`;
      popover.style.left = `${r.left}px`;

      popover.querySelectorAll("[data-site-key]").forEach((input) => {
        const key = input.dataset.siteKey;
        input.checked = !!effectiveSiteSetting(host, key);
        input.addEventListener("change", () => {
          if (!host) return;
          Settings.setSiteOverride(host, { [key]: input.checked });
          reloadActiveTabWithNewSettings();
        });
      });

      popover.querySelector("#site-popover-reset")?.addEventListener("click", () => {
        if (host) Settings.clearSiteOverride(host);
        reloadActiveTabWithNewSettings();
        closePopover();
      });
      popover.querySelector("#site-popover-full")?.addEventListener("click", () => {
        closePopover();
        withdrawActiveViewForOverlay();
        setTimeout(() => Settings.openPanel(), 60);
      });

      setTimeout(() => document.addEventListener("click", onOutsideClick, true), 0);
    });
  }

  function wireUI() {
    wireSiteSettingsPopover();
    document.getElementById("addr-form").addEventListener("submit", (e) => {
      e.preventDefault();
      navigate(document.getElementById("addr-input").value);
    });
    document.getElementById("start-form").addEventListener("submit", (e) => {
      e.preventDefault();
      navigate(document.getElementById("start-addr-input").value);
    });
    wireSuggestions(
      document.getElementById("addr-input"),
      document.getElementById("addr-suggest"),
      document.getElementById("addr-form")
    );
    wireSuggestions(
      document.getElementById("start-addr-input"),
      document.getElementById("start-addr-suggest"),
      document.getElementById("start-form")
    );

    const addrInput = document.getElementById("addr-input");
    const addrClear = document.getElementById("addr-clear");
    addrInput.addEventListener("input", () => {
      addrClear.classList.toggle("show", addrInput.value.length > 0);
    });
    addrClear.addEventListener("click", () => {
      addrInput.value = "";
      addrClear.classList.remove("show");
      addrInput.focus();
    });
    addrInput.addEventListener("focus", withdrawActiveViewForOverlay);
    addrInput.addEventListener("blur", () => setTimeout(restoreActiveViewFromOverlay, 200));

    document.getElementById("new-tab-btn").addEventListener("click", () => createTab(null));

    document.getElementById("back-btn").addEventListener("click", () => {
      const tab = currentTab();
      if (!tab) return;
      if (isTauri) {
        tauriInvoke("tab_eval", { id: tab.id, script: "window.history.back();" }).catch(() => {});
        return;
      }
      const f = document.getElementById(`frame-${tab.id}`);
      if (!f) return;
      try { f.contentWindow?.history.back(); } catch {}
      f.classList.remove("nav-back");
      void f.offsetWidth;
      f.classList.add("nav-back");
    });
    document.getElementById("fwd-btn").addEventListener("click", () => {
      const tab = currentTab();
      if (!tab) return;
      if (isTauri) {
        tauriInvoke("tab_eval", { id: tab.id, script: "window.history.forward();" }).catch(() => {});
        return;
      }
      const f = document.getElementById(`frame-${tab.id}`);
      if (!f) return;
      try { f.contentWindow?.history.forward(); } catch {}
      f.classList.remove("nav-fwd");
      void f.offsetWidth;
      f.classList.add("nav-fwd");
    });
    document.getElementById("reload-btn").addEventListener("click", () => {
      const btn = document.getElementById("reload-btn");
      btn.classList.remove("kick");
      void btn.offsetWidth;
      btn.classList.add("kick");
      setTimeout(() => btn.classList.remove("kick"), 300);

      const tab = currentTab();
      if (!tab || tab.url === "about:start") return;
      if (isTauri) {
        btn.classList.add("loading");
        tauriInvoke("tab_eval", { id: tab.id, script: "window.location.reload();" }).catch(() => {});
        setTimeout(() => btn.classList.remove("loading"), 1200);
        return;
      }
      const f = document.getElementById(`frame-${tab.id}`);
      if (f) {
        btn.classList.add("loading");
        f.src = f.src;
        setTimeout(() => btn.classList.remove("loading"), 6000);
      }
    });
    document.getElementById("open-system-btn").addEventListener("click", () => {
      const tab = currentTab();
      if (tab && tab.url !== "about:start") openInSystemBrowser(tab.url);
    });
    document.getElementById("bookmark-toggle")?.addEventListener("click", () => toggleBookmarkCurrentTab());

    document.getElementById("sidebar-collapse").addEventListener("click", () => {
      document.getElementById("shell").classList.toggle("collapsed");
    });

    // Settings is wired up by Settings.init(). Ensure native tab view is
    // withdrawn before opening, and restored after closing so overlays
    // reliably appear above content (native webviews otherwise paint on top).
    document.getElementById("settings-btn").addEventListener("click", () => {
      withdrawActiveViewForOverlay();
      // Small delay gives the native view time to hide before showing the panel
      setTimeout(() => Settings.openPanel(), 60);
    });
    document.getElementById("settings-close").addEventListener("click", () => {
      Settings.closePanel();
      restoreActiveViewFromOverlay();
    });
    document.getElementById("settings-overlay").addEventListener("click", () => {
      Settings.closePanel();
      restoreActiveViewFromOverlay();
    });

    wireCmdk();
    wireAbout();

    if (isTauri) {
      // Keep the active tab's native webview aligned with the content
      // area across window resizes and sidebar collapse/expand.
      let boundsTimer = null;
      const ro = new ResizeObserver(() => {
        if (!activeNativeTabId) return;
        clearTimeout(boundsTimer);
        boundsTimer = setTimeout(() => {
          tauriInvoke("set_tab_bounds", { id: activeNativeTabId, ...getViewBounds() }).catch(() => {});
        }, 16);
      });
      ro.observe(document.getElementById("view-stack"));
    }

    document.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openCmdk(); return; }
      if (e.key === "Escape") { closeCmdk(); closeAbout(); }
      if (!mod) return;
      if (e.key.toLowerCase() === "t") { e.preventDefault(); createTab(null); }
      else if (e.key.toLowerCase() === "w") { e.preventDefault(); const t = currentTab(); if (t) closeTab(t.id); }
      else if (e.key.toLowerCase() === "l") { e.preventDefault(); document.getElementById("addr-input").focus(); document.getElementById("addr-input").select(); }
      else if (e.key.toLowerCase() === "d") { e.preventDefault(); toggleBookmarkCurrentTab(); }
    });

    window.addEventListener("resize", updateTabIndicator);

    // A subtle "wobble" whenever the native window is dragged, so moving
    // the window feels alive rather than static. Only available inside
    // the real Tauri app (no-op in the plain-browser preview).
    if (isTauri) {
      try {
        const wm = window.__TAURI__.window;
        const win = (wm.getCurrentWindow || wm.getCurrent)?.call(wm);
        let wobbleTimer = null;
        win?.onMoved?.(() => {
          const shell = document.getElementById("shell");
          shell.classList.remove("wobble");
          void shell.offsetWidth;
          shell.classList.add("wobble");
          clearTimeout(wobbleTimer);
          wobbleTimer = setTimeout(() => shell.classList.remove("wobble"), 340);
        });
      } catch (err) {
        console.warn("Window move animation unavailable:", err);
      }
    }

    wireVaultAndHistory();
    wireDraggableButtons();
  }

  // ---------------------------------------------------------------------
  // Passwords + History panels (inside Settings)
  // ---------------------------------------------------------------------
  async function renderVaultList() {
    const el = document.getElementById("vault-list");
    if (!el) return;
    const entries = await Vault.list();
    el.innerHTML = entries.length
      ? entries.map((e, i) => `
        <div class="vault-row" data-i="${i}">
          <div class="vault-row-main">
            <strong>${escapeHtml(e.site)}</strong>
            <span>${escapeHtml(e.username)}</span>
          </div>
          <div class="vault-row-actions">
            <button class="icon-btn vault-copy" data-copy="${escapeHtml(e.password)}" title="Copy password">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </button>
            <button class="icon-btn vault-del" data-site="${escapeHtml(e.site)}" data-user="${escapeHtml(e.username)}" title="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg>
            </button>
          </div>
        </div>`).join("")
      : `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>No saved logins yet — add one below.</div>`;

    el.querySelectorAll(".vault-copy").forEach((btn) => {
      btn.addEventListener("click", () => {
        navigator.clipboard?.writeText(btn.dataset.copy || "").catch(() => {});
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 900);
      });
    });
    el.querySelectorAll(".vault-del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await Vault.remove(btn.dataset.site, btn.dataset.user);
        renderVaultList();
      });
    });
  }

  async function renderHistoryList() {
    const el = document.getElementById("history-list");
    if (!el) return;
    const entries = await HistoryStore.list();
    el.innerHTML = entries.length
      ? entries.slice(0, 200).map((e) => `
        <div class="history-row" data-time="${e.time}">
          <div class="history-row-main">
            <strong>${escapeHtml(e.title)}</strong>
            <span>${escapeHtml(e.url)}</span>
          </div>
          <button class="icon-btn history-del" data-time="${e.time}" title="Remove">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>`).join("")
      : `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>No browsing history yet.</div>`;

    el.querySelectorAll(".history-row-main").forEach((row, i) => {
      row.addEventListener("click", () => {
        const entry = entries[i];
        if (!entry) return;
        Settings.closePanel();
        restoreActiveViewFromOverlay();
        createTab(entry.url);
      });
    });
    el.querySelectorAll(".history-del").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await HistoryStore.remove(Number(btn.dataset.time));
        renderHistoryList();
      });
    });
  }

  async function renderBookmarkList() {
    const el = document.getElementById("bookmark-list");
    if (!el) return;
    const entries = await Bookmarks.list();
    el.innerHTML = entries.length
      ? entries.map((e) => `
        <div class="bm-row" data-url="${escapeHtml(e.url)}">
          <span class="bm-dot" style="--bm-color:${escapeHtml(e.color)}" data-swatch title="Change color"></span>
          <div class="bm-row-main">
            <strong>${escapeHtml(e.title)}</strong>
            <span>${escapeHtml(e.url)}</span>
          </div>
          <button class="icon-btn bm-del" data-url="${escapeHtml(e.url)}" title="Remove bookmark">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>`).join("")
      : `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>No bookmarks yet. Use "Bookmark this page" (⌘D) while on a site.</div>`;

    el.querySelectorAll(".bm-row-main").forEach((row) => {
      row.addEventListener("click", () => {
        const url = row.closest(".bm-row").dataset.url;
        Settings.closePanel();
        restoreActiveViewFromOverlay();
        createTab(url);
      });
    });
    el.querySelectorAll(".bm-del").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await Bookmarks.remove(btn.dataset.url);
        renderBookmarkList();
      });
    });
    el.querySelectorAll("[data-swatch]").forEach((dot) => {
      dot.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const url = dot.closest(".bm-row").dataset.url;
        const current = dot.style.getPropertyValue("--bm-color").trim();
        const next = BOOKMARK_COLORS[(BOOKMARK_COLORS.indexOf(current) + 1 + BOOKMARK_COLORS.length) % BOOKMARK_COLORS.length];
        await Bookmarks.setColor(url, next);
        renderBookmarkList();
      });
    });
  }

  async function toggleBookmarkCurrentTab() {
    const tab = currentTab();
    if (!tab || tab.url === "about:start") return;
    if (await Bookmarks.isBookmarked(tab.url)) {
      await Bookmarks.remove(tab.url);
    } else {
      await Bookmarks.add(tab.url, tab.title, BOOKMARK_COLORS[0]);
    }
    renderBookmarkList();
    updateBookmarkButton();
  }

  async function updateBookmarkButton() {
    const btn = document.getElementById("bookmark-toggle");
    if (!btn) return;
    const tab = currentTab();
    const marked = tab && tab.url !== "about:start" && (await Bookmarks.isBookmarked(tab.url));
    btn.classList.toggle("active", !!marked);
    btn.title = marked ? "Remove bookmark" : "Bookmark this page";
  }

  async function renderWorkspaceSettings() {
    const el = document.getElementById("workspace-settings-list");
    if (!el || !window.Lock) return;
    const rows = await Promise.all(
      workspaces.map(async (w) => {
        const has = await window.Lock.hasWorkspacePassword(w.id);
        workspacePasswordFlags[w.id] = has;
        return { w, has };
      })
    );
    el.innerHTML = rows
      .map(
        ({ w, has }) => `
      <div class="ws-settings-row" data-id="${w.id}">
        <div class="ws-settings-head">
          <span class="ws-dot" style="--ws-color:${escapeHtml(w.color || "#3d8bff")}"></span>
          <strong>${escapeHtml(w.name)}</strong>
          <input type="color" class="ws-color-input" data-id="${w.id}" value="${escapeHtml(w.color || "#3d8bff")}" title="Workspace color" />
        </div>
        <p class="field-hint">${has ? "Password-protected. Switching in will ask for it." : "No password set — switching in is instant."}</p>
        <div class="ws-settings-actions">
          ${has
            ? `<button class="btn-secondary ws-change-pw" data-id="${w.id}">Change password</button>
               <button class="btn-secondary ws-remove-pw" data-id="${w.id}">Remove password</button>`
            : `<button class="btn-primary ws-set-pw" data-id="${w.id}">Set a password</button>`}
        </div>
      </div>`
      )
      .join("");

    el.querySelectorAll(".ws-color-input").forEach((input) => {
      input.addEventListener("input", () => {
        setWorkspaceColor(input.dataset.id, input.value);
        renderWorkspaces();
        input.previousElementSibling.previousElementSibling?.style.setProperty("--ws-color", input.value);
      });
    });
    el.querySelectorAll(".ws-set-pw").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const wsName = (workspaces.find((w) => w.id === id) || {}).name || id;
        const pw = await SreonDialog.prompt(`Choose a password for ${wsName} (at least 4 characters):`, { title: "Set password" });
        if (pw === null) return;
        if (pw.length < 4) { if (pw) await SreonDialog.alert("Use at least 4 characters."); return; }
        // Existing data (if any) is currently encrypted under this
        // workspace's device key, since it had no password yet.
        const oldKey = await SecureStore.keyFor(id, false);
        await window.Lock.setWorkspacePassword(id, pw); // also unlocks with the new password
        const newKey = await SecureStore.keyFor(id, true);
        await migrateWorkspaceStorage(id, oldKey, newKey);
        // Setting the password unlocks it in memory for this session (that's
        // needed to do the migration above), but that used to mean the very
        // next switch into this workspace skipped the password prompt
        // entirely until you restarted Sreon. Re-lock it now so switching
        // into it — including right after you just set the password —
        // always asks for it, same as any other app relock.
        SecureStore.lock(id);
        workspacePasswordFlags[id] = true;
        renderWorkspaceSettings();
        renderWorkspaces();
      });
    });
    el.querySelectorAll(".ws-change-pw").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const old = await SreonDialog.prompt("Enter the current password:", { title: "Change password" });
        if (!old) return;
        const ok = await window.Lock.verifyWorkspacePassword(id, old);
        if (!ok) { await SreonDialog.alert("That password isn't right."); return; }
        const oldKey = await SecureStore.keyFor(id, true); // now unlocked with the old password
        const next = await SreonDialog.prompt("Choose a new password (at least 4 characters):", { title: "Change password" });
        if (next === null) return;
        if (next.length < 4) { if (next) await SreonDialog.alert("Use at least 4 characters."); return; }
        await window.Lock.setWorkspacePassword(id, next); // re-unlocks with the new password
        const newKey = await SecureStore.keyFor(id, true);
        await migrateWorkspaceStorage(id, oldKey, newKey);
        // Same fix as setting a fresh password: don't leave it unlocked in
        // memory just because it was touched from Settings.
        SecureStore.lock(id);
        renderWorkspaceSettings();
      });
    });
    el.querySelectorAll(".ws-remove-pw").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const old = await SreonDialog.prompt("Enter the current password to remove it:", { title: "Remove password" });
        if (!old) return;
        try {
          const ok = await window.Lock.verifyWorkspacePassword(id, old);
          if (!ok) throw new Error("Incorrect password");
          const oldKey = await SecureStore.keyFor(id, true); // currently unlocked with the password
          await window.Lock.removeWorkspacePassword(id, old);
          SecureStore.lock(id);
          const newKey = await SecureStore.keyFor(id, false); // falls back to the device key
          await migrateWorkspaceStorage(id, oldKey, newKey);
          workspacePasswordFlags[id] = false;
          renderWorkspaceSettings();
          renderWorkspaces();
        } catch {
          await SreonDialog.alert("That password isn't right.");
        }
      });
    });
  }

  function wireVaultAndHistory() {
    renderVaultList();
    renderHistoryList();
    renderBookmarkList();
    renderWorkspaceSettings();

    const form = document.getElementById("vault-add-form");
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const site = document.getElementById("vault-site").value.trim();
      const user = document.getElementById("vault-user").value.trim();
      const pass = document.getElementById("vault-pass").value;
      if (!site || !user || !pass) return;
      await Vault.add(site, user, pass);
      form.reset();
      renderVaultList();
    });

    document.getElementById("history-clear")?.addEventListener("click", async () => {
      await HistoryStore.clear();
      renderHistoryList();
    });

    const bmForm = document.getElementById("bookmark-add-form");
    bmForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const url = document.getElementById("bookmark-url").value.trim();
      const title = document.getElementById("bookmark-title").value.trim();
      const color = document.getElementById("bookmark-color").value;
      if (!url) return;
      await Bookmarks.add(url, title, color);
      bmForm.reset();
      renderBookmarkList();
    });
  }

  // ---------------------------------------------------------------------
  // Customizable layout — every toolbar / sidebar-footer icon button can
  // be picked up and dropped into a new order. Order persists in
  // localStorage per container id, keyed by each button's element id so
  // it survives reloads.
  // ---------------------------------------------------------------------
  function wireDraggableButtons() {
    const containers = [
      document.getElementById("nav-group"),
      document.getElementById("sidebar-footer"),
    ].filter(Boolean);

    containers.forEach((container) => {
      const key = `sreon:layout:${container.id}`;
      // Restore saved order first.
      try {
        const order = JSON.parse(localStorage.getItem(key) || "null");
        if (Array.isArray(order)) {
          order.forEach((id) => {
            const node = document.getElementById(id);
            if (node) container.appendChild(node);
          });
        }
      } catch {}

      let dragEl = null;
      Array.from(container.children).forEach((child) => {
        if (!child.id) return;
        child.setAttribute("draggable", "true");
        child.classList.add("layout-draggable");
        child.addEventListener("dragstart", () => {
          dragEl = child;
          child.classList.add("dragging");
        });
        child.addEventListener("dragend", () => {
          child.classList.remove("dragging");
          dragEl = null;
          const order = Array.from(container.children).map((c) => c.id).filter(Boolean);
          localStorage.setItem(key, JSON.stringify(order));
        });
        child.addEventListener("dragover", (e) => {
          e.preventDefault();
          if (!dragEl || dragEl === child) return;
          const rect = child.getBoundingClientRect();
          const horizontal = container.id === "nav-group";
          const before = horizontal
            ? e.clientX < rect.left + rect.width / 2
            : e.clientY < rect.top + rect.height / 2;
          container.insertBefore(dragEl, before ? child : child.nextSibling);
        });
      });
    });
  }

  // Dashboard/start-page widgets: live clock, weather, now-playing, system
  // info, plus the top tab strip. Mounted once at boot; the widgets refresh
  // themselves on their own timers (see widgets.js).
  function wireDashboard() {
    const mount = document.getElementById("dash-widgets");
    if (mount && window.SreonWidgets) window.SreonWidgets.mountDashboardLayout(mount);

    const tabs = document.querySelectorAll(".dash-tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const grid = mount && mount.querySelector(".widget-grid");
        if (!grid) return;
        const cards = grid.querySelectorAll(".widget-card");
        const which = tab.dataset.dashTab;
        cards.forEach((card) => (card.style.display = ""));
        if (which === "media") {
          cards.forEach((c) => { if (!c.classList.contains("widget-nowplaying")) c.style.display = "none"; });
        } else if (which === "weather") {
          cards.forEach((c, i) => { if (i !== 1) c.style.display = "none"; });
        } else if (which === "performance") {
          cards.forEach((c, i) => { if (i !== 3) c.style.display = "none"; });
        }
      });
    });
  }

  function bootShell() {
    Settings.init();
    loadWorkspaceColors();
    const restored = loadSession();
    renderWorkspaces();
    wireUI();
    wireDashboard();
    if (restored) {
      renderTabs();
      renderActiveView();
    } else {
      createTab(null); // starts on the sreon://start page
    }

    if (window.SreonTour) window.SreonTour.maybeShow();

    // Learn which workspaces currently have a password set, so the
    // switcher knows to gate them and the vault/history/bookmark stores
    // know which key to ask SecureStore for. Re-checked whenever Settings
    // changes a workspace password (see wireWorkspaceLockSettings).
    Promise.all(
      workspaces.map((w) =>
        window.Lock ? window.Lock.hasWorkspacePassword(w.id).then((has) => { workspacePasswordFlags[w.id] = has; }) : Promise.resolve()
      )
    ).then(async () => {
      renderWorkspaces();
      // If the workspace restored on launch needs a password, gate it
      // immediately rather than silently showing empty vault/history data.
      if (workspaceRequiresPassword(activeWorkspaceId) && window.Lock) {
        const w = workspaces.find((x) => x.id === activeWorkspaceId);
        const ok = await window.Lock.unlockWorkspace(activeWorkspaceId, w ? w.name : activeWorkspaceId);
        if (ok) { renderVaultList(); renderHistoryList(); renderBookmarkList(); }
      }
    });

    // Quick-lock: instantly re-lock Sreon and hide every tab, regardless
    // of whether a password is currently set (if none is set yet, this
    // just clears the screen — Settings > Privacy & Security can add a
    // password so quick-lock actually requires one to get back in).
    document.addEventListener("keydown", (e) => {
      const combo = (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "l";
      if (combo) {
        e.preventDefault();
        if (isTauri) tauriInvoke("hide_all_tab_views", {}).catch(() => {});
        window.Lock && window.Lock.engage();
      }
    });
  }
  window.__sreonBootShell = bootShell;

  document.addEventListener("DOMContentLoaded", () => {
    if (typeof Settings !== "undefined") Settings.applyEarly(); // so the lock screen picks up saved theme/background immediately
    if (window.Lock) {
      window.Lock.init(bootShell);
    } else {
      bootShell();
    }
  });
})();
