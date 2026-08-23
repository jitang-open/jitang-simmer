@echo off
setlocal

set "ROOT=%~dp0"
set "NODE24=node.exe"
set "SERVER=%ROOT%server\index.js"
set "COLLECTOR=%ROOT%collector\SimmerCollector.exe"
set "TOKEN_SCANNER=%ROOT%collector\simmer-token-scan.exe"
set "DASHBOARD=http://127.0.0.1:8788/index.html"

where "%NODE24%" >nul 2>&1
if errorlevel 1 (
  echo [Jitang Simmer] Node.js 24 was not found in PATH.
  goto :failed
)

"%NODE24%" --version | findstr /B /C:"v24." >nul
if errorlevel 1 (
  echo [Jitang Simmer] Node.js 24 is required. Current version:
  "%NODE24%" --version
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

if not exist "%TOKEN_SCANNER%" (
  echo [Jitang Simmer] Warning: AI Token scanner was not found.
  echo [Jitang Simmer] Software time collection will still start; run collector\build.ps1 to enable Token Statistics.
)

call :check_server
if errorlevel 1 (
  echo [Jitang Simmer] Starting server...
  start "Jitang Simmer Server" /min "%NODE24%" "%SERVER%"
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
