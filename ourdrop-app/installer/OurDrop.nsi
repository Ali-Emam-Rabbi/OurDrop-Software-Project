; OurDrop v60 — per-user Windows installer (NSIS).
; One Setup exe, like other consumer software: installs into
; %LOCALAPPDATA%\Programs\OurDrop, adds Start Menu + Desktop
; shortcuts, an uninstaller and Add/Remove Programs entries.
;
; The installer deliberately does NOT write the Startup (Run) entry:
; the app registers its own autostart on first run (with --hidden),
; so the in-app Settings toggle stays the single source of truth.
; The uninstaller only REMOVES that Run value again, because a
; deleted exe cannot clean it up itself.
;
; Build (makensis):
;   makensis -DPAYLOAD=<abs path to release\OurDrop-PC-v60> ^
;            -DOUT=<abs path to OurDrop-Setup-v60.exe> OurDrop.nsi

Unicode True
!include "MUI2.nsh"

!ifndef PAYLOAD
  !define PAYLOAD "..\release\OurDrop-PC-v60"
!endif
!ifndef OUT
  !define OUT "..\..\your_files\ourdrop-windows\OurDrop-Setup-v60.exe"
!endif

Name "OurDrop"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\OurDrop"
InstallDirRegKey HKCU "Software\OurDrop" "InstallDir"
RequestExecutionLevel user
; v56: NON-solid LZMA (was /SOLID in v53/v54). Per-file compression
; blocks stream out independently at install time and NSIS stores
; already-incompressible files raw, which cuts the extraction cost
; Rabbi felt on real Windows — for +1.6% download size. zlib was
; measured ~3.6x faster still but pushed the Setup to ~159 MB
; (+39%), so it was rejected. Sandbox codec simulation and the
; full numbers: REGRESSION.md v56 section.
SetCompressor lzma
SetCompressorDictSize 32
Icon "..\build\icon.ico"
UninstallIcon "..\build\icon.ico"

VIProductVersion "60.0.0.0"
VIAddVersionKey "ProductName" "OurDrop"
VIAddVersionKey "CompanyName" "Ali Emam Rabbi & Sadhin Khan"
VIAddVersionKey "Publisher" "Ali Emam Rabbi & Sadhin Khan"
VIAddVersionKey "FileVersion" "60.0.0"
VIAddVersionKey "FileDescription" "OurDrop Setup"
VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 Ali Emam Rabbi & Sadhin Khan"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\OurDrop.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Run OurDrop"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  ; If an older OurDrop is running, close it first — its locked
  ; files would otherwise fail the copy below.
  nsExec::Exec 'taskkill /IM OurDrop.exe /F'
  Sleep 800

  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*.*"

  CreateDirectory "$SMPROGRAMS\OurDrop"
  CreateShortcut "$SMPROGRAMS\OurDrop\OurDrop.lnk" "$INSTDIR\OurDrop.exe"
  CreateShortcut "$DESKTOP\OurDrop.lnk" "$INSTDIR\OurDrop.exe"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\OurDrop" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OurDrop" "DisplayName" "OurDrop"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OurDrop" "DisplayVersion" "60.0.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OurDrop" "Publisher" "Ali Emam Rabbi & Sadhin Khan"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OurDrop" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OurDrop" "DisplayIcon" "$INSTDIR\OurDrop.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OurDrop" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OurDrop" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OurDrop" "NoRepair" 1
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM OurDrop.exe /F'
  Sleep 800

  Delete "$DESKTOP\OurDrop.lnk"
  Delete "$SMPROGRAMS\OurDrop\OurDrop.lnk"
  RMDir "$SMPROGRAMS\OurDrop"

  ; Remove the app's own autostart entry (registered by the app via
  ; the Settings toggle) so no dead Startup entry survives.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OurDrop"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OurDrop"
  DeleteRegKey HKCU "Software\OurDrop"

  ; Payload files. The final RMDir only succeeds if the folder is
  ; empty — anything the user kept there (e.g. an "OurDrop Files"
  ; folder with received files) is left untouched on purpose.
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\OurDrop.exe"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\PORO-AMAY.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
