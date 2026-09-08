# Sreon

Sreon is a small, privacy-focused desktop web browser you build and run on
your own computer. Frosted-glass look, real tabs, a command menu (⌘K),
an app lock, built-in ad/tracker blocking, and a fully customizable
theme — including using your own photo or video as the background.

## What's new in this version

- **Fixed: "Set a password" doing nothing.** Both the workspace
  passwords (Personal/Work) and the general Sreon lock password used
  `window.prompt()` for input — which Tauri's macOS webview doesn't
  reliably support, so clicking those buttons silently did nothing at
  all. All password entry now goes through Sreon's own glass-styled
  dialog, which always renders.
- **Fixed: a failed page load leaving the tab permanently blank with
  no error.** If opening a tab failed for any reason, Sreon used to mark
  it as "loaded" anyway (so switching back to it never retried) and
  only showed an error if you'd set a proxy — otherwise it failed
  completely silently, leaving the content area blank. Now every
  failure shows a real message and the tab stays retryable.
- **Google is the default search engine.** Switch to DuckDuckGo
  ("Sreon") or Bing any time in Settings > General.
- **Test ad blocker.** A one-click, fully local test page in
  Settings > Privacy & Security that checks the popup blocker, the
  ad-container hider, and notification blocking live in a real tab —
  no network request involved.
- **Fixed:** setting, changing, or removing a workspace (Personal/
  Work) password could make that workspace's saved logins,
  bookmarks, and history unreadable, because the existing data
  stayed encrypted under the old key while Sreon started asking for
  the new one. Sreon now re-encrypts a workspace's data to the new key
  the moment its password changes, so nothing is orphaned.
- **Fixed:** switching workspaces right after launch, before Sreon had
  finished checking whether that workspace had a password, could skip
  the password prompt entirely. It now always checks live instead of
  trusting a cache that might not have loaded yet.
- **Fixed a real performance bug:** Sreon's on-page branding used to
  create a brand-new page-wide `MutationObserver` every 1.2 seconds on
  every tab, without ever removing the old ones — the longer a tab
  stayed open, the more piled up, each one scanning the whole page on
  every change. That's fixed; the observer is now created once per
  page load.
- **A loading progress bar**, a "Use Tor" quick-fill for the proxy
  field, and nicer empty states for saved logins/history/bookmarks.
- **App lock.** Set a password (optional) that gates the whole app on
  launch. Salted + hashed locally — see PRIVACY.txt.
- **Ad & tracker blocking**, on by default. Blocks a local list of known
  ad/analytics/tracker domains before they load, and hides common
  leftover ad boxes. No network calls involved in checking the list —
  it ships inside the app.
- **No notifications.** Sreon never shows an OS/in-app notification, and
  it silently denies every website's notification-permission request.
- **Photo/video backgrounds.** Settings > Background lets you use a
  solid frosted-glass look (default), or your own photo or video as the
  actual browser background, with adjustable darkening and blur for
  readability.
- **Deep customization**, all in Settings: accent color (presets, a
  custom picker, or auto-derived from a photo), glass blur/opacity,
  corner radius, search engine, homepage, reduce-motion, saved logins,
  history, and more.
- **One-click start.** Double-click `Start Sreon (Mac or Linux).command`
  or `Start Sreon (Windows).bat` instead of typing terminal commands.
- **PRIVACY.txt** in this folder — a plain-language account of exactly
  what Sreon stores, where, and what it blocks.

- **Lock screen & dashboard widgets.** The lock screen (Aurora/Midnight/
  Sunset/accent-matched themes, pick one in Settings) and the start-page
  dashboard (uses your accent theme) both now show a live clock, local
  weather (via keyless Open-Meteo, using your device's own location), a
  now-playing card, and basic device info, with staggered fade/float-in
  animations. All cosmetic widgets, all client-side.



## What makes Sreon different

Most simple browser projects fake their tabs using an `<iframe>`. Big
sites like Google **block** iframes on purpose, as a security rule, so
a fake browser like that shows an error instead of the real page.

Sreon doesn't do that. Every tab in Sreon is a **real, separate browser
window** stacked on top of the app, the same way Chrome or Safari does
it. Real websites load the normal way — nothing gets blocked.

## Before you run it

You need two free programs installed once, ever:

1. **Node.js** — https://nodejs.org (pick the LTS version)
2. **Rust** — https://rustup.rs

Then just double-click:

- **Mac or Linux:** `Start Sreon (Mac or Linux).command`
  (first time, macOS may say "unidentified developer" — right-click it
  and choose **Open** once to allow it)
- **Windows:** `Start Sreon (Windows).bat`

That script installs the app's dependencies the first time only, then
launches Sreon. No terminal typing needed. The very first launch also
compiles some Rust code, which can take a few minutes — that's normal.

An app icon is already included, so you don't need any icon-generation
step either. When you want a real double-click-to-open installed app
(instead of running the script every time), see "Building an installer"
below.

## What's inside this folder

```
Sreon-Browser/
├── README.md                        <- you are here
├── PRIVACY.txt                      <- plain-language privacy report
├── Start Sreon (Mac or Linux).command <- double-click to run, no Terminal typing
├── Start Sreon (Windows).bat          <- same, for Windows
└── app/                             <- the actual app code
    ├── package.json                  tells npm how to start/build the app
    ├── src/                          everything you SEE (the UI)
    │   ├── index.html                 layout: sidebar, tabs, toolbar, lock screen
    │   ├── css/
    │   │   ├── glass.css               color/design tokens, the glass look
    │   │   └── app.css                 layout, animations, lock screen, background
    │   └── js/
    │       ├── app.js                  tabs, navigation, ⌘K menu, boot sequence
    │       ├── settings.js             settings screen, theme, ad-block, background
    │       └── lock.js                 the app-lock password screen
    └── src-tauri/                    the Rust side — makes it a real desktop app
        ├── src/main.rs                 tabs-as-real-windows, ad-block, app lock
        ├── icons/                      pre-generated app icon (all platforms)
        ├── Cargo.toml, build.rs, tauri.conf.json
```

## Building an installer (optional)

When you want a finished app you can double-click to open (instead of
running the start script every time):

```
cd app
npm run build
```

This creates the finished, installable app inside:
`app/src-tauri/target/release/bundle/`

## Good to know

- Building a Tauri/Rust desktop app always requires a one-time compile
  on the machine you're building it on — there's no way around that for
  any app in this category, on any platform. The start script above is
  the closest thing to "no commands": one double-click, and it handles
  the rest.
- Ad/tracker blocking and the app lock are both entirely local — see
  PRIVACY.txt for the full rundown of what's stored and where.
