import { SYSTEM_BROWSER_FRAME, type LinksOpenIn } from "@realm/contracts";

/** The links a Realm Browser tab can show. Anything else keeps going where the OS sends it. */
export const isWebLink = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * Where a link clicked in a Realm window opens: what Settings ▸ General ▸ Links says, or the other
 * one when ⌘ was held. Null for a link that is not http(s), which this never routes.
 */
export function linkTarget(url: string, pref: LinksOpenIn, inverted: boolean): LinksOpenIn | null {
  if (!isWebLink(url)) return null;
  if (!inverted) return pref;
  return pref === "realm" ? "default" : "realm";
}

/** What was last pressed in a Realm window: the middle button, or anything else (another button, a key). */
export type LastPress = "middle" | "other";

/** `lastPress` after one of the window's input events (`webContents` "input-event"). */
export function lastPress(input: { type: string; button?: string }, was: LastPress): LastPress {
  if (input.type === "mouseDown") return input.button === "middle" ? "middle" : "other";
  if (input.type === "keyDown" || input.type === "rawKeyDown") return "other";
  return was;
}

/**
 * Whether the click that opened a window held ⌘. Every link in the app is `target="_blank"` (or a
 * `window.open`), so main sees the click as a window request rather than the click itself, and the
 * disposition is what is left of the modifier: Chromium makes a plain click a foreground tab and a
 * ⌘-click a background one. It makes a middle-click a background tab too, which is why the last press
 * is asked as well: a middle-click is never ⌘.
 */
export const heldCommand = (disposition: string, press: LastPress): boolean => disposition === "background-tab" && press !== "middle";

/** The window request main's `setWindowOpenHandler` hands over, routed: a sign-in opened by name in
 *  the default browser, any other link by `linkTarget`. A middle-click follows the setting like a
 *  plain click and opens `background`, behind the tab showing. */
export function windowOpenTarget(
  d: { url: string; disposition: string; frameName: string }, pref: LinksOpenIn, press: LastPress,
): { to: LinksOpenIn; background: boolean } | null {
  if (d.frameName === SYSTEM_BROWSER_FRAME) return isWebLink(d.url) ? { to: "default", background: false } : null;
  const to = linkTarget(d.url, pref, heldCommand(d.disposition, press));
  return to && { to, background: d.disposition === "background-tab" && press === "middle" };
}
