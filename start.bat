@echo off
chcp 65001 >nul
setlocal
title qq-bridge (daemon)

rem ============================================================
rem  qq-bridge daemon launcher
rem
rem  - ALL paths come from paths.bat. Edit that file, not this one.
rem  - node.exe is resolved in this order:
rem      paths.bat NODE  ->  `node` on PATH  ->  bundled sandbox runtime
rem    (a bare `node` is not on PATH in this deployment, which is why
rem     the bridge used to fail silently when launched from elsewhere)
rem  - mirrors stdout/stderr into LOGDIR so crashes leave evidence.
rem  - restarts the bridge 5s after an unexpected exit.
rem  - exit code 2 means "another instance is already running"
rem    (the bridge's single-instance lock) - stop here.
rem
rem  Keep this file PURE ASCII: cmd reads .bat byte-wise.
rem ============================================================

set "HERE=%~dp0"
if exist "%HERE%paths.bat" call "%HERE%paths.bat"

rem Resolve node: configured path first, then PATH, then bundled runtime.
set "NODE_EXE="
if defined NODE if exist "%NODE%" set "NODE_EXE=%NODE%"
if not defined NODE_EXE (
  where node >nul 2>&1
  if not errorlevel 1 set "NODE_EXE=node"
)
if not defined NODE_EXE (
  echo [ERROR] node.exe not found.
  echo   Set NODE=^<absolute path to node.exe^> in paths.bat,
  echo   or install Node.js ^(>=22.13^) so `where node` succeeds.
  pause
  exit /b 1
)

if not defined LOGDIR set "LOGDIR=%HERE%..\bridge-logs"
cd /d "%HERE%"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

:loop
"%NODE_EXE%" src\bridge.js >> "%LOGDIR%\bridge.out.log" 2>> "%LOGDIR%\bridge.err.log"
set "code=%errorlevel%"

if "%code%"=="2" (
  echo [%date% %time%] bridge already running in another window. Exiting.
  pause
  exit /b 2
)

echo [%date% %time%] bridge exited ^(code %code%^), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
