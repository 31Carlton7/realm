import { isAppViewUrl } from "@realm/contracts";

/**
 * Main's two rules for the frames MCP servers' views are drawn in (MCP Apps). The renderer sandboxes
 * each view and serves it on an origin of its own; these are what main adds that the page cannot.
 *
 * No Electron import, so the rules are testable; index.ts and capture-guard.ts apply them.
 */

/**
 * Whether a frame may go to `target`. A frame showing a view may load only its own origin — a view
 * reloading itself — and never take its frame somewhere else: a sandboxed frame keeps the right to
 * navigate ITSELF, and a view that did would put any page it liked inside Realm's window, under no CSP
 * of Realm's. The renderer's `frame-src` already refuses addresses outside loopback and the views'
 * hosts; this refuses the rest — another of Realm's own listeners, another view's address.
 *
 * Any frame that is not showing a view is none of this rule's business.
 */
export function viewNavigationAllowed(frameUrl: string, target: string): boolean {
  if (!isAppViewUrl(frameUrl)) return true;
  try { return new URL(target).origin === new URL(frameUrl).origin; } catch { return false; }
}

/** Whether a permission request comes from a view's frame — every one of which is refused. A view
 *  asks for nothing the sandbox gives it: no notification as Realm, no clipboard, no device. */
export function fromAppView(requestingUrl: string | undefined): boolean {
  return !!requestingUrl && isAppViewUrl(requestingUrl);
}
