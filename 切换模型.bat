@echo off
chcp 65001 >nul
setlocal
title QQ Bot Model Switch
rem ============================================================
rem  One-click model switch for the QQ bot:
rem  Zhipu GLM (subscription quota) <-> DeepSeek (pay-per-token)
rem
rem  - Pure ASCII on purpose: cmd parses .bat byte-wise (see
rem   handover doc, pitfall #1). Chinese UI lives in the .mjs.
rem  - node.exe comes from paths.bat / PATH / bundled runtime (_node.bat).
rem ============================================================
call "%~dp0_node.bat"
if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Set NODE= in paths.bat, or install node on PATH.
  pause
  exit /b 1
)
cd /d "%~dp0"
"%NODE_EXE%" scripts\switch-model.mjs %*
echo.
pause
