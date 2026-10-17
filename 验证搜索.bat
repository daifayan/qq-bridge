@echo off
title Verify Web Search Fix
call "%~dp0_node.bat"
if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Set NODE= in paths.bat, or install node on PATH.
  pause
  exit /b 1
)
"%NODE_EXE%" "%~dp0verify-search.mjs"
if errorlevel 1 (
  echo.
  echo Script exited with an error.
  pause
)
