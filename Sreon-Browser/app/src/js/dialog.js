// Sreon's own prompt/alert/confirm — replaces window.prompt/alert/confirm.
//
// WHY THIS FILE EXISTS: Tauri's macOS webview (WKWebView) does not
// reliably support window.prompt() — many WKWebView embeddings simply
// never implement the native text-input panel, so the call returns
// null/undefined immediately with no dialog ever appearing on screen.
// Sreon's "Set a password" buttons (both the per-workspace ones and the
// general app-lock one) used to go straight through window.prompt(),
// which meant clicking them did nothing visible at all — the password
// variable came back empty, the length check silently failed, and the
// handler just returned. This file replaces every one of those calls
// with a real in-app dialog built from Sreon's own glass UI, so it always
// renders and always works the same way on every platform.
(function () {
  "use strict";

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function ensureOverlay() {
    let overlay = document.getElementById("dialog-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "dialog-overlay";
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  function open({ kind, title, message, password, placeholder, confirmLabel, cancelLabel }) {
    return new Promise((resolve) => {
      const overlay = ensureOverlay();
      const isPrompt = kind === "prompt";
      const showCancel = kind !== "alert";
      overlay.innerHTML = `
        <div class="dialog-card glass">
          <h3 class="dialog-title">${escapeHtml(title || "Sreon")}</h3>
          <p class="dialog-msg">${escapeHtml(message || "")}</p>
          ${isPrompt ? `<input class="dialog-input" type="${password === false ? "text" : "password"}" placeholder="${escapeHtml(placeholder || "")}" autocomplete="off" spellcheck="false" />` : ""}
          <div class="dialog-actions">
            ${showCancel ? `<button type="button" class="btn-secondary dialog-cancel">${escapeHtml(cancelLabel || "Cancel")}</button>` : ""}
            <button type="button" class="btn-primary dialog-ok">${escapeHtml(confirmLabel || "OK")}</button>
          </div>
        </div>`;
      // Force reflow so the show transition animates even on back-to-back opens.
      void overlay.offsetWidth;
      overlay.classList.add("show");

      const input = overlay.querySelector(".dialog-input");
      const okBtn = overlay.querySelector(".dialog-ok");
      const cancelBtn = overlay.querySelector(".dialog-cancel");

      function finish(result) {
        overlay.classList.remove("show");
        document.removeEventListener("keydown", onKey);
        setTimeout(() => { if (!overlay.classList.contains("show")) overlay.innerHTML = ""; }, 220);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); finish(isPrompt ? null : false); }
        else if (e.key === "Enter") { e.preventDefault(); okBtn.click(); }
      }
      okBtn.addEventListener("click", () => finish(isPrompt ? (input.value || "") : true));
      cancelBtn?.addEventListener("click", () => finish(isPrompt ? null : false));
      document.addEventListener("keydown", onKey);
      setTimeout(() => { (input || okBtn).focus(); }, 60);
    });
  }

  window.SreonDialog = {
    /** Resolves to the entered string, or null if cancelled/escaped. */
    prompt(message, opts = {}) {
      return open({ kind: "prompt", message, title: opts.title, password: opts.password, placeholder: opts.placeholder, confirmLabel: opts.confirmLabel, cancelLabel: opts.cancelLabel });
    },
    /** Resolves once the person dismisses it. */
    alert(message, opts = {}) {
      return open({ kind: "alert", message, title: opts.title, confirmLabel: opts.confirmLabel || "OK" });
    },
    /** Resolves to true/false. */
    confirm(message, opts = {}) {
      return open({ kind: "confirm", message, title: opts.title, confirmLabel: opts.confirmLabel || "Confirm", cancelLabel: opts.cancelLabel });
    },
  };
})();
