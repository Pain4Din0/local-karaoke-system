$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RootDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $RootDir

$NodeVersion = 'v22.13.0'
$NodeDirName = "node-$NodeVersion-win-x64"
$PythonVersion = '3.11.9'
$BootstrapDir = Join-Path $RootDir '.bootstrap'
$MirrorConfigPath = Join-Path $BootstrapDir 'mirror_config.txt'
$BootstrapStatePath = Join-Path $BootstrapDir 'bootstrap_state.cmd'
$PipRefreshStatePath = Join-Path $BootstrapDir 'pip_refresh_state.json'
$NodeArchivePath = Join-Path $BootstrapDir 'node.zip'
$PythonArchivePath = Join-Path $BootstrapDir 'python.zip'
$FfmpegArchivePath = Join-Path $BootstrapDir 'ffmpeg.zip'
$VcRedistInstallerPath = Join-Path $BootstrapDir 'vc_redist.x64.exe'
$GetPipPath = Join-Path $BootstrapDir 'bootstrap-get-pip.py'
$NodeTempDir = Join-Path $BootstrapDir 'bin_temp'
$FfmpegTempDir = Join-Path $BootstrapDir 'ffmpeg_temp'
$LegacyMirrorConfigPath = Join-Path $RootDir '.mirror_config'
$LegacyBootstrapStatePath = Join-Path $RootDir '.bootstrap_state.cmd'
$LegacyPipRefreshStatePath = Join-Path $RootDir '.bootstrap_pip_state.json'
$PipRefreshIntervalHours = 168
$SkipLaunch = $env:START_NO_LAUNCH -eq '1'

$script:NodeSource = ''
$script:NodeExe = ''
$script:PythonSource = ''
$script:PythonExe = ''
$script:DemucsAvailable = $false
$script:YtMusicApiAvailable = $false

function Write-Step([string]$Level, [string]$Message) {
    Write-Host "[$Level] $Message"
}

function Write-Info([string]$Message) { Write-Step 'INFO' $Message }
function Write-Task([string]$Message) { Write-Step 'TASK' $Message }
function Write-Done([string]$Message) { Write-Step 'DONE' $Message }
function Write-Warn([string]$Message) { Write-Step 'WARN' $Message }
function Write-Check([string]$Message) { Write-Step 'CHECK' $Message }

function Fail([string]$Message) {
    throw $Message
}

function Remove-PathIfExists([string]$Path) {
    if (-not $Path) { return }
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

function Hide-PathIfPossible([string]$Path) {
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::Hidden) -eq 0) {
            $item.Attributes = $item.Attributes -bor [IO.FileAttributes]::Hidden
        }
    }
    catch {
    }
}

function Initialize-BootstrapStorage {
    Ensure-Directory $BootstrapDir
    Hide-PathIfPossible $BootstrapDir

    if (Test-Path -LiteralPath $LegacyMirrorConfigPath) {
        if (-not (Test-Path -LiteralPath $MirrorConfigPath)) {
            Move-Item -LiteralPath $LegacyMirrorConfigPath -Destination $MirrorConfigPath -Force
        }
        else {
            Remove-PathIfExists $LegacyMirrorConfigPath
        }
    }

    if (Test-Path -LiteralPath $LegacyPipRefreshStatePath) {
        if (-not (Test-Path -LiteralPath $PipRefreshStatePath)) {
            Move-Item -LiteralPath $LegacyPipRefreshStatePath -Destination $PipRefreshStatePath -Force
        }
        else {
            Remove-PathIfExists $LegacyPipRefreshStatePath
        }
    }

    Remove-PathIfExists $LegacyBootstrapStatePath
}

function Get-CommandPath([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $cmd) { return $null }
    return $cmd.Source
}

function Invoke-External {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [switch]$AllowFailure,
        [switch]$CaptureOutput
    )

    $oldErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($CaptureOutput) {
            $output = & $FilePath @Arguments 2>&1
        } else {
            & $FilePath @Arguments
        }
    } finally {
        $ErrorActionPreference = $oldErrorActionPreference
    }
    $exitCode = $LASTEXITCODE

    if ($CaptureOutput) {
        if (-not $AllowFailure -and $exitCode -ne 0) {
            $text = ($output | Out-String).Trim()
            if (-not $text) { $text = "exit code $exitCode" }
            Fail "Command failed: $FilePath $($Arguments -join ' ')`n$text"
        }
        return [PSCustomObject]@{
            ExitCode = $exitCode
            Output   = @($output)
        }
    }

    if (-not $AllowFailure -and $exitCode -ne 0) {
        Fail "Command failed: $FilePath $($Arguments -join ' ') (exit code $exitCode)"
    }
    return $exitCode
}

function Invoke-Download([string[]]$Urls, [string]$TargetFile, [string]$DisplayName) {
    if ($null -eq $Urls -or $Urls.Count -eq 0) {
        Fail "No download URLs were configured for $DisplayName."
    }

    Ensure-Directory $BootstrapDir
    $tempTarget = Join-Path $BootstrapDir ((Split-Path -Path $TargetFile -Leaf) + '.download')
    $downloadErrors = @()

    foreach ($url in $Urls) {
        if (-not $url) { continue }
        Remove-PathIfExists $tempTarget
        Write-Info "Trying $DisplayName source: $url"

        $curl = Get-CommandPath 'curl.exe'
        if ($curl) {
            try {
                Invoke-External -FilePath $curl -Arguments @('-L', '--fail', '--retry', '3', '--retry-delay', '2', '-o', $tempTarget, $url)
            }
            catch {
                $downloadErrors += "curl -> $url :: $($_.Exception.Message)"
                Write-Warn "curl download failed for $DisplayName. Falling back to PowerShell for the same source."
            }
        }

        if (-not (Test-Path -LiteralPath $tempTarget)) {
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tempTarget
            }
            catch {
                $downloadErrors += "powershell -> $url :: $($_.Exception.Message)"
                continue
            }
        }

        if (-not (Test-Path -LiteralPath $tempTarget)) {
            $downloadErrors += "download finished without creating $tempTarget for $url"
            continue
        }

        $fileInfo = Get-Item -LiteralPath $tempTarget
        if ($fileInfo.Length -le 0) {
            $downloadErrors += "download produced an empty file for $url"
            continue
        }

        Remove-PathIfExists $TargetFile
        Move-Item -LiteralPath $tempTarget -Destination $TargetFile -Force
        return
    }

    $errorText = ($downloadErrors | Select-Object -Unique | Out-String).Trim()
    Fail "Failed to download $DisplayName from all configured sources.`n$errorText"
}

function Expand-ZipFile([string]$ZipFile, [string]$Destination, [string]$DisplayName) {
    Remove-PathIfExists $Destination
    try {
        Expand-Archive -LiteralPath $ZipFile -DestinationPath $Destination -Force
    }
    catch {
        Fail "Failed to extract $DisplayName from $ZipFile. $($_.Exception.Message)"
    }

    if (-not (Test-Path -LiteralPath $Destination)) {
        Fail "$DisplayName extraction finished but '$Destination' was not created."
    }
}

function Select-MirrorChoice {
    if (Test-Path -LiteralPath $MirrorConfigPath) {
        $saved = (Get-Content -LiteralPath $MirrorConfigPath -TotalCount 1 -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($saved -eq '1' -or $saved -eq '2') {
            return $saved
        }
    }

    Write-Host '==========================================================='
    Write-Host '              Download Source Selection'
    Write-Host '==========================================================='
    Write-Host ''
    Write-Host '[1] China Mainland'
    Write-Host '    npmmirror, Huawei Cloud, Aliyun, ghfast'
    Write-Host ''
    Write-Host '[2] Original'
    Write-Host '    nodejs.org, python.org, github.com'
    Write-Host ''

    $choice = Read-Host 'Enter choice [1/2]'
    if ($choice -ne '1') { $choice = '2' }
    Set-Content -LiteralPath $MirrorConfigPath -Value $choice -NoNewline
    return $choice
}

function Get-MirrorSettings([string]$Choice) {
    if ($Choice -eq '1') {
        return @{
            NodeUrls     = @(
                "https://npmmirror.com/mirrors/node/$NodeVersion/node-$NodeVersion-win-x64.zip",
                "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
            )
            PythonUrls   = @(
                "https://repo.huaweicloud.com/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip",
                "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
            )
            GetPipUrls   = @(
                'https://mirrors.aliyun.com/pypi/get-pip.py',
                'https://bootstrap.pypa.io/get-pip.py'
            )
            YtDlpUrls    = @(
                'https://ghfast.top/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
                'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
            )
            FfmpegUrls   = @(
                'https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
                'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
            )
            VcRedistUrls = @(
                'https://aka.ms/vs/17/release/vc_redist.x64.exe'
            )
            PipIndex     = 'https://pypi.tuna.tsinghua.edu.cn/simple'
            NpmRegistry  = 'https://registry.npmmirror.com'
        }
    }

    return @{
        NodeUrls     = @(
            "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip",
            "https://npmmirror.com/mirrors/node/$NodeVersion/node-$NodeVersion-win-x64.zip"
        )
        PythonUrls   = @(
            "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip",
            "https://repo.huaweicloud.com/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
        )
        GetPipUrls   = @(
            'https://bootstrap.pypa.io/get-pip.py',
            'https://mirrors.aliyun.com/pypi/get-pip.py'
        )
        YtDlpUrls    = @(
            'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
            'https://ghfast.top/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
        )
        FfmpegUrls   = @(
            'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
            'https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
        )
        VcRedistUrls = @(
            'https://aka.ms/vs/17/release/vc_redist.x64.exe'
        )
        PipIndex     = 'https://pypi.org/simple'
        NpmRegistry  = 'https://registry.npmjs.org'
    }
}

function Cleanup-StaleBootstrapArtifacts {
    @(
        $NodeArchivePath,
        $PythonArchivePath,
        $FfmpegArchivePath,
        $VcRedistInstallerPath,
        $GetPipPath,
        $NodeTempDir,
        $FfmpegTempDir,
        $LegacyBootstrapStatePath
    ) | ForEach-Object {
        Remove-PathIfExists $_
    }
}

function Invoke-Npm([string[]]$Arguments) {
    if ($script:NodeSource -eq 'portable') {
        Invoke-External -FilePath $script:NodeExe -Arguments @('.\bin\node_modules\npm\bin\npm-cli.js') + $Arguments | Out-Null
        return
    }

    $npm = Get-CommandPath 'npm'
    if (-not $npm) {
        Fail 'npm was not found.'
    }
    Invoke-External -FilePath $npm -Arguments $Arguments | Out-Null
}

function Ensure-Node($Settings) {
    $portableNode = Join-Path $RootDir 'bin\node.exe'
    $portableNpmCli = Join-Path $RootDir 'bin\node_modules\npm\bin\npm-cli.js'
    if ((Test-Path -LiteralPath $portableNode) -and (Test-Path -LiteralPath $portableNpmCli)) {
        try {
            Invoke-External -FilePath $portableNode -Arguments @('-v') | Out-Null
            $script:NodeSource = 'portable'
            $script:NodeExe = $portableNode
            Invoke-Npm @('--version')
            Write-Check "Found portable Node.js in 'bin'."
            return
        }
        catch {
            Write-Warn 'Existing portable Node.js is invalid. Reinstalling it.'
            Remove-PathIfExists (Join-Path $RootDir 'bin')
        }
    }

    $systemNode = Get-CommandPath 'node'
    if ($systemNode) {
        try {
            $nodeVersionResult = Invoke-External -FilePath $systemNode -Arguments @('-v') -CaptureOutput
            $nodeVersion = ($nodeVersionResult.Output | Select-Object -First 1).ToString().Trim()
            $major = 0
            [void][int]::TryParse(($nodeVersion -replace '^[vV]', '').Split('.')[0], [ref]$major)
            if ($major -ge 18) {
                $script:NodeSource = 'system'
                $script:NodeExe = $systemNode
                Invoke-Npm @('--version')
                Write-Check "Found system Node.js $nodeVersion."
                return
            }
            Write-Warn "System Node.js $nodeVersion is too old. Falling back to portable $NodeVersion."
        }
        catch {
            Write-Warn 'System npm is unavailable. Falling back to portable Node.js.'
        }
        $script:NodeSource = ''
        $script:NodeExe = ''
    }

    Write-Task "Downloading Node.js $NodeVersion..."
    Invoke-Download -Urls $Settings.NodeUrls -TargetFile $NodeArchivePath -DisplayName 'Node.js'
    Write-Task 'Extracting Node.js...'
    Expand-ZipFile -ZipFile $NodeArchivePath -Destination $NodeTempDir -DisplayName 'Node.js'

    $extractedNode = Join-Path $NodeTempDir $NodeDirName
    if (-not (Test-Path -LiteralPath (Join-Path $extractedNode 'node.exe'))) {
        Fail 'Node.js extraction finished but node.exe was not found.'
    }

    Remove-PathIfExists (Join-Path $RootDir 'bin')
    Move-Item -LiteralPath $extractedNode -Destination (Join-Path $RootDir 'bin')
    Remove-PathIfExists $NodeTempDir
    Remove-PathIfExists $NodeArchivePath

    $script:NodeSource = 'portable'
    $script:NodeExe = Join-Path $RootDir 'bin\node.exe'
    Invoke-External -FilePath $script:NodeExe -Arguments @('-v') | Out-Null
    Invoke-Npm @('--version')
    Write-Done 'Node.js ready.'
}

function Ensure-YtDlp($Settings) {
    $ytDlpPath = Join-Path $RootDir 'yt-dlp.exe'
    if (Test-Path -LiteralPath $ytDlpPath) {
        try {
            Invoke-External -FilePath $ytDlpPath -Arguments @('--version') | Out-Null
            Write-Check 'yt-dlp ready.'
            return
        }
        catch {
            Write-Warn 'Existing yt-dlp.exe is invalid. Re-downloading it.'
        }
    }

    Write-Task 'Downloading yt-dlp...'
    Invoke-Download -Urls $Settings.YtDlpUrls -TargetFile $ytDlpPath -DisplayName 'yt-dlp'
    Invoke-External -FilePath $ytDlpPath -Arguments @('--version') | Out-Null
    Write-Done 'yt-dlp ready.'
}

function Ensure-Ffmpeg($Settings) {
    $ffmpegPath = Join-Path $RootDir 'ffmpeg.exe'
    $ffprobePath = Join-Path $RootDir 'ffprobe.exe'
    if ((Test-Path -LiteralPath $ffmpegPath) -and (Test-Path -LiteralPath $ffprobePath)) {
        try {
            Invoke-External -FilePath $ffmpegPath -Arguments @('-version') | Out-Null
            Invoke-External -FilePath $ffprobePath -Arguments @('-version') | Out-Null
            Write-Check 'FFmpeg and FFprobe ready.'
            return
        }
        catch {
            Write-Warn 'Existing FFmpeg files are invalid. Re-downloading them.'
        }
    }

    Write-Task 'Downloading FFmpeg...'
    Invoke-Download -Urls $Settings.FfmpegUrls -TargetFile $FfmpegArchivePath -DisplayName 'FFmpeg'
    Write-Task 'Extracting FFmpeg...'
    Expand-ZipFile -ZipFile $FfmpegArchivePath -Destination $FfmpegTempDir -DisplayName 'FFmpeg'

    $ffmpegBinary = Get-ChildItem -LiteralPath $FfmpegTempDir -Filter 'ffmpeg.exe' -Recurse -File | Select-Object -First 1
    $ffprobeBinary = Get-ChildItem -LiteralPath $FfmpegTempDir -Filter 'ffprobe.exe' -Recurse -File | Select-Object -First 1
    if ($null -eq $ffmpegBinary -or $null -eq $ffprobeBinary) {
        Fail 'FFmpeg extraction completed but ffmpeg.exe or ffprobe.exe was not found.'
    }

    Copy-Item -LiteralPath $ffmpegBinary.FullName -Destination $ffmpegPath -Force
    Copy-Item -LiteralPath $ffprobeBinary.FullName -Destination $ffprobePath -Force
    Remove-PathIfExists $FfmpegTempDir
    Remove-PathIfExists $FfmpegArchivePath

    Invoke-External -FilePath $ffmpegPath -Arguments @('-version') | Out-Null
    Invoke-External -FilePath $ffprobePath -Arguments @('-version') | Out-Null
    Write-Done 'FFmpeg ready.'
}

function Ensure-VcRedist($Settings) {
    $vcRuntimeDll = Join-Path $env:SystemRoot 'System32\vcruntime140.dll'
    if (Test-Path -LiteralPath $vcRuntimeDll) {
        Write-Check 'Visual C++ Redistributable detected.'
        return
    }

    Write-Task 'Visual C++ Redistributable not found. Installing silently...'
    try {
        Invoke-Download -Urls $Settings.VcRedistUrls -TargetFile $VcRedistInstallerPath -DisplayName 'Visual C++ Redistributable'
    }
    catch {
        Write-Warn 'Failed to download the Visual C++ Redistributable. Demucs may fail until it is installed.'
        return
    }

    try {
        Invoke-External -FilePath $VcRedistInstallerPath -Arguments @('/install', '/quiet', '/norestart') -AllowFailure | Out-Null
    }
    finally {
        Remove-PathIfExists $VcRedistInstallerPath
    }

    if (Test-Path -LiteralPath $vcRuntimeDll) {
        Write-Done 'Visual C++ Redistributable ready.'
        return
    }

    Write-Warn 'Visual C++ Redistributable was not detected after installation. Demucs may fail until it is installed.'
}

function Ensure-Pip([string[]]$GetPipUrls) {
    $check = Invoke-External -FilePath $script:PythonExe -Arguments @('-m', 'pip', '--version') -AllowFailure -CaptureOutput
    if ($check.ExitCode -eq 0) { return }

    Write-Task 'Installing pip...'
    Invoke-Download -Urls $GetPipUrls -TargetFile $GetPipPath -DisplayName 'get-pip.py'
    try {
        Invoke-External -FilePath $script:PythonExe -Arguments @($GetPipPath, '--no-warn-script-location') | Out-Null
    }
    finally {
        Remove-PathIfExists $GetPipPath
    }

    $verify = Invoke-External -FilePath $script:PythonExe -Arguments @('-m', 'pip', '--version') -AllowFailure -CaptureOutput
    if ($verify.ExitCode -ne 0) {
        Fail "pip installation finished but '$script:PythonExe -m pip --version' still failed."
    }
    Write-Done 'pip ready.'
}

function Ensure-Python($Settings) {
    $portablePython = Join-Path $RootDir 'python\python.exe'
    if (Test-Path -LiteralPath $portablePython) {
        try {
            Invoke-External -FilePath $portablePython -Arguments @('-c', 'import sys') | Out-Null
            $script:PythonSource = 'portable'
            $script:PythonExe = $portablePython
            Ensure-Pip -GetPipUrls $Settings.GetPipUrls
            Write-Check "Found portable Python in 'python'."
            return
        }
        catch {
            Write-Warn 'Existing portable Python is invalid. Reinstalling it.'
            Remove-PathIfExists (Join-Path $RootDir 'python')
        }
    }

    $systemPython = Get-CommandPath 'python'
    if ($systemPython) {
        try {
            $versionResult = Invoke-External -FilePath $systemPython -Arguments @('--version') -CaptureOutput
            $versionText = ($versionResult.Output | Select-Object -First 1).ToString().Trim()
            $version = $versionText -replace '^Python\s+', ''
            $major = 0
            $minor = 0
            $parts = $version.Split('.')
            if ($parts.Length -ge 2) {
                [void][int]::TryParse($parts[0], [ref]$major)
                [void][int]::TryParse($parts[1], [ref]$minor)
            }

            if ($major -eq 3 -and $minor -ge 9) {
                $script:PythonSource = 'system'
                $script:PythonExe = $systemPython
                if ($minor -gt 12) {
                    Write-Warn "System Python $version is newer than the recommended 3.9-3.12 range. Continuing with it because it is already installed."
                }
                Ensure-Pip -GetPipUrls $Settings.GetPipUrls
                Write-Check "Found system Python $version."
                return
            }

            Write-Warn "System Python $version is older than the supported 3.9+ range. Falling back to portable $PythonVersion."
        }
        catch {
            Write-Warn 'System Python is available but pip setup failed. Falling back to portable Python.'
        }

        $script:PythonSource = ''
        $script:PythonExe = ''
    }

    Write-Task "Downloading Python $PythonVersion..."
    Invoke-Download -Urls $Settings.PythonUrls -TargetFile $PythonArchivePath -DisplayName 'Python'
    Write-Task 'Extracting Python...'
    Remove-PathIfExists (Join-Path $RootDir 'python')
    Expand-ZipFile -ZipFile $PythonArchivePath -Destination (Join-Path $RootDir 'python') -DisplayName 'Python'
    Remove-PathIfExists $PythonArchivePath

    if (-not (Test-Path -LiteralPath $portablePython)) {
        Fail 'Python extraction finished but python.exe was not found.'
    }

    $pthFile = Get-ChildItem -LiteralPath (Join-Path $RootDir 'python') -Filter 'python*._pth' -File | Select-Object -First 1
    if ($pthFile) {
        $pthContent = Get-Content -LiteralPath $pthFile.FullName
        $updated = $pthContent -replace '#import site', 'import site'
        Set-Content -LiteralPath $pthFile.FullName -Value $updated
    }

    $script:PythonSource = 'portable'
    $script:PythonExe = $portablePython
    Ensure-Pip -GetPipUrls $Settings.GetPipUrls
    Write-Done 'Python runtime ready.'
}

function Get-PipRefreshState {
    if (-not (Test-Path -LiteralPath $PipRefreshStatePath)) {
        return $null
    }

    try {
        return Get-Content -LiteralPath $PipRefreshStatePath -Raw | ConvertFrom-Json
    }
    catch {
        Write-Warn 'Failed to read pip refresh state. A full packaging-tools refresh will be performed.'
        return $null
    }
}

function Save-PipRefreshState($Settings) {
    $payload = [PSCustomObject]@{
        updatedAt    = (Get-Date).ToString('o')
        pythonExe    = $script:PythonExe
        pythonSource = $script:PythonSource
        pipIndex     = $Settings.PipIndex
    }

    $payload | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $PipRefreshStatePath -Encoding UTF8
}

function Get-PipRefreshDecision($Settings) {
    if ($env:FORCE_PIP_REFRESH -eq '1') {
        return [PSCustomObject]@{
            Refresh       = $true
            Reason        = 'forced by FORCE_PIP_REFRESH=1'
            LastUpdatedAt = $null
        }
    }

    $state = Get-PipRefreshState
    if ($null -eq $state) {
        return [PSCustomObject]@{
            Refresh       = $true
            Reason        = 'no previous refresh state'
            LastUpdatedAt = $null
        }
    }

    if ($state.pythonExe -ne $script:PythonExe) {
        return [PSCustomObject]@{
            Refresh       = $true
            Reason        = 'python executable changed'
            LastUpdatedAt = $state.updatedAt
        }
    }

    if ($state.pipIndex -ne $Settings.PipIndex) {
        return [PSCustomObject]@{
            Refresh       = $true
            Reason        = 'pip index changed'
            LastUpdatedAt = $state.updatedAt
        }
    }

    try {
        $lastUpdatedAt = [DateTime]::Parse($state.updatedAt)
    }
    catch {
        return [PSCustomObject]@{
            Refresh       = $true
            Reason        = 'previous refresh timestamp was invalid'
            LastUpdatedAt = $state.updatedAt
        }
    }

    $ageHours = ((Get-Date) - $lastUpdatedAt).TotalHours
    if ($ageHours -ge $PipRefreshIntervalHours) {
        return [PSCustomObject]@{
            Refresh       = $true
            Reason        = "last refresh is older than $PipRefreshIntervalHours hours"
            LastUpdatedAt = $lastUpdatedAt
        }
    }

    return [PSCustomObject]@{
        Refresh       = $false
        Reason        = 'packaging tools were refreshed recently'
        LastUpdatedAt = $lastUpdatedAt
    }
}

function Upgrade-PipStack($Settings) {
    $decision = Get-PipRefreshDecision -Settings $Settings
    if (-not $decision.Refresh) {
        $lastUpdatedLabel = if ($decision.LastUpdatedAt) {
            ([DateTime]$decision.LastUpdatedAt).ToString('yyyy-MM-dd HH:mm:ss')
        }
        else {
            'unknown'
        }
        Write-Check "Python packaging tools are current. Skipping refresh (last successful refresh: $lastUpdatedLabel)."
        return
    }

    Write-Task "Upgrading pip/setuptools/wheel... ($($decision.Reason))"
    $result = Invoke-External -FilePath $script:PythonExe -Arguments @('-m', 'pip', '--disable-pip-version-check', 'install', '--upgrade', 'pip', 'setuptools', 'wheel', '-i', $Settings.PipIndex, '--no-warn-script-location') -AllowFailure -CaptureOutput
    if ($result.ExitCode -ne 0) {
        Write-Warn 'Failed to upgrade pip/setuptools/wheel. Continuing with the existing Python packaging tools.'
        return
    }
    Save-PipRefreshState -Settings $Settings
    Write-Done 'Python packaging tools ready.'
}

function Ensure-PythonModule([string]$ModuleName, [string]$Label, [bool]$Optional, $Settings) {
    $check = Invoke-External -FilePath $script:PythonExe -Arguments @('-c', "import $ModuleName") -AllowFailure -CaptureOutput
    if ($check.ExitCode -eq 0) {
        if ($ModuleName -eq 'demucs') { $script:DemucsAvailable = $true }
        if ($ModuleName -eq 'ytmusicapi') { $script:YtMusicApiAvailable = $true }
        Write-Check "$Label available."
        return
    }

    Write-Task "Installing $Label..."
    $install = Invoke-External -FilePath $script:PythonExe -Arguments @('-m', 'pip', '--disable-pip-version-check', 'install', $ModuleName, '-i', $Settings.PipIndex, '--no-warn-script-location') -AllowFailure -CaptureOutput
    if ($install.ExitCode -ne 0) {
        if ($Optional) {
            Write-Warn "Failed to install $Label. Related features will be unavailable."
            return
        }
        Fail "Failed to install $Label."
    }

    $verify = Invoke-External -FilePath $script:PythonExe -Arguments @('-c', "import $ModuleName") -AllowFailure -CaptureOutput
    if ($verify.ExitCode -ne 0) {
        if ($Optional) {
            Write-Warn "$Label installed but import verification failed."
            return
        }
        Fail "$Label installed but import verification failed."
    }

    if ($ModuleName -eq 'demucs') { $script:DemucsAvailable = $true }
    if ($ModuleName -eq 'ytmusicapi') { $script:YtMusicApiAvailable = $true }
    Write-Done "$Label ready."
}

function Ensure-NodeDependencies($Settings) {
    $expressPath = Join-Path $RootDir 'node_modules\express\package.json'
    $socketIoPath = Join-Path $RootDir 'node_modules\socket.io\package.json'
    if ((Test-Path -LiteralPath $expressPath) -and (Test-Path -LiteralPath $socketIoPath)) {
        Write-Check 'Node.js dependencies already installed.'
        return
    }

    Write-Task 'Installing Node.js dependencies...'
    Invoke-Npm @('install', '--registry', $Settings.NpmRegistry, '--no-fund', '--no-audit')
    if (-not (Test-Path -LiteralPath $expressPath)) {
        Fail 'npm install finished but Express was not found in node_modules.'
    }
    if (-not (Test-Path -LiteralPath $socketIoPath)) {
        Fail 'npm install finished but Socket.IO was not found in node_modules.'
    }
    Write-Done 'Node.js dependencies ready.'
}

function Run-ProjectCheck {
    Write-Task 'Running project checks...'
    Invoke-Npm @('run', 'check')
    Write-Done 'Project checks passed.'
}

function Verify-Runtime {
    Invoke-External -FilePath $script:NodeExe -Arguments @('--check', 'server.js') | Out-Null
    Invoke-External -FilePath (Join-Path $RootDir 'yt-dlp.exe') -Arguments @('--version') | Out-Null
    Invoke-External -FilePath (Join-Path $RootDir 'ffmpeg.exe') -Arguments @('-version') | Out-Null
    Invoke-External -FilePath (Join-Path $RootDir 'ffprobe.exe') -Arguments @('-version') | Out-Null
    Invoke-External -FilePath $script:PythonExe -Arguments @('-c', 'import sys; print(sys.executable)') | Out-Null
}

function Print-Summary([string]$MirrorChoice) {
    $nodeVersion = ((Invoke-External -FilePath $script:NodeExe -Arguments @('-v') -CaptureOutput).Output | Select-Object -First 1).ToString().Trim()
    $pythonVersionText = ((Invoke-External -FilePath $script:PythonExe -Arguments @('--version') -CaptureOutput).Output | Select-Object -First 1).ToString().Trim()
    $pythonVersion = $pythonVersionText -replace '^Python\s+', ''
    $ytDlpVersion = ((Invoke-External -FilePath (Join-Path $RootDir 'yt-dlp.exe') -Arguments @('--version') -CaptureOutput).Output | Select-Object -First 1).ToString().Trim()
    $ffmpegVersionLine = ((Invoke-External -FilePath (Join-Path $RootDir 'ffmpeg.exe') -Arguments @('-version') -CaptureOutput).Output | Select-Object -First 1).ToString().Trim()

    Write-Host ''
    Write-Host '[INFO] Bootstrap summary:'
    Write-Host "[INFO]   Node.js: $nodeVersion ($script:NodeSource)"
    Write-Host "[INFO]   Python: $pythonVersion ($script:PythonSource)"
    Write-Host "[INFO]   yt-dlp: $ytDlpVersion"
    Write-Host "[INFO]   FFmpeg: $ffmpegVersionLine"
    if ($script:DemucsAvailable) { Write-Host '[INFO]   Demucs: ready' } else { Write-Host '[WARN]   Demucs: unavailable' }
    if ($script:YtMusicApiAvailable) { Write-Host '[INFO]   ytmusicapi: ready' } else { Write-Host '[WARN]   ytmusicapi: unavailable' }
    Write-Host "[INFO]   Mirror mode: $MirrorChoice"
    Write-Host ''
}

function Export-BootstrapState {
    if (-not $script:NodeExe) {
        Fail 'Node executable path was not resolved during bootstrap.'
    }

    $lines = @(
        '@echo off',
        "set ""BOOTSTRAP_NODE_EXE=$script:NodeExe"""
    )

    Set-Content -LiteralPath $BootstrapStatePath -Value $lines -Encoding ASCII
    Write-Info 'Bootstrap finished. start.bat will launch server.js directly so runtime logs stay fully real-time.'
}

try {
    Initialize-BootstrapStorage
    $mirrorChoice = Select-MirrorChoice
    $settings = Get-MirrorSettings -Choice $mirrorChoice

    Write-Info 'Local Karaoke System Launcher'
    Write-Info 'Preparing runtime and dependencies...'
    Write-Host ''

    Cleanup-StaleBootstrapArtifacts
    Ensure-Node -Settings $settings
    Ensure-YtDlp -Settings $settings
    Ensure-Ffmpeg -Settings $settings
    Ensure-VcRedist -Settings $settings
    Ensure-Python -Settings $settings
    Upgrade-PipStack -Settings $settings
    Ensure-PythonModule -ModuleName 'demucs' -Label 'Demucs (AI vocal separation)' -Optional $true -Settings $settings
    Ensure-PythonModule -ModuleName 'ytmusicapi' -Label 'ytmusicapi (timed lyrics)' -Optional $true -Settings $settings
    Ensure-NodeDependencies -Settings $settings
    Run-ProjectCheck
    Verify-Runtime
    Print-Summary -MirrorChoice $mirrorChoice
    New-Item -ItemType Directory -Force -Path (Join-Path $RootDir 'downloads') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $RootDir 'separated') | Out-Null
    if ($SkipLaunch) {
        Write-Info 'START_NO_LAUNCH=1 detected. Bootstrap verification finished without launching the server.'
        exit 0
    }
    Export-BootstrapState
    exit 0
}
catch {
    Write-Host ''
    Write-Host "[ERR] $($_.Exception.Message)"
    exit 1
}
