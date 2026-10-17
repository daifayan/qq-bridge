@echo off
REM ============================================================
REM  QQ bot - whitelist manager
REM
REM  Opens the whitelist section of the bridge console in the
REM  default browser. There every friend / group is listed by
REM  NAME with one-click "add to allow / deny" - much faster
REM  than typing 10-digit QQ numbers into a CLI menu.
REM
REM  Keep this file PURE ASCII: cmd.exe parses .bat byte-wise,
REM  and a non-ASCII byte here corrupts the lines after it.
REM
REM  CLI fallback (bridge must be running too):
REM    node whitelist-menu.mjs
REM ============================================================
setlocal
title Whitelist Manager

rem 65001 = UTF-8 so the Chinese printed by Node renders correctly
chcp 65001 >nul

call "%~dp0_node.bat"

if not defined NODE_EXE (
  echo [ERROR] node.exe not found.
  echo         Set NODE= in paths.bat, or install node and add it to PATH.
  pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0scripts\open-whitelist.mjs"

if errorlevel 1 (
  echo.
  pause
)
