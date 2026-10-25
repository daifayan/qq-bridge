@echo off
rem ============================================================
rem  Restart ONLY the DSH Desktop app (port 43129).
rem  SnowLuma (3000/3001/5099) and qq-bridge (3100) are NOT
rem  touched - the bridge polls DSH every 5s and reconnects
rem  (and re-discovers the fresh launch token) on its own.
rem
rem  WARNING: if an Agent conversation is running through DSH
rem  right now, it will be interrupted. That is expected.
rem
rem  History: this script used to target the retired CLI runtime
rem  (node bin.js web on port 3080, started via dsh-launcher.lnk).
rem  Since 2026-10-25 the DSH Desktop app owns 43129, so the whole
rem  stop/start/wait chain was rewritten for the desktop topology.
rem
rem  Keep this file PURE ASCII: cmd reads .bat byte-wise and a
rem  non-ASCII byte anywhere corrupts the rest of the script.
rem ============================================================
setlocal
rem ---- paths come from paths.bat; node resolution from _node.bat ----
call "%~dp0_node.bat"
if not defined BRIDGEDIR set "BRIDGEDIR=%~dp0"
if not defined DSHOPEN set "DSHOPEN=F:\ai\tools\dsh-open.mjs"
if not defined DSHEXE set "DSHEXE=D:\dsh\DSH Desktop\DSH Desktop.exe"
set "DSHLNK=%USERPROFILE%\Desktop\DSH Desktop.lnk"

echo ============================================================
echo    Restarting DSH Desktop app (43129) only
echo    SnowLuma + QQ-Bridge are left running
echo ============================================================
echo.

echo [1/4] Stopping DSH (desktop app tree + CLI runtime fallback)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='DSH Desktop.exe'\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*@deepseek-ai\dsh\lib\bin.js*' -or $_.CommandLine -like '*start-desktop-runtime*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

rem wait until 43129 is actually free (max ~20s)
for /l %%i in (1,1,20) do (
  netstat -ano | findstr ":43129 " | findstr "LISTENING" >nul 2>&1
  if errorlevel 1 goto :freed
  ping -n 2 127.0.0.1 >nul 2>&1
)
:freed

echo [2/4] Starting DSH Desktop ...
if exist "%DSHLNK%" (
  start "" "%DSHLNK%"
) else if exist "%DSHEXE%" (
  start "" "%DSHEXE%"
) else (
  echo       [ERROR] neither of these was found:
  echo              %DSHLNK%
  echo              %DSHEXE%
  goto :end
)

echo [3/4] Waiting for 43129 to answer ...
for /l %%i in (1,1,60) do (
  netstat -ano | findstr ":43129 " | findstr "LISTENING" >nul 2>&1
  if not errorlevel 1 goto :up
  ping -n 2 127.0.0.1 >nul 2>&1
)

echo.
echo       [warn] 43129 still not listening after ~2 minutes.
echo              The desktop app may need a manual double-click,
echo              or it got stuck on a temporary port - close it
echo              completely and run this script again.
goto :end

:up
echo.
echo ============================================================
echo    DSH Desktop is back up:  http://127.0.0.1:43129/
echo ============================================================
rem Open the page WITH the fresh token: the token is regenerated
rem on every start and otherwise only lands in the harness log.
if defined NODE_EXE if exist "%DSHOPEN%" (
  "%NODE_EXE%" "%DSHOPEN%"
) else (
  start "" "http://127.0.0.1:43129/"
)

:end
echo.
echo    SnowLuma + QQ-Bridge were left running; the bridge
echo    reconnects to DSH within about 5 seconds.
echo.
pause
