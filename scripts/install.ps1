# WorkDaddy (JiuZhang AI Guardian) Windows installer.
# Responsibilities (mirror daemon.js IS_WIN contract):
#   1. Lay scripts/ into %LOCALAPPDATA%\Programs\JIUZHANG AI 管家
#   2. Generate launcher.cmd (starts daemon.js with --experimental-sqlite for node:sqlite)
#   3. Register watchdog.ps1 into HKCU Run key (autostart + keep-alive)
# Env contract (see daemon.js): WBSWITCH_PROFILE (default workbuddy-cn), WBSWITCH_PORT (default 47832).

param(
    [string]$SourceDir = $PSScriptRoot,
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\JIUZHANG AI 管家",
    [string]$Profile = "workbuddy-cn",
    [int]$Port = 47832
)

$ErrorActionPreference = "Stop"

Write-Host "[install] WorkDaddy -> $InstallDir (profile=$Profile port=$Port)"

# 1. Lay scripts/ contents into install dir (SourceDir points at the scripts/ directory itself)
if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
Copy-Item -Path (Join-Path $SourceDir "*") -Destination $InstallDir -Recurse -Force

# 2. Generate launcher.cmd（用 %~dp0 推导安装目录，避免在 ASCII 批处理里嵌入中文路径）
$launcher = "@echo off`r`n" +
"setlocal`r`n" +
"set `"WBSWITCH_PROFILE=$Profile`"`r`n" +
"set `"WBSWITCH_PORT=$Port`"`r`n" +
"set `"WBSWITCH_APP_DIR=%~dp0`"`r`n" +
"start `"`" /B node `"%~dp0daemon.js`" --experimental-sqlite`r`n" +
"endlocal`r`n"
Set-Content -Path (Join-Path $InstallDir "launcher.cmd") -Value $launcher -Encoding ASCII

# 3. Copy watchdog.ps1 (already in scripts/) and register autostart
$watchdog = Join-Path $InstallDir "watchdog.ps1"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
Set-ItemProperty -Path $runKey -Name "JiuZhangAIWatchdog" -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`""

Write-Host "[install] done. Launcher: $InstallDir\launcher.cmd"
