; 作业扫码登记 — Windows 安装程序（NSIS 3，Unicode）
; 安装到用户目录 %LOCALAPPDATA%（无需管理员权限，适配教室电脑权限受限场景）
; 数据目录在安装目录内 data\，卸载时保留数据，避免误删作业记录
Unicode true
Name "作业扫码登记"
OutFile "..\dist\HomeworkScan_1.0.0_Windows_Setup.exe"
InstallDir "$LOCALAPPDATA\作业扫码登记"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"

; ---- 界面语言：简体中文 ----
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; 安装程序自身与快捷方式图标
Icon "..\src-tauri\icons\icon.ico"
UninstallIcon "..\src-tauri\icons\icon.ico"

Section "主程序" SecMain
  SetOutPath "$INSTDIR"

  ; 绿色包全部内容（node/node_modules/public/server.js/启动器/说明）
  File /r "..\dist\HoWoAuRe-win-portable\*"

  ; 桌面 + 开始菜单快捷方式（指向启动器，双击即用）
  CreateShortCut "$DESKTOP\作业扫码登记.lnk" "$INSTDIR\启动作业扫码.bat" "" "$INSTDIR\启动作业扫码.bat" 0 SW_SHOWMINIMIZED
  CreateDirectory "$SMPROGRAMS\作业扫码登记"
  CreateShortCut "$SMPROGRAMS\作业扫码登记\作业扫码登记.lnk" "$INSTDIR\启动作业扫码.bat" "" "$INSTDIR\启动作业扫码.bat" 0 SW_SHOWMINIMIZED
  CreateShortCut "$SMPROGRAMS\作业扫码登记\卸载作业扫码登记.lnk" "$INSTDIR\卸载作业扫码登记.exe"

  ; 卸载器
  WriteUninstaller "$INSTDIR\卸载作业扫码登记.exe"
SectionEnd

Section "Uninstall"
  ; 删除程序文件，保留 data\（作业数据目录）
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\public"
  Delete "$INSTDIR\server.js"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\启动作业扫码.bat"
  Delete "$INSTDIR\使用说明.txt"
  Delete "$INSTDIR\卸载作业扫码登记.exe"
  RMDir "$INSTDIR"

  Delete "$DESKTOP\作业扫码登记.lnk"
  RMDir /r "$SMPROGRAMS\作业扫码登记"
SectionEnd