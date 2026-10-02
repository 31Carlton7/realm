/**
 * The main-process halves of the browser pane's ⋯ menu (Plan 26 W7b) that do more than pass a call
 * through to the view: writing a screenshot to disk, and clearing the partition behind a confirm.
 *
 * Electron-free, like `downloads.ts`: the capture, the filesystem and the dialog are seams, so what
 * these decide — the file's name and folder, and that nothing is cleared without a yes — dies in a test.
 */
import { basename, join } from "node:path";
import type { BrowserScreenshotSaved } from "@realm/contracts";
import { safeAttachmentName } from "./attachments";

/**
 * `example.com-2026-10-01T19-30-05.png` — the page's host, then the time.
 *
 * The host because a folder of these is read by name in the Finder and in the Library, and "which
 * site was this" is the first question. The stamp is the simulator screenshot's (`simulators/service.ts`),
 * so a space's two kinds of screenshot sort and read alike. The host comes from the view's own URL —
 * never the page's title — and goes through the same sanitizer as a pasted file, so nothing a page
 * controls can put a slash in it.
 */
export function screenshotFileName(pageUrl: string, now: Date): string {
  let host = "page";
  try {
    const u = new URL(pageUrl);
    if (u.host) host = u.host;
  } catch { /* about:blank, or nothing at all */ }
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return safeAttachmentName(`${host.replace(/:/g, "-")}-${stamp}.png`, "page.png");
}

export type ScreenshotDeps = {
  capture(): Promise<Uint8Array | null>;
  pageUrl: string;
  /** Absolute. Resolved by the server (`browsers.screenshotDir`), never composed by the renderer. */
  dir: string;
  now(): Date;
  mkdirp(dir: string): void;
  exists(path: string): boolean;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
};

/**
 * Capture the pane's page and write it into the space's `screenshots/` folder.
 *
 * A name already taken gets ` (2)`, ` (3)`… rather than overwriting: two shots in the same second are
 * two files, and a screenshot someone already attached to a message must not change under it.
 */
export async function saveBrowserScreenshot(d: ScreenshotDeps): Promise<BrowserScreenshotSaved> {
  // Same requirement the download path has: this writes to disk, and a relative path would resolve
  // against whatever directory Electron happens to have been started in.
  if (!d.dir.startsWith("/")) return { ok: false, error: "This space has no folder to save a screenshot in." };
  const png = await d.capture().catch(() => null);
  if (!png || png.length === 0) return { ok: false, error: "The page had nothing on screen to capture." };
  d.mkdirp(d.dir);
  const path = uniquePath(d.dir, screenshotFileName(d.pageUrl, d.now()), d.exists);
  await d.writeFile(path, png);
  return { ok: true, path, name: basename(path), size: png.length };
}

function uniquePath(dir: string, name: string, exists: (p: string) => boolean): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 1000; n++) {
    const candidate = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return join(dir, `${stem} (${Date.now()})${ext}`);
}

/**
 * The confirm, word for word. It names the consequence before it asks (design.md, Language): every pane
 * shares the one partition, so this is not "clear this tab" — it signs every browser pane out. It also
 * says what is KEPT, because the Settings page holds sign-ins too, and a person deciding whether to
 * press this needs to know those survive.
 */
export const CLEAR_BROWSING_DATA_COPY = {
  message: "Clear browsing data for every browser pane?",
  detail: "This removes the cookies, site data, cache and history of Realm's browser. Every browser pane is signed out of the sites it was signed in to. Saved sign-ins and passkeys in Settings are kept.",
  clear: "Clear browsing data",
  cancel: "Cancel",
} as const;

/**
 * Ask, then clear. Answers whether anything was cleared, so the pane can say so.
 *
 * `confirm` resolves the button index the user pressed: 0 is Clear, anything else — Cancel, Escape,
 * the dialog closing — is no. That default is the point: the only path to `clear` is a yes.
 */
export async function clearBrowsingData(d: {
  confirm(copy: typeof CLEAR_BROWSING_DATA_COPY): Promise<number>;
  clear(): Promise<void>;
}): Promise<{ cleared: boolean }> {
  const answer = await d.confirm(CLEAR_BROWSING_DATA_COPY).catch(() => -1);
  if (answer !== 0) return { cleared: false };
  await d.clear();
  return { cleared: true };
}
