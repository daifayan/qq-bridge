@echo off
title Stop Bot Services
call "%~dp0_node.bat"
if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Set NODE= in paths.bat, or install node on PATH.
  pause
  exit /b 1
)
"%NODE_EXE%" "%~dp0stop-bot.mjs"
if errorlevel 1 (
  echo.
  echo Script reported a problem.
  pause
)
