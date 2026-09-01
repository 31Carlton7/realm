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
    /** Browser pane (Plan 11 W1): drives the native WebContentsView main owns for a browser item. */
    browser: {
      create(id: string, url: string, allowlist: string[] | null): Promise<void>;
      destroy(id: string): Promise<void>;
      /** Resolves the normalized URL actually loaded, or null when refused (allowlist) / empty. */
      navigate(id: string, input: string): Promise<string | null>;
      nav(id: string, action: "back" | "forward" | "reload" | "stop"): Promise<void>;
      setAllowlist(id: string, allowlist: string[] | null): Promise<void>;
      /** Per-frame, fire-and-forget: placeholder rect (CSS px) + devicePixelRatio + visibility. */
      setBounds(id: string, rect: { x: number; y: number; width: number; height: number }, dpr: number, visible: boolean): void;
      onState(cb: (s: BrowserViewState) => void): () => void;
    };
  };
}
/** Mirrors TccRow in main/tcc.ts — the Permissions tab's row payload. */
interface TccRow { id: string; label: string; state: "granted" | "denied" | "unknown"; detail: string }
/** Mirrors BrowserViewState in the preload — the main→renderer browser state channel's payload. */
interface BrowserViewState { id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }
