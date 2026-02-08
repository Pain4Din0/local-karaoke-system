@echo off
setlocal EnableDelayedExpansion
:: Switch to UTF-8
chcp 65001 >nul
cd /d "%~dp0"

title System Launcher
color 07

:: =========================================================
:: Configuration - Version Numbers
:: =========================================================
set "NODE_VER=v22.13.0"
set "NODE_DIR_NAME=node-%NODE_VER%-win-x64"
set "PYTHON_VER=3.11.9"

:: =========================================================
:: Mirror Selection (First Run)
:: =========================================================
set "CONFIG_FILE=.mirror_config"

:: Check if config exists
if exist "%CONFIG_FILE%" (
    set /p MIRROR_CHOICE=<"%CONFIG_FILE%"
    goto SET_URLS
)

:: First run - ask user to select mirror
cls
echo ===========================================================
echo               Download Source Selection
echo ===========================================================
echo.
echo [1] China Mainland
echo     npmmirror, Huawei Cloud, Aliyun, ghfast
echo.
echo [2] Original
echo     nodejs.org, python.org, github.com
echo.
set /p MIRROR_CHOICE="Enter choice [1/2]: "

:: Validate and save choice
if "%MIRROR_CHOICE%"=="1" (
    echo 1>"%CONFIG_FILE%"
) else (
    set "MIRROR_CHOICE=2"
    echo 2>"%CONFIG_FILE%"
)

:SET_URLS
:: Set URLs based on mirror choice
if "%MIRROR_CHOICE%"=="1" (
    :: China Mainland Mirrors
    set "NODE_URL=https://npmmirror.com/mirrors/node/%NODE_VER%/node-%NODE_VER%-win-x64.zip"
    set "PYTHON_URL=https://repo.huaweicloud.com/python/%PYTHON_VER%/python-%PYTHON_VER%-embed-amd64.zip"
    set "GET_PIP_URL=https://mirrors.aliyun.com/pypi/get-pip.py"
    set "YTDLP_URL=https://ghfast.top/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    set "FFMPEG_URL=https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    set "VCREDIST_URL=https://aka.ms/vs/17/release/vc_redist.x64.exe"
    set "PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple"
    set "NPM_REGISTRY=https://registry.npmmirror.com"
) else (
    :: Official Sources
    set "NODE_URL=https://nodejs.org/dist/%NODE_VER%/node-%NODE_VER%-win-x64.zip"
    set "PYTHON_URL=https://www.python.org/ftp/python/%PYTHON_VER%/python-%PYTHON_VER%-embed-amd64.zip"
    set "GET_PIP_URL=https://bootstrap.pypa.io/get-pip.py"
    set "YTDLP_URL=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    set "FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    set "VCREDIST_URL=https://aka.ms/vs/17/release/vc_redist.x64.exe"
    set "PIP_INDEX=https://pypi.org/simple"
    set "NPM_REGISTRY=https://registry.npmjs.org"
)

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
where node >nul 2>&1
if %errorlevel% equ 0 (
    for /f "delims=" %%v in ('node -v') do echo [CHECK] Found System Node.js ^(%%v^)
    goto SET_SYSTEM
)

:: C. Download if neither is found
:DOWNLOAD_NODE
echo [TASK] Node.js not found. Downloading %NODE_VER%...
if exist "node.zip" del "node.zip"

curl -L -o node.zip "%NODE_URL%"

if not exist "node.zip" (
    echo. & echo [ERR] Node.js download failed. & pause & exit /b 1
)

echo.
echo [TASK] Extracting Node.js...
if exist "bin_temp" rmdir /s /q "bin_temp"
powershell -NoProfile -Command "Expand-Archive -Path 'node.zip' -DestinationPath 'bin_temp' -Force"

if not exist "bin_temp\%NODE_DIR_NAME%\node.exe" (
    echo. & echo [ERR] Node.js extraction failed. & pause & exit /b 1
)

if exist "bin" rmdir /s /q "bin"
move "bin_temp\%NODE_DIR_NAME%" "bin" >nul
rmdir /s /q "bin_temp" 2>nul
del "node.zip" 2>nul

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
if exist "ffmpeg.exe" goto CHECK_VCRUNTIME

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
:: 3.5 Check Visual C++ Redistributable (required for PyTorch)
:: ---------------------------------------------------------
:CHECK_VCRUNTIME
:: Check if vcruntime140.dll exists (indicates VC++ is installed)
where /q vcruntime140.dll >nul 2>&1
if %errorlevel% equ 0 goto CHECK_PYTHON

:: Check in System32
if exist "%SystemRoot%\System32\vcruntime140.dll" goto CHECK_PYTHON

echo [TASK] Visual C++ Redistributable not found. Installing...
curl -L -o vc_redist.x64.exe "%VCREDIST_URL%"

if not exist "vc_redist.x64.exe" (
    echo [WARN] VC++ download failed. Demucs may not work.
    goto CHECK_PYTHON
)

:: Open installer for user to manually install
echo [INFO] Please complete the VC++ installation in the popup window...
start /wait vc_redist.x64.exe
del "vc_redist.x64.exe" 2>nul
echo [DONE] Visual C++ Redistributable ready.
echo.

:: ---------------------------------------------------------
:: 3.6 Check and Install Python + Demucs (for AI vocal separation)
:: ---------------------------------------------------------
:CHECK_PYTHON

:: A. Check for portable Python (Highest priority for environment isolation)
if exist "python\python.exe" (
    echo [CHECK] Found Portable Python in 'python'.
    set "PYTHON_EXE=.\python\python.exe"
    set "PIP_CMD=.\python\python.exe -m pip"
    goto CHECK_DEMUCS
)

:: B. Check for system-installed Python
python --version >nul 2>&1
if %errorlevel% equ 0 (
    for /f "delims=" %%v in ('python --version') do echo [CHECK] Found System %%v
    set "PYTHON_EXE=python"
    set "PIP_CMD=pip"
    goto CHECK_DEMUCS
)

:: C. Download portable Python if neither is found
echo [TASK] Python not found. Downloading Python %PYTHON_VER%...
if exist "python.zip" del "python.zip"

curl -L -o python.zip "%PYTHON_URL%"

if not exist "python.zip" (
    echo. & echo [ERR] Python download failed. & pause & exit
)

echo.
echo [TASK] Extracting Python...
if exist "python" rmdir /s /q "python"
powershell -NoProfile -Command "Expand-Archive -Path 'python.zip' -DestinationPath 'python' -Force"
del "python.zip"

:: Configure embedded Python to allow pip installation
echo [TASK] Configuring Python for pip support...
:: Modify python311._pth to enable site-packages
set "PTH_FILE=python\python311._pth"
if exist "%PTH_FILE%" (
    powershell -NoProfile -Command "(Get-Content '%PTH_FILE%') -replace '#import site', 'import site' | Set-Content '%PTH_FILE%'"
)

:: Download and install pip
echo [TASK] Installing pip...
curl -L -o python\get-pip.py "%GET_PIP_URL%"
if exist "python\get-pip.py" (
    .\python\python.exe python\get-pip.py --no-warn-script-location
    del "python\get-pip.py"
)

echo [DONE] Python ready.
echo.
set "PYTHON_EXE=.\python\python.exe"
set "PIP_CMD=.\python\python.exe -m pip"

:CHECK_DEMUCS
:: Check if demucs is installed via Python module
%PYTHON_EXE% -c "import demucs" >nul 2>&1
if %errorlevel% equ 0 (
    echo [CHECK] Demucs AI Vocal Separation available.
    echo.
    goto INSTALL_DEPS
)

:: Auto-install demucs and dependencies
echo [TASK] Installing Demucs (AI Vocal Separation)...
echo [INFO] This may take several minutes on first run...
%PIP_CMD% install demucs -i %PIP_INDEX% --no-warn-script-location

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

:: Dynamically configure npm registry
call %NPM_CMD% config set registry %NPM_REGISTRY%
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