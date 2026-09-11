import { execFile } from "node:child_process";
import { NOTIFICATIONS_IMESSAGE_KEY, NOTIFICATIONS_SLACK_WEBHOOK_KEY, RELAYED_CATEGORIES, type NotificationCategory } from "@realm/contracts";
import type { SettingsStore } from "../store/settings";

/**
 * One line, as it reaches a phone: the session, where it is, then what it wants.
 *
 * The space name is here because at level C — realm-server running headless, with no Realm window
 * anywhere — this line is ALL a person gets. A session title alone does not say which of three spaces
 * to open, and "Fix the login flow needs your OK" is a sentence you cannot act on without going
 * looking. Omitted when there is no space (a row about the app itself, not about work in one).
 */
export function relayText(n: { category: NotificationCategory; title: string; body: string | null; spaceName?: string | null }): string {
  const head = n.category === "permission" ? "needs your OK" : n.category === "run_blocked" ? "is blocked" : "finished";
  const where = n.spaceName ? ` (${n.spaceName})` : "";
  return `Realm: ${n.title}${where} ${head}${n.body ? ` — ${n.body}` : ""}`;
}

export type RelayTransport = {
  /** `mac messages send <handle> <text>` — the Messages bridge the `mac` CLI already owns. */
  imessage: (handle: string, text: string) => Promise<void>;
  /** POST `{ text }` to a Slack incoming webhook. */
  slack: (url: string, text: string) => Promise<void>;
};

/**
 * Does the iMessage half still work once realm-server is a daemon that outlived Realm.app?
 *
 * Measured, because at level C — no Electron at all — this relay is the ENTIRE story of how a person
 * finds out anything happened, and a silent TCC denial would be the worst possible failure of it.
 *
 * It works. macOS resolves a process's Automation responsibility at exec and keeps it; a child
 * spawned detached, whose parent then exits and which is reparented to launchd, still drives Messages
 * under the grant that was in force when it started. Verified directly: a detached child outliving
 * its parent gets a clean answer from Messages rather than errAEEventNotPermitted.
 *
 * What does NOT survive is being asked for the first time. A TCC prompt needs somebody frontmost to
 * answer it, and a headless daemon has nobody — so a Mac that has never granted Automation to Realm
 * gets a denial rather than a dialog. That is survivable exactly because of the posture below: every
 * relay failure is a log line and never a throw, and the Slack webhook is plain HTTP with no TCC at
 * all, which is why Settings offers both rather than treating iMessage as the real one.
 */
export const realTransport: RelayTransport = {
  imessage: (handle, text) => new Promise((resolve, reject) => {
    // Argument vector, never a shell string: the text is whatever an agent named its tool call.
    execFile("mac", ["messages", "send", handle, text, "--quiet"], { timeout: 15_000 }, (err) => (err ? reject(err) : resolve()));
  }),
  slack: async (url, text) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`slack webhook answered ${res.status}`);
  },
};

/**
 * Relays a notification beyond this Mac, to wherever settings say — nowhere by default.
 *
 * Read at send time rather than cached: a handle typed into Settings takes effect on the next
 * notification, with nothing to restart. Every failure is a log line and never a throw: the feed
 * row has already been written and broadcast, and a webhook that is down must not take the
 * in-app notification down with it. Fire-and-forget for the same reason — the session pump that
 * raised the event is not going to wait on a phone.
 */
export class NotificationRelay {
  constructor(private d: { settings: SettingsStore; transport: RelayTransport; log?: (line: string) => void }) {}

  /** The configured destinations, as strings; empty when unset or not a string. */
  targets(): { imessage: string; slack: string } {
    const str = (k: string) => { const v = this.d.settings.get(k); return typeof v === "string" ? v.trim() : ""; };
    return { imessage: str(NOTIFICATIONS_IMESSAGE_KEY), slack: str(NOTIFICATIONS_SLACK_WEBHOOK_KEY) };
  }

  /** Whether `send` would do anything for this category — the service's cheap pre-check. */
  relays(category: NotificationCategory): boolean {
    if (!RELAYED_CATEGORIES.includes(category)) return false;
    const t = this.targets();
    return t.imessage !== "" || t.slack !== "";
  }

  send(n: { category: NotificationCategory; title: string; body: string | null; spaceName?: string | null }): void {
    if (!RELAYED_CATEGORIES.includes(n.category)) return;
    const t = this.targets();
    const text = relayText(n);
    const note = (where: string) => (e: unknown) => this.d.log?.(`[notifications] ${where} relay failed: ${e instanceof Error ? e.message : String(e)}`);
    if (t.imessage) this.d.transport.imessage(t.imessage, text).catch(note("iMessage"));
    if (t.slack) this.d.transport.slack(t.slack, text).catch(note("Slack"));
  }
}
