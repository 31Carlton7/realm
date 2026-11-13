import { fromAppView } from "./app-views";

/**
 * No website in a browser pane — and nothing else Realm shows — gets this Mac's camera or microphone.
 * Electron's default is to approve every permission request, and what kept a page off the camera until
 * now was only that a signed Realm held no camera entitlement. It holds one now: macOS reaches a
 * connected iPhone's screen as a camera (`phone-screen.ts`), and a grant given for the phone would
 * otherwise be any page's for the asking. The screen is refused with them: up to Electron 44 a screen
 * capture asked as `media` and was refused by that rule, and from 45 it asks as `display-capture`.
 * Every other permission keeps Electron's default for Realm's own page.
 *
 * A view an MCP server drew (MCP Apps) gets nothing at all, asked or checked: it is a stranger's page
 * framed inside Realm's window, and a notification it raised would arrive as Realm's.
 *
 * The one exception is the microphone for Realm's own page, which dictation listens through: a
 * request for audio and nothing else, from the page `ownPage` recognises. Only the window's session
 * is given `ownPage`; the browser partition never is, so no website reaches the microphone either.
 *
 * No Electron import, so the rules are testable; index.ts applies `refuseCapture` to the app's own
 * session and browser-pane.ts applies `guardPanePermissions` to every browser partition.
 */
export function capturePermitted(permission: string, requestingUrl?: string, media?: MediaAsk, ownPage?: (url: string) => boolean): boolean {
  if (fromAppView(requestingUrl)) return false;
  if (permission === "media" && ownPage && requestingUrl && ownPage(requestingUrl) && audioOnly(media)) return true;
  return permission !== "media" && permission !== "display-capture";
}

/**
 * A website in a browser pane gets fullscreen and a plain-text clipboard write (a Copy button), and
 * nothing else. Electron's default would grant the rest with no prompt: `openExternal` hands any URL
 * scheme a page navigates to straight to macOS, and `clipboard-read` gives the page whatever password
 * was just copied. Realm has no permission prompt, so anything not listed is refused, including names
 * Chromium adds later.
 */
const PANE_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write"]);

/** What a `media` request names, as Electron reports it: `mediaTypes` on a request, `mediaType` on a check. */
type MediaAsk = { mediaTypes?: string[]; mediaType?: string };

function audioOnly(media: MediaAsk | undefined): boolean {
  if (!media) return false;
  if (media.mediaTypes) return media.mediaTypes.length > 0 && media.mediaTypes.every((t) => t === "audio");
  return media.mediaType === "audio";
}

type PermissionDetails = { requestingUrl?: string } & MediaAsk;

type PermissionSession = {
  setPermissionRequestHandler(handler: (wc: unknown, permission: string, answer: (granted: boolean) => void, details?: PermissionDetails) => void): void;
  setPermissionCheckHandler(handler: (wc: unknown, permission: string, requestingOrigin?: string, details?: PermissionDetails) => boolean): void;
};

function applyRule(ses: PermissionSession, permitted: (permission: string, requestingUrl?: string, media?: MediaAsk) => boolean): void {
  ses.setPermissionRequestHandler((_wc, permission, answer, details) => answer(permitted(permission, details?.requestingUrl, details)));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => permitted(permission, details?.requestingUrl ?? requestingOrigin, details));
}

export function refuseCapture(ses: PermissionSession, ownPage?: (url: string) => boolean): void {
  applyRule(ses, (permission, requestingUrl, media) => capturePermitted(permission, requestingUrl, media, ownPage));
}

export function guardPanePermissions(ses: PermissionSession): void {
  applyRule(ses, (permission) => PANE_PERMISSIONS.has(permission));
}
