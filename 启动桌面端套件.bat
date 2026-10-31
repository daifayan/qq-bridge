@echo off
REM ============================================================
REM  Desktop Suite one-click start (2026-10-24)
REM    Desktop DSH runtime (43129) + SnowLuma (5099/3000/3001) + QQ-Bridge (3100)
REM
REM  Use this instead of the old family bucket (which starts DSH Web 3080):
REM  the bridge now points at the desktop harness runtime on 43129.
REM  Run by double-clicking. Services started from an agent session
REM  die when that session ends - this one does not.
REM
REM  Keep this file PURE ASCII: cmd reads .bat byte-wise and a
REM  non-ASCII path here corrupts the rest of the script.
REM ============================================================
setlocal enabledelayedexpansion
title Desktop Suite - One-Click Start

set "HERE=%~dp0"
if exist "%HERE%paths.bat" call "%HERE%paths.bat"
if not defined BRIDGEDIR set "BRIDGEDIR=%HERE%"
if not defined SNOWDIR set "SNOWDIR=%HERE%..\SnowLuma"
if not defined DSHEXE set "DSHEXE=D:\dsh\DSH Desktop\DSH Desktop.exe"

echo ============================================================
echo    Desktop Suite - One-Click Start
echo    Desktop runtime(43129) + SnowLuma(5099/3000/3001) + QQ-Bridge(3100)
echo ============================================================
echo.
echo    QQ must be running and logged in: SnowLuma attaches to QQ.
echo    If QQ is closed, step 0 below tries to start it (paths.bat QQEXE).
echo.

REM ---- 0) QQ client -----------------------------------------------
REM  SnowLuma can only attach to a running, logged-in QQ. Without this
REM  step a cold boot ends in "OneBot did not answer" 60 seconds later,
REM  and the real cause (QQ was never started) is easy to miss.
REM  Skipped silently when QQEXE is empty in paths.bat.
set "NODE_EXE=%NODE%"
if not defined NODE_EXE set "NODE_EXE=node"
echo [1/4] QQ client   : checking...
"%NODE_EXE%" "%BRIDGEDIR%\scripts\ensure-qq.mjs" --wait 40
if errorlevel 1 (
  echo       [WARN] QQ could not be started automatically.
  echo              Open QQ yourself and log in, then run this script again.
) else (
  echo       QQ is up. If it shows a QR code, finish logging in now.
)
echo.

REM ---- 1) DSH Desktop app (prefers 43129) -----------------------
tasklist /FI "IMAGENAME eq DSH Desktop.exe" 2>nul | findstr /I "DSH Desktop.exe" >nul
if !errorlevel!==0 (
  echo [2/4] DSH Desktop : already running - skipped
  netstat -ano | findstr ":43129 " | findstr "LISTENING" >nul 2>&1
  if !errorlevel! neq 0 (
    echo       [WARN] DSH Desktop is running but 43129 is not listening.
    echo              It may be on a temporary port. Close DSH Desktop and run this again.
  )
) else (
  netstat -ano | findstr ":43129 " | findstr "LISTENING" >nul 2>&1
  if !errorlevel!==0 (
    echo [2/4] DSH Desktop : port 43129 is already in use - desktop app not started.
    echo       Close the process using 43129, then run this again.
    echo       Starting the desktop app now would put it on a temporary port.
  ) else (
    if exist "%DSHEXE%" (
      echo [2/4] DSH Desktop : starting desktop app...
      start "" "%DSHEXE%"
    ) else if exist "%BRIDGEDIR%\start-desktop-runtime.bat" (
      echo [2/4] DSH Desktop : executable not found, using CLI runtime fallback...
      start "DSH Desktop Runtime" "%BRIDGEDIR%\start-desktop-runtime.bat"
    ) else (
      echo       [ERROR] neither DSH Desktop nor start-desktop-runtime.bat found
    )
  )
)

REM ---- 2) SnowLuma -----------------------------------------------
netstat -ano | findstr ":5099 " | findstr "LISTENING" >nul 2>&1
if !errorlevel!==0 (
  echo [3/4] SnowLuma    : already running on 5099 - skipped
) else (
  echo [3/4] SnowLuma    : starting...
  if exist "%BRIDGEDIR%\start-snowluma.bat" (
    start "SnowLuma" /min "%BRIDGEDIR%\start-snowluma.bat"
  ) else (
    echo       [ERROR] start-snowluma.bat missing in %BRIDGEDIR%
  )
)

echo.
echo       waiting for the OneBot HTTP API on 3000 ...
set "ONEBOT=0"
set "BOTUIN=3838778152"
REM Token is read from config.json at runtime - never hardcode secrets in a
REM committed file (config.json itself is gitignored).
set "BOTTOKEN="
for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "try{(ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText('%BRIDGEDIR%\config.json',[System.Text.Encoding]::UTF8))).snowluma.accessToken}catch{''}"`) do set "BOTTOKEN=%%t"
if not defined BOTTOKEN echo       [WARN] snowluma.accessToken not found in config.json - OneBot check will likely fail
for /l %%i in (1,1,30) do (
  if !ONEBOT!==0 (
    curl.exe -s -m 3 -X POST -H "content-type: application/json" -H "Authorization: Bearer !BOTTOKEN!" -d "{}" http://127.0.0.1:3000/get_login_info > "%TEMP%\dsh-onebot-check.json" 2>nul
    findstr /c:"!BOTUIN!" "%TEMP%\dsh-onebot-check.json" >nul 2>&1
    if !errorlevel!==0 (
      set "ONEBOT=1"
    ) else (
      ping -n 3 127.0.0.1 >nul 2>&1
    )
  )
)
if !ONEBOT!==1 (
  echo       OneBot is UP and verified as the bot account !BOTUIN!
) else (
  echo       *** OneBot did NOT answer as the bot account after ~60s.
  echo           Check QQ login and SnowLuma OneBot config.
)

REM ---- 3) QQ-Bridge ----------------------------------------------
netstat -ano | findstr ":3100 " | findstr "LISTENING" >nul 2>&1
if !errorlevel!==0 (
  echo [4/4] QQ-Bridge   : already running on 3100 - skipped
) else (
  echo [4/4] QQ-Bridge   : starting... daemon, auto-restarts on crash
  if exist "%BRIDGEDIR%\start.bat" (
    start "qq-bridge" /min "%BRIDGEDIR%\start.bat"
  ) else (
    echo       [ERROR] start.bat missing in %BRIDGEDIR%
  )
)

echo.
echo ============================================================
echo    Done.
echo ============================================================
ping -n 7 127.0.0.1 >nul 2>&1
REM Open the console with its current token; the bare root URL returns 401.
if defined NODE if exist "F:\ai\tools\bridge-open.mjs" (
  start "QQ Bridge Console" /min "%NODE%" "F:\ai\tools\bridge-open.mjs"
) else (
  start "" "http://127.0.0.1:3100/"
)

echo    DSH Desktop      43129  (desktop app + web page share it)
echo    QQ-Bridge console  http://127.0.0.1:3100/
echo    SnowLuma WebUI     http://127.0.0.1:5099/
echo.
echo    You can close THIS window; the services keep running.
echo.
