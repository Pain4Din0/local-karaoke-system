@echo off
setlocal EnableDelayedExpansion
:: Switch to UTF-8
chcp 65001 >nul
cd /d "%~dp0"

title System Launcher
color 07

:: =========================================================
:: Configuration
:: =========================================================
set "NODE_VER=v22.13.0"
set "NODE_URL=https://nodejs.org/dist/%NODE_VER%/node-%NODE_VER%-win-x64.zip"
set "NODE_DIR_NAME=node-%NODE_VER%-win-x64"

set "YTDLP_URL=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
set "FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"

cls
echo [INFO] System Launcher
echo [INFO] Environment Check...
echo.

:: ---------------------------------------------------------
:: 1. Smart Detection for Node.js
:: ---------------------------------------------------------

:: A. Check for portable version (Highest priority for environment isolation)
if exist "bin\node.exe" (
    echo [CHECK] Found Portable Node.js in 'bin'.
    goto SET_PORTABLE
)

:: B. Check for system-installed Node.js
node -v >nul 2>&1
if %errorlevel% equ 0 (
    for /f "delims=" %%v in ('node -v') do echo [CHECK] Found System Node.js (%%v)
    goto SET_SYSTEM
)

:: C. Download if neither is found
echo [TASK] Node.js not found. Downloading %NODE_VER%...
if exist "node.zip" del "node.zip"

curl -L -o node.zip "%NODE_URL%"

if not exist "node.zip" (
    echo. & echo [ERR] Download failed. & pause & exit
)

echo.
echo [TASK] Extracting Node.js...
if exist "bin_temp" rmdir /s /q "bin_temp"
powershell -NoProfile -Command "Expand-Archive -Path 'node.zip' -DestinationPath 'bin_temp' -Force"

if exist "bin" rmdir /s /q "bin"
move "bin_temp\%NODE_DIR_NAME%" "bin" >nul
rmdir /s /q "bin_temp"
del "node.zip"

echo [DONE] Node.js ready.
echo.
goto SET_PORTABLE


:: --- Environment Config Logic ---

:SET_PORTABLE
:: Set variables for portable version
set "NODE_EXE=.\bin\node.exe"
:: Portable npm requires special command
set "NPM_CMD=".\bin\node.exe" ".\bin\node_modules\npm\bin\npm-cli.js""
goto CHECK_TOOLS

:SET_SYSTEM
:: Set variables for system command
set "NODE_EXE=node"
set "NPM_CMD=npm"
goto CHECK_TOOLS


:: ---------------------------------------------------------
:: 2. Check yt-dlp
:: ---------------------------------------------------------
:CHECK_TOOLS
if exist "yt-dlp.exe" goto CHECK_FFMPEG

echo [TASK] yt-dlp not found. Downloading...
curl -L -o yt-dlp.exe "%YTDLP_URL%"

if not exist "yt-dlp.exe" (
    echo. & echo [ERR] Download failed. & pause & exit
)
echo. & echo [DONE] yt-dlp ready.
echo.

:: ---------------------------------------------------------
:: 3. Check FFmpeg
:: ---------------------------------------------------------
:CHECK_FFMPEG
if exist "ffmpeg.exe" goto INSTALL_DEPS

echo [TASK] FFmpeg not found. Downloading...
if exist "ffmpeg.zip" del "ffmpeg.zip"
curl -L -o ffmpeg.zip "%FFMPEG_URL%"

if not exist "ffmpeg.zip" (
    echo. & echo [ERR] Download failed. & pause & exit
)

echo.
echo [TASK] Extracting FFmpeg...
if exist "ffmpeg_temp" rmdir /s /q "ffmpeg_temp"
powershell -NoProfile -Command "Expand-Archive -Path 'ffmpeg.zip' -DestinationPath 'ffmpeg_temp' -Force"

echo [TASK] Configuring FFmpeg...
for /r "ffmpeg_temp" %%f in (ffmpeg.exe) do move "%%f" . >nul 2>&1
for /r "ffmpeg_temp" %%f in (ffprobe.exe) do move "%%f" . >nul 2>&1

rmdir /s /q "ffmpeg_temp"
del "ffmpeg.zip"

if not exist "ffmpeg.exe" (
    echo [ERR] FFmpeg configuration failed.
    pause
    exit
)
echo [DONE] FFmpeg ready.
echo.

:: ---------------------------------------------------------
:: 3.5 Check and Install Demucs (for AI vocal separation)
:: ---------------------------------------------------------
:CHECK_DEMUCS
:: Check Python first
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] Python not found. Demucs requires Python 3.8+
    echo [HINT] Install Python from https://www.python.org/downloads/
    echo.
    goto INSTALL_DEPS
)

:: Check if demucs is installed via Python module
python -c "import demucs" >nul 2>&1
if %errorlevel% equ 0 (
    echo [CHECK] Demucs AI Vocal Separation available.
    echo.
    goto INSTALL_DEPS
)

:: Auto-install demucs and dependencies
echo [TASK] Installing Demucs (AI Vocal Separation)...
echo [INFO] This may take a few minutes...
pip install demucs torchcodec -i https://pypi.tuna.tsinghua.edu.cn/simple

if %errorlevel% neq 0 (
    echo [WARN] Demucs installation failed. AI vocal removal will be disabled.
    echo.
    goto INSTALL_DEPS
)
echo [DONE] Demucs ready.
echo.

:: ---------------------------------------------------------
:: 4. Install Dependencies
:: ---------------------------------------------------------
:INSTALL_DEPS
if exist "node_modules" goto START_SERVER

echo [TASK] Installing dependencies...
echo [INFO] Using npmmirror registry...

:: Dynamically configure npm registry
call %NPM_CMD% config set registry https://registry.npmmirror.com
call %NPM_CMD% install

if %errorlevel% neq 0 (
    echo. & echo [ERR] Install failed. & pause & exit
)
echo [DONE] Setup complete.
echo.

:: ---------------------------------------------------------
:: 5. Start Server
:: ---------------------------------------------------------
:START_SERVER
if not exist "downloads" mkdir downloads

echo [INFO] Starting Server...
echo [HINT] Allow browser autoplay if asked.
echo.

start "" cmd /c "timeout /t 2 >nul & start http://localhost:8080/player.html"

:: Run node server
%NODE_EXE% server.js

pause