// First-run tutorial. Shown once, the first time Sreon is opened on a
// device (tracked separately from the lock-screen onboarding flag in
// lock.js, which only covers setting up a password). Walks through the
// handful of things that aren't obvious from just looking at the UI:
// workspaces, the address bar, ad blocking, the cream sidebar toggle,
// and the vault/lock. Skippable at any point; never shown again once
// finished or skipped.
(function () {
  "use strict";

  const SEEN_KEY = "sreon:tour-done";

  const STEPS = [
    {
      title: "Welcome to Sreon",
      body: "A quick, 30-second tour of the few things that aren't obvious at a glance. You can skip this any time.",
    },
    {
      title: "Workspaces",
      body: "The pills at the top of the sidebar (Personal, Work, etc.) are separate workspaces — each keeps its own tabs, history, bookmarks, and can have its own lock password.",
    },
    {
      title: "One address bar for everything",
      body: "Type a URL, or just type what you're looking for — Sreon sends it to your search engine automatically.",
    },
    {
      title: "Built-in ad & tracker blocking",
      body: "On by default for every site. Click the lock icon in the address bar any time to turn it off for just that site.",
    },
    {
      title: "Cream sidebar",
      body: "Prefer a warmer look? Settings → Cream sidebar switches the sidebar to a light cream theme. It only affects Sreon's own chrome, never the pages you visit.",
    },
    {
      title: "Passwords stay local",
      body: "Saved logins, history, and bookmarks are encrypted on this device only. Settings → Data lets you clear tabs, or permanently delete everything.",
    },
  ];

  function ensureOverlay() {
    let overlay = document.getElementById("tour-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "tour-overlay";
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  function render(overlay, index) {
    const step = STEPS[index];
    const isFirst = index === 0;
    const isLast = index === STEPS.length - 1;
    overlay.innerHTML = `
      <div class="tour-card glass">
        <div class="tour-dots">
          ${STEPS.map((_, i) => `<span class="tour-dot${i === index ? " active" : ""}"></span>`).join("")}
        </div>
        <h3 class="tour-title">${step.title}</h3>
        <p class="tour-body">${step.body}</p>
        <div class="tour-actions">
          <button class="btn-ghost" id="tour-skip">Skip</button>
          <div class="tour-actions-right">
            ${isFirst ? "" : `<button class="btn-secondary" id="tour-back">Back</button>`}
            <button class="btn-primary" id="tour-next">${isLast ? "Get started" : "Next"}</button>
          </div>
        </div>
      </div>
    `;
    const finish = () => {
      localStorage.setItem(SEEN_KEY, "1");
      overlay.remove();
    };
    overlay.querySelector("#tour-skip").addEventListener("click", finish);
    overlay.querySelector("#tour-next").addEventListener("click", () => {
      if (isLast) finish();
      else render(overlay, index + 1);
    });
    const back = overlay.querySelector("#tour-back");
    if (back) back.addEventListener("click", () => render(overlay, index - 1));
  }

  function maybeShow() {
    if (localStorage.getItem(SEEN_KEY)) return;
    render(ensureOverlay(), 0);
  }

  window.SreonTour = { maybeShow };
})();
