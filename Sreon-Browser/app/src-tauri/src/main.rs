// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};
use tauri::webview::Color;

#[derive(Default)]
struct TabViews(Mutex<HashMap<String, tauri::Webview>>);

fn label_for(id: &str) -> String {
    format!("tabview-{id}")
}

// Built-in ad/tracker blocklist. Local and compiled in — nothing phones home.
const BLOCKED_HOST_FRAGMENTS: &[&str] = &[
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "adservice.google.",
    "google-analytics.com",
    "googletagmanager.com",
    "googletagservices.com",
    "adnxs.com",
    "adsrvr.org",
    "adroll.com",
    "criteo.com",
    "criteo.net",
    "taboola.com",
    "outbrain.com",
    "scorecardresearch.com",
    "quantserve.com",
    "moatads.com",
    "pubmatic.com",
    "rubiconproject.com",
    "openx.net",
    "casalemedia.com",
    "bidswitch.net",
    "yieldmo.com",
    "media.net",
    "smartadserver.com",
    "adform.net",
    "mathtag.com",
    "bluekai.com",
    "exelator.com",
    "agkn.com",
    "amazon-adsystem.com",
    "connect.facebook.net",
    "analytics.tiktok.com",
    "ads.linkedin.com",
    "ads-twitter.com",
    "static.ads-twitter.com",
    "hotjar.com",
    "mixpanel.com",
    "segment.io",
    "fullstory.com",
    "crazyegg.com",
    "adsafeprotected.com",
    "serving-sys.com",
    "advertising.com",
    "teads.tv",
    "sharethrough.com",
    "zedo.com",
    "adblade.com",
    "revcontent.com",
    "mgid.com",
    "popads.net",
    "propellerads.com",
    "adcolony.com",
    "chartboost.com",
    "vungle.com",
    "unityads.unity3d.com",
    "applovin.com",
    "inmobi.com",
    "smaato.com",
    "adcash.com",
    "pagead2.googlesyndication.com",
    "stats.g.doubleclick.net",
    "adition.com",
    "adroll.io",
    "adsafe.org",
    "adtechus.com",
    "advertising-api.amazon.com",
    "bing.com/ads",
    "clicktale.net",
    "demdex.net",
    "doubleverify.com",
    "flashtalking.com",
    "ib.adnxs.com",
    "indexww.com",
    "innovid.com",
    "krxd.net",
    "liadm.com",
    "lijit.com",
    "moatpixel.com",
    "narrative.io",
    "outbrainimg.com",
    "pixel.wp.com",
    "pubnation.com",
    "quantcast.com",
    "rlcdn.com",
    "rfihub.com",
    "sail-horizon.com",
    "sitescout.com",
    "spotxchange.com",
    "stickyadstv.com",
    "tapad.com",
    "tribalfusion.com",
    "tvsquared.com",
    "vidoomy.com",
    "zeotap.com",
];

fn is_ad_or_tracker(url: &Url) -> bool {
    match url.host_str() {
        Some(host) => {
            let host = host.to_lowercase();
            BLOCKED_HOST_FRAGMENTS.iter().any(|f| host.contains(f))
        }
        None => false,
    }
}

fn build_init_script(ad_block: bool, dark_mode: bool, privacy_mode: bool) -> String {
    let base = r#"
(function () {
  try {
    if (window.Notification) {
      window.Notification.requestPermission = function (cb) {
        if (cb) cb('denied');
        return Promise.resolve('denied');
      };
      try { Object.defineProperty(window.Notification, 'permission', { get: function () { return 'denied'; } }); } catch (e) {}
    }
  } catch (e) {}
})();
"#;

    let mut script = base.to_string();

    // Websites always render with their own normal styling now — the
    // "Dark mode" setting only affects Sreon's own sidebar/chrome (see
    // app.css / settings.js). This opaque-background backstop always
    // targets plain white, since there's no per-site filter to match.
    let bg = "#ffffff";
    script.push_str(&format!(
        r#"
(function () {{
  try {{
    var s = document.createElement('style');
    s.setAttribute('data-sreon-opaque-bg', '1');
    s.textContent = 'html{{background:{bg} !important;}}';
    (document.head || document.documentElement).appendChild(s);
  }} catch (e) {{}}
}})();
"#,
        bg = bg
    ));

    // Watches this tab's Media Session and reports real now-playing changes to the main window.
    script.push_str(
        r#"
(function () {
  try {
    var last = "";
    function report() {
      try {
        var ms = navigator.mediaSession;
        var md = ms && ms.metadata;
        var title = md && md.title ? md.title : null;
        var artist = md && (md.artist || md.album) ? (md.artist || md.album) : null;
        var playing = !!md && ms.playbackState === "playing";
        var key = title + "|" + artist + "|" + playing;
        if (key === last) return;
        last = key;
        if (window.__TAURI__) {
          var api = window.__TAURI__.core || window.__TAURI__.tauri;
          api.invoke("report_now_playing", { title: title, artist: artist, playing: playing }).catch(function () {});
        }
      } catch (e) {}
    }
    setInterval(report, 1000);
  } catch (e) {}
})();
"#,
    );

    if ad_block {
        let hosts_json = serde_json::to_string(BLOCKED_HOST_FRAGMENTS).unwrap_or_else(|_| "[]".into());
        script.push_str(&format!(
            r#"
(function () {{
  var BLOCKED = {hosts};
  function reportBlocked(n) {{
    try {{
      if (window.__TAURI__) {{
        var api = window.__TAURI__.core || window.__TAURI__.tauri;
        api.invoke('report_block_event', {{ amount: n }}).catch(function () {{}});
      }}
    }} catch (e) {{}}
  }}
  try {{
    var _open = window.open;
    window.open = function (u, n, s) {{
      try {{
        if (u && BLOCKED.some(function (h) {{ return String(u).indexOf(h) !== -1; }})) {{
          reportBlocked(1);
          return null;
        }}
      }} catch (e) {{}}
      return _open ? _open.call(window, u, n, s) : null;
    }};
  }} catch (e) {{}}
  try {{
    var SEL = '.adsbygoogle,ins.adsbygoogle,iframe[src*="doubleclick"],iframe[src*="googlesyndication"],[id*="google_ads"],[id^="div-gpt-ad"],[class*="ad-container"],[class*="ad-slot"],[class^="ad-"],[id^="ad-"],[data-ad-slot],[data-ad-client],.advertisement,.ad-wrapper,.sponsored-content,[aria-label="Advertisement" i]';
    var style = document.createElement('style');
    style.setAttribute('data-sreon-adblock', '1');
    style.textContent = SEL + '{{display:none!important;visibility:hidden!important;}}';
    (document.head || document.documentElement).appendChild(style);
    function countAndReport() {{
      try {{
        var n = document.querySelectorAll(SEL).length;
        if (n > 0) reportBlocked(n);
      }} catch (e) {{}}
    }}
    if (document.readyState === 'complete' || document.readyState === 'interactive') {{
      setTimeout(countAndReport, 300);
    }} else {{
      document.addEventListener('DOMContentLoaded', function () {{ setTimeout(countAndReport, 300); }});
    }}
  }} catch (e) {{}}
}})();
"#,
            hosts = hosts_json
        ));
    }

    // Website-content dark mode has been removed entirely (it fought with
    // sites' own overlay/blur effects — see the removed invert-filter
    // block). "Dark mode" now only themes Sreon's own chrome; the
    // `dark_mode` argument is accepted for API compatibility with the
    // frontend but no longer changes anything about page content.
    let _ = dark_mode;

    // Privacy Mode: WebRTC leak protection, geolocation refusal, canvas/WebGL fingerprint noise, timezone spoofing, and referrer stripping. Doesn't hide your IP from the server itself — pair with a proxy for that.
    if privacy_mode {
        script.push_str(
            r#"
(function () {
  try {
    // --- Stop sending Referer / referrerPolicy leaks to other sites ---
    var m = document.createElement('meta');
    m.name = 'referrer';
    m.content = 'no-referrer';
    (document.head || document.documentElement).prepend(m);
    Object.defineProperty(navigator, 'doNotTrack', { get: function () { return '1'; } });
    if (navigator.sendBeacon) navigator.sendBeacon = function () { return false; };
  } catch (e) {}

  try {
    // --- WebRTC IP leak protection ---
    var block = function () { throw new Error('WebRTC disabled by Sreon Privacy Mode'); };
    ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection'].forEach(function (k) {
      try { if (window[k]) window[k] = block; } catch (e) {}
    });
    if (navigator.mediaDevices) {
      try {
        navigator.mediaDevices.enumerateDevices = function () { return Promise.resolve([]); };
      } catch (e) {}
    }
  } catch (e) {}

  try {
    // --- Refuse geolocation ---
    if (navigator.geolocation) {
      var deny = function (ok, err) { if (err) err({ code: 1, message: 'Denied by Sreon Privacy Mode' }); };
      navigator.geolocation.getCurrentPosition = deny;
      navigator.geolocation.watchPosition = deny;
    }
  } catch (e) {}

  try {
    // --- Canvas fingerprint noise, stable per tab load ---
    var seed = Math.random();
    var noisy = function (orig) {
      return function () {
        try {
          var ctx = this.getContext && this.getContext('2d');
          if (ctx) {
            var w = this.width || 1, h = this.height || 1;
            var px = Math.max(1, Math.floor(w * seed)) % w;
            var py = Math.max(1, Math.floor(h * seed)) % h;
            var data = ctx.getImageData(px, py, 1, 1);
            data.data[0] = (data.data[0] + 1) % 256;
            ctx.putImageData(data, px, py);
          }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    };
    if (window.HTMLCanvasElement) {
      HTMLCanvasElement.prototype.toDataURL = noisy(HTMLCanvasElement.prototype.toDataURL);
    }
  } catch (e) {}

  try {
    // --- Round hardwareConcurrency/deviceMemory to common values ---
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: function () { return 4; } });
  } catch (e) {}
  try {
    if ('deviceMemory' in navigator) {
      Object.defineProperty(navigator, 'deviceMemory', { get: function () { return 8; } });
    }
  } catch (e) {}

  try {
    // --- Report UTC regardless of the real timezone ---
    var RealDTF = Intl.DateTimeFormat;
    var spoofedTZ = 'UTC';
    Intl.DateTimeFormat = function () {
      var args = Array.prototype.slice.call(arguments);
      args[1] = Object.assign({}, args[1], { timeZone: spoofedTZ });
      return RealDTF.apply(this, args);
    };
    Intl.DateTimeFormat.prototype = RealDTF.prototype;
    var origResolved = RealDTF.prototype.resolvedOptions;
    RealDTF.prototype.resolvedOptions = function () {
      var o = origResolved.apply(this, arguments);
      o.timeZone = spoofedTZ;
      return o;
    };
    Date.prototype.getTimezoneOffset = function () { return 0; };
  } catch (e) {}

  try {
    // --- WebGL vendor/renderer spoofing ---
    var wrapGetParameter = function (proto) {
      if (!proto || !proto.getParameter) return;
      var orig = proto.getParameter;
      proto.getParameter = function (param) {
        // UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL from WEBGL_debug_renderer_info
        if (param === 37445) return 'Generic Renderer';
        if (param === 37446) return 'Generic Renderer';
        return orig.apply(this, arguments);
      };
    };
    if (window.WebGLRenderingContext) wrapGetParameter(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) wrapGetParameter(WebGL2RenderingContext.prototype);
  } catch (e) {}

  try {
    // --- Round screen resolution to a common value ---
    var roundTo = function (v, step) { return Math.round(v / step) * step; };
    var rw = roundTo(screen.width, 100), rh = roundTo(screen.height, 100);
    var dims = { width: rw, height: rh, availWidth: rw, availHeight: rh };
    Object.keys(dims).forEach(function (k) {
      try { Object.defineProperty(screen, k, { get: function () { return dims[k]; } }); } catch (e) {}
    });
  } catch (e) {}

  try {
    // --- Strip outgoing referrer ---
    var meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    (document.head || document.documentElement).insertBefore(meta, document.head ? document.head.firstChild : null);
  } catch (e) {}

  try {
    Object.defineProperty(navigator, 'doNotTrack', { get: function () { return '1'; } });
    Object.defineProperty(navigator, 'globalPrivacyControl', { get: function () { return true; } });
  } catch (e) {}

  try {
    navigator.sendBeacon = function () { return false; };
  } catch (e) {}
})();
"#,
        );
    }

    script
}

#[derive(Default)]
struct BlockCounter(Mutex<u32>);

#[tauri::command]
fn report_block_event(
    app: tauri::AppHandle,
    counter: tauri::State<BlockCounter>,
    amount: Option<u32>,
) -> Result<u32, String> {
    let mut n = counter.0.lock().map_err(|e| e.to_string())?;
    *n += amount.unwrap_or(1);
    let total = *n;
    let _ = app.emit("sreon://block-count", total);
    Ok(total)
}

#[derive(Clone, Serialize)]
struct NowPlaying {
    title: Option<String>,
    artist: Option<String>,
    playing: bool,
}

#[tauri::command]
fn report_now_playing(
    app: tauri::AppHandle,
    title: Option<String>,
    artist: Option<String>,
    playing: bool,
) -> Result<(), String> {
    app.emit("sreon://now-playing", NowPlaying { title, artist, playing })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_tab_view(
    window: tauri::Window,
    state: tauri::State<TabViews>,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    ad_block: Option<bool>,
    dark_mode: Option<bool>,
    privacy_mode: Option<bool>,
    proxy_url: Option<String>,
) -> Result<(), String> {
    let mut views = state.0.lock().map_err(|e| e.to_string())?;
    if views.contains_key(&id) {
        return Ok(());
    }
    let ad_block = ad_block.unwrap_or(true);
    let dark_mode = dark_mode.unwrap_or(false);
    let privacy_mode = privacy_mode.unwrap_or(false);
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    let init_script = build_init_script(ad_block, dark_mode, privacy_mode);
    let nav_window = window.clone();
    let mut builder = tauri::webview::WebviewBuilder::new(label_for(&id), WebviewUrl::External(parsed))
        .initialization_script(&init_script)
        // The main window is `"transparent": true` (for the glass UI chrome
        // behind/around tabs). Without an explicit opaque background here,
        // this child webview inherits that transparency, so any page with a
        // plain background just shows the blurred wallpaper through it
        // instead of rendering solid — looked like search results were
        // "blank"/see-through even though the page had actually loaded.
        .background_color(Color(255, 255, 255, 255))
        .on_navigation(move |nav_url| {
            let blocked = ad_block && is_ad_or_tracker(nav_url);
            if blocked {
                if let Some(state) = nav_window.try_state::<BlockCounter>() {
                    if let Ok(mut n) = state.0.lock() {
                        *n += 1;
                        let _ = nav_window.emit("sreon://block-count", *n);
                    }
                }
            }
            !blocked
        });
    // Optional SOCKS5/HTTP proxy — the only thing here that actually changes the IP a site sees.
    if let Some(proxy) = proxy_url.filter(|p| !p.trim().is_empty()) {
        let proxy_parsed = Url::parse(proxy.trim())
            .map_err(|e| format!("Invalid proxy address: {e}"))?;
        builder = builder.proxy_url(proxy_parsed);
    }
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    views.insert(id, webview);
    Ok(())
}

#[tauri::command]
fn navigate_tab_view(state: tauri::State<TabViews>, id: String, url: String) -> Result<(), String> {
    let views = state.0.lock().map_err(|e| e.to_string())?;
    let webview = views.get(&id).ok_or("no such tab view")?;
    let js_url = serde_json::to_string(&url).map_err(|e| e.to_string())?;
    webview
        .eval(&format!("window.location.href = {js_url};"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_tab_bounds(
    state: tauri::State<TabViews>,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let views = state.0.lock().map_err(|e| e.to_string())?;
    let webview = views.get(&id).ok_or("no such tab view")?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn show_tab_view(state: tauri::State<TabViews>, id: String) -> Result<(), String> {
    let views = state.0.lock().map_err(|e| e.to_string())?;
    match views.get(&id) {
        Some(w) => w.show().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
fn hide_tab_view(state: tauri::State<TabViews>, id: String) -> Result<(), String> {
    let views = state.0.lock().map_err(|e| e.to_string())?;
    match views.get(&id) {
        Some(w) => w.hide().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
fn hide_all_tab_views(state: tauri::State<TabViews>) -> Result<(), String> {
    let views = state.0.lock().map_err(|e| e.to_string())?;
    for w in views.values() {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
fn close_tab_view(state: tauri::State<TabViews>, id: String) -> Result<(), String> {
    let mut views = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(w) = views.remove(&id) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn tab_eval(state: tauri::State<TabViews>, id: String, script: String) -> Result<(), String> {
    let views = state.0.lock().map_err(|e| e.to_string())?;
    let webview = views.get(&id).ok_or("no such tab view")?;
    webview.eval(&script).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_in_system_browser(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Refusing to open a non-http(s) URL".into());
    }

    #[cfg(target_os = "macos")]
    {
        // Try Firefox specifically first; fall back to the OS default opener
        // if Firefox isn't installed, so the button never silently fails.
        let firefox = std::process::Command::new("open")
            .args(["-a", "Firefox", &url])
            .spawn();
        if firefox.is_err() {
            std::process::Command::new("open")
                .arg(&url)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(target_os = "windows")]
    {
        let candidates = [
            r"C:\Program Files\Mozilla Firefox\firefox.exe",
            r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
        ];
        let mut launched = false;
        for path in candidates {
            if std::process::Command::new(path).arg(&url).spawn().is_ok() {
                launched = true;
                break;
            }
        }
        if !launched {
            std::process::Command::new("cmd")
                .args(["/C", "start", "", &url])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        let firefox = std::process::Command::new("firefox").arg(&url).spawn();
        if firefox.is_err() {
            std::process::Command::new("xdg-open")
                .arg(&url)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

// Device-local password gate. Only a salted SHA-256 hash is ever written to disk.
#[derive(Serialize, Deserialize)]
struct LockFile {
    salt: String,
    hash: String,
}

fn lock_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("sreon_lock.json"))
}

fn gen_salt() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}-{:x}", nanos, std::process::id())
}

fn hash_password(password: &str, salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b":sreon:");
    hasher.update(password.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[tauri::command]
fn has_app_password(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(lock_file_path(&app)?.exists())
}

#[tauri::command]
fn set_app_password(app: tauri::AppHandle, new_password: String) -> Result<(), String> {
    if new_password.trim().is_empty() {
        return Err("Password cannot be empty".into());
    }
    let salt = gen_salt();
    let hash = hash_password(&new_password, &salt);
    let path = lock_file_path(&app)?;
    let json = serde_json::to_string(&LockFile { salt, hash }).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn verify_app_password(app: tauri::AppHandle, password: String) -> Result<bool, String> {
    let path = lock_file_path(&app)?;
    if !path.exists() {
        return Ok(true);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let data: LockFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(hash_password(&password, &data.salt) == data.hash)
}

#[tauri::command]
fn remove_app_password(app: tauri::AppHandle, password: String) -> Result<(), String> {
    let path = lock_file_path(&app)?;
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let data: LockFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if hash_password(&password, &data.salt) != data.hash {
            return Err("Incorrect password".into());
        }
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn force_reset_app_password(app: tauri::AppHandle) -> Result<(), String> {
    let path = lock_file_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Workspace locks: same salted-SHA-256 scheme as the app lock, one per workspace id.
type WorkspaceLocks = HashMap<String, LockFile>;

fn workspace_locks_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("sreon_workspace_locks.json"))
}

fn read_workspace_locks(app: &tauri::AppHandle) -> Result<WorkspaceLocks, String> {
    let path = workspace_locks_path(app)?;
    if !path.exists() {
        return Ok(WorkspaceLocks::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_workspace_locks(app: &tauri::AppHandle, locks: &WorkspaceLocks) -> Result<(), String> {
    let path = workspace_locks_path(app)?;
    let json = serde_json::to_string(locks).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn has_workspace_password(app: tauri::AppHandle, workspace_id: String) -> Result<bool, String> {
    Ok(read_workspace_locks(&app)?.contains_key(&workspace_id))
}

#[tauri::command]
fn set_workspace_password(
    app: tauri::AppHandle,
    workspace_id: String,
    new_password: String,
) -> Result<(), String> {
    if new_password.trim().is_empty() {
        return Err("Password cannot be empty".into());
    }
    let mut locks = read_workspace_locks(&app)?;
    let salt = gen_salt();
    let hash = hash_password(&new_password, &salt);
    locks.insert(workspace_id, LockFile { salt, hash });
    write_workspace_locks(&app, &locks)
}

#[tauri::command]
fn verify_workspace_password(
    app: tauri::AppHandle,
    workspace_id: String,
    password: String,
) -> Result<bool, String> {
    let locks = read_workspace_locks(&app)?;
    match locks.get(&workspace_id) {
        Some(data) => Ok(hash_password(&password, &data.salt) == data.hash),
        None => Ok(true),
    }
}

#[tauri::command]
fn remove_workspace_password(
    app: tauri::AppHandle,
    workspace_id: String,
    password: String,
) -> Result<(), String> {
    let mut locks = read_workspace_locks(&app)?;
    if let Some(data) = locks.get(&workspace_id) {
        if hash_password(&password, &data.salt) != data.hash {
            return Err("Incorrect password".into());
        }
        locks.remove(&workspace_id);
        write_workspace_locks(&app, &locks)?;
    }
    Ok(())
}

#[tauri::command]
fn force_reset_workspace_password(app: tauri::AppHandle, workspace_id: String) -> Result<(), String> {
    let mut locks = read_workspace_locks(&app)?;
    if locks.remove(&workspace_id).is_some() {
        write_workspace_locks(&app, &locks)?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(TabViews::default())
        .manage(BlockCounter::default())
        .invoke_handler(tauri::generate_handler![
            open_in_system_browser,
            create_tab_view,
            navigate_tab_view,
            set_tab_bounds,
            show_tab_view,
            hide_tab_view,
            hide_all_tab_views,
            close_tab_view,
            tab_eval,
            has_app_password,
            set_app_password,
            verify_app_password,
            remove_app_password,
            force_reset_app_password,
            has_workspace_password,
            set_workspace_password,
            verify_workspace_password,
            remove_workspace_password,
            force_reset_workspace_password,
            report_now_playing,
            report_block_event,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sreon");
}
