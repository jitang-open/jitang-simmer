@echo off
setlocal

set "ROOT=%~dp0"
set "NODE22=C:\Users\jitang\.local\nodejs\node.exe"
set "SERVER=%ROOT%server\index.js"
set "COLLECTOR=%ROOT%collector\SimmerCollector.exe"
set "DASHBOARD=http://127.0.0.1:8788/index.html"

if not exist "%NODE22%" (
  echo [Jitang Simmer] Node.js 22 was not found:
  echo %NODE22%
  goto :failed
)

if not exist "%ROOT%server\node_modules\better-sqlite3" (
  echo [Jitang Simmer] Server dependencies are missing. Run npm install in server first.
  goto :failed
)

if not exist "%SERVER%" (
  echo [Jitang Simmer] Server entry was not found: %SERVER%
  goto :failed
)

if not exist "%COLLECTOR%" (
  echo [Jitang Simmer] Collector was not found: %COLLECTOR%
  goto :failed
)

call :check_server
if errorlevel 1 (
  echo [Jitang Simmer] Starting server...
  start "Jitang Simmer Server" /min "%NODE22%" "%SERVER%"
)

set "SERVER_READY="
for /l %%I in (1,1,20) do (
  call :check_server
  if not errorlevel 1 (
    set "SERVER_READY=1"
    goto :server_ready
  )
  powershell.exe -NoProfile -Command "Start-Sleep -Seconds 1" >nul
)

echo [Jitang Simmer] Server did not respond within 20 seconds.
goto :failed

:server_ready
tasklist /FI "IMAGENAME eq SimmerCollector.exe" /NH | find /I "SimmerCollector.exe" >nul
if errorlevel 1 (
  echo [Jitang Simmer] Starting collector...
  start "" "%COLLECTOR%"
) else (
  echo [Jitang Simmer] Collector is already running.
)

echo [Jitang Simmer] Opening dashboard...
start "" "%DASHBOARD%"
echo [Jitang Simmer] Ready.
exit /b 0

:check_server
powershell.exe -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -Uri '%DASHBOARD%' -TimeoutSec 1; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
exit /b %errorlevel%

:failed
echo.
pause
exit /b 1
