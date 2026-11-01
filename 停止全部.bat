@echo off
setlocal
title Stop All - DSH Desktop + SnowLuma + QQ Bridge
call "%~dp0_node.bat"
if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Set NODE= in paths.bat, or install node on PATH.
  ping -n 9 127.0.0.1 >nul
  exit /b 1
)
set "SCRIPT=%~dp0stop-bot.mjs"

echo ============================================================
echo    STOP ALL  -  DSH Desktop + SnowLuma + QQ-Bridge
echo ============================================================
echo.
echo    WARNING: this also stops the DSH Desktop app (port 43129).
echo    If you are talking to the Agent right now, that
echo    conversation will be interrupted.
echo.
echo    Restart later with the desktop shortcut:
echo       DSH Desktop.lnk   or   Panel.lnk -^> choose 1
echo.
rem ------------------------------------------------------------
rem  Two-step confirm, NO keyboard input required.
rem    double-click once                -> arms (nothing stops)
rem    double-click again within 60s    -> really stops
rem  Reason: cmd windows on remote desktop / phone may not receive
rem  typed keys at all, so set /p and choice can hang forever.
rem ------------------------------------------------------------
"%NODE_EXE%" "%~dp0scripts\stop-confirm.mjs"
if errorlevel 1 (
  echo.
  echo    NOT stopped. Double-click this file AGAIN within 60 seconds to confirm.
  echo.
  ping -n 9 127.0.0.1 >nul
  exit /b 0
)

echo.
"%NODE_EXE%" "%SCRIPT%" --all --yes

echo.
echo    Done. You can close this window.
ping -n 9 127.0.0.1 >nul
