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
 * No Electron import, so the rules are testable; index.ts applies `refuseCapture` to the app's own
 * session and browser-pane.ts applies `guardPanePermissions` to every browser partition.
 */
export function capturePermitted(permission: string, requestingUrl?: string): boolean {
  if (fromAppView(requestingUrl)) return false;
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

type PermissionSession = {
  setPermissionRequestHandler(handler: (wc: unknown, permission: string, answer: (granted: boolean) => void, details?: { requestingUrl?: string }) => void): void;
  setPermissionCheckHandler(handler: (wc: unknown, permission: string, requestingOrigin?: string, details?: { requestingUrl?: string }) => boolean): void;
};

function applyRule(ses: PermissionSession, permitted: (permission: string, requestingUrl?: string) => boolean): void {
  ses.setPermissionRequestHandler((_wc, permission, answer, details) => answer(permitted(permission, details?.requestingUrl)));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => permitted(permission, details?.requestingUrl ?? requestingOrigin));
}

export function refuseCapture(ses: PermissionSession): void {
  applyRule(ses, capturePermitted);
}

export function guardPanePermissions(ses: PermissionSession): void {
  applyRule(ses, (permission) => PANE_PERMISSIONS.has(permission));
}
