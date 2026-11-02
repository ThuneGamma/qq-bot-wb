@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Use the node.exe shipped with this release (v24.22.1) instead of whatever
rem "node" happens to be first on PATH. check-node-version.cjs requires
rem ^24.22.1 || >=26.12.1, while a normal machine PATH often carries Node 22
rem (nvm / WorkBuddy managed runtime), which makes this script exit at once.
if exist "%~dp0node.exe" set "PATH=%~dp0;%PATH%"

node .\check-node-version.cjs
if errorlevel 1 (
  echo.
  echo [launcher] Node version check failed. Expected 24.22.1 or newer.
  echo [launcher] Fallback: "%~dp0node.exe" ./index.mjs
  pause
  exit /b 1
)
node ./index.mjs
pause
