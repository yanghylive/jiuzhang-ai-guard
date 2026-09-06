@echo off
rem WorkDaddy (JiuZhang AI Guardian) Windows launcher.
rem Starts daemon.js with --experimental-sqlite (node:sqlite, required on Windows).
rem Embedded runtime\node.exe (both NSIS and green zip bundle Node; no user Node required).
rem Uses %~dp0 to derive the install dir, avoiding hardcoded non-ASCII (GBK) paths.
setlocal
set "WBSWITCH_PROFILE=workbuddy-cn"
set "WBSWITCH_PORT=47832"
set "WBSWITCH_APP_DIR=%~dp0"
start "" /B "%~dp0runtime\node.exe" "%~dp0daemon.js" --experimental-sqlite
endlocal
