/// <reference types="vite/client" />
interface ScrollPhaseMessage { phase: string; momentum: string; dx: number; dy: number; ts: number }
/** Mirrors PickedFile in the preload: `size` and `name` are for the prompter's own checks; only
 *  `path` and `mime` ever reach `sessions.send`. */
interface PickedFile { path: string; mime: string; name: string; size: number }
interface Window {
  realm: {
    port: number; home: string;
    pickFolder(): Promise<string | null>;
    /** Native multi-select file picker; [] when cancelled. */
    pickFiles(): Promise<PickedFile[]>;
    /** Downscaled data: URL for an image attachment; null for anything not a readable image. */
    attachmentThumbnail(path: string): Promise<string | null>;
    /** Single-image picker for the icon picker's "Uploaded" tab; null when cancelled. */
    pickIconImage(): Promise<PickedFile | null>;
    /** Write a pasted (pathless) file under Realm's home and describe it like a picked one. */
    saveTempAttachment(name: string, mime: string, bytes: Uint8Array): Promise<PickedFile>;
    /** Real filesystem path behind a dropped File ("" when it has none — a pasted image). */
    pathForFile(file: File): string;
    /** Native trackpad scroll phases (macOS helper); optional — may never fire. */
    onScrollPhase?(cb: (m: ScrollPhaseMessage) => void): () => void;
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
    credentials: {
      list(): Promise<import("@realm/contracts").BrowserCredential[]>;
      status(): Promise<{ available: boolean; canPromptTouchID: boolean; presenceTtlMs: number }>;
      add(input: import("@realm/contracts").BrowserCredentialInput): Promise<import("@realm/contracts").BrowserCredential>;
      remove(id: string): Promise<boolean>;
      setPresenceTtl(ms: number): Promise<number>;
    };
    /** Browser pane (Plan 11 W1): drives the native WebContentsView main owns for a browser item. */
    browser: {
      create(id: string, url: string, allowlist: string[] | null): Promise<void>;
      destroy(id: string): Promise<void>;
      /** Resolves the normalized URL actually loaded, or null when refused (allowlist) / empty. */
      navigate(id: string, input: string): Promise<string | null>;
      nav(id: string, action: "back" | "forward" | "reload" | "stop"): Promise<void>;
      /** Plan 23 W4: downloads the pane blocked, and the user's own consent to fetch one. */
      blockedDownloads(id: string): Promise<import("@realm/contracts").BlockedDownload[]>;
      saveDownload(id: string, blockedId: string, dir: string): Promise<import("@realm/contracts").BrowserDownloadResult>;
      dismissDownload(id: string, blockedId: string): Promise<void>;
      onDownloadBlocked(cb: (m: { browserId: string; blocked: import("@realm/contracts").BlockedDownload }) => void): () => void;
      setAllowlist(id: string, allowlist: string[] | null): Promise<void>;
      /** Per-frame, fire-and-forget: placeholder rect (CSS px) + devicePixelRatio + visibility. */
      setBounds(id: string, rect: { x: number; y: number; width: number; height: number }, dpr: number, visible: boolean): void;
      onState(cb: (s: BrowserViewState) => void): () => void;
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
/** Mirrors BrowserViewState in the preload — the main→renderer browser state channel's payload. */
interface BrowserViewState { id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }
