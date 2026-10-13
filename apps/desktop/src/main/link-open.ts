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

/**
 * Whether the click that opened a window held ⌘. Every link in the app is `target="_blank"` (or a
 * `window.open`), so main sees the click as a window request rather than the click itself, and the
 * disposition is what is left of the modifier: Chromium makes a plain click a foreground tab and a
 * ⌘-click a background one.
 */
export const heldCommand = (disposition: string): boolean => disposition === "background-tab";

/** The window request main's `setWindowOpenHandler` hands over, routed: a sign-in opened by name in
 *  the default browser, any other link by `linkTarget`. */
export function windowOpenTarget(d: { url: string; disposition: string; frameName: string }, pref: LinksOpenIn): LinksOpenIn | null {
  if (d.frameName === SYSTEM_BROWSER_FRAME) return isWebLink(d.url) ? "default" : null;
  return linkTarget(d.url, pref, heldCommand(d.disposition));
}
