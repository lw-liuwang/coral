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
where node >nul 2>&1
if errorlevel 1 (
  echo [coral] Node.js 22.13+ and npm are required. Install Node.js 24 LTS from https://nodejs.org/ and reopen this script.
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

echo [coral] Starting server. Press Ctrl+C to stop.
node dist/server.js
exit /b %errorlevel%
