@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0app"

echo ==========================================
echo   Sreon - starting up
echo ==========================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js isn't installed yet. Opening the download page...
  echo Install it, then double-click this file again.
  start https://nodejs.org
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo.
  echo Rust isn't installed yet. Opening the install page...
  echo Install it, then double-click this file again.
  start https://rustup.rs
  pause
  exit /b 1
)

set "PLATFORM_TAG=Windows-%PROCESSOR_ARCHITECTURE%"
set "MARKER=node_modules\.sreon-platform"
set "OLD_TAG="

if exist "node_modules" (
  if exist "%MARKER%" (
    set /p OLD_TAG=<"%MARKER%"
  )
  if not "!OLD_TAG!"=="!PLATFORM_TAG!" (
    echo This app folder's dependencies were installed for a different
    echo computer - clearing them out so they get reinstalled here.
    rmdir /s /q node_modules
  )
)

if exist "node_modules" (
  if not exist "node_modules\@tauri-apps\cli\main.js" (
    echo A previous install looks incomplete or corrupted - reinstalling...
    rmdir /s /q node_modules
    if exist package-lock.json del /q package-lock.json
  )
)

if not exist "node_modules" (
  echo.
  echo First-time setup needs to download some things before Sreon can run:
  echo   - npm packages (the Tauri CLI + JS tooling)  ~ 250-350 MB download
  echo   - Rust crates + a native build              ~ 300-600 MB download,
  echo                                                  ~1.5-2.5 GB once built
  echo   Total: roughly 600 MB-1 GB downloaded, ~2-3 GB of disk space used.
  echo   (Exact numbers vary by OS/CPU - this only happens once.)
  echo.
  set /p CONFIRM="Continue and download now? [Y/n] "
  if /i "!CONFIRM!"=="n" (
    echo Setup cancelled - nothing was downloaded. Run this again anytime.
    pause
    exit /b 0
  )
  echo Installing the app's building blocks...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. See the messages above for details.
    pause
    exit /b 1
  )
  echo !PLATFORM_TAG!>"%MARKER%"
)

echo.
echo Launching Sreon. The very first launch compiles some Rust code and
echo can take a few minutes - this window will show the progress.
echo Every launch after this one is much faster.
echo.

call npm run dev

echo.
echo Sreon closed.
pause
