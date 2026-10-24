; Included by electron-builder's NSIS installer (electron-builder.yml `nsis.include`).
;
; An update runs the old install's own uninstaller, with --updated, which first moves every file of the
; old install into %TEMP%\nsXXXX.tmp\old-install. Realm 2.3.0 to 2.5.0 installed every link in the
; server's pnpm node_modules as a copy (apps/desktop/scripts/lib/hoist-modules.mjs says why), and their
; deepest paths are too long to move there: that uninstaller gives up with 2, and the update would stop at
; "Failed to uninstall old application files". Their server never started, so its folder goes first, by a
; route that takes long paths, and the uninstaller runs again. Any other failure ends as it always has.
!macro customUnInstallCheck
  ${if} $R0 != 0
    ReadRegStr $R9 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ; A missing value sets the error flag, which below means the uninstaller could not be started.
    ClearErrors
    ${if} $R9 != ""
    ${andIf} ${FileExists} "$R9\resources\server\node_modules\.pnpm\*.*"
      DetailPrint `Removing the old server, whose paths its uninstaller cannot move: $R9\resources\server`
      nsExec::Exec `"$SYSDIR\cmd.exe" /C rd /s /q "\\?\$R9\resources\server"`
      Pop $R8
      Push SHELL_CONTEXT
      Call uninstallOldVersion
    ${endif}
  ${endif}

  ; From here, what electron-builder's handleUninstallResult does when this macro is not defined.
  IfErrors 0 +3
  DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  Return

  ${if} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${endif}
!macroend
