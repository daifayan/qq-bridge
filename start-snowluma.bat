@echo off
REM ============================================================
REM  SnowLuma launcher (owned wrapper).
REM
REM  Why this exists instead of SnowLuma's launcher.bat directly:
REM  launcher.bat uses RELATIVE paths (".\check-node-version.cjs",
REM  ".\index.mjs") and a bare `node`. In cmd.exe a bare `node`
REM  resolves via the CURRENT DIRECTORY first, so launcher.bat only
REM  works when the cwd is already the SnowLuma install dir (that is
REM  where SnowLuma ships its own node.exe, v22.13.0).
REM
REM  Launched from anywhere else - e.g. `start /min launcher.bat`
REM  from the suite launcher, whose cwd is the bridge project dir -
REM  the bare `node` is not found, errorlevel 1 fires, and the window
REM  just sits at `pause`. SnowLuma silently never starts, and the only
REM  symptom is "QQ messages get no reply".
REM
REM  This wrapper pins the cwd and uses an absolute node.exe, so the
REM  cwd of whoever launched it no longer matters.
REM
REM  Keep this file pure ASCII: cmd.exe parses .bat byte-wise, and a
REM  non-ASCII byte here corrupts parsing of the following lines.
REM ============================================================
title SnowLuma
setlocal

rem ---- paths come from paths.bat (single source of truth) ----
set "HERE=%~dp0"
if exist "%HERE%paths.bat" call "%HERE%paths.bat"
if not defined SNOWDIR set "SNOWDIR=%HERE%..\SnowLuma"

cd /d "%SNOWDIR%"
if errorlevel 1 (
  echo [ERROR] cannot cd into %SNOWDIR%
  echo         set SNOWDIR= in paths.bat
  pause
  exit /b 1
)

REM SnowLuma ships its own tested runtime; do not borrow DSH's node.
set "SL_NODE=%SNOWDIR%\node.exe"

if not exist "%SL_NODE%" (
  echo [ERROR] SnowLuma node.exe not found:
  echo         %SL_NODE%
  pause
  exit /b 1
)

echo ============================================================
echo    SnowLuma
echo    node: %SL_NODE%
echo    WebUI 5099   OneBot HTTP 3000   OneBot WS 3001
echo    Keep this window open. Closing it stops SnowLuma.
echo ============================================================
echo.

"%SL_NODE%" ".\check-node-version.cjs"
if errorlevel 1 (
  echo.
  echo [ERROR] this Node version is not supported by SnowLuma.
  pause
  exit /b 1
)

"%SL_NODE%" ".\index.mjs"

echo.
echo SnowLuma exited (code %errorlevel%).
pause
