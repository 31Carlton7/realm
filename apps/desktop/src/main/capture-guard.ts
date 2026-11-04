import { fromAppView } from "./app-views";

/**
 * No website in a browser pane — and nothing else Realm shows — gets this Mac's camera or microphone.
 * Electron's default is to approve every permission request, and what kept a page off the camera until
 * now was only that a signed Realm held no camera entitlement. It holds one now: macOS reaches a
 * connected iPhone's screen as a camera (`phone-screen.ts`), and a grant given for the phone would
 * otherwise be any page's for the asking. The screen is refused with them: up to Electron 44 a screen
 * capture asked as `media` and was refused by that rule, and from 45 it asks as `display-capture`.
 * Every other permission keeps Electron's default.
 *
 * A view an MCP server drew (MCP Apps) gets nothing at all, asked or checked: it is a stranger's page
 * framed inside Realm's window, and a notification it raised would arrive as Realm's.
 *
 * The one exception is the microphone for Realm's own page, which voice mode listens through: a
 * request for audio and nothing else, from the page `ownPage` recognises. Only the window's session
 * is given `ownPage`; the browser partition never is, so no website reaches the microphone either.
 *
 * No Electron import, so the rule is testable; the sessions it is applied to are index.ts's and
 * browser-pane.ts's.
 */
export function capturePermitted(permission: string, requestingUrl?: string, media?: MediaAsk, ownPage?: (url: string) => boolean): boolean {
  if (fromAppView(requestingUrl)) return false;
  if (permission === "media" && ownPage && requestingUrl && ownPage(requestingUrl) && audioOnly(media)) return true;
  return permission !== "media" && permission !== "display-capture";
}

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

export function refuseCapture(ses: PermissionSession, ownPage?: (url: string) => boolean): void {
  ses.setPermissionRequestHandler((_wc, permission, answer, details) => answer(capturePermitted(permission, details?.requestingUrl, details, ownPage)));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => capturePermitted(permission, details?.requestingUrl ?? requestingOrigin, details, ownPage));
}
