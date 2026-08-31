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
  };
}
