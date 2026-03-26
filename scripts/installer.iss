; =============================================================================
; Google Family Automation — Inno Setup Script
; 
; Prerequisites:
;   - Run scripts/build-release.ps1 first to generate the release/ folder
;   - Install Inno Setup 6: https://jrsoftware.org/isinfo.php
;
; Build:
;   iscc scripts\installer.iss
;
; Output:
;   installer-output\GFA-Setup-x.x.x.exe
; =============================================================================

#define MyAppName      "Google Family Automation"
#define MyAppShortName "GFA"
#define MyAppVersion   "1.0.0"
#define MyAppPublisher "GFA Team"
#define MyAppURL       "https://github.com"
#define MyAppExe       "Start-GFA.bat"

; Read version from file if available
#define ReleaseDir "..\release"

[Setup]
AppId={{A7C3F2B1-8D4E-4F6A-B2C5-1E9D3A7F8B2E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppShortName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
; Require admin for Program Files install
PrivilegesRequired=admin
; Installer output
OutputDir=..\installer-output
OutputBaseFilename=GFA-Setup-{#MyAppVersion}
; Compression
Compression=lzma2/ultra64
SolidCompression=yes
; Wizard appearance
WizardStyle=modern
; Minimum Windows 10
MinVersion=10.0.17763
; Always use the script defaults instead of inheriting a previous install's task choices
UsePreviousTasks=no
; Show license
; LicenseFile=..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "在桌面创建快捷方式（{#MyAppShortName}）"; GroupDescription: "其他任务："; Flags: checkedonce
Name: "autostart"; Description: "Windows 启动时自动运行 {#MyAppName}"; GroupDescription: "其他任务："; Flags: unchecked

[Files]
; All release files
Source: "{#ReleaseDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; Start Menu
Name: "{group}\启动 {#MyAppName}"; Filename: "{app}\Start-GFA.bat"; WorkingDir: "{app}"; IconFilename: "{app}\runtime\node.exe"
Name: "{group}\停止 {#MyAppName}"; Filename: "{app}\Stop-GFA.bat"; WorkingDir: "{app}"
Name: "{group}\查看状态"; Filename: "{app}\Status-GFA.bat"; WorkingDir: "{app}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"

; Desktop shortcut
Name: "{autodesktop}\启动 {#MyAppShortName}"; Filename: "{app}\Start-GFA.bat"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; Launch app after installation
Filename: "{app}\Start-GFA.bat"; Description: "立即启动 {#MyAppName}"; Flags: postinstall shellexec skipifsilent

[UninstallRun]
; Stop services before uninstall
Filename: "{app}\Stop-GFA.bat"; RunOnceId: "StopGFA"; Flags: shellexec waituntilterminated

[Registry]
; Auto-start entry (only if task selected)
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#MyAppShortName}"; ValueData: """{app}\Start-GFA.bat"""; Flags: uninsdeletevalue; Tasks: autostart

[Code]
// ── Pre-install: check for AdsPower ──────────────────────────────────────────
function AdsPowerInstalled(): Boolean;
var
  regValue: String;
begin
  Result := RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AdsPower', 'DisplayName', regValue)
         or RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AdsPower', 'DisplayName', regValue)
         or FileExists(ExpandConstant('{localappdata}\AdsPower\AdsPower.exe'))
         or FileExists(ExpandConstant('{pf}\AdsPower\AdsPower.exe'))
         or FileExists(ExpandConstant('{pf32}\AdsPower\AdsPower.exe'));
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not AdsPowerInstalled() then begin
    if WizardSilent then
      exit;

    if MsgBox('安装程序未检测到 AdsPower。' + #13#10 +
              'Google Family Automation 需要 AdsPower 才能工作。' + #13#10#13#10 +
              '是否继续安装？（你可以稍后再安装 AdsPower）', mbConfirmation, MB_YESNO) = IDNO then
      Result := False;
  end;
end;

// ── Post-install: check WinRM/ExecutionPolicy via registry isn't needed ───────
// The .bat files already use -ExecutionPolicy Bypass, so no extra step needed.
