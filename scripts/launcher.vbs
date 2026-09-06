Option Explicit
' JiuZhang AI Guardian - silent launcher (wscript, no console window).
' Same as launcher.cmd but starts daemon.js with a hidden window, so no black
' terminal pops up when the user double-clicks the Start Menu shortcut.
Dim shell, fso, appDir, nodeExe, daemonJs, env
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = appDir & "\runtime\node.exe"
daemonJs = appDir & "\daemon.js"
Set env = shell.Environment("Process")
env("WBSWITCH_PROFILE") = "workbuddy-cn"
env("WBSWITCH_PORT") = "47832"
env("WBSWITCH_APP_DIR") = appDir
env("NODE_NO_WARNINGS") = "1"
shell.Run """" & nodeExe & """ """ & daemonJs & """ --experimental-sqlite", 0, False
