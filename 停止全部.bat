@echo off
setlocal
title Stop All - DSH + SnowLuma + QQ Bridge
call "%~dp0_node.bat"
if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Set NODE= in paths.bat, or install node on PATH.
  pause
  exit /b 1
)
set "SCRIPT=%~dp0stop-bot.mjs"

echo ============================================================
echo    STOP ALL  -  DSH + SnowLuma + QQ-Bridge
echo ============================================================
echo.
echo    WARNING: this also stops DSH (port 3080).
echo    If you are talking to the Agent right now, that
echo    conversation will be interrupted.
echo.
echo    Restart later with the desktop shortcut:
echo       DeepSeek Suite   (icon: whale)
echo.
set "OK="
set /p "OK=Type y then Enter to confirm (anything else cancels): "
if /i not "%OK%"=="y" (
  echo.
  echo    Cancelled - nothing was stopped.
  echo.
  pause
  exit /b 0
)

echo.
"%NODE_EXE%" "%SCRIPT%" --all --yes

echo.
echo    Done. You can close this window.
pause
