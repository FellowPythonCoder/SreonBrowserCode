// Controls glass tuning, accent color, and browsing prefs.
const Settings = (() => {
  const STORAGE_KEY = "sreon:settings";

  const PRESET_NAMES = {
    "#22c55e": "Earth Glass",
    "#6d1ee0": "Ocean Glass",
    "#8b5cf6": "Violet Glass",
    "#f97316": "Sunset Glass",
    "#ec4899": "Rose Glass",
    "#14b8a6": "Teal Glass",
    "#eab308": "Gold Glass",
    "#64748b": "Slate Glass",
  };

  const defaults = {
    blur: 34,
    opacity: 30,
    radius: 20,
    accentColor: "#6d1ee0",
    searchEngine: "https://www.google.com/search?q=",
    homepage: "sreon://start",
    searchSuggestions: false,
    restoreSession: false,
    reduceMotion: false,
    adBlock: true,
    darkMode: false, // cream sidebar theme (name kept for backwards-compat with saved settings)
    privacyMode: true, // WebRTC IP-leak blocking + anti-fingerprinting — on by default
    proxyUrl: "", // e.g. socks5://127.0.0.1:9050 (Tor) or http://user:pass@host:port
    performanceMode: false, // trims blur/animation cost for lower-end machines
    siteOverrides: {}, // { "example.com": { adBlock, privacyMode } } — per-site toggle overrides
    lockBgMode: "theme", // "theme" | "image" | "video" — lock screen's own background, independent of the app bg
    lockBgData: null,
    lockBgBlur: 0,
    lockTheme: "accent", // "accent" | "aurora" | "midnight" | "sunset" | "custom"
    lockCustomColor: "#6d1ee0",
    bgMode: "glass", // "glass" | "image" | "video"
    bgData: null, // data: URL of the chosen photo/video
    bgDim: 35, // 0-85, darkening overlay for readability
    bgBlur: 0, // 0-40, blur applied to the background media itself
  };

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const merged = raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
      if (merged.lockTheme === "light") merged.lockTheme = "aurora";
      return merged;
    } catch {
      return { ...defaults };
    }
  }

  function save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      // Most likely quota exceeded because of a large photo/video
      // background. Fall back to saving everything except the media
      // itself, so the rest of the settings still persist — the
      // background just won't survive a restart this time.
      try {
        const { bgData, lockBgData, ...rest } = state;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
      } catch {
        /* give up silently — not fatal, just won't persist this run */
      }
    }
  }

  function hexToRgb(hex) {
    const clean = hex.replace("#", "");
    const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex([r, g, b]) {
    return "#" + [r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("");
  }

  function darken(rgb, amt) {
    return rgb.map((c) => Math.round(c * (1 - amt)));
  }

  function themeName(hex) {
    return PRESET_NAMES[hex.toLowerCase()] || "Custom Glass";
  }

  function applyAccent(hex) {
    const rgb = hexToRgb(hex);
    const strong = rgbToHex(darken(rgb, 0.28));
    const root = document.documentElement.style;
    root.setProperty("--accent", hex);
    root.setProperty("--accent-strong", strong);
    root.setProperty("--accent-soft", `rgba(${rgb.join(",")}, 0.35)`);
    root.setProperty("--accent-glow", `rgba(${rgb.join(",")}, 0.55)`);
  }

  const LOCK_THEME_COLORS = {
    aurora: "#2dd4bf",
    midnight: "#818cf8",
    sunset: "#fb923c",
  };

  function applyLockTheme(state) {
    const root = document.documentElement.style;
    let hex = state.accentColor;
    if (LOCK_THEME_COLORS[state.lockTheme]) hex = LOCK_THEME_COLORS[state.lockTheme];
    else if (state.lockTheme === "custom") hex = state.lockCustomColor || "#6d1ee0";
    const rgb = hexToRgb(hex);
    const strong = rgbToHex(darken(rgb, 0.28));
    root.setProperty("--lock-accent", hex);
    root.setProperty("--lock-accent-strong", strong);
    root.setProperty("--lock-accent-soft", `rgba(${rgb.join(",")}, 0.35)`);
    root.setProperty("--lock-accent-glow", `rgba(${rgb.join(",")}, 0.55)`);
    document.documentElement.dataset.lockTheme = state.lockTheme;
  }

  function applyBackground(state) {
    const layer = document.getElementById("bg-layer");
    const img = document.getElementById("bg-image");
    const video = document.getElementById("bg-video");
    const overlay = document.getElementById("bg-overlay");
    if (!layer || !img || !video || !overlay) return;

    if (state.bgMode === "image" && state.bgData) {
      layer.classList.add("show");
      img.src = state.bgData;
      img.style.display = "block";
      img.style.filter = `blur(${state.bgBlur || 0}px)`;
      video.pause();
      video.removeAttribute("src");
      video.style.display = "none";
    } else if (state.bgMode === "video" && state.bgData) {
      layer.classList.add("show");
      video.src = state.bgData;
      video.loop = true; // always loop custom video backgrounds
      video.muted = true; // required for autoplay in the webview
      video.style.display = "block";
      video.style.filter = `blur(${state.bgBlur || 0}px)`;
      video.play().catch(() => {});
      img.style.display = "none";
      img.removeAttribute("src");
    } else {
      layer.classList.remove("show");
      img.style.display = "none";
      video.style.display = "none";
      video.pause();
    }
    overlay.style.background = `rgba(4, 10, 8, ${(state.bgDim ?? 35) / 100})`;
  }

  function applyLockBackground(state) {
    const img = document.getElementById("lock-bg-image");
    const video = document.getElementById("lock-bg-video");
    if (!img || !video) return; // lock overlay isn't rendered right now
    if (state.lockBgMode === "image" && state.lockBgData) {
      img.src = state.lockBgData;
      img.style.display = "block";
      img.style.filter = `blur(${state.lockBgBlur || 0}px)`;
      video.pause();
      video.removeAttribute("src");
      video.style.display = "none";
    } else if (state.lockBgMode === "video" && state.lockBgData) {
      video.src = state.lockBgData;
      video.loop = true; // always auto-loop
      video.muted = true;
      video.style.display = "block";
      video.style.filter = `blur(${state.lockBgBlur || 0}px)`;
      video.play().catch(() => {});
      img.style.display = "none";
      img.removeAttribute("src");
    } else {
      img.style.display = "none";
      video.style.display = "none";
      video.pause();
    }
  }

  function apply(state) {
    const root = document.documentElement.style;
    const perf = !!state.performanceMode;
    root.setProperty("--glass-blur", `${perf ? Math.min(state.blur, 6) : state.blur}px`);
    root.setProperty("--glass-blur-soft", `${perf ? 3 : Math.max(6, state.blur * 0.6)}px`);
    root.setProperty("--glass-opacity", (state.opacity / 100).toFixed(2));
    root.setProperty("--glass-opacity-strong", Math.min(0.9, state.opacity / 100 + 0.16).toFixed(2));
    root.setProperty("--radius", `${state.radius}px`);
    root.setProperty("--radius-sm", `${Math.max(6, state.radius * 0.6)}px`);
    document.documentElement.dataset.reduceMotion = state.reduceMotion || perf ? "true" : "false";
    document.documentElement.dataset.performanceMode = perf ? "true" : "false";
    // The "Cream sidebar" toggle only re-themes Sreon's own sidebar —
    // it no longer touches website content at all (that invert-filter
    // approach was removed). This flag drives the cream palette in
    // app.css, scoped to #sidebar.
    document.documentElement.dataset.uiDark = state.darkMode ? "true" : "false";
    applyAccent(state.accentColor);
    applyLockTheme(state);
    applyBackground(state);
  }

  let state = load();
  const listeners = [];
  // Exposed panel control hooks (populated in init)
  let openPanelFn = () => {};
  let closePanelFn = () => {};

  function updateThemeBadge() {
    const badge = document.getElementById("theme-badge");
    if (badge) badge.textContent = themeName(state.accentColor);
  }

  function updateSwatchActive() {
    document.querySelectorAll("#opt-accent-swatches .swatch[data-color]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.color.toLowerCase() === state.accentColor.toLowerCase());
    });
  }

  function init() {
    apply(state);
    updateThemeBadge();

    const blur = document.getElementById("opt-blur");
    const blurVal = document.getElementById("opt-blur-val");
    const opacity = document.getElementById("opt-opacity");
    const opacityVal = document.getElementById("opt-opacity-val");
    const radius = document.getElementById("opt-radius");
    const radiusVal = document.getElementById("opt-radius-val");
    const search = document.getElementById("opt-search");
    const home = document.getElementById("opt-home");
    const suggestions = document.getElementById("opt-suggestions");
    const restore = document.getElementById("opt-restore");
    const reduceMotion = document.getElementById("opt-reduce-motion");
    const clearData = document.getElementById("opt-clear-data");
    const customColor = document.getElementById("opt-accent-custom");

    blur.value = state.blur;
    opacity.value = state.opacity;
    radius.value = state.radius;
    search.value = state.searchEngine;
    home.value = state.homepage;
    suggestions.checked = state.searchSuggestions;
    restore.checked = state.restoreSession;
    reduceMotion.checked = state.reduceMotion;
    customColor.value = state.accentColor;
    blurVal.textContent = `${state.blur}px`;
    opacityVal.textContent = `${state.opacity}%`;
    radiusVal.textContent = `${state.radius}px`;
    updateSwatchActive();

    blur.addEventListener("input", () => {
      state.blur = Number(blur.value);
      blurVal.textContent = `${state.blur}px`;
      apply(state);
      save(state);
    });
    opacity.addEventListener("input", () => {
      state.opacity = Number(opacity.value);
      opacityVal.textContent = `${state.opacity}%`;
      apply(state);
      save(state);
    });
    radius.addEventListener("input", () => {
      state.radius = Number(radius.value);
      radiusVal.textContent = `${state.radius}px`;
      apply(state);
      save(state);
    });
    search.addEventListener("change", () => {
      state.searchEngine = search.value;
      save(state);
    });
    home.addEventListener("change", () => {
      state.homepage = home.value.trim() || defaults.homepage;
      save(state);
    });
    suggestions.addEventListener("change", () => {
      state.searchSuggestions = suggestions.checked;
      save(state);
    });
    restore.addEventListener("change", () => {
      state.restoreSession = restore.checked;
      save(state);
      listeners.forEach((fn) => fn("restoreSession", state.restoreSession));
    });
    reduceMotion.addEventListener("change", () => {
      state.reduceMotion = reduceMotion.checked;
      apply(state);
      save(state);
    });
    clearData.addEventListener("click", () => {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem("sreon:session");
      window.location.reload();
    });

    // ---- Delete all data (full factory reset) ----
    // clearData above only ever touched settings + session — it never
    // reached saved passwords, history, bookmarks, workspace colors, or
    // lock-screen passwords, all of which live under other "sreon:*"
    // keys. This wipes every one of them.
    const deleteAll = document.getElementById("opt-delete-all-data");
    if (deleteAll) {
      deleteAll.addEventListener("click", async () => {
        const ok = await SreonDialog.confirm(
          "This permanently erases every saved password, all history and bookmarks, lock passwords, and all settings on this device. This can't be undone.",
          { title: "Delete all data?", confirmLabel: "Delete everything", cancelLabel: "Cancel" }
        );
        if (!ok) return;
        Object.keys(localStorage)
          .filter((k) => k.startsWith("sreon:"))
          .forEach((k) => localStorage.removeItem(k));
        window.location.reload();
      });
    }

    document.querySelectorAll("#opt-accent-swatches .swatch[data-color]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.accentColor = btn.dataset.color;
        customColor.value = state.accentColor;
        applyAccent(state.accentColor);
        updateThemeBadge();
        updateSwatchActive();
        save(state);
      });
    });
    customColor.addEventListener("input", () => {
      state.accentColor = customColor.value;
      applyAccent(state.accentColor);
      updateThemeBadge();
      updateSwatchActive();
      save(state);
    });

    const panel = document.getElementById("settings-panel");
    const overlay = document.getElementById("settings-overlay");
    const openBtn = document.getElementById("settings-btn");
    const closeBtn = document.getElementById("settings-close");

    // Exposed open/close so the shell can hide native webviews before showing
    // the panel, and restore them after it closes.
    function openPanel() { panel.classList.add("open"); overlay.classList.add("show"); }
    function closePanel() { panel.classList.remove("open"); overlay.classList.remove("show"); }

    // Wire up the close controls here (open is triggered by the shell to
    // ensure native views are withdrawn first).
    closeBtn.addEventListener("click", closePanel);
    overlay.addEventListener("click", closePanel);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePanel();
    });

    // Theme-from-photo controls
    const photoInput = document.getElementById("opt-theme-photo");
    const photoApply = document.getElementById("opt-theme-photo-apply");
    const photoPreview = document.getElementById("opt-theme-photo-preview");
    let pendingHex = null;

    async function extractAverageColor(file) {
      try {
        const bitmap = await createImageBitmap(file);
        const w = 64;
        const h = Math.round((bitmap.height / bitmap.width) * w) || 64;
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
        }
        return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
      } catch (err) {
        return null;
      }
    }

    photoInput?.addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      if (photoPreview) {
        photoPreview.innerHTML = `<img src="${url}" style="max-width:100%; max-height:80px; border-radius:8px; display:block;"/>`;
      }
      const rgb = await extractAverageColor(f);
      if (rgb) {
        pendingHex = rgbToHex(rgb);
        photoApply.disabled = false;
        photoApply.textContent = `Apply theme (${pendingHex})`;
      } else {
        pendingHex = null;
        photoApply.disabled = true;
        photoApply.textContent = `Apply theme from photo`;
      }
    });

    photoApply?.addEventListener("click", () => {
      if (!pendingHex) return;
      state.accentColor = pendingHex;
      document.getElementById("opt-accent-custom").value = state.accentColor;
      applyAccent(state.accentColor);
      updateThemeBadge();
      updateSwatchActive();
      save(state);
      pendingHex = null;
      photoApply.disabled = true;
      photoApply.textContent = `Apply theme from photo`;
    });

    // ---- Ad & tracker blocking ----
    const adBlock = document.getElementById("opt-adblock");
    if (adBlock) {
      adBlock.checked = state.adBlock;
      adBlock.addEventListener("change", () => {
        state.adBlock = adBlock.checked;
        save(state);
        window.SreonTabs?.reloadActiveTabWithNewSettings();
      });
    }
    const adBlockTestBtn = document.getElementById("opt-adblock-test");
    if (adBlockTestBtn) {
      adBlockTestBtn.addEventListener("click", () => {
        if (window.SreonAdBlockTest) window.SreonAdBlockTest.open();
      });
    }

    // ---- Sidebar theme (cream) ----
    // This used to also force-invert every website's colors — that's
    // gone now. It only re-themes Sreon's own sidebar/chrome (into a
    // warm cream palette instead of the default glass), so there's no
    // need to touch the active tab's content at all.
    const darkMode = document.getElementById("opt-darkmode");
    if (darkMode) {
      darkMode.checked = state.darkMode;
      darkMode.addEventListener("change", () => {
        state.darkMode = darkMode.checked;
        apply(state);
        save(state);
      });
    }

    // ---- Privacy Mode (WebRTC IP-leak blocking + anti-fingerprinting) ----
    const privacyMode = document.getElementById("opt-privacy");
    if (privacyMode) {
      privacyMode.checked = state.privacyMode;
      privacyMode.addEventListener("change", () => {
        state.privacyMode = privacyMode.checked;
        save(state);
        window.SreonTabs?.reloadActiveTabWithNewSettings();
      });
    }

    // ---- Proxy (the actual IP-changing setting) ----
    const proxyInput = document.getElementById("opt-proxy");
    if (proxyInput) {
      proxyInput.value = state.proxyUrl || "";
      proxyInput.addEventListener("change", () => {
        state.proxyUrl = proxyInput.value.trim();
        save(state);
      });
    }
    const useTorBtn = document.getElementById("opt-use-tor");
    if (useTorBtn && proxyInput) {
      useTorBtn.addEventListener("click", () => {
        proxyInput.value = "socks5://127.0.0.1:9050";
        state.proxyUrl = proxyInput.value;
        save(state);
      });
    }

    // ---- Performance Mode ----
    const perfMode = document.getElementById("opt-performance");
    if (perfMode) {
      perfMode.checked = state.performanceMode;
      perfMode.addEventListener("change", () => {
        state.performanceMode = perfMode.checked;
        save(state);
        apply(state);
      });
    }

    // ---- Lock screen theme ----
    const lockThemeRow = document.getElementById("opt-lock-theme");
    const lockCustomColor = document.getElementById("opt-lock-custom-color");
    function updateLockThemeUI() {
      if (lockThemeRow) {
        lockThemeRow.querySelectorAll("[data-lock-theme]").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.lockTheme === state.lockTheme);
        });
      }
      if (lockCustomColor) {
        lockCustomColor.style.display = state.lockTheme === "custom" ? "" : "none";
        lockCustomColor.value = state.lockCustomColor;
      }
      applyLockTheme(state);
    }
    if (lockThemeRow) {
      lockThemeRow.querySelectorAll("[data-lock-theme]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.lockTheme = btn.dataset.lockTheme;
          save(state);
          updateLockThemeUI();
        });
      });
    }
    if (lockCustomColor) {
      lockCustomColor.addEventListener("input", () => {
        state.lockCustomColor = lockCustomColor.value;
        state.lockTheme = "custom";
        save(state);
        updateLockThemeUI();
      });
    }
    updateLockThemeUI();

    // ---- Background (photo/video theme) ----
    const bgModeRow = document.getElementById("opt-bg-mode");
    const bgUploadWrap = document.getElementById("opt-bg-upload-wrap");
    const bgTuneWrap = document.getElementById("opt-bg-tune-wrap");
    const bgFile = document.getElementById("opt-bg-file");
    const bgClear = document.getElementById("opt-bg-clear");
    const bgDim = document.getElementById("opt-bg-dim");
    const bgDimVal = document.getElementById("opt-bg-dim-val");
    const bgBlur = document.getElementById("opt-bg-blur");
    const bgBlurVal = document.getElementById("opt-bg-blur-val");

    function syncBgUI() {
      if (!bgModeRow) return;
      bgModeRow.querySelectorAll(".bg-mode-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.mode === state.bgMode);
      });
      const showUpload = state.bgMode === "image" || state.bgMode === "video";
      bgUploadWrap.style.display = showUpload ? "" : "none";
      bgTuneWrap.style.display = showUpload && state.bgData ? "" : "none";
      bgClear.style.display = state.bgData ? "" : "none";
      if (bgFile) bgFile.accept = state.bgMode === "video" ? "video/*" : "image/*";
    }

    bgModeRow?.querySelectorAll(".bg-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.bgMode = btn.dataset.mode;
        if (state.bgMode === "glass") state.bgData = null;
        apply(state);
        save(state);
        syncBgUI();
      });
    });

    bgFile?.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        state.bgData = reader.result;
        apply(state);
        save(state);
        syncBgUI();
      };
      reader.readAsDataURL(f);
    });

    bgClear?.addEventListener("click", () => {
      state.bgMode = "glass";
      state.bgData = null;
      if (bgFile) bgFile.value = "";
      apply(state);
      save(state);
      syncBgUI();
    });

    bgDim && (bgDim.value = state.bgDim);
    bgDimVal && (bgDimVal.textContent = `${state.bgDim}%`);
    bgDim?.addEventListener("input", () => {
      state.bgDim = Number(bgDim.value);
      bgDimVal.textContent = `${state.bgDim}%`;
      apply(state);
      save(state);
    });

    bgBlur && (bgBlur.value = state.bgBlur);
    bgBlurVal && (bgBlurVal.textContent = `${state.bgBlur}px`);
    bgBlur?.addEventListener("input", () => {
      state.bgBlur = Number(bgBlur.value);
      bgBlurVal.textContent = `${state.bgBlur}px`;
      apply(state);
      save(state);
    });

    syncBgUI();

    // ---- Lock screen's own background (photo/video), independent of the app bg ----
    const lockBgModeRow = document.getElementById("opt-lock-bg-mode");
    const lockBgUploadWrap = document.getElementById("opt-lock-bg-upload-wrap");
    const lockBgTuneWrap = document.getElementById("opt-lock-bg-tune-wrap");
    const lockBgFile = document.getElementById("opt-lock-bg-file");
    const lockBgClear = document.getElementById("opt-lock-bg-clear");
    const lockBgBlur = document.getElementById("opt-lock-bg-blur");
    const lockBgBlurVal = document.getElementById("opt-lock-bg-blur-val");

    function syncLockBgUI() {
      if (!lockBgModeRow) return;
      lockBgModeRow.querySelectorAll(".bg-mode-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.lockBgMode === state.lockBgMode);
      });
      const showUpload = state.lockBgMode === "image" || state.lockBgMode === "video";
      lockBgUploadWrap.style.display = showUpload ? "" : "none";
      lockBgTuneWrap.style.display = showUpload && state.lockBgData ? "" : "none";
      lockBgClear.style.display = state.lockBgData ? "" : "none";
      if (lockBgFile) lockBgFile.accept = state.lockBgMode === "video" ? "video/*" : "image/*";
    }

    lockBgModeRow?.querySelectorAll(".bg-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.lockBgMode = btn.dataset.lockBgMode;
        if (state.lockBgMode === "theme") state.lockBgData = null;
        applyLockBackground(state);
        save(state);
        syncLockBgUI();
      });
    });

    lockBgFile?.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        state.lockBgData = reader.result;
        applyLockBackground(state);
        save(state);
        syncLockBgUI();
      };
      reader.readAsDataURL(f);
    });

    lockBgClear?.addEventListener("click", () => {
      state.lockBgMode = "theme";
      state.lockBgData = null;
      if (lockBgFile) lockBgFile.value = "";
      applyLockBackground(state);
      save(state);
      syncLockBgUI();
    });

    lockBgBlur && (lockBgBlur.value = state.lockBgBlur || 0);
    lockBgBlurVal && (lockBgBlurVal.textContent = `${state.lockBgBlur || 0}px`);
    lockBgBlur?.addEventListener("input", () => {
      state.lockBgBlur = Number(lockBgBlur.value);
      lockBgBlurVal.textContent = `${state.lockBgBlur}px`;
      applyLockBackground(state);
      save(state);
    });

    syncLockBgUI();

    // ---- App lock controls ----
    wireLockSettings();

    // Populate exposed hooks
    openPanelFn = openPanel;
    closePanelFn = closePanel;
  }

  async function wireLockSettings() {
    const label = document.getElementById("lock-status-label");
    const controls = document.getElementById("lock-settings-controls");
    if (!label || !controls || !window.Lock) return;

    async function refresh() {
      const locked = await window.Lock.hasPassword();
      label.textContent = locked
        ? "A password is set for Sreon on this device."
        : "No password is set — Sreon opens straight to your tabs.";
      controls.innerHTML = locked
        ? `<button class="btn-secondary" id="lock-change-btn">Change password</button>
           <button class="btn-secondary" id="lock-remove-btn">Remove password</button>
           <button class="btn-secondary" id="lock-now-btn">Lock Sreon now</button>`
        : `<button class="btn-primary" id="lock-set-btn">Set a password</button>`;

      document.getElementById("lock-set-btn")?.addEventListener("click", () => promptSet());
      document.getElementById("lock-change-btn")?.addEventListener("click", () => promptChange());
      document.getElementById("lock-remove-btn")?.addEventListener("click", () => promptRemove());
      document.getElementById("lock-now-btn")?.addEventListener("click", () => {
        closePanelFn();
        window.Lock.engage();
      });
    }

    function miniPrompt(msg) {
      return SreonDialog.prompt(msg, { title: "Sreon Lock" });
    }

    async function promptSet() {
      const a = await miniPrompt("Choose a password for Sreon (at least 4 characters):");
      if (!a) return;
      if (a.length < 4) { await SreonDialog.alert("Use at least 4 characters."); return; }
      await window.Lock.setPassword(a);
      refresh();
    }
    async function promptChange() {
      const old = await miniPrompt("Enter your current password:");
      if (!old) return;
      const ok = await window.Lock.verifyPassword(old);
      if (!ok) { await SreonDialog.alert("That password isn't right."); return; }
      const a = await miniPrompt("Choose a new password (at least 4 characters):");
      if (!a) return;
      if (a.length < 4) { await SreonDialog.alert("Use at least 4 characters."); return; }
      await window.Lock.setPassword(a);
      refresh();
    }
    async function promptRemove() {
      const old = await miniPrompt("Enter your current password to remove the lock:");
      if (!old) return;
      try {
        await window.Lock.removePassword(old);
        refresh();
      } catch {
        await SreonDialog.alert("That password isn't right.");
      }
    }

    refresh();
  }

  return {
    init,
    get: () => state,
    applyEarly: () => apply(state), // safe to call before init(), e.g. ahead of the lock screen's first paint
    applyLockBackground: () => applyLockBackground(state), // call after the lock overlay re-renders its DOM
    getSiteOverride: (host) => (state.siteOverrides && state.siteOverrides[host]) || {},
    setSiteOverride: (host, patch) => {
      state.siteOverrides = state.siteOverrides || {};
      state.siteOverrides[host] = { ...(state.siteOverrides[host] || {}), ...patch };
      save(state);
    },
    clearSiteOverride: (host) => {
      if (state.siteOverrides) delete state.siteOverrides[host];
      save(state);
    },
    searchUrl: (query) => state.searchEngine + encodeURIComponent(query),
    homepage: () => state.homepage,
    onChange: (fn) => listeners.push(fn),
    openPanel: () => openPanelFn(),
    closePanel: () => closePanelFn(),
  };
})();
