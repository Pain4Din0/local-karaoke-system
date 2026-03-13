@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

title Local Karaoke System Launcher
color 07

set "BOOTSTRAP_STATE=.bootstrap\bootstrap_state.cmd"
set "BOOTSTRAP_NODE_EXE="
set "FAIL_STAGE=bootstrap"
if exist "%BOOTSTRAP_STATE%" del /f /q "%BOOTSTRAP_STATE%" >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\bootstrap\start.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if "%START_NO_LAUNCH%"=="1" exit /b %EXIT_CODE%

if "%EXIT_CODE%"=="0" (
    if not exist "%BOOTSTRAP_STATE%" (
        echo.
        echo [ERR] Bootstrap completed but did not export the runtime state file.
        echo [HINT] Expected file: %BOOTSTRAP_STATE%
        pause
        exit /b 1
    )

    call "%BOOTSTRAP_STATE%"
    if not defined BOOTSTRAP_NODE_EXE (
        echo.
        echo [ERR] Bootstrap state file did not define BOOTSTRAP_NODE_EXE.
        pause
        exit /b 1
    )

    echo [INFO] Starting server with direct Node handoff...
    echo [INFO] Allow browser autoplay if the browser asks.
    echo.
    set "FAIL_STAGE=server"
    "!BOOTSTRAP_NODE_EXE!" server.js
    set "EXIT_CODE=!ERRORLEVEL!"
)

if not "!EXIT_CODE!"=="0" (
    echo.
    if /i "!FAIL_STAGE!"=="server" (
        echo [ERR] Server exited with code !EXIT_CODE!.
    ) else (
        echo [ERR] Bootstrap failed with exit code !EXIT_CODE!.
        echo [HINT] Read the PowerShell output above for the exact failed step.
    )
)

pause
exit /b !EXIT_CODE!
