import { fromAppView } from "./app-views";

/**
 * No website in a browser pane — and nothing else Realm shows — gets this Mac's camera or microphone.
 * Electron's default is to approve every permission request, and what kept a page off the camera until
 * now was only that a signed Realm held no camera entitlement. It holds one now: macOS reaches a
 * connected iPhone's screen as a camera (`phone-screen.ts`), and a grant given for the phone would
 * otherwise be any page's for the asking. Every other permission keeps Electron's default.
 *
 * A view an MCP server drew (MCP Apps) gets nothing at all, asked or checked: it is a stranger's page
 * framed inside Realm's window, and a notification it raised would arrive as Realm's.
 *
 * No Electron import, so the rule is testable; the sessions it is applied to are index.ts's and
 * browser-pane.ts's.
 */
export function capturePermitted(permission: string, requestingUrl?: string): boolean {
  if (fromAppView(requestingUrl)) return false;
  return permission !== "media";
}

type PermissionSession = {
  setPermissionRequestHandler(handler: (wc: unknown, permission: string, answer: (granted: boolean) => void, details?: { requestingUrl?: string }) => void): void;
  setPermissionCheckHandler(handler: (wc: unknown, permission: string, requestingOrigin?: string, details?: { requestingUrl?: string }) => boolean): void;
};

export function refuseCapture(ses: PermissionSession): void {
  ses.setPermissionRequestHandler((_wc, permission, answer, details) => answer(capturePermitted(permission, details?.requestingUrl)));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => capturePermitted(permission, details?.requestingUrl ?? requestingOrigin));
}
