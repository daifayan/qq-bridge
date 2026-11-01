@echo off
title Restore - SnowLuma + QQ Bridge
setlocal
rem ============================================================
rem  Silent recovery: start SnowLuma and the QQ bridge, no prompts.
rem  Double-click this file when the bot is down. Nothing to type.
rem  Keep this file PURE ASCII.
rem ============================================================

set "HERE=%~dp0"
if exist "%HERE%paths.bat" call "%HERE%paths.bat"

echo ============================================================
echo    Restore: SnowLuma + QQ Bridge
echo ============================================================
echo.

echo [1/2] Starting SnowLuma (new window)...
start "SnowLuma" "%HERE%start-snowluma.bat"

echo       Waiting 6 seconds for OneBot ports 3000/3001...
ping -n 7 127.0.0.1 >nul

echo [2/2] Starting QQ bridge (new window)...
start "qq-bridge" "%HERE%start.bat"

echo.
echo Both windows are launched. Keep them open.
echo   SnowLuma : http://127.0.0.1:5099
echo   Console  : http://127.0.0.1:3100
echo.
ping -n 6 127.0.0.1 >nul
