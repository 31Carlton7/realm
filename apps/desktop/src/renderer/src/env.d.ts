/// <reference types="vite/client" />
interface ScrollPhaseMessage { phase: string; momentum: string; dx: number; dy: number; ts: number }
/** Mirrors PickedFile in the preload: `size` and `name` are for the prompter's own checks; only
 *  `path` and `mime` ever reach `sessions.send`. */
interface PickedFile { path: string; mime: string; name: string; size: number }
/** One row of a menu the OS draws — mirrors `NativeMenuItem` in main/native-menu.ts, the other end of
 *  the call. A row with an `id` answers it when chosen; a row without one is a line of information. */
type NativeMenuItem =
  | { type: "separator" }
  | { separator: true }
  | { id?: string; label: string; enabled?: boolean; checked?: boolean; accelerator?: string; toolTip?: string; icon?: string; submenu?: NativeMenuItem[] };
interface Window {
  realm: {
    port: number; home: string;
    /** The RPC token from the preload, sent as the `realm.<token>` subprotocol on every dial. */
    token: string;
    /** The profile this window was opened for (Plan 27 Phase 2: a window per profile), or undefined for
     *  the first window, which shows whichever profile its saved space is in. Boot lands in it. */
    profileId?: string;
    /** A window per profile. Optional like every bridge: jsdom has none. */
    windows?: {
      openProfile(profileId: string): Promise<void>;
      focusProfile(profileId: string): Promise<boolean>;
      setProfile(profileId: string | null): void;
    };
    /** The window's page zoom, 1 at 100% (`webFrame.getZoomFactor`). Optional like every other
     *  bridge: jsdom has none, and a renderer without it reads as 100%, which is what the app
     *  assumed before anything asked. */
    zoomFactor?(): number;
    /** A session picked from the menu-bar item while the window was closed. */
    onOpenSession(cb: (target: { sessionId: string; spaceId: string | null }) => void): () => void;
    /** Quit Realm and stop every agent. Confirms in main when anything is working. */
    quitAndStopAgents(): Promise<void>;
    /** The agent server's health, as main sees it. Replayed on every new window. */
    onDaemonState(cb: (state: { kind: string; attempt?: number; logPath?: string; why?: string }) => void): () => void;
    /** Whether the window is key (AppKit's sense: it has the keyboard), as main sees it. */
    onWindowKey(cb: (key: boolean) => void): () => void;
    isWindowKey(): Promise<boolean>;
    setMenuKeybindings?(rules: unknown[]): void;
    onAppCommand?(cb: (command: string) => void): () => void;
    /** OS menus (main/native-menu.ts): the chosen row's id, or null. Optional: absent in jsdom, where
     *  `Menu` draws its own. */
    popupMenu?(items: NativeMenuItem[], at: { x: number; y: number }): Promise<string | null>;
    closeMenu?(): Promise<void>;
    /** REALM_HTML_MENUS=1: the app's `Menu` draws its own, for a live script to drive over CDP. */
    htmlMenus?: boolean;
    /** `process.platform` from the preload. Absent in jsdom, which has no bridge — every reader has
     *  to treat "unknown" as "no window material" rather than guessing macOS. */
    platform?: string;
    /** Settings ▸ Appearance ▸ Reduce motion: main changes what this window reports for
     *  `prefers-reduced-motion`. Optional like the other late bridges — jsdom has none. */
    motion?: { set(pref: import("@realm/contracts").ReducedMotionPref): Promise<void> };
    /** Settings ▸ General ▸ Power: tells main the keep-awake switch moved. */
    power?: { preventSleep(on: boolean): Promise<void> };
    /** The code editors installed on this Mac, and opening a path in one. */
    editors?: {
      list(): Promise<import("@realm/contracts").InstalledEditor[]>;
      open(id: import("@realm/contracts").EditorId, path: string, base?: string): Promise<boolean>;
    };
    pickFolder(): Promise<string | null>;
    /** Native multi-select file picker; [] when cancelled. */
    pickFiles(): Promise<PickedFile[]>;
    /** The path of a VS Code colour theme the user chose, or null if they cancelled. */
    pickThemeFile(): Promise<string | null>;
    /** Downscaled data: URL for an image attachment; null for anything not a readable image. */
    /** `tile` (the default) is a 96px mark beside a name; `card` is the Library's preview. */
    attachmentThumbnail(path: string, size?: "tile" | "card"): Promise<string | null>;
    /** Hand an attachment to the app the user reads that type in — the files Realm cannot draw.
     *  Optional for the same reason `media` is: without the bridge the tile stays a picture. */
    openAttachment?(path: string): Promise<void>;
    /** Write text to a file the user names; the saved path, or null when cancelled. Optional like
     *  the other late additions: jsdom has no bridge, and the caller says so rather than throwing. */
    saveText?(input: { name: string; text: string }): Promise<string | null>;
    /** Single-image picker for the icon picker's "Uploaded" tab; null when cancelled. */
    describePaths(paths: string[]): Promise<PickedFile[]>;
    pickIconImage(): Promise<PickedFile | null>;
    compressIconImage(path: string): Promise<PickedFile | null>;
    /** Local media drawn inline in the transcript. Optional in the type on purpose: every call site
     *  degrades to "no media" without it, so a renderer that loads before the bridge (and jsdom,
     *  which has no bridge at all) shows prose rather than throwing. */
    media?: {
      /** One answer per candidate, in order: the media file it names, or null. Aligned rather than
       *  filtered — the answer's path is the resolved one, which is rarely the string asked with. */
      stat(candidates: readonly string[]): Promise<(import("@realm/contracts").MediaFile | null)[]>;
      /** QuickLook poster frame (data: URL) for a video; null when macOS has none. */
      poster(path: string): Promise<string | null>;
      reveal(path: string): Promise<void>;
      open(path: string): Promise<void>;
    };
    /** Any file the app is already LISTING — a Library row, a session's outputs — as opposed to a
     *  path an agent merely named. `media` above admits only what a media element can decode, so it
     *  is right to refuse a `.ts`; these are gated on existence instead. Optional for the same
     *  reason: every call site degrades to "cannot", and jsdom has no bridge at all. */
    /** Realm's theme preference, so the window's native material, menus and panels match it
     *  (main/appearance.ts). Optional: a renderer with no bridge has no native appearance to set. */
    setAppearance?(pref: "system" | "light" | "dark"): void;
    /** The Dock icon (main/app-icon.ts). Optional: only the desktop app has a Dock to change. */
    appIcon?: {
      get(): Promise<string>;
      set(id: string, png: Uint8Array): Promise<boolean>;
    };
    files?: {
      /** Size and mtime, or null when nothing is there — how a preview learns to say the file is
       *  gone rather than drawing actions that would each fail in turn. */
      stat(path: string): Promise<{ path: string; size: number; mtimeMs: number } | null>;
      /** One folder of a space or a checkout, newest first (`main/browse.ts`). Null when it cannot
       *  be read, or when the path would leave the root — the session file browser's data source,
       *  and the one list that shows a file a shell command made. */
      browse?(root: string, dir: string): Promise<{ dir: string; truncated: boolean;
        entries: { path: string; name: string; isDir: boolean; size: number; mtimeMs: number }[] } | null>;
      /** A readable picture of the file (a decoded image, or QuickLook's render of a PDF, a sheet,
       *  a page of source). Null for a type macOS has no generator for. */
      preview(path: string): Promise<string | null>;
      /** Select it in the Finder. `~/…` is the home folder and a relative path is relative to `base`
       *  — the way an agent writes them. False when nothing is there to select. */
      reveal(path: string, base?: string): Promise<boolean>;
      /** Finder's own icon as a data URL, read off this machine. Null when it cannot be read. */
      finderIcon(): Promise<string | null>;
      /** Copy it where the user points; the saved path, or null when they cancelled. */
      saveCopy(path: string): Promise<string | null>;
      /** Quick Look, Share and drag-out (main/file-actions.ts). Optional, like every bridge. */
      quickLook?(path: string, base?: string): Promise<void>;
      share?(path: string, at: { x: number; y: number }, base?: string): Promise<void>;
      startDrag?(path: string): void;
    };
    /** Write a pasted (pathless) file under Realm's home and describe it like a picked one. */
    saveTempAttachment(name: string, mime: string, bytes: Uint8Array): Promise<PickedFile>;
    /** Real filesystem path behind a dropped File ("" when it has none — a pasted image). */
    pathForFile(file: File): string;
    /** Native trackpad scroll phases (macOS helper); optional — may never fire. */
    onScrollPhase?(cb: (m: ScrollPhaseMessage) => void): () => void;
    /** A real iPhone's picture, live (the phone pane's Show live). Raises macOS's camera prompt — it
     *  reaches a connected iPhone's screen as a camera — and answers the camera's status after. */
    phoneScreen?: {
      showLive(): Promise<string>;
    };
    /** macOS Permissions tab (Plan 12 W6): TCC rows with honest states; probe never prompts. */
    permissions: {
      probe(): Promise<TccRow[]>;
      openSettings(pane: string): Promise<void>;
    };
    /** The `mac` CLI's access (Permissions tab, "Apps on this Mac"). `status` runs `mac doctor`,
     *  which never prompts; `grant` deliberately DOES — it runs the one read-only command that
     *  raises that capability's macOS dialog, so it stays pending while the dialog is up. */
    macAccess: {
      status(): Promise<MacAccessStatus>;
      grant(id: string): Promise<MacAccessStatus>;
      openSettings(id: string): Promise<void>;
      revealApp(): Promise<void>;
      /** The real macOS icon for a capability's app, as a data URL. Null where there is no app
       *  (Full Disk Access) or where the bundle is not installed — the row shows nothing for both. */
      appIcon(id: string): Promise<string | null>;
    };
    /** Computer control's two grants (Permissions tab). `status` never prompts; `request`
     *  deliberately does, from a click on that row — see computer-access.ts for why asking lives
     *  apart from checking. */
    computerAccess: {
      status(): Promise<ComputerAccessStatus>;
      request(id: string): Promise<ComputerAccessStatus>;
      openSettings(id: string): Promise<void>;
    };
    /** Settings→App Updates row (Plan 15 W1). The gate lives in main: on a gated build `check`
     *  answers the same disabled state `status` does — the renderer can't start a check main won't run. */
    updates: {
      status(): Promise<UpdateStatus>;
      check(): Promise<UpdateStatus>;
      install(): Promise<void>;
    };
    /** Desktop notifications (the feed's last hop). `show` answers whether a toast was posted — main
     *  suppresses one while the window is focused. `onActivate` carries a clicked toast's row id. */
    notify: {
      show(input: { id: string; title: string; body: string | null }): Promise<boolean>;
      badge(count: number): Promise<void>;
      onActivate(cb: (id: string) => void): () => void;
    };
    /** Settings → Sign-ins. One-way by construction: `add` takes a value, nothing gives one back. */
    /** Every door names the PROFILE whose sign-ins it is: they are a profile's own (Plan 27 Phase 2). */
    credentials: {
      list(profileId: string): Promise<import("@realm/contracts").BrowserCredential[]>;
      status(): Promise<{ available: boolean; canPromptTouchID: boolean; presenceTtlMs: number }>;
      add(profileId: string, input: import("@realm/contracts").BrowserCredentialInput): Promise<import("@realm/contracts").BrowserCredential>;
      remove(profileId: string, id: string): Promise<boolean>;
      /** COPY one into another profile; the original stays. */
      share(profileId: string, id: string, toProfileId: string): Promise<{ ok: true; profileName: string } | { ok: false; error: string }>;
      setPresenceTtl(ms: number): Promise<number>;
    };
    /** Settings → Sign-ins, the passkey half. No `add`: a passkey is created by a site asking for one
     *  in a pane and the user answering Touch ID, so there is nothing for a person to type. */
    passkeys: {
      list(profileId: string): Promise<import("@realm/contracts").Passkey[]>;
      remove(profileId: string, id: string): Promise<boolean>;
      share(profileId: string, id: string, toProfileId: string): Promise<{ ok: true; profileName: string } | { ok: false; error: string }>;
    };
    /** Browser pane (Plan 11 W1): drives the native WebContentsView main owns for a browser item. */
    clipboard: { readText(): Promise<string> };
    browser: {
      create(id: string, url: string, allowlist: string[] | null): Promise<void>;
      destroy(id: string): Promise<void>;
      /** The pane unmounted but the browser did not close: keep the view alive and hidden. */
      retain(id: string): Promise<void>;
      /** Resolves the normalized URL actually loaded, or null when refused (allowlist) / empty. */
      navigate(id: string, input: string): Promise<string | null>;
      nav(id: string, action: "back" | "forward" | "reload" | "stop"): Promise<void>;
      /** The typed text as a web search, even when it looks like an address. */
      search(id: string, query: string): Promise<string | null>;
      historyMenu(id: string, dir: "back" | "forward", at: { x: number; y: number }): Promise<void>;
      /** Arms the element picker. See `BrowserHostBridge` for the promise's lifetime. */
      pickElement(id: string): Promise<import("@realm/contracts").BrowserPickedElement | null>;
      cancelPick(id: string): Promise<void>;
      /** Plan 26 W7d: annotate — pending until Send in the page's toolbar, or the session ends. */
      annotate(id: string, accent?: string, dir?: string | null): Promise<import("@realm/contracts").BrowserAnnotateResult>;
      cancelAnnotate(id: string): Promise<void>;
      setAccent(accent: string): void;
      /** Plan 23 W4: downloads the pane blocked, and the user's own consent to fetch one. */
      blockedDownloads(id: string): Promise<import("@realm/contracts").BlockedDownload[]>;
      saveDownload(id: string, blockedId: string, dir: string): Promise<import("@realm/contracts").BrowserDownloadResult>;
      dismissDownload(id: string, blockedId: string): Promise<void>;
      onDownloadBlocked(cb: (m: { browserId: string; blocked: import("@realm/contracts").BlockedDownload }) => void): () => void;
      /** A passkey request the pane refused, so a sign-in that goes nowhere says why. */
      onPasskey(cb: (m: import("@realm/contracts").PasskeyNotice) => void): () => void;
      setAllowlist(id: string, allowlist: string[] | null): Promise<void>;
      /** Per-frame, fire-and-forget: placeholder rect (CSS px) + devicePixelRatio + visibility. */
      setBounds(id: string, rect: { x: number; y: number; width: number; height: number }, dpr: number, visible: boolean): void;
      onState(cb: (s: BrowserViewState) => void): () => void;
      /** Plan 26 W7b — the ⋯ menu's facts, and its rows. */
      menuState(id: string): Promise<import("@realm/contracts").BrowserMenuState>;
      goToIndex(id: string, index: number): Promise<void>;
      find(id: string, query: string, step: "start" | "next" | "previous"): Promise<void>;
      stopFind(id: string): Promise<void>;
      onFound(cb: (m: import("@realm/contracts").BrowserFindResult) => void): () => void;
      /** ⌘F pressed inside a pane's page, which this window never hears directly. */
      onFindRequest(cb: (m: { browserId: string }) => void): () => void;
      zoom(id: string, step: "in" | "out" | "reset" | null): Promise<number>;
      print(id: string): Promise<void>;
      setDevice(id: string, preset: "phone" | "tablet" | "desktop" | null): Promise<void>;
      screenshot(id: string, dir: string): Promise<import("@realm/contracts").BrowserScreenshotSaved>;
      /** Clears the PANE's profile's partition, after main asks; answers whose it was. */
      clearData(id: string): Promise<{ cleared: boolean; profileId: string | null }>;
      /** Copy the page's site's cookies into another profile's partition. */
      shareSignIn(id: string, toProfileId: string): Promise<import("@realm/contracts").BrowserSignInShare>;
    };
  };
}
/** Mirrors UpdateState/UpdateStatus in main/updater.ts — the Updates row's payload. Every kind is a
 *  fact main reported; `disabled` carries the reason so the row can say why, honestly. */
type UpdateState =
  | { kind: "disabled"; reason: "dev" | "unsigned" | "no-feed" }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "downloading"; version: string }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };
interface UpdateStatus { version: string; state: UpdateState }
/** Mirrors TccRow in main/tcc.ts — the Permissions tab's row payload. */
interface TccRow { id: string; label: string; state: "granted" | "denied" | "unknown"; detail: string }
/** Mirrors MacAccessRow/MacAccessStatus in main/mac-access.ts. The five states are mac doctor's own,
 *  kept apart on purpose: `writeOnly` is a half-grant (writes land, reads come back empty), so
 *  collapsing it into "granted" would put a green check over a broken capability. */
type MacAccessState = "granted" | "denied" | "notRequested" | "writeOnly" | "unknown";
interface MacAccessRow {
  id: string; label: string; group: "data" | "automation" | "disk" | "other";
  state: MacAccessState; detail: string;
  /** The command Realm would run, shown before it runs. Null where macOS has no prompt at all. */
  grantCommand: string | null;
  /** Realm can still raise this prompt — false once granted, and false once DENIED, because a
   *  denial is sticky and re-running would be a button that cannot work. */
  canPrompt: boolean;
  /** A trip to System Settings is the reliable fix (denied, writeOnly, Full Disk Access). */
  needsSettings: boolean;
  /** Raising the prompt will open the target app — AppleScript has to talk to something. */
  launchesApp: boolean;
}
interface MacAccessStatus {
  cli: { present: true; path: string; version: string | null } | { present: false; searched: string[] };
  rows: MacAccessRow[];
  /** The app macOS attributes the grants to. Under `pnpm dev` that is Electron, not Realm — the
   *  page says so, because grants made in dev do not carry into the packaged app. */
  host: { name: string; bundlePath: string; packaged: boolean };
}
/** Mirrors ComputerAccessRow/ComputerAccessStatus in main/computer-access.ts — the two grants the
 *  computer-control tools need. Only `granted` and `denied` are ever sent: macOS answers both of
 *  these definitively, so unlike the mac doctor rows (five states, including `notRequested`) there
 *  is nothing here to be undecided about — though it still cannot tell "refused" from "never asked"
 *  for Accessibility. The union carries `unknown` anyway because it mirrors main's `TccState`. */
interface ComputerAccessRow {
  id: "accessibility" | "screenRecording";
  label: string;
  state: "granted" | "denied" | "unknown";
  detail: string;
  /** Realm has a way to raise the real prompt for this row. */
  canPrompt: boolean;
  /** The switch that actually grants it lives in System Settings — true whenever it is missing. */
  needsSettings: boolean;
  /** What pressing "Ask macOS" will really do; null when there is nothing to ask for. */
  askExplanation: string | null;
}
interface ComputerAccessStatus {
  rows: ComputerAccessRow[];
  /** The app macOS attributes the grants to — "Electron" under `pnpm dev`. */
  hostName: string;
  packaged: boolean;
  /** False when this build has no compiled accessibility helper: computer control is unavailable
   *  whatever macOS has granted. */
  helperAvailable: boolean;
}
/** Mirrors BrowserViewState in the preload — the main→renderer browser state channel's payload. */
interface BrowserViewState { id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean;
  /** The device preset the page is shown at (Plan 26 W7e), or null when it fits the pane. */
  device: "phone" | "tablet" | "desktop" | null;
  /** The page's own icon, a `data:` URL main fetched on the pane's session; null until it has one. */
  favicon: string | null }

/**
 * noVNC ships no types (Plan 25 W3). Declared here rather than pulled from DefinitelyTyped, which
 * carries a full surface for a library this app touches through exactly one constructor and the
 * handful of members `RfbLike` names — and a full surface would let a call site reach for something
 * the hub's seam has no way to fake.
 *
 * The package's exports map is a single string (`"exports": "./core/rfb.js"`), so this bare
 * specifier is the only one that resolves.
 */
declare module "@novnc/novnc" {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>);
    disconnect(): void;
    focus(): void;
    blur(): void;
    addEventListener(type: string, fn: (e: Event) => void): void;
    viewOnly: boolean;
    scaleViewport: boolean;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
  }
}
