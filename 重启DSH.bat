@echo off
rem ============================================================
rem  Restart ONLY the DSH web process (port 3080).
rem  SnowLuma (3000/3001/5099) and qq-bridge (3100) are NOT touched.
rem
rem  Why this script exists:
rem  DSH is started through dsh-launcher.lnk -> start-dsh.mjs web.
rem  That wrapper exits as soon as dsh exits, so nothing brings DSH
rem  back on its own - it must be started again from outside.
rem
rem  Keep this file PURE ASCII: cmd reads .bat byte-wise and a
rem  non-ASCII byte anywhere corrupts the rest of the script.
rem ============================================================
setlocal
rem ---- paths come from paths.bat; node resolution from _node.bat ----
call "%~dp0_node.bat"
if not defined BRIDGEDIR set "BRIDGEDIR=%~dp0"
if not defined DSHLNK set "DSHLNK=%BRIDGEDIR%dsh-launcher.lnk"

echo ============================================================
echo    Restarting DSH web (3080) only
echo ============================================================
echo.

echo [1/3] Stopping DSH ...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*@deepseek-ai\dsh\lib\bin.js*' -or $_.CommandLine -like '*start-dsh.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

rem wait until 3080 is actually free (max ~20s)
for /l %%i in (1,1,20) do (
  netstat -ano | findstr ":3080 " | findstr "LISTENING" >nul 2>&1
  if errorlevel 1 goto :freed
  ping -n 2 127.0.0.1 >nul 2>&1
)
:freed

echo [2/3] Starting DSH ...
if exist "%DSHLNK%" (
  start "DeepSeek Harness" "%DSHLNK%"
) else (
  echo       [ERROR] launcher shortcut missing: %DSHLNK%
  echo       Please run the all-in-one launcher in %BRIDGEDIR% instead
  goto :end
)

echo [3/3] Waiting for 3080 to answer ...
for /l %%i in (1,1,45) do (
  netstat -ano | findstr ":3080 " | findstr "LISTENING" >nul 2>&1
  if not errorlevel 1 goto :up
  ping -n 2 127.0.0.1 >nul 2>&1
)

echo.
echo       [warn] 3080 still not listening. Check the window titled
echo              "DeepSeek Harness" for an error message.
goto :end

:up
echo.
echo ============================================================
echo    DSH is back up:  http://127.0.0.1:3080/
echo ============================================================
rem Open the page WITH the fresh token: the token is regenerated on every start
rem and otherwise only appears in the "DeepSeek Harness" console window.
if defined DSHOPEN if exist "%DSHOPEN%" (
  "%NODE_EXE%" "%DSHOPEN%"
) else (
  start "" "http://127.0.0.1:3080/"
)

:end
echo.
pause
