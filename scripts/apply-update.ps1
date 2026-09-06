# WorkDaddy (JiuZhang AI Guardian) Windows updater.
# Invoked via wscript.exe -> apply-update.vbs -> powershell -File apply-update.ps1
#   <srcPkg> <appDir> <port> <applyLog> <attemptId> <profileId>
# Contract (see daemon.js applyUpdate IS_WIN branch):
#   1. Kill watchdog + daemon precisely (taskkill WITHOUT /T).
#   2. Install new package by extension:
#      - .exe（主）: Start-Process Setup.exe /S /D=<appDir> -Wait 静默安装（NSIS），安装前备份 .old，失败回滚
#      - .zip（回退）: Expand-Archive 解包后替换 scripts（企业内网/绿色版）
#   3. Relaunch daemon（内嵌 runtime\node.exe，彻底消除「用户需预装 Node」假设）。
#   4. finally: clear pending.json (watchdog resumes keep-alive).

$SrcPkg    = $args[0]
$AppDir    = $args[1]
$Port      = if ($args[2]) { [int]$args[2] } else { 47832 }
$ApplyLog  = $args[3]
$AttemptId = $args[4]
$ProfileId = if ($args[5]) { $args[5] } else { "workbuddy-cn" }

$DataDir = "$env:APPDATA\JIUZHANG AI 管家"
$PendingFile = "$DataDir\update\pending.json"
$PidFile = "$DataDir\watchdog.pid"
$NodeExe = Join-Path $AppDir "runtime\node.exe"

function Log($msg) {
    if ($ApplyLog) { Add-Content -Path $ApplyLog -Value $msg }
}

Log "[apply] start attempt=$AttemptId srcPkg=$SrcPkg appDir=$AppDir port=$Port"

$StagedPkg = $null
$script:ApplyFailed = $false
try {
    # 0. 【E2E 实证修复 2026-08-27】NSIS 安装器自身位于含非 ASCII 字符的路径时，
    #    静默安装必失败退出码 2（云电脑真机矩阵实验：ASCII 路径 exit0；中文路径
    #    无论包版本与 /D= 参数均 exit2；而 /D= 中文目标目录不受影响）。
    #    DATA_DIR=%APPDATA%\JIUZHANG AI 管家 必含中文 -> 先把 srcPkg 暂存到 ProgramData
    #    纯 ASCII 路径再执行安装，finally 统一清理。
    $StagingDir = Join-Path $env:ProgramData 'JiuZhangUpdate'
    New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null
    $StagedPkg = Join-Path $StagingDir ("upd-" + [guid]::NewGuid().ToString('N').Substring(0,8) + '-' + (Split-Path $SrcPkg -Leaf))
    Copy-Item -Path $SrcPkg -Destination $StagedPkg -Force
    if (-not (Test-Path $StagedPkg)) { throw "更新包暂存到 ASCII 路径失败: $SrcPkg" }
    Log "[apply] staged pkg to ascii path: $StagedPkg"
    $SrcPkg = $StagedPkg

    # 1. Kill watchdog (by PID file) + daemon (by listening port) precisely, no /T.
    if (Test-Path $PidFile) {
        $wpid = (Get-Content $PidFile -Raw).Trim()
        if ($wpid) { Start-Process -FilePath "taskkill" -ArgumentList "/PID $wpid /F" -WindowStyle Hidden -Wait }
    }
    $conn = netstat -ano | Select-String ":$Port\s+.*LISTENING"
    foreach ($line in $conn) {
        $pidMatch = [regex]::Match($line.ToString(), "\s(\d+)\s*$")
        if ($pidMatch.Success) {
            $dpid = $pidMatch.Groups[1].Value
            Start-Process -FilePath "taskkill" -ArgumentList "/PID $dpid /F" -WindowStyle Hidden -Wait
        }
    }
    Start-Sleep -Seconds 2

    $ext = [System.IO.Path]::GetExtension($SrcPkg).ToLowerInvariant()

    if ($ext -eq ".exe") {
        # 2a. NSIS 静默安装（主链路）：
        #     - 备份 $AppDir -> $AppDir.old（供回滚）
        #     - Start-Process <exe> /S /D=<AppDir> -Wait（NSIS /D 必须为最后一个参数，见架构 §7.8）
        #     - 校验 daemon.js + runtime\node.exe 存在，失败回滚 .old
        $bak = "$AppDir.old"
        if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
        $hadApp = Test-Path $AppDir
        if ($hadApp) { Move-Item $AppDir $bak -Force }

        Log "[apply] exe 静默安装: $SrcPkg /S /D=$AppDir"
        $installArg = "/S /D=$AppDir"
        $p = Start-Process -FilePath $SrcPkg -ArgumentList $installArg -Wait -PassThru -WindowStyle Hidden
        Log "[apply] exe 安装退出码: $($p.ExitCode)"

        $daemonOk = Test-Path (Join-Path $AppDir "daemon.js")
        $nodeOk   = Test-Path $NodeExe
        if (-not ($daemonOk -and $nodeOk)) {
            Log "[apply] exe 安装后校验失败 daemonOk=$daemonOk nodeOk=$nodeOk -> 回滚 .old"
            if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
            if ($hadApp -and (Test-Path $bak)) { Move-Item $bak $AppDir -Force }
            throw "exe 静默安装失败（daemon.js/runtime\node.exe 缺失）"
        }
        if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
        Log "[apply] exe 静默安装完成"
    } elseif ($ext -eq ".zip") {
        # 2b. zip 便携回退（企业内网/绿色版）：解包后替换 scripts
        # 2026-08-29 复核 P1：与 exe 分支同等的安装后校验 + 失败回滚（原实现直接删 .old，失败不可恢复）
        $tmp = Join-Path $env:TEMP ("wd-update-" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        Expand-Archive -Path $SrcPkg -DestinationPath $tmp -Force
        if (-not (Test-Path (Join-Path $tmp "daemon.js")) -and -not (Test-Path (Join-Path $tmp "scripts\daemon.js"))) {
            throw "zip 解包后未找到 daemon.js，更新包内容无效（拒绝替换）"
        }

        $bak = "$AppDir.old"
        if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
        $hadApp = Test-Path $AppDir
        if ($hadApp) { Move-Item $AppDir $bak -Force }

        $scriptsTmp = Join-Path $tmp "scripts"
        if (Test-Path $scriptsTmp) {
            Move-Item $scriptsTmp $AppDir -Force
            Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            Move-Item $tmp $AppDir -Force
        }
        # 安装后校验：daemon.js 必须存在，否则回滚 .old
        $zipDaemonOk = Test-Path (Join-Path $AppDir "daemon.js")
        if (-not $zipDaemonOk) {
            Log "[apply] zip 安装后校验失败 -> 回滚 .old"
            if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
            if ($hadApp -and (Test-Path $bak)) { Move-Item $bak $AppDir -Force }
            throw "zip 替换失败（daemon.js 缺失），已回滚"
        }
        if (Test-Path $bak) { Remove-Item $bak -Recurse -Force -ErrorAction SilentlyContinue }
        Log "[apply] zip 解包替换完成（校验通过）"
    } else {
        throw "不支持的更新包类型: $ext（仅支持 .exe / .zip）"
    }

    Log "[apply] files swapped, relaunching daemon"

    # 3. Relaunch daemon（launcher.cmd 或内嵌 runtime\node.exe；缺 runtime 时回退 node 兼容旧绿色目录）
    $env:WBSWITCH_PROFILE = $ProfileId
    $env:WBSWITCH_PORT = "$Port"
    $env:WBSWITCH_APP_DIR = $AppDir
    $launcher = Join-Path $AppDir "launcher.cmd"
    if (Test-Path $launcher) {
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$launcher`"" -WindowStyle Hidden
    } elseif (Test-Path $NodeExe) {
        Start-Process -FilePath $NodeExe -ArgumentList "`"$AppDir\daemon.js`" --experimental-sqlite" -WindowStyle Hidden
    } else {
        Start-Process -FilePath "node" -ArgumentList "`"$AppDir\daemon.js`" --experimental-sqlite" -WindowStyle Hidden
    }
} catch {
    Log "[apply] error: $($_.Exception.Message)"
    # 2026-08-29 复核 P1：失败必须返回非零退出码（调用方/daemon 据此判定失败重试），
    # 且不删除 pending.json（保留更新意图，watchdog/下次启动可重试），仅在成功时清理。
    # 通过退出码 10 + 日志标记失败；finally 只清理 staging 包，pending 交由成功路径处理。
    $script:ApplyFailed = $true
    $host.SetShouldExit(10)
} finally {
    if ($StagedPkg -and (Test-Path $StagedPkg)) { Remove-Item $StagedPkg -Force -ErrorAction SilentlyContinue }
    if (-not $script:ApplyFailed -and (Test-Path $PendingFile)) { Remove-Item $PendingFile -Force }
    Log "[apply] done attempt=$AttemptId failed=$([bool]$script:ApplyFailed)"
}
