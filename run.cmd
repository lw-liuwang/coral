@echo off
setlocal EnableExtensions DisableDelayedExpansion

pushd "%~dp0sys"
if errorlevel 1 (
  echo [coral] Cannot open the sys directory. Keep this script in the project root.
  pause
  exit /b 1
)

call :run
set "coral_exit_code=%errorlevel%"
popd
if not "%coral_exit_code%"=="0" (
  echo [coral] Startup failed. See the error above.
  pause
)
exit /b %coral_exit_code%

:run
if exist "dist\coral.exe" goto start

where go >nul 2>&1
if errorlevel 1 if not defined CORAL_GO (
  echo [coral] Build requires Go 1.26+. Install Go from https://go.dev/dl/ or use a prebuilt coral.exe.
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [coral] Building web assets requires Node.js 22.13+ and npm. The built server runs without Node.js.
  exit /b 1
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [coral] npm is missing. Reinstall Node.js with npm from https://nodejs.org/ and reopen this script.
  exit /b 1
)
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error('[coral] Node.js 22.13+ is required. Install Node.js 24 LTS from https://nodejs.org/'); process.exit(1); }"
if errorlevel 1 exit /b %errorlevel%

where git >nul 2>&1
if errorlevel 1 echo [coral] Git was not found. Install Git for Windows to enable version history.

if not exist "node_modules\" (
  echo [coral] Installing dependencies...
  call npm.cmd ci
  if errorlevel 1 exit /b 1
)

echo [coral] Building...
call npm.cmd run build
if errorlevel 1 exit /b %errorlevel%

:start
echo [coral] Starting Go server. Press Ctrl+C to stop.
dist\coral.exe
exit /b %errorlevel%
