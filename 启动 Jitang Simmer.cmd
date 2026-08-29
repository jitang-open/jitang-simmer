@echo off
setlocal

set "ROOT=%~dp0"
set "COLLECTOR=%ROOT%collector\SimmerCollector.exe"
set "TOKEN_SCANNER=%ROOT%collector\simmer-token-scan.exe"
set "CONFIG="

rem Use the same config location resolution order as SimmerCollector.
if defined SIMMER_DATA_DIR set "CONFIG=%SIMMER_DATA_DIR%\config.json"
if defined CONFIG goto :config_ready
if exist "%ROOT%collector\portable.flag" set "CONFIG=%ROOT%collector\data\config.json"
if defined CONFIG goto :config_ready
set "CONFIG=%APPDATA%\SimmerCollector\config.json"

:config_ready
if not exist "%CONFIG%" (
  echo [Jitang Simmer] Collector config was not found: %CONFIG%
  echo [Jitang Simmer] Start the collector once and set the central server address first.
  goto :failed
)

set "SIMMER_LAUNCH_CONFIG=%CONFIG%"
set "DASHBOARD="
for /f "usebackq delims=" %%U in (`powershell.exe -NoProfile -Command "$ErrorActionPreference = 'Stop'; try { $json = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:SIMMER_LAUNCH_CONFIG; $cfg = ConvertFrom-Json -InputObject $json; $url = [string]$cfg.ServerUrl; if ([string]::IsNullOrWhiteSpace($url)) { throw 'ServerUrl is empty' }; $url = $url.Trim().TrimEnd('/'); if ($url.EndsWith('/simmer', [System.StringComparison]::OrdinalIgnoreCase)) { $url = $url.Substring(0, $url.Length - 7) + '/simmer-dashboard/' } else { $url += '/index.html' }; Write-Output $url } catch { exit 1 }"`) do set "DASHBOARD=%%U"

if not defined DASHBOARD (
  echo [Jitang Simmer] Could not derive the dashboard address from: %CONFIG%
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
tasklist /FI "IMAGENAME eq SimmerCollector.exe" /NH | find /I "SimmerCollector.exe" >nul
if errorlevel 1 (
  echo [Jitang Simmer] Starting collector...
  start "" "%COLLECTOR%"
) else (
  echo [Jitang Simmer] Collector is already running.
)

echo [Jitang Simmer] Opening dashboard: %DASHBOARD%
start "" "%DASHBOARD%"
echo [Jitang Simmer] Ready.
exit /b 0

:failed
echo.
pause
exit /b 1
