import { connectorById } from "@realm/contracts";
import type { IconName } from "@realm/ui";

/**
 * Realm's own servers, by what follows `realm-`, wear the glyph of the pane they drive: a browser
 * call is the browser's globe, a terminal call the terminal's. One that drives no pane takes the
 * glyph its page or surface already wears elsewhere in the app.
 */
const REALM_SERVER_MARKS: Record<string, IconName> = {
  browser: "browser", terminal: "terminal", simulator: "simulator", docs: "documents",
  agent: "agents", team: "team", computer: "pointer", vm: "machine", schedule: "clock",
  workspace: "layout", app: "app-view", ui: "session", goal: "flag",
};

/**
 * A vendor's server, by how people name it: the claude.ai connector's `Google_Calendar`, a row
 * someone added as `gmail-work`, a connector's `realm-linear`. Keys are the name's words run
 * together, lower-case, so `google-drive`, `Google Drive` and `googledrive` are one key.
 */
const VENDOR_MARKS: Record<string, IconName> = {
  gmail: "gmail", googlecalendar: "googleCalendar", googledrive: "googleDrive",
  notion: "notion", linear: "linear", figma: "figma", github: "github", slack: "slack",
  posthog: "posthog", vercel: "vercel", stripe: "stripe", sentry: "sentry", supabase: "supabase",
  atlassian: "atlassian", confluence: "atlassian", jira: "jira",
};

/** True for a server Realm itself runs (`realm-browser`), as against a connector it registered
 *  under the same prefix (`realm-linear`) or a server somebody added. */
export function isRealmServer(server: string): boolean {
  if (server === "realm") return true;
  const rest = /^realm-(.+)$/.exec(server)?.[1];
  return rest !== undefined && connectorById(rest) === undefined;
}

/**
 * The mark an MCP server's calls are drawn with, from the server's name as it reaches the agent.
 *
 * The one resolver for "which app is this": a connector Realm registered takes the icon its card on
 * the Connections page wears (`CONNECTORS`), Realm's own servers take their pane's glyph, and any
 * other server is matched on its name's leading words against the vendors Realm carries a mark for.
 * What none of that names keeps the plug every connection wears.
 */
export function mcpServerMark(server: string): IconName {
  const name = server.replace(/^claude_ai_/, "").toLowerCase();
  const rest = /^realm-(.+)$/.exec(name)?.[1];
  if (rest !== undefined) {
    const connector = connectorById(rest);
    if (connector) return connector.icon as IconName;
    return REALM_SERVER_MARKS[rest] ?? "plug";
  }
  // The longest run of leading words that names a vendor: `google_calendar_work` is Calendar, not
  // Google, and `gmail-personal` is still Gmail.
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  for (let n = words.length; n > 0; n--) {
    const mark = VENDOR_MARKS[words.slice(0, n).join("")];
    if (mark) return mark;
  }
  return "plug";
}
