@echo off
REM RadScheduler Widget — one-command build for Windows.
REM
REM What it does:
REM   1. Verifies Node.js is installed (must download from nodejs.org first)
REM   2. Runs `npm install` if node_modules isn't already populated
REM   3. Builds an unsigned .exe installer via electron-builder
REM   4. Opens the dist folder in Explorer
REM
REM Run from inside widget\:
REM   build-win.cmd

setlocal
cd /d "%~dp0"

echo.
echo === RadScheduler widget build (Windows) ===
echo Working dir: %CD%
echo.

REM === 1. Node.js =====================================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS installer from:
  echo   https://nodejs.org/en/download
  echo Then re-run this script.
  exit /b 1
)
node --version
npm --version

REM === 2. npm install ================================================
if not exist "node_modules\electron" (
  echo.
  echo Installing dependencies (one-time ~2 min download)...
  call npm install
  if errorlevel 1 (
    echo npm install failed. See errors above.
    exit /b 1
  )
)

REM === 3. Placeholder icon ===========================================
REM electron-builder needs build\icon.png. If absent, generate a 512x512
REM placeholder PNG using PowerShell (no external libs needed).
if not exist "build\icon.png" (
  echo.
  echo Generating placeholder icon (replace build\icon.png with your real one)...
  if not exist "build" mkdir build
  powershell -NoProfile -Command "$w=512;$h=512;$bm=New-Object System.Drawing.Bitmap $w,$h;$g=[System.Drawing.Graphics]::FromImage($bm);$brush=New-Object System.Drawing.Drawing2D.LinearGradientBrush(([System.Drawing.Point]::new(0,0)),([System.Drawing.Point]::new($w,$h)),([System.Drawing.Color]::FromArgb(15,23,42)),([System.Drawing.Color]::FromArgb(56,189,248)));$g.FillRectangle($brush,0,0,$w,$h);$bm.Save('build\icon.png',[System.Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$bm.Dispose()"
)

REM === 4. Build ======================================================
echo.
echo Building .exe via electron-builder...
call npm run build:win
if errorlevel 1 (
  echo Build failed. See errors above.
  exit /b 1
)

REM === 5. Reveal in Explorer =========================================
echo.
echo === Build complete. Output: ===
dir /b "dist\*.exe" 2>nul
echo.
echo Distribute the installer .exe to physicians. They double-click to
echo install. SmartScreen may warn "unrecognized app" on first launch —
echo click "More info" then "Run anyway" to bypass. Then paste the
echo pairing code in the widget.
explorer dist
