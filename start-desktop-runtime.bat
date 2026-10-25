@echo off
rem Start the DSH Desktop runtime on port 43129.
rem DSH_HOME points at the dsh-desktop harness profile.
rem Keep this file PURE ASCII: cmd reads .bat byte-wise.

setlocal
cd /d "%~dp0"
if exist "%~dp0paths.bat" call "%~dp0paths.bat"

set "NODE_EXE="
if defined NODE if exist "%NODE%" set "NODE_EXE=%NODE%"
if not defined NODE_EXE (
  where node >nul 2>&1
  if not errorlevel 1 set "NODE_EXE=node"
)
if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Set NODE in paths.bat or install Node.js.
  pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0start-desktop-runtime.mjs"
