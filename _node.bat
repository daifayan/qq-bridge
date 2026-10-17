@echo off
REM ============================================================
REM  Shared helper: resolve node.exe into %NODE_EXE%.
REM
REM  Called by the other launchers as:  call "%~dp0_node.bat"
REM  Do NOT setlocal here - the caller needs NODE_EXE to survive.
REM
REM  Resolution order:
REM    1. NODE from paths.bat (if the file actually exists)
REM    2. `node` found on PATH
REM    3. bundled sandbox runtime (last resort, current machine only)
REM
REM  Keep this file PURE ASCII: cmd reads .bat byte-wise.
REM ============================================================

if exist "%~dp0paths.bat" call "%~dp0paths.bat"

set "NODE_EXE="
if defined NODE if exist "%NODE%" set "NODE_EXE=%NODE%"
if not defined NODE_EXE (
  where node >nul 2>&1
  if not errorlevel 1 set "NODE_EXE=node"
)
if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Set NODE= in paths.bat, or install Node.js on PATH.
  exit /b 1
)
