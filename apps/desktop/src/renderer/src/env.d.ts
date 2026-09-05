/// <reference types="vite/client" />
interface ScrollPhaseMessage { phase: string; momentum: string; dx: number; dy: number; ts: number }
/** Mirrors PickedFile in the preload: `size` and `name` are for the prompter's own checks; only
 *  `path` and `mime` ever reach `sessions.send`. */
interface PickedFile { path: string; mime: string; name: string; size: number }
interface Window {
  realm: {
    port: number; home: string;
    /** `process.platform` from the preload. Absent in jsdom, which has no bridge — every reader has
     *  to treat "unknown" as "no window material" rather than guessing macOS. */
    platform?: string;
    pickFolder(): Promise<string | null>;
    /** Native multi-select file picker; [] when cancelled. */
    pickFiles(): Promise<PickedFile[]>;
    /** Downscaled data: URL for an image attachment; null for anything not a readable image. */
    attachmentThumbnail(path: string): Promise<string | null>;
    /** Hand an attachment to the app the user reads that type in — the files Realm cannot draw.
     *  Optional for the same reason `media` is: without the bridge the tile stays a picture. */
    openAttachment?(path: string): Promise<void>;
    /** Single-image picker for the icon picker's "Uploaded" tab; null when cancelled. */
    pickIconImage(): Promise<PickedFile | null>;
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
      /** The pane unmounted but the browser did not close: keep the view alive and hidden. */
      retain(id: string): Promise<void>;
      /** Resolves the normalized URL actually loaded, or null when refused (allowlist) / empty. */
      navigate(id: string, input: string): Promise<string | null>;
      nav(id: string, action: "back" | "forward" | "reload" | "stop"): Promise<void>;
      /** Arms the element picker. See `BrowserHostBridge` for the promise's lifetime. */
      pickElement(id: string): Promise<import("@realm/contracts").BrowserPickedElement | null>;
      cancelPick(id: string): Promise<void>;
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
/** Mirrors ComputerAccessRow/ComputerAccessStatus in main/computer-access.ts — the two grants the
 *  computer-control tools need. Only two states here, unlike the mac doctor rows: macOS answers both
 *  of these definitively, though it cannot tell "refused" from "never asked" for Accessibility. */
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
interface BrowserViewState { id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }
