/**
 * What this OS can do for Realm, in one place (docs/platforms.md has the audit behind every row).
 *
 * Realm was built on a Mac, and a good part of it is the Mac itself: Accessibility for computer use,
 * the Simulator, the Keychain behind Touch ID, Metal for Laya, AppleScript behind the `mac` CLI, the
 * Dock, a notarized update feed, the window's material. On Linux and Windows those are not slower or
 * partial — they are absent — so a feature asks this table whether it exists, rather than each one
 * reading `process.platform` and deciding for itself what "not a Mac" means.
 *
 * Pure: the platform is an argument, so main, the server and the renderer read the same answer and a
 * test can ask about Windows from a Mac. Main and the server pass `process.platform`; the renderer
 * gets the table from the preload (`window.realm.capabilities`).
 */
export type PlatformCapabilities = {
  /** Which family this is. Anything that is neither a Mac nor Windows is treated as Linux. */
  os: "mac" | "windows" | "linux";
  /** An NSVisualEffectView behind the window, which the panes' translucency is drawn over. */
  windowMaterial: boolean;
  /** The traffic lights inset into the head row (`titleBarStyle: "hiddenInset"`). Elsewhere the
   *  window has no frame of its own and the system draws its controls over the head row's right end. */
  insetTrafficLights: boolean;
  /** Accessibility + Screen Recording, which computer use drives other apps through. */
  accessibility: boolean;
  /** Xcode's Simulator and a cabled iPhone. */
  simulators: boolean;
  /** The login Keychain and Touch ID. */
  keychain: boolean;
  /** Laya's local model, which trains and serves on Apple's GPU (MPS). */
  laya: boolean;
  /** The `mac` CLI and the Calendar/Mail/Notes permissions it asks for. */
  macCli: boolean;
  /** Alternate app icons set on the Dock tile. */
  dockIcons: boolean;
  /** The signed, notarized update feed `updater.ts` installs from. */
  autoUpdate: boolean;
  /** Quick Look previews and thumbnails (`qlmanage`). */
  quickLook: boolean;
  /** The system Share menu on a file. */
  shareMenu: boolean;
  /** Seatbelt (`sandbox-exec`), the execution sandbox's enforcement. */
  executionSandbox: boolean;
  /** What the OS calls the app that "Show in …" opens. */
  fileManager: string;
};

export function platformCapabilities(platform: string): PlatformCapabilities {
  const mac = platform === "darwin";
  const os = mac ? "mac" : platform === "win32" ? "windows" : "linux";
  return {
    os,
    windowMaterial: mac,
    insetTrafficLights: mac,
    accessibility: mac,
    simulators: mac,
    keychain: mac,
    laya: mac,
    macCli: mac,
    dockIcons: mac,
    autoUpdate: mac,
    quickLook: mac,
    shareMenu: mac,
    executionSandbox: mac,
    fileManager: mac ? "Finder" : os === "windows" ? "File Explorer" : "Files",
  };
}

/**
 * The shell a terminal opens when the person has not named one. `$SHELL` on a Mac or Linux (zsh is
 * the Mac's default since Catalina, bash nearly every Linux's); on Windows `$SHELL` is unset or names
 * a Git-Bash/MSYS path the rest of Windows cannot run, so it is PowerShell — `pwsh` would be the
 * newer one, but only Windows PowerShell is guaranteed to be installed — found through `ComSpec`'s
 * neighbour so a Windows on another drive still resolves.
 */
export function defaultShell(platform: string, env: Record<string, string | undefined>): string {
  if (platform === "win32") {
    const root = env.SystemRoot || env.windir || "C:\\Windows";
    return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  }
  return env.SHELL ?? (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

/**
 * The arguments a terminal's shell starts with. A login shell (`-l`) on a Mac and Linux, because a
 * non-login zsh never reads /etc/zprofile, so path_helper's PATH and the user's ~/.zprofile are
 * missing. PowerShell takes `-NoLogo` and cmd nothing; neither understands `-l`.
 *
 * With `command`, the shell runs that one command line and exits with its status — the terminal a
 * `realm run` opens, whose pty ending IS the command ending. Still a login shell, for the PATH.
 */
export function shellArgs(platform: string, shell: string, command?: string): string[] {
  if (platform !== "win32") return command === undefined ? ["-l"] : ["-l", "-c", command];
  if (/(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(shell)) return command === undefined ? ["-NoLogo"] : ["-NoLogo", "-Command", command];
  return command === undefined ? [] : ["/d", "/s", "/c", command];
}

/** PATH's separator, which is `;` on Windows because `:` is in every drive letter. */
export const pathDelimiter = (platform: string): string => (platform === "win32" ? ";" : ":");

/**
 * The file names a bare command resolves to, in the order a spawn would try them. On Windows a CLI
 * installed by npm is `claude.cmd`, a native one `claude.exe`, and the bare name is never what runs —
 * so each PATHEXT extension is tried first (the bare name last, for a path that already has one).
 */
export function executableNames(name: string, platform: string, env: Record<string, string | undefined>): string[] {
  if (platform !== "win32") return [name];
  if (/\.[a-z0-9]+$/i.test(name)) return [name];
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [...exts.map((e) => name + e.toLowerCase()), name];
}

/**
 * Whether a resolved executable has to be started through `cmd.exe`. Windows cannot exec a batch
 * file directly, and since the April 2024 fix for CVE-2024-27980 Node refuses to spawn a `.cmd` or
 * `.bat` without `shell: true` — which is how every npm-installed CLI on Windows is installed.
 */
export const needsShell = (bin: string, platform: string): boolean => platform === "win32" && /\.(cmd|bat)$/i.test(bin);
