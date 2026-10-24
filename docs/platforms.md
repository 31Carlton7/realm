# Realm on Linux and Windows

Realm was built as a Mac app. 2.3 makes the core app ready for Linux and Windows: sessions,
terminals, the browser pane, documents, connections and MCP, settings, the library, and schedules.
The features that exist only because of macOS are hidden there rather than offered and refused.
Since 2.5 the Linux AppImage and deb have been launched and driven on GitHub's x86_64 Ubuntu runners, and the packaged
`realm` command runs on Linux, macOS and Windows runners; see "What has been run" below.

This page lists every macOS assumption the 2.3 audit found, where it lives, and what was decided
about it. File and line references are to the 2.3 tree. A line marked *(base)* is from 2.2.0 and
was not edited.

## How it is gated

One table answers whether this OS has a thing: `platformCapabilities(platform)` in
`packages/contracts/src/platform.ts`. Each part of the app reads it in its own way:

- **Main** builds it once from `process.platform` (`apps/desktop/src/main/index.ts:86`).
- **The server** calls it where a service has to know.
- **The renderer** gets it from the preload (`window.realm.capabilities`) and reads it through
  `capabilities()` in `apps/desktop/src/renderer/src/platform.ts`. With no bridge (jsdom), that
  function answers for a Mac, so every component test still sees the app it was written against.

| Capability | Mac | Linux | Windows | What reads it |
|---|---|---|---|---|
| `windowMaterial` | yes | no | no | window chrome (vibrancy) |
| `insetTrafficLights` | yes | no | no | window chrome, renderer's head row (`data-window-controls`) |
| `accessibility` | yes | no | no | Settings ▸ Computer use, Permissions |
| `simulators` | yes | no | no | side panel "+", new-tab page, palette, Settings ▸ Lab |
| `keychain` | yes | no | no | reserved for the passwords stream (Touch ID / Keychain) |
| `laya` | yes | no | no | Settings ▸ Engines ▸ Laya, server's Laya runtime |
| `macCli` | yes | no | no | Settings ▸ Permissions |
| `dockIcons` | yes | no | no | Settings ▸ Appearance ▸ App icon |
| `autoUpdate` | yes | no | no | `updaterDecision` (`reason: "platform"`) |
| `quickLook` | yes | no | no | Quick Look on Space, file menus |
| `shareMenu` | yes | no | no | Share in file menus |
| `executionSandbox` | yes | no | no | documented; the server already refuses Seatbelt off darwin |
| `fileManager` | Finder | Files | File Explorer | "Reveal in …" rows |

Beside the table there are four pure helpers that core paths use:
- `defaultShell`
- `shellArgs`
- `pathDelimiter`
- `executableNames` / `needsShell`

The adapters package builds `findExecutable`, `spawnTarget` and `killTree` from them
(`packages/adapters/src/spawn-target.ts`). Every test injects the platform; none relies on the host.

## Decisions, by area

### Window chrome

- **The window frame** (`apps/desktop/src/main/window-chrome.ts`, used at `index.ts:480`).
  - Before, the window was always `titleBarStyle: "hiddenInset"` with `trafficLightPosition` at {12, 14} *(base index.ts:473)*.
  - **Mac:** unchanged: inset traffic lights and sidebar vibrancy.
  - **Linux and Windows:** the window is frameless (`titleBarStyle: "hidden"`). The system draws its minimise, maximise and close over the right end of the 40px head row (`titleBarOverlay`, which is clear, with glyphs in the appearance's ink). There are no Mac offsets.
  - The overlay's glyph colour follows `nativeTheme` (`index.ts:1715`).
- **Head-row CSS** (`styles.css`, the `data-window-controls="overlay"` block after `.window-trail`).
  - `--lights-end` drops to 2px, so back and forward start 12px in.
  - The side-pane toggle, the top-right pane bar and the media viewer's head move left by the controls' width. That width is read from `env(titlebar-area-*)`, falling back to Windows' 138px.
- **Window material:** already Mac-only *(base index.ts:480)*; kept.

### Keyboard

- **The `mod` key** (`packages/contracts/src/key-event.ts:70`): `mod` is Ctrl on Linux and Windows, and Ctrl's own bindings move to Super/Win.
  - Before, `chordFromEvent` mapped `metaKey` to `mod` everywhere, so every shortcut on Windows sat on the Win key.
  - The renderer passes its platform (`keys/use-keybindings.ts`). Main passes its own (`app-menu.ts` `shouldPageOwn`).
- **Menu accelerators** (`app-menu.ts` `acceleratorFor`): `Control`/`Super` off a Mac.
- **Shortcut display** (`keybindings.ts` `displayKeyChord`): reads "Ctrl+Shift+F" off a Mac. The renderer sets the OS once at boot (`platform.ts` `applyPlatform`). The tooltip chord parser (`tooltips.ts`) and the OS-menu accelerator parser (`components/native-menu.ts`) read that form too.
- **Not done:** the renderer still checks `metaKey` directly in about 11 places for secondary gestures. On Linux and Windows those are Super/Win-only:
  - ⌘-click to open beside, in `SessionRows.tsx`, `ActivityCard.tsx`, `TeamRows.tsx` and `SessionsList.tsx`
  - ⌘F, ⌘⌫ and ⌘1–9 inside `SessionsList.tsx`, `PermissionCard.tsx` and `ModelPicker.tsx`

  About 38 hard-coded "⌘" strings in titles still read as Mac glyphs. Both are listed under Open work.

### Terminals and shells

- **Default shell** (`apps/server/src/terminals/manager.ts:29`, `service.ts:240` *(base)*): `$SHELL ?? /bin/zsh` became `defaultShell`.
  - Mac: `$SHELL`, else zsh.
  - Linux: `$SHELL`, else bash.
  - Windows: Windows PowerShell under `SystemRoot`.
- **Shell arguments** (`manager.ts:33` *(base)*): `-l` on a Mac and Linux, `-NoLogo` for PowerShell, nothing for cmd.
- **Shells named as programs** (`packages/contracts/src/terminal-programs.ts`): `powershell` and `cmd` count as shells, and backslash paths and `.exe` are read, so a Windows prompt is not named as a program.
- **Typing a script** (`apps/server/src/scripts/service.ts`): Return is `\r` on Windows, where `\n` is Ctrl+J.
- **Finding the foreground process** (`terminals/foreground.ts:149` *(base)*): this uses `ps -t`, which works with Linux procps. Windows never reaches it, because `ptsName` is null there. Kept.

### PATH and finding CLIs

- **Login-shell PATH** (`apps/desktop/src/main/login-shell-path.ts`).
  - Before, the merge split PATH on `:`, which cuts `C:\…` apart.
  - Now it splits on `pathDelimiter`.
  - Windows asks no login shell, because Explorer already gives a GUI app the user's PATH.
  - Linux falls back to `/usr/local/bin`, Linuxbrew and `~/.local/bin`, never to Homebrew's Mac directory.
- **Finding agent CLIs** (`claude/probe.ts`, `cli/provenance.ts` `resolveInstall`).
  - Before, they used a bare-name lookup with `X_OK`. On Windows that found npm's extensionless sh shim, or nothing.
  - Now Windows looks up each PATHEXT extension.
  - Realm's own Claude resolves to `claude.exe` on Windows.
- **Starting a CLI** (`codex/probe.ts`, `acp/probe.ts`, `jsonrpc/stdio.ts`, `cli/install.ts`, `agents/signin-service.ts`, `mcp/live-check.ts`).
  - Before, these spawned the bare name. Node refuses to spawn a `.cmd` on Windows, and every npm CLI there is one.
  - Now they all go through `spawnTarget`, which escapes arguments through `cmd.exe` cross-spawn's way and sets `windowsHide`.
  - The sign-in pty passes the command line through as one string.
- **Ending a CLI** (`stdio.ts` reap, installer timeout, MCP check): `killTree` runs `taskkill /T /F` on Windows, because a CLI started through cmd.exe is that shell's child.
- **Install routes** (`apps/server/src/cli/install.ts`): the `curl … | bash` routes are not offered on Windows. npm and uv routes stay.
- **Sign-in command** (`apps/server/src/browsers/signin-flow.ts`): the typed sign-in for Realm's own `claude` is `& '…'` in PowerShell.
- **Console windows:** git and gh calls (`workspace/git-exec.ts`, `git-info.ts`, `git-write.ts`, `code-review/gh.ts`) and the server spawn (`apps/desktop/src/main/server-process.ts`) set `windowsHide`. Otherwise each call opens a console window.

### Server lifecycle

- **Daemon mode** (`apps/desktop/src/main/daemon.ts` `daemonModeEnabled`) is Mac-only by default.
  - An AppImage's mount disappears when the app exits, taking the daemon's executable with it.
  - On Windows a running daemon locks the install folder, so the installer can neither update nor remove Realm.
  - On Linux and Windows the server is the app's child. `REALM_DAEMON=1` still opts in.
- **Stopping the server on Windows** (`index.ts:2173`, `apps/server/src/rpc/methods.ts`).
  - On Windows SIGTERM is TerminateProcess, so the server's shutdown never ran.
  - Now quit asks the server to stop over its socket (`daemon.stop`), and `daemon.stop` emits SIGTERM to itself instead of signalling.
- **Reopening a window** (`index.ts:1537`): Linux and Windows have no `activate` event, so launching Realm again (`second-instance`) brings a window back.
- **Tray** (`tray-icon.ts`, `index.ts:191`): a colour app icon off a Mac, where a template image is black on a dark panel. `setTitle` is Mac-only, so the counts stay in the tooltip.
- **Notifications** (`index.ts:89`): `setAppUserModelId` is set on Windows, which shows toasts only for an app it can name.

### Paths

- **Absolute-path checks** (main's downloads `index.ts:968`, `browser-controls.ts:53`, `browser-agent-host.ts:745`):
  - Before, these used `startsWith("/")`, which refuses every Windows folder.
  - Now they use `isAbsolute`.
- **Mention refs** (`packages/contracts/src/mention-refs.ts`):
  - The absolute-path schema accepts `C:\…` and `\\server\share`.
  - `isSecretPath` splits on either separator, so a Windows `.ssh` is still withheld.
- **Repo escape check** (`apps/server/src/workspace/git-diff.ts` `assertRepoRelative`): it splits on either separator, so `..\..\x` cannot leave the checkout.
- **Skill staging** (`apps/server/src/skills/service.ts`): skills are staged with a junction on Windows. A symlink there needs admin rights or Developer Mode.
- **ACP links** (`packages/adapters/src/acp/acp-adapter.ts`): links use `pathToFileURL` on Windows. The Mac keeps its exact old form.
- **Memory repos** (`apps/server/src/paths.ts` `appDataDir`, used at `app.ts:1080`): the fallback root is AppData on Windows and XDG's data home on Linux. It used to be `~/Library/Application Support` on every OS.
- **Home check** (`app.ts:1069`): `holdsUserHome` no longer counts a space on another drive as holding the home folder.
- **Realm home** (`apps/server/src/paths.ts` *(base)*): `~/Realm` via `homedir()` on every OS. Kept.

### Mac-only features: hidden

- **Computer use, Accessibility, Permissions, the `mac` CLI, Lab:**
  - Mac-only pieces: `computer-use-helper.ts`, `tcc.ts`, `mac-access.ts`, `computer-access.ts`, `lab-host.ts` and the Swift helpers in `apps/desktop/native/`.
  - The locators already return null off darwin *(base)*.
  - Settings' Computer pages are left out of the rail, out of search, and out of a direct request (`settings-index.ts` `tabAvailable`).
- **Simulators** (`apps/server/src/simulators/`): left out of the side panel's "+", the new-tab page and the palette (`side-tools.ts` `sideToolOffered`).
  - Android's SDK path is Mac-shaped (`simulators/android.ts:35` *(base)*), so it goes too.
- **Laya:** the Engines section is hidden, and `realLayaRuntime` reports itself unavailable off a Mac. That covers arm64 Linux and arm64 Windows too.
- **Dock icons** (`AppIconPicker.tsx` `canChooseAppIcon`): hidden.
- **Quick Look and Share** (`file-actions.ts`): hidden. Thumbnails already returned null off darwin (`attachments.ts:136` *(base)*).
- **Look Up** in the text menu (`text-context-menu.ts`): offered on a Mac only.
- **Auto-update** (`updater.ts`): `reason: "platform"`. Settings ▸ General says to install new versions from the releases page.
- **Execution sandbox** (`apps/server/src/sandbox/service.ts:194` *(base)*): already reports `unsupported_platform` off darwin. Kept.
- **Keychain, Touch ID, passkeys and saved sign-ins** (`secret-store.ts`, `passkeys.ts`): owned by the passwords stream. That stream gates them itself. This stream only adds the `keychain` capability for it to read.
- **Swift helpers** (`scripts/build-native.mjs:24` *(base)*): build-native already exits on non-darwin. `stage-pack.mjs` no longer warns about helpers that cannot exist there.

### Packaging

- **`electron-builder.yml`.**
  - Linux: `AppImage` (static runtime, zstd) and `deb`. Category Development, executable `realm`. The deb's `/usr/bin/realm`
    opens the window; the command line is `/opt/Realm/resources/bin/realm`.
  - Every OS: `../server/bin` is copied to `resources/bin`, so the packaged app carries the `realm` command.
  - Windows: `nsis`, assisted, per-user, with the install folder choosable.
    - `nsis.include` (`resources/installer.nsh`) lets an update replace a 2.3.0 to 2.5.0 install. An update runs the old
      install's own uninstaller with `--updated`, which first moves every file into `%TEMP%\nsXXXX.tmp\old-install`; those
      versions' deepest server paths come to about 261 characters there, so it exits 2 and the update stopped at "Failed to
      uninstall old application files". The installer then removes the old `resources\server` (`rd /s /q \\?\…`) and
      runs the old uninstaller again.
  - Both use `build/icon.png`, the 1024px source of the `.icns`, and electron-builder makes the hicolor set and the `.ico` from it.
  - The `mac` block is unchanged. The schema was validated locally with app-builder-lib's own validator.
- **`stage-pack.mjs`** stages for the OS it runs on:
  - that OS's node-pty prebuilds (it used to keep `darwin-*` only)
  - the colour tray icon and `build/icon.png` off a Mac
  - no iOS device runner off a Mac
  - `pnpm` through a shell on Windows
  - on Windows, the server's `node_modules` as real directories (`lib/hoist-modules.mjs`). pnpm links each package's
    dependencies in with junctions, which hold absolute paths, and NSIS's 7-Zip follows them. Every installer from 2.3.0
    to 2.5.0 held a copy at each link, and its server could not start.
  - on every OS, a check that every package the server imports resolves inside the staged tree, with no link at all on
    Windows (`lib/unresolved-modules.mjs`). The build stops when one does not.
- **`pack.mjs`** starts `electron-builder.cmd` through a shell on Windows.
- **Scripts:** `pnpm --filter @realm/desktop dist:linux` and `dist:win` in `apps/desktop/package.json`. `homepage` was added because a deb needs a project URL.
- **CI:** `.github/workflows/build-desktop.yml` runs on macOS, Ubuntu and Windows. Each job installs, typechecks, tests, builds and packages unsigned, then uploads the artifacts. Nothing is published.
  - The Mac job is gated on the whole suite.
  - The Linux and Windows jobs are gated on the platform-branch tests, and run the whole suite for information only, since it was written against POSIX hosts.

## What has been run

- **Linux (Ubuntu 24.04, x86_64, GitHub's 4 vCPU runner), from the packaged app** (`.github/workflows/linux-bench.yml` on the
  `ci/linux-bench` branch): the AppImage opens its first window in about 3.3 s with no account wall, on AppImage's static
  runtime (no libfuse2 needed); the deb installs with apt; `resources/bin/realm serve` runs with no display, and the
  agent-orchestrator-bench stub lane (six worktree tasks at once, a killed task, the merge check) passes from it.
- **macOS runner, from the released dmg:** the packaged `realm` command (`resources/bin/realm`) runs a command in a
  worktree end to end.
- **Windows (GitHub's windows-latest runner), installed** (`.github/workflows/windows-installer.yml` on the
  `ci/windows-installer` branch): the NSIS installer, installed silently on a runner that did not build it.
  `resources\bin\realm.cmd serve` is up in about a second, `realm status` names the release, a command runs in a
  worktree of its own in a ConPTY terminal, the Agent SDK finds its `claude.exe`, and the installed `Realm.exe` starts
  its server. The same installer updates an installed 2.5.0, 2.4.0 or itself, and serves afterwards.
  - The published 2.3.0, 2.4.0 and 2.5.0 installers fail all of it: their server stops at "Cannot find package
    'pkce-challenge'", and the SDK cannot find `claude.exe`. `realm` had passed from `win-unpacked`, but only on the
    machine that built it, whose `.pack-stage` its junctions still pointed into.

## What is not verified

Beyond the runs above, the Windows and Linux branches are covered by unit tests with the platform injected, and were otherwise checked by reading. The places most likely to need a fix on first contact:

- The window-controls overlay on Linux:
  - `titleBarOverlay` support differs by Electron version and window manager.
  - `env(titlebar-area-*)` may be absent, which leaves the 138px fallback.
- `cmd.exe` escaping for unusual arguments. It follows cross-spawn's rules but has not met a real shim.
- node-pty under ConPTY:
  - the sign-in pty's string command line
  - `kill()` with no signal
- The deb's maintainer field is "Charm Technologies" with no email. fpm accepts that, but some repositories expect an address.

## Open work

- Make the whole test suite portable: live ptys under `/bin/sh` and POSIX fixture paths. Then gate Linux and Windows on all of it.
- Put the renderer's direct `metaKey` checks behind the platform's `mod`, and its hard-coded "⌘" titles behind `displayKeyChord`.
- Name the OS file manager in the remaining "Show in Finder" rows, which live in panes other streams own:
  - `SpaceSections.tsx`, `MemoryPanel.tsx`, `MemoryRepoRow.tsx`, `LibraryPage.tsx`, `ProfilePage.tsx`, `SkillViewer.tsx`
  - `RecordPages.tsx`, `ReviewPane.tsx`, `DocumentsPane.tsx`, `SessionFiles.tsx`, `MediaView.tsx`, `MediaViewer.tsx`, `KeybindingsPanel.tsx`
- Find editors on Linux and Windows (`editors.ts` only knows `/Applications`).
- Find installed apps on Linux and Windows for the `@` list (`installed-apps.ts`).
- Find QEMU on Linux (`machines/qemu-locator.ts` checks Mac prefixes and HVF).
- Decide whether Linux and Windows get an update feed (AppImage can self-update; NSIS through electron-updater).
- Signing: Authenticode on Windows, and AppImage signatures if wanted.
