/**
 * `realm-workspace`: Realm's own state, read by the agents it hosts — what is in a space, what is on
 * the user's screen, and what the other sessions in the space said — plus the one tool that brings a
 * closed pane back.
 *
 * Here rather than beside the provider because two processes spell these names: the server, whose
 * provider registers them, and Electron main, whose refusal about a closed browser pane has to name
 * the tool that fixes it. A refusal that names a tool the gateway does not route is worse than none.
 */
export const WORKSPACE_PROVIDER_NAME = "realm-workspace";
export const PANE_SHOW_TOOL_NAME = "pane_show";

/**
 * The tools of this provider that only read. Realm's broker never prompts for them, and the Claude
 * adapter pre-allows them so Claude's own per-MCP-tool prompt does not stack on top of nothing — the
 * same arrangement, and the same warning, as `BROWSER_READ_ONLY_TOOLS`: never add a tool that
 * changes anything.
 */
export const WORKSPACE_READ_ONLY_TOOLS = ["workspace_state", "sessions_list", "session_read", "space_list", "settings_get"] as const;

/** `pane_show` under the name the gateway lists it by — the name every "not open" refusal spells. */
export const PANE_SHOW_WIRE_NAME = `${WORKSPACE_PROVIDER_NAME}__${PANE_SHOW_TOOL_NAME}`;

/**
 * What a browser tool says when the pane it was pointed at is not mounted — closed from the layout,
 * or never shown. It used to say "the user must open (or reopen) the browser pane", which left the
 * agent nothing to do but stop: 125 calls in the log ended on that sentence. It now names the tool
 * that brings the pane back, and what to do where that tool is switched off.
 */
export function paneNotOpenError(browserId: string): string {
  return `browser ${browserId}'s pane is not open in the app. Call ${PANE_SHOW_WIRE_NAME} with {"browserId": "${browserId}"} to bring it back into your side pane, then retry. If that tool is not available to you, ask the user to reopen the browser pane.`;
}

/**
 * What `browser_screenshot` says when the page will not paint. Chrome draws a page only while its view
 * is on screen; a pane that is a tab behind another, in a side panel the user put away, or in a window
 * that is hidden has nothing to capture, and the capture waits for a frame that never comes — it used
 * to wait out the bridge's whole minute (13 calls in the log). Electron main gives up after a few
 * seconds and says this instead: what still works without a picture, and how to get one.
 */
export function paneNotPaintingError(browserId: string): string {
  return `browser ${browserId}'s pane is not being drawn — it is a tab behind another, in a side panel the user put away, or in a window that is hidden — so there is no picture to take. browser_snapshot and browser_read work on it as it is. To see it, call ${PANE_SHOW_WIRE_NAME} with {"browserId": "${browserId}"} to bring it to the front of your side pane, then retry; if it still cannot be captured, the Realm window is not on screen.`;
}
