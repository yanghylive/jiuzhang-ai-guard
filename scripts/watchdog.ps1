# WorkDaddy (JiuZhang AI Guardian) watchdog.
# Keeps daemon.js alive: if the API port stops listening, relaunch daemon.
# Update window: while pending.json exists (apply-update.ps1 is swapping files),
#   do NOT relaunch, otherwise we race the updater and re-grab port 47832.

# watchdog.ps1 与 daemon.js/launcher.cmd 同处安装目录：用 $PSScriptRoot 推导安装目录，避免硬编码中文路径。
$InstallDir = $PSScriptRoot
$Profile = "workbuddy-cn"
$Port = 47832
$DataDir = "$env:APPDATA\JIUZHANG AI 管家"
$PendingFile = "$DataDir\update\pending.json"
$PidFile = "$DataDir\watchdog.pid"

if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
Set-Content -Path $PidFile -Value $PID -Force

while ($true) {
    Start-Sleep -Seconds 3
    if (Test-Path $PendingFile) { continue }

    $listening = netstat -ano | Select-String ":$Port\s+.*LISTENING"
    if (-not $listening) {
        $env:WBSWITCH_PROFILE = $Profile
        $env:WBSWITCH_PORT = "$Port"
        $env:WBSWITCH_APP_DIR = $InstallDir
        $env:NODE_NO_WARNINGS = "1"
        # 内嵌 runtime\node.exe（NSIS/green zip 均内嵌 Node，消除「用户需预装 Node」假设）
        Start-Process -FilePath "$InstallDir\runtime\node.exe" -ArgumentList "`"$InstallDir\daemon.js`" --experimental-sqlite" -WindowStyle Hidden
    }
}
