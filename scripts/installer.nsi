; ============================================================================
; JIUZHANG AI（九章AI管家）Windows 安装器 — MUI2 官方向导 + 品牌位图
; 2026-08-27 v2：回退官方 MUI2 机制（nsDialogs 自绘在真机两轮翻车：裁切→空白）。
; 品牌化：欢迎/完成页 164x314 侧栏图 + header 150x57 横幅（assets/installer/）。
; 契约不变：per-user 安装 %LOCALAPPDATA%\Programs\九章AI管家、HKCU Run 自启、
;           内嵌 runtime、/S 静默跳过 UI（apply-update.ps1 的 /S /D= 零影响）。
; ============================================================================

Unicode true
SetCompressor /SOLID lzma
XPStyle on
CRCCheck on
RequestExecutionLevel user
BrandingText "JIUZHANG AI"

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef APP_NAME
  !define APP_NAME "九章AI管家"
!endif
; 安装目录名必须 ASCII（NSIS 对中文路径静默失败，2026-08-29 装机 E2E 抓到）。
; 1.0.2：统一为 JiuZhangAI（与 daemon.js WIN_INSTALL_NAME 一致，修复 build-win.js 未传
; INSTALL_DIR_NAME 导致实际装进 WorkDaddy、自动更新替换目标对不上的 P0 链路断问题）。
!ifndef INSTALL_DIR_NAME
  !define INSTALL_DIR_NAME "JiuZhangAI"
!endif
!ifndef STAGE_DIR
  !error "STAGE_DIR 未定义（build-win.js 会传入打包目录绝对路径）"
!endif
!ifndef ASSETS_DIR
  !define ASSETS_DIR "..\assets"
!endif

!include "MUI2.nsh"
!include "FileFunc.nsh"

Icon "${STAGE_DIR}/jiuzhang.ico"
UninstallIcon "${STAGE_DIR}/jiuzhang.ico"

Name "${APP_NAME}"
OutFile "${APP_NAME}-Setup-${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${INSTALL_DIR_NAME}"
InstallDirRegKey HKCU "Software\${INSTALL_DIR_NAME}" "InstallDir"

!define REG_APP "Software\${APP_NAME}"
!define REG_RUN "Software\Microsoft\Windows\CurrentVersion\Run"

; ---- 品牌位图（官方尺寸）----
!define MUI_WELCOMEFINISHPAGE_BITMAP "${ASSETS_DIR}\installer\welcome_side.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${ASSETS_DIR}\installer\welcome_side.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${ASSETS_DIR}\installer\header.bmp"
!define MUI_HEADERIMAGE_RIGHT

; ---- 欢迎页文案 ----
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT "安装向导将引导您完成 ${APP_NAME} 的安装过程。$\r$\n$\r$\n在开始之前，建议关闭其他应用程序以获取更好的安装体验。"

; ---- 许可页：勾选同意 gate ----
!define MUI_LICENSEPAGE_TEXT_TOP "请阅读以下许可协议。按 PgDn 查看协议其余部分。"
!define MUI_LICENSEPAGE_CHECKBOX

; ---- 完成页：立即运行（launcher.vbs 静默启动不弹终端）----
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 ${APP_NAME}"
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "${APP_NAME} 已成功安装到您的计算机。"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${ASSETS_DIR}\LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"

Function LaunchApp
  Exec '"$SYSDIR\wscript.exe" "$INSTDIR\launcher.vbs"'
FunctionEnd

; ============================================================================
; 安装段（契约不变）
; ============================================================================
Section "Install" SEC01
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; 1. 铺目录（静默更新场景由 apply-update.ps1 先杀进程）
  File /r "${STAGE_DIR}\*.*"
  File "/oname=$INSTDIR\LICENSE.txt" "${ASSETS_DIR}\LICENSE.txt"

  ; 2. 安装目录与版本
  WriteRegStr HKCU "${REG_APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${REG_APP}" "Version" "${APP_VERSION}"

  ; 3. 卸载器
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; 4. 开机常驻：HKCU Run（等价 launchd；与 install.ps1 契约一致）
  WriteRegStr HKCU "${REG_RUN}" "JiuZhangAIWatchdog" 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\watchdog.ps1"'
  ; 1.0.2：升级兼容——清理旧品牌 Run 键（WorkDaddyWatchdog），防双 watchdog 开机竞争
  DeleteRegValue HKCU "${REG_RUN}" "WorkDaddyWatchdog"

  ; 5. 开始菜单快捷方式（VBS 静默启动，不弹终端）
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\launcher.vbs"' "$INSTDIR\jiuzhang.ico" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"

  ; 6. 桌面快捷方式（VBS 静默启动，图标同款）
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\launcher.vbs"' "$INSTDIR\jiuzhang.ico" 0
SectionEnd

; ============================================================================
; 卸载
; ============================================================================
Section "Uninstall"
  DeleteRegValue HKCU "${REG_RUN}" "JiuZhangAIWatchdog"
  DeleteRegKey HKCU "${REG_APP}"

  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\uninstall.ps1" -InstallDir "$INSTDIR" -Port 47832'

  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"

  RMDir /r "$INSTDIR"
SectionEnd
