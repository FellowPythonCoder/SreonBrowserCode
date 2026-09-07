// Shared widgets for the lock screen and the dashboard/start page.
(function () {
  "use strict";

  let timers = [];
  let unlisteners = [];
  const track = (id) => timers.push(id);
  function teardownWidgets() {
    timers.forEach(clearInterval);
    timers = [];
    unlisteners.forEach((fn) => { try { fn(); } catch {} });
    unlisteners = [];
  }

  // ---------------------------------------------------------------- clock
  function mountClock(root) {
    const t = root.querySelector("[data-w-time]");
    const d = root.querySelector("[data-w-date]");
    if (!t) return;
    const tick = () => {
      const now = new Date();
      t.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (d) d.textContent = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    };
    tick();
    track(setInterval(tick, 15000));
  }

  // --------------------------------------------------------------- weather
  const WEATHER_CACHE_KEY = "sreon:widget-weather-cache";
  const WEATHER_CODES = {
    0: "Clear sky", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Icy fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow", 73: "Snow",
    75: "Heavy snow", 80: "Rain showers", 81: "Rain showers", 82: "Violent showers",
    95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Severe thunderstorm",
  };
  // Small inline SVG icon set (no emoji — renders identically everywhere).
  const ICONS = {
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
    cloudSun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="7.5" cy="8" r="3"/><path d="M7.5 2.5v1.4M3 8H1.6M12 5.6l-1 1M13.5 15.5h-8a3.5 3.5 0 010-7c.3 0 .6 0 .9.1A5 5 0 0115.5 11a3 3 0 01-2 4.5z"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6.5 18h10a4 4 0 000-8 6 6 0 00-11.3 2A3.7 3.7 0 006.5 18z"/></svg>',
    fog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9h16M2 13h20M4 17h16M6 21h12"/></svg>',
    rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6.5 15h10a4 4 0 000-8 6 6 0 00-11.3 2A3.7 3.7 0 006.5 15z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/></svg>',
    snow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6.5 14h10a4 4 0 000-8 6 6 0 00-11.3 2A3.7 3.7 0 006.5 14z"/><path d="M12 17v5M9.5 19l5-4M14.5 19l-5-4"/></svg>',
    storm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6.5 13h10a4 4 0 000-8 6 6 0 00-11.3 2A3.7 3.7 0 006.5 13z"/><path d="M13 14l-3 5h3l-2 4"/></svg>',
    cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M6 2v0"/></svg>',
    temp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 14.5V4a2 2 0 10-4 0v10.5a4 4 0 104 0z"/></svg>',
    mem: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="16" height="8" rx="1"/><path d="M8 8V5M12 8V5M16 8V5M8 19v-3M12 19v-3M16 19v-3"/></svg>',
    disk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
    tabs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="8" height="6" rx="1"/><rect x="13" y="6" width="8" height="6" rx="1"/><path d="M4 16h16"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
    network: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.5a10 10 0 0114 0M8 15.8a6 6 0 018 0M12 19h.01"/></svg>',
  };
  function weatherIcon(code) {
    if (code === 0) return ICONS.sun;
    if ([1, 2].includes(code)) return ICONS.cloudSun;
    if (code === 3) return ICONS.cloud;
    if ([45, 48].includes(code)) return ICONS.fog;
    if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return ICONS.rain;
    if ([71, 73, 75].includes(code)) return ICONS.snow;
    if ([95, 96, 99].includes(code)) return ICONS.storm;
    return ICONS.cloudSun;
  }
  function getPosition() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => resolve(null),
        { timeout: 4000 }
      );
    });
  }
  async function fetchWeather() {
    try {
      const cached = JSON.parse(localStorage.getItem(WEATHER_CACHE_KEY) || "null");
      if (cached && Date.now() - cached.at < 1000 * 60 * 20) return cached.data;
    } catch {}
    const pos = (await getPosition()) || { lat: 40.71, lon: -74.0 };
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${pos.lat}&longitude=${pos.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code&temperature_unit=celsius`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("weather fetch failed");
    const j = await res.json();
    const data = {
      temp: Math.round(j.current.temperature_2m),
      feelsLike: Math.round(j.current.apparent_temperature),
      humidity: Math.round(j.current.relative_humidity_2m),
      code: j.current.weather_code,
    };
    localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
    return data;
  }
  async function mountWeather(root) {
    const icon = root.querySelector("[data-w-wicon]");
    const cond = root.querySelector("[data-w-cond]");
    const temp = root.querySelector("[data-w-temp]");
    const meta = root.querySelector("[data-w-meta]");
    if (!icon) return;
    try {
      const w = await fetchWeather();
      icon.innerHTML = weatherIcon(w.code);
      cond.textContent = WEATHER_CODES[w.code] || "—";
      temp.textContent = `${w.temp}°`;
      meta.textContent = `Humidity ${w.humidity}% · Feels like ${w.feelsLike}°`;
    } catch {
      icon.innerHTML = ICONS.cloudSun;
      cond.textContent = "Weather unavailable";
      temp.textContent = "--°";
      meta.textContent = "Check your connection";
    }
  }

  // --------------------------------------------------------- device/shell
  async function mountSystem(root) {
    const batt = root.querySelector("[data-w-batt]");
    const plat = root.querySelector("[data-w-plat]");
    const up = root.querySelector("[data-w-up]");
    if (plat) plat.textContent = navigator.platform || navigator.userAgentData?.platform || "Unknown";
    if (up) {
      const start = Number(sessionStorage.getItem("sreon:widget-session-start")) || Date.now();
      sessionStorage.setItem("sreon:widget-session-start", String(start));
      const tick = () => {
        const mins = Math.floor((Date.now() - start) / 60000);
        up.textContent = mins < 1 ? "just now" : `${mins} min`;
      };
      tick();
      track(setInterval(tick, 30000));
    }
    if (batt && navigator.getBattery) {
      try {
        const b = await navigator.getBattery();
        const render = () => {
          batt.innerHTML = `${Math.round(b.level * 100)}%${b.charging ? ` <span class="batt-bolt">${ICONS.bolt}</span>` : ""}`;
        };
        render();
        b.addEventListener("levelchange", render);
        b.addEventListener("chargingchange", render);
      } catch { batt.textContent = "—"; }
    } else if (batt) batt.textContent = "—";
  }

  // ------------------------------------------------------------ now playing
  // Real detection. In the Tauri build, each tab is its own native
  // webview with its own JS context, so the dashboard listens for the
  // "sreon://now-playing" event that every tab reports (see main.rs) —
  // genuine data from whichever site is actually playing something. In
  // the plain-browser preview (no Tauri runtime) it falls back to this
  // page's own Media Session, since there's only one JS context.
  function mountNowPlaying(root) {
    if (!root) return;
    const title = root.querySelector("[data-w-track]");
    const artist = root.querySelector("[data-w-artist]");
    const bars = root.querySelectorAll(".viz-bar");

    function render(np) {
      if (np && np.title) {
        title.textContent = np.title;
        artist.textContent = np.artist || "";
        root.classList.toggle("is-playing", !!np.playing);
      } else {
        title.textContent = "Nothing playing";
        artist.textContent = "Play something in a tab to see it here";
        root.classList.remove("is-playing");
      }
    }

    bars.forEach((bar, i) => (bar.style.animationDelay = `${i * 0.09}s`));

    if (window.__TAURI__ && window.__TAURI__.event) {
      render(null);
      window.__TAURI__.event.listen("sreon://now-playing", (e) => render(e.payload)).then((un) => unlisteners.push(un));
      return;
    }

    function fromMediaSession() {
      const ms = navigator.mediaSession;
      const md = ms && ms.metadata;
      if (md && md.title) {
        render({ title: md.title, artist: md.artist || md.album, playing: ms.playbackState === "playing" });
        return true;
      }
      render(null);
      return false;
    }
    fromMediaSession();
    track(setInterval(fromMediaSession, 1000));
  }

  // ------------------------------------------------------------ stat rings
  // Real browser data — not fake system stats: how many tabs are open
  // (read straight from the DOM), how many ads/trackers have actually
  // been blocked this session (real count reported by every tab's own
  // ad-block script via a Tauri event — see main.rs), this page's own
  // JS heap usage (real, where the engine exposes performance.memory),
  // and real network connectivity.
  let blockedCount = 0;
  function mountStatRings(root) {
    const rings = root.querySelectorAll("[data-w-ring]");
    if (!rings.length) return;

    function setRing(el, percent, valueText) {
      const circle = el.querySelector("circle.ring-fg");
      if (circle) {
        const r = circle.r.baseVal.value;
        const c = 2 * Math.PI * r;
        circle.style.strokeDasharray = `${c}`;
        circle.style.strokeDashoffset = `${c * (1 - Math.max(0, Math.min(100, percent)) / 100)}`;
      }
      const label = el.querySelector("[data-w-ring-val]");
      if (label) label.textContent = valueText;
    }

    function renderTabs() {
      const count = document.querySelectorAll("#tab-bar .tab, .tab-strip .tab").length || 0;
      if (rings[0]) setRing(rings[0], Math.min(100, count * 12), String(count));
    }
    function renderBlocked() {
      if (rings[1]) setRing(rings[1], Math.min(100, blockedCount * 2), String(blockedCount));
    }
    function renderMemory() {
      const mem = performance.memory;
      if (mem && mem.jsHeapSizeLimit) {
        const pct = Math.round((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100);
        if (rings[2]) setRing(rings[2], pct, `${pct}%`);
      } else if (rings[2]) {
        setRing(rings[2], 0, "—");
      }
    }
    function renderOnline() {
      const online = navigator.onLine;
      if (rings[3]) setRing(rings[3], online ? 100 : 0, online ? "Up" : "Down");
    }

    renderTabs();
    renderBlocked();
    renderMemory();
    renderOnline();
    track(setInterval(renderTabs, 2000));
    track(setInterval(renderMemory, 4000));

    window.addEventListener("online", renderOnline);
    window.addEventListener("offline", renderOnline);
    unlisteners.push(() => {
      window.removeEventListener("online", renderOnline);
      window.removeEventListener("offline", renderOnline);
    });

    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event
        .listen("sreon://block-count", (e) => {
          blockedCount = e.payload || 0;
          renderBlocked();
        })
        .then((un) => unlisteners.push(un));
    }
  }

  // --------------------------------------------------------- notifications
  // Cosmetic sample list — Sreon never generates real OS notifications
  // (see PRIVACY.txt / README); this is purely decorative chrome.
  const SAMPLE_NOTIFS = [
    { app: "Sreon", title: "Ad & tracker blocking is on", body: "Nothing to report — all clear." },
    { app: "Sreon", title: "Backgrounds", body: "Set a photo or video theme in Settings." },
    { app: "Sreon", title: "Tip", body: "⌘⇧L quick-locks the app any time." },
  ];
  function mountNotifications(root) {
    if (!root) return;
    root.innerHTML = SAMPLE_NOTIFS.map(
      (n, i) => `<div class="notif-row" style="--wd:${0.3 + i * 0.06}s">
        <div class="notif-dot"></div>
        <div class="notif-text"><b>${n.app}</b> ${n.title}<div class="notif-body">${n.body}</div></div>
      </div>`
    ).join("");
  }

  // --------------------------------------------------------------- markup
  function ring(iconSvg, name) {
    return `
      <div>
        <div class="stat-ring" data-w-ring>
          <svg viewBox="0 0 64 64">
            <circle class="ring-bg" cx="32" cy="32" r="26"/>
            <circle class="ring-fg" cx="32" cy="32" r="26"/>
          </svg>
          <div class="stat-ring-inner">
            <span class="stat-ring-icon">${iconSvg}</span>
            <span data-w-ring-val>--%</span>
          </div>
        </div>
        <div class="stat-ring-name">${name}</div>
      </div>`;
  }

  // 3-column layout for the lock screen (photo-1 style).
  function lockLayoutTemplate() {
    return `
      <img id="lock-bg-image" class="lock-bg-media" style="display:none" alt="" />
      <video id="lock-bg-video" class="lock-bg-media" style="display:none" autoplay muted playsinline loop></video>
      <div class="lock-layout">
        <div class="lock-col lock-col-left">
          <div class="widget-card glass w-anim" style="--wd:0s">
            <div class="widget-label">Weather</div>
            <div class="widget-weather-row">
              <div class="widget-wicon" data-w-wicon>🌤️</div>
              <div><div class="widget-temp" data-w-temp>--°</div><div class="widget-cond" data-w-cond>Loading…</div></div>
            </div>
            <div class="widget-meta" data-w-meta></div>
          </div>
          <div class="widget-card glass w-anim shell-card" style="--wd:.08s">
            <div class="widget-label">Session</div>
            <div class="shell-line"><span>Platform</span><span data-w-plat>—</span></div>
            <div class="shell-line"><span>Uptime</span><span data-w-up>—</span></div>
            <div class="shell-line"><span>Battery</span><span data-w-batt>—</span></div>
          </div>
          <div class="widget-card glass w-anim widget-nowplaying" data-w-nowplaying style="--wd:.16s">
            <div class="widget-label">Now playing</div>
            <div class="widget-np-row">
              <div class="widget-viz"><span class="viz-bar"></span><span class="viz-bar"></span><span class="viz-bar"></span><span class="viz-bar"></span><span class="viz-bar"></span></div>
              <div class="widget-np-text"><div class="widget-track" data-w-track>—</div><div class="widget-artist" data-w-artist>—</div></div>
            </div>
          </div>
        </div>

        <div class="lock-col lock-col-center">
          <div class="lock-clock-block w-anim" style="--wd:.05s">
            <div class="widget-clock-time lock-big-time" data-w-time>--:--</div>
            <div class="widget-clock-date" data-w-date>—</div>
          </div>
          <div class="lock-avatar-slot w-anim" style="--wd:.12s" id="lock-avatar-slot"></div>
          <div class="lock-card glass w-anim" style="--wd:.18s" id="lock-card-mount"></div>
        </div>

        <div class="lock-col lock-col-right">
          <div class="widget-card glass w-anim stat-grid" style="--wd:.1s">
            ${ring(ICONS.tabs, "Tabs open")}${ring(ICONS.shield, "Blocked")}${ring(ICONS.mem, "Memory")}${ring(ICONS.network, "Network")}
          </div>
          <div class="widget-card glass w-anim notif-card" style="--wd:.2s">
            <div class="widget-label">Notifications</div>
            <div class="notif-list" data-w-notifs></div>
          </div>
        </div>
      </div>`;
  }

  function mountLockLayout(overlayEl) {
    overlayEl.innerHTML = lockLayoutTemplate();
    mountClock(overlayEl);
    mountWeather(overlayEl);
    mountSystem(overlayEl);
    mountNowPlaying(overlayEl.querySelector("[data-w-nowplaying]"));
    mountStatRings(overlayEl);
    mountNotifications(overlayEl.querySelector("[data-w-notifs]"));
    return overlayEl.querySelector("#lock-card-mount");
  }

  // Full-bleed dashboard layout for the start page (photo-2 style).
  function dashboardLayoutTemplate() {
    return `
      <div class="dash-layout">
        <div class="dash-hero widget-card glass w-anim" style="--wd:0s" data-w-nowplaying>
          <div class="dash-hero-viz">
            <div class="widget-viz dash-viz-big">
              <span class="viz-bar"></span><span class="viz-bar"></span><span class="viz-bar"></span>
              <span class="viz-bar"></span><span class="viz-bar"></span><span class="viz-bar"></span><span class="viz-bar"></span>
            </div>
          </div>
          <div class="dash-hero-text">
            <div class="widget-track" data-w-track>—</div>
            <div class="widget-artist" data-w-artist>—</div>
          </div>
          <div class="dash-hero-art"></div>
        </div>

        <div class="widget-grid">
          <div class="widget-card glass w-anim" style="--wd:.06s">
            <div class="widget-label">Clock</div>
            <div class="widget-clock-time" data-w-time>--:--</div>
            <div class="widget-clock-date" data-w-date>—</div>
          </div>
          <div class="widget-card glass w-anim" style="--wd:.12s">
            <div class="widget-label">Weather</div>
            <div class="widget-weather-row">
              <div class="widget-wicon" data-w-wicon>🌤️</div>
              <div><div class="widget-temp" data-w-temp>--°</div><div class="widget-cond" data-w-cond>Loading…</div></div>
            </div>
            <div class="widget-meta" data-w-meta></div>
          </div>
          <div class="widget-card glass w-anim stat-grid" style="--wd:.18s">
            ${ring(ICONS.tabs, "Tabs open")}${ring(ICONS.shield, "Blocked")}${ring(ICONS.mem, "Memory")}${ring(ICONS.network, "Network")}
          </div>
          <div class="widget-card glass w-anim" style="--wd:.24s">
            <div class="widget-label">This device</div>
            <div class="widget-sys-row"><span>Battery</span><span data-w-batt>—</span></div>
            <div class="widget-sys-row"><span>Platform</span><span data-w-plat>—</span></div>
            <div class="widget-sys-row"><span>Session</span><span data-w-up>—</span></div>
          </div>
        </div>
      </div>`;
  }

  function mountDashboardLayout(mountEl) {
    mountEl.innerHTML = dashboardLayoutTemplate();
    mountClock(mountEl);
    mountWeather(mountEl);
    mountSystem(mountEl);
    mountNowPlaying(mountEl.querySelector("[data-w-nowplaying]"));
    mountStatRings(mountEl);
  }

  function mountWidgets(container) {
    mountDashboardLayout(container);
  }

  window.SreonWidgets = { mountWidgets, mountLockLayout, mountDashboardLayout, teardownWidgets };
})();
