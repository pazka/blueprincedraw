@echo off
rem Starts BlueprinceDraw locally and opens it in the default browser.
rem Same server and security headers as https://excalidraw.hosh.it, bound to this machine only.
rem Keep the address http://localhost:4270 : the board saved in browser storage belongs to it.
cd /d "%~dp0"

if not exist "node_modules" (
  echo Installing dependencies...
  call npm ci --no-audit || goto :fail
)

if not exist "dist\index.html" (
  echo Building...
  call npm run build || goto :fail
)

set APP_HOST=127.0.0.1
set APP_PORT=4270
start "" "http://localhost:4270/"
node server\main.js || goto :fail
goto :eof

:fail
echo.
echo BlueprinceDraw failed to start.
pause
