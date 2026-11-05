import type { Item, TerminalStatus } from "@realm/contracts";
import { TERMINAL_TEXT_MAX, type BrowserPane, type TerminalOutput, type TerminalPane } from "@realm/remote";
import { tilde } from "./rows";

/**
 * What a phone is shown of the browser and terminal panes a session's space has open (`session.panes`,
 * `session.browserFrame`, `session.terminal`): each named as its pane is, a browser's page as a picture
 * with its password fields covered, and a terminal's output as the text its pty wrote. Nothing here
 * sends anything to a pane: a phone only looks.
 *
 * A browser's picture is polled as a screen's is, about once a second while the phone's viewer is
 * open, and bounded the same way (`screens.ts`): at most `SCREEN_SIDE.max` on its longer side and
 * `FRAME_MAX_BYTES` heavy. Every call for a pane within BROWSER_FRAME_EVERY_MS of the last picture is
 * answered with that picture, however many phones or viewers ask, so a page is pictured at most once a
 * second. A terminal's output is polled too, and each answer carries only what came after the phone's
 * cursor, at most TERMINAL_TEXT_MAX of it.
 */

/** The least time between two pictures of one browser pane. */
export const BROWSER_FRAME_EVERY_MS = 1_000;

/** Mimes a phone draws a favicon in: every one the tab keeps but SVG, which UIKit cannot read. */
const PHONE_FAVICON = /^data:(image\/(?:png|x-icon|gif|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/** A tab's favicon (`isFaviconDataUrl`, already bounded) as a phone draws it, or undefined. */
export function phoneFavicon(dataUrl: string | undefined): BrowserPane["favicon"] {
  const m = dataUrl ? PHONE_FAVICON.exec(dataUrl) : null;
  return m ? { mime: m[1]!, data: m[2]! } : undefined;
}

/** A browser pane, as a phone lists it: by its tab's title, else its address, else "Browser". */
export function browserPane(item: Item, url: string, live: boolean): BrowserPane {
  const favicon = phoneFavicon(item.favicon);
  return { id: item.refId, name: item.title || url || "Browser", url, ...(favicon ? { favicon } : {}), live };
}

/** A terminal, as a phone lists it: by its pane's title, with the command it runs or where it runs. */
export function terminalPane(item: Item, status: TerminalStatus | undefined, home: string): TerminalPane {
  const detail = status ? status.command ?? tilde(status.cwd, home) : "";
  return { id: item.refId, name: item.title || "Terminal", detail, running: status?.running ?? false };
}

/** The live first, then by name as a person reads a list, then by id: `screenOrder`'s rule. */
export const paneOrder = <T extends { id: string; name: string }>(live: (p: T) => boolean) => (a: T, b: T): number =>
  Number(live(b)) - Number(live(a)) || a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The pane items a space has open, of one kind. */
export const openPanes = (items: readonly Item[], kind: "browser" | "terminal"): Item[] => items.filter((it) => it.kind === kind && !it.archived);

type Cursor = { runId: string; seq: number };
type Read = { runId: string; seq: number; live: string; truncated: boolean; running: boolean; history: { data: string } | null };

/**
 * A terminal's read (`terminals.read`) as a phone is sent it. Following on from its cursor, only what
 * came after; otherwise the whole of what the Mac holds — the screen the last shell left, then this
 * one's output — as a `reset`. More than TERMINAL_TEXT_MAX is cut to its end, from the first line that
 * starts inside it, so the text never begins part way through an escape, and is a `reset` too.
 */
export function terminalOutput(read: Read, cursor: Cursor | null): TerminalOutput {
  const follows = cursor !== null && cursor.runId === read.runId && !read.truncated;
  const before = follows ? "" : read.history?.data ?? "";
  let text = before && read.live ? `${before}\r\n${read.live}` : before || read.live;
  let reset = !follows;
  if (text.length > TERMINAL_TEXT_MAX) {
    const tail = text.slice(-TERMINAL_TEXT_MAX);
    const line = tail.indexOf("\n");
    text = line >= 0 ? tail.slice(line + 1) : tail;
    reset = true;
  }
  return { runId: read.runId, seq: read.seq, text, reset, running: read.running };
}
