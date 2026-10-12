/**
 * Where a click on a web link opens: the Mac's default browser, or a Realm Browser tab beside the
 * session (Settings ▸ General ▸ Links). The default browser unless asked — it is what a link did
 * before there was a choice. ⌘-click opens it in the other one, and the link's right-click menu
 * offers both, the chosen one first.
 *
 * Only http(s) links are routed: a mailto:, file: or app scheme goes where the OS sends it whatever
 * this says, since a browser pane cannot open one.
 */
export const LINKS_OPEN_IN_KEY = "links.openIn";
export type LinksOpenIn = "default" | "realm";
export const LINKS_OPEN_IN_DEFAULT: LinksOpenIn = "default";
export const isLinksOpenIn = (x: unknown): x is LinksOpenIn => x === "default" || x === "realm";

/** The window name a `window.open` gives to say "the default browser, whatever the setting": a
 *  sign-in, whose cookies have to be the ones the person's own browser keeps. */
export const SYSTEM_BROWSER_FRAME = "realm-system-browser";
