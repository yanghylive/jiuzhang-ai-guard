# WorkDaddy (JiuZhang AI Guardian) Windows uninstall helper.
# Called by the NSIS uninstaller BEFORE files are removed:
#   powershell -File uninstall.ps1 -InstallDir <dir> -Port 47832
# Stops watchdog (by pid file) + daemon (by listening port) precisely (taskkill WITHOUT /T),
# mirroring the kill block in apply-update.ps1. User data (%APPDATA%\JIUZHANG AI 管家) is NOT removed here.
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\JIUZHANG AI 管家",
    [int]$Port = 47832
)

$DataDir = "$env:APPDATA\JIUZHANG AI 管家"
$PidFile = "$DataDir\watchdog.pid"

# 1. Kill watchdog by pid file.
if (Test-Path $PidFile) {
    $wpid = (Get-Content $PidFile -Raw).Trim()
    if ($wpid) { Start-Process -FilePath "taskkill" -ArgumentList "/PID $wpid /F" -WindowStyle Hidden -Wait }
}

# 2. Kill daemon by listening port.
$conn = netstat -ano | Select-String ":$Port\s+.*LISTENING"
foreach ($line in $conn) {
    $m = [regex]::Match($line.ToString(), "\s(\d+)\s*$")
    if ($m.Success) {
        Start-Process -FilePath "taskkill" -ArgumentList "/PID $($m.Groups[1].Value) /F" -WindowStyle Hidden -Wait
    }
}
