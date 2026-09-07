// App-level lock screen. Separate from the saved-logins vault: this is
// one password that gates the whole app before any tab is shown.

(function () {
  "use strict";

  const ONBOARD_KEY = "sreon:lock-onboarded";
  const FALLBACK_KEY = "sreon:lock-fallback";

  function isTauriEnv() {
    return typeof window.__TAURI__ !== "undefined";
  }

  function invoke(cmd, args) {
    try {
      const t = window.__TAURI__;
      if (!t) return Promise.reject(new Error("tauri-not-available"));
      const invokeFn = (t.core && t.core.invoke) || (t.tauri && t.tauri.invoke) || t.invoke;
      if (!invokeFn) return Promise.reject(new Error("tauri-invoke-not-found"));
      return invokeFn(cmd, args);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // ---- Fallback (non-Tauri preview) password store, Web Crypto based ----
  async function sha256Hex(text) {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function randomSalt() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function loadFallback() {
    try { return JSON.parse(localStorage.getItem(FALLBACK_KEY)); } catch { return null; }
  }
  function saveFallback(v) { localStorage.setItem(FALLBACK_KEY, JSON.stringify(v)); }

  async function hasPassword() {
    if (isTauriEnv()) return invoke("has_app_password", {});
    return !!loadFallback();
  }
  async function setPassword(newPassword) {
    if (isTauriEnv()) return invoke("set_app_password", { newPassword });
    const salt = randomSalt();
    const hash = await sha256Hex(salt + ":sreon:" + newPassword);
    saveFallback({ salt, hash });
  }
  async function verifyPassword(password) {
    if (isTauriEnv()) return invoke("verify_app_password", { password });
    const rec = loadFallback();
    if (!rec) return true;
    const hash = await sha256Hex(rec.salt + ":sreon:" + password);
    return hash === rec.hash;
  }
  async function removePassword(password) {
    if (isTauriEnv()) return invoke("remove_app_password", { password });
    const rec = loadFallback();
    if (rec) {
      const hash = await sha256Hex(rec.salt + ":sreon:" + password);
      if (hash !== rec.hash) throw new Error("Incorrect password");
    }
    localStorage.removeItem(FALLBACK_KEY);
  }
  async function forceResetPassword() {
    if (isTauriEnv()) return invoke("force_reset_app_password", {});
    localStorage.removeItem(FALLBACK_KEY);
  }

  // ---- UI ----
  let overlayEl = null;
  let onUnlockedCb = null;

  function pwToggleBtn(inputId) {
    return `<button type="button" class="lock-pw-toggle" data-for="${inputId}" aria-label="Show password">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
    </button>`;
  }
  function wirePwToggles(root) {
    root.querySelectorAll(".lock-pw-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const input = root.querySelector("#" + btn.dataset.for);
        if (!input) return;
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        input.classList.toggle("lock-pw", show);
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      });
    });
  }

  function render(mode) {
    // mode: "setup" | "enter" | "change"
    overlayEl.innerHTML = "";

    const cardMount = window.SreonWidgets
      ? window.SreonWidgets.mountLockLayout(overlayEl)
      : overlayEl.appendChild(document.createElement("div"));
    if (typeof Settings !== "undefined") Settings.applyLockBackground();

    const card = cardMount;
    card.classList.add("lock-card");

    const globe = `<img class="lock-globe earth-cartoon" src="assets/sreon-logo.png" alt="Sreon" />`;

    const avatarSlot = overlayEl.querySelector("#lock-avatar-slot");
    if (avatarSlot) {
      avatarSlot.innerHTML = `<div class="lock-avatar">${globe}</div>`;
    }

    if (mode === "setup") {
      card.innerHTML = `
        <h2>Lock Sreon with a password?</h2>
        <p class="lock-sub">Optional, and fully local to this device. Nobody — not even Anthropic or Sreon's developers — can see or reset it for you.</p>
        <form id="lock-setup-form">
          <div class="lock-pw-field">
            <input type="password" id="lock-new-pass" placeholder="New password" autocomplete="new-password" />
            ${pwToggleBtn("lock-new-pass")}
          </div>
          <div class="lock-pw-field">
            <input type="password" id="lock-new-pass-confirm" placeholder="Confirm password" autocomplete="new-password" />
            ${pwToggleBtn("lock-new-pass-confirm")}
          </div>
          <div class="lock-err" id="lock-setup-err"></div>
          <button type="submit" class="btn-primary lock-btn">Set password &amp; lock</button>
        </form>
        <button class="btn-secondary lock-skip" id="lock-skip">Skip for now</button>
      `;
      wirePwToggles(card);
      const form = card.querySelector("#lock-setup-form");
      const err = card.querySelector("#lock-setup-err");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const a = card.querySelector("#lock-new-pass").value;
        const b = card.querySelector("#lock-new-pass-confirm").value;
        if (a.length < 4) { err.textContent = "Use at least 4 characters."; return; }
        if (a !== b) { err.textContent = "Passwords don't match."; return; }
        try {
          await setPassword(a);
          localStorage.setItem(ONBOARD_KEY, "1");
          finish();
        } catch (ex) {
          err.textContent = "Couldn't save that password. Try again.";
        }
      });
      card.querySelector("#lock-skip").addEventListener("click", () => {
        localStorage.setItem(ONBOARD_KEY, "1");
        finish();
      });
    } else if (mode === "enter") {
      card.innerHTML = `
        <h2>Sreon is locked</h2>
        <p class="lock-sub">Enter your password to continue.</p>
        <form id="lock-enter-form">
          <div class="lock-pass-pill">
            <svg class="lock-pass-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>
            <input type="password" id="lock-enter-pass" placeholder="Enter your password" autocomplete="current-password" autofocus />
            <button type="submit" class="lock-pass-go" aria-label="Unlock">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </button>
          </div>
          <div class="lock-err" id="lock-enter-err"></div>
        </form>
        <button class="btn-secondary lock-skip" id="lock-forgot">Forgot password?</button>
      `;
      const form = card.querySelector("#lock-enter-form");
      const err = card.querySelector("#lock-enter-err");
      const input = card.querySelector("#lock-enter-pass");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const ok = await verifyPassword(input.value);
        if (ok) {
          finish();
        } else {
          err.textContent = "That password isn't right.";
          card.classList.remove("lock-shake");
          void card.offsetWidth;
          card.classList.add("lock-shake");
          input.value = "";
          input.focus();
        }
      });
      card.querySelector("#lock-forgot").addEventListener("click", () => {
        renderForgot(card);
      });
      setTimeout(() => input.focus(), 50);
    }
  }

  function renderForgot(card) {
    card.innerHTML = `
      <h2>Reset the lock?</h2>
      <p class="lock-sub">This removes the password only — your tabs, history, saved logins, and settings all stay exactly as they are. There's no way to recover the old password itself, because Sreon never stores it anywhere it could be read back.</p>
      <button class="btn-primary lock-btn" id="lock-do-reset">Remove password &amp; continue</button>
      <button class="btn-secondary lock-skip" id="lock-cancel-reset">Cancel</button>
    `;
    card.querySelector("#lock-do-reset").addEventListener("click", async () => {
      await forceResetPassword();
      finish();
    });
    card.querySelector("#lock-cancel-reset").addEventListener("click", () => render("enter"));
  }

  function finish() {
    overlayEl.classList.remove("show");
    if (window.SreonWidgets) window.SreonWidgets.teardownWidgets();
    try { if (window.restoreActiveViewFromOverlay) window.restoreActiveViewFromOverlay(); } catch {}
    if (onUnlockedCb) {
      const cb = onUnlockedCb;
      onUnlockedCb = null;
      cb();
    }
  }

  async function init(onUnlocked) {
    overlayEl = document.getElementById("lock-overlay");
    if (!overlayEl) { onUnlocked(); return; }
    onUnlockedCb = onUnlocked;
    const locked = await hasPassword();
    // If a native webview is visible (Tauri), withdraw it so the lock
    // overlay (which is regular DOM) renders above the content.
    try { if (window.withdrawActiveViewForOverlay) window.withdrawActiveViewForOverlay(); } catch {}
    overlayEl.classList.add("show");
    if (locked) {
      render("enter");
    } else if (!localStorage.getItem(ONBOARD_KEY)) {
      render("setup");
    } else {
      finish();
    }
  }

  // Re-engage the lock on demand (quick-lock shortcut, or a "Lock now"
  // button in Settings). Always shows the "enter password" screen if one
  // is set; if none is set, just blanks the screen with the setup prompt.
  async function engage() {
    overlayEl = overlayEl || document.getElementById("lock-overlay");
    if (!overlayEl) return;
    onUnlockedCb = () => {}; // no-op: shell is already booted
    const locked = await hasPassword();
    try { if (window.withdrawActiveViewForOverlay) window.withdrawActiveViewForOverlay(); } catch {}
    overlayEl.classList.add("show");
    render(locked ? "enter" : "setup");
  }

  function wsFallbackKey(workspaceId) {
    return `sreon:wslock-fallback:${workspaceId}`;
  }

  async function hasWorkspacePassword(workspaceId) {
    if (isTauriEnv()) return invoke("has_workspace_password", { workspaceId });
    return !!JSON.parse(localStorage.getItem(wsFallbackKey(workspaceId)) || "null");
  }
  async function setWorkspacePassword(workspaceId, newPassword) {
    if (isTauriEnv()) await invoke("set_workspace_password", { workspaceId, newPassword });
    else {
      const salt = randomSalt();
      const hash = await sha256Hex(salt + ":sreon:" + newPassword);
      localStorage.setItem(wsFallbackKey(workspaceId), JSON.stringify({ salt, hash }));
    }
    if (window.SecureStore) await window.SecureStore.unlockWithPassword(workspaceId, newPassword);
  }
  async function verifyWorkspacePassword(workspaceId, password) {
    let ok;
    if (isTauriEnv()) {
      ok = await invoke("verify_workspace_password", { workspaceId, password });
    } else {
      const rec = JSON.parse(localStorage.getItem(wsFallbackKey(workspaceId)) || "null");
      if (!rec) { ok = true; } else {
        const hash = await sha256Hex(rec.salt + ":sreon:" + password);
        ok = hash === rec.hash;
      }
    }
    if (ok && window.SecureStore) await window.SecureStore.unlockWithPassword(workspaceId, password);
    return ok;
  }
  async function removeWorkspacePassword(workspaceId, password) {
    if (isTauriEnv()) return invoke("remove_workspace_password", { workspaceId, password });
    const rec = JSON.parse(localStorage.getItem(wsFallbackKey(workspaceId)) || "null");
    if (rec) {
      const hash = await sha256Hex(rec.salt + ":sreon:" + password);
      if (hash !== rec.hash) throw new Error("Incorrect password");
    }
    localStorage.removeItem(wsFallbackKey(workspaceId));
  }
  async function forceResetWorkspacePassword(workspaceId) {
    if (isTauriEnv()) return invoke("force_reset_workspace_password", { workspaceId });
    localStorage.removeItem(wsFallbackKey(workspaceId));
  }

  function unlockWorkspace(workspaceId, workspaceName) {
    return new Promise((resolve) => {
      overlayEl = overlayEl || document.getElementById("lock-overlay");
      if (!overlayEl) { resolve(true); return; }
      try { if (window.withdrawActiveViewForOverlay) window.withdrawActiveViewForOverlay(); } catch {}
      overlayEl.classList.add("show");

      const cardMount = window.SreonWidgets
        ? window.SreonWidgets.mountLockLayout(overlayEl)
        : overlayEl.appendChild(document.createElement("div"));
      const card = cardMount;
      card.classList.add("lock-card");
      overlayEl.innerHTML = "";
      overlayEl.appendChild(cardMount);
      card.innerHTML = `
        <h2>${workspaceName} is locked</h2>
        <p class="lock-sub">Enter this workspace's password to switch into it.</p>
        <form id="ws-lock-form">
          <div class="lock-pass-pill">
            <svg class="lock-pass-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>
            <input type="password" id="ws-lock-pass" placeholder="Enter your password" autocomplete="current-password" autofocus />
            <button type="submit" class="lock-pass-go" aria-label="Unlock">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </button>
          </div>
          <div class="lock-err" id="ws-lock-err"></div>
        </form>
        <button class="btn-secondary lock-skip" id="ws-lock-cancel">Cancel</button>
      `;
      const form = card.querySelector("#ws-lock-form");
      const err = card.querySelector("#ws-lock-err");
      const input = card.querySelector("#ws-lock-pass");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const ok = await verifyWorkspacePassword(workspaceId, input.value);
        if (ok) {
          overlayEl.classList.remove("show");
          if (window.SreonWidgets) window.SreonWidgets.teardownWidgets();
          try { if (window.restoreActiveViewFromOverlay) window.restoreActiveViewFromOverlay(); } catch {}
          resolve(true);
        } else {
          err.textContent = "That password isn't right.";
          card.classList.remove("lock-shake");
          void card.offsetWidth;
          card.classList.add("lock-shake");
          input.value = "";
          input.focus();
        }
      });
      card.querySelector("#ws-lock-cancel").addEventListener("click", () => {
        overlayEl.classList.remove("show");
        if (window.SreonWidgets) window.SreonWidgets.teardownWidgets();
        try { if (window.restoreActiveViewFromOverlay) window.restoreActiveViewFromOverlay(); } catch {}
        resolve(false);
      });
      setTimeout(() => input.focus(), 50);
    });
  }

  window.Lock = {
    init,
    engage,
    hasPassword,
    setPassword,
    verifyPassword,
    removePassword,
    forceResetPassword,
    hasWorkspacePassword,
    setWorkspacePassword,
    verifyWorkspacePassword,
    removeWorkspacePassword,
    forceResetWorkspacePassword,
    unlockWorkspace,
  };
})();
