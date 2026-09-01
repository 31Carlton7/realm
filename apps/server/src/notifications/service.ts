import { AGENT_META, NOTIFICATIONS_DISABLED_KEY, NotificationCategorySchema, type McpServerStatus, type Notification, type NotificationCategory, type Session, type SessionEvent } from "@realm/contracts";
import type { ProbeResult } from "@realm/adapters";
import type { RpcServer } from "../rpc/server";
import type { SettingsStore } from "../store/settings";
import type { NotificationsStore } from "../store/notifications";

/** Where `probeResults` remembers each CLI's last-known availability, so "previously available" is a
 *  durable fact (survives restart) rather than one process's memory. */
export const LAST_PROBE_KEY = "notifications.lastProbe";

/** Session-status transitions that count as a turn SETTLING. `waiting_permission` is in the from-set
 *  only for the crash path (an adapter dying under an unanswered card) — an answered permission goes
 *  back through `running` first, so it can never settle out of the from-set spuriously. */
const SETTLED_FROM = new Set(["running", "waiting_permission"]);
const SETTLED_TO = new Set(["idle", "ended", "error"]);
const SETTLE_WORD: Record<string, string> = { idle: "Finished a turn", ended: "Ended", error: "Failed" };

/**
 * The one writer of notification rows (Plan 12 W5). No polling anywhere: every row is written from a
 * hook on the exact code path that already broadcasts the underlying event — `SessionService.onEvent`
 * (permissions, settles), the hub's `onStatus` callback in app.ts (MCP health), `probeAll` (CLI
 * regressions), and the two stale-ack refusal sites (worktree hazards).
 *
 * **The feed is GLOBAL.** The sidebar row lives above the space section, its count spans every space,
 * and `markRead all` marks the whole feed — there is no per-space feed for it to leak across. Rows
 * still carry `spaceId` so the page can say where a thing happened and jump there.
 *
 * **`session_done` architecture.** The server cannot know renderer focus, so it writes a row for EVERY
 * settle; the RENDERER — the one honest holder of focus — immediately marks the row read when the
 * settled session is the pane the user is looking at (it gets the row in the `notifications.changed`
 * payload, so there is no refetch race). Failure modes, stated: a settle while the session is focused
 * but the user is away from the machine is auto-read (under-reports); a settle while no renderer is
 * connected stays unread even if the user later watched the session end elsewhere (over-reports).
 * Both degrade to a slightly-wrong read bit on an informational row, never to a lost row.
 *
 * **Dedup.** The key is `(category, refId)`. Lifecycle categories (`permission`, `mcp_health`,
 * `agent_probe`) collapse: a repeat of a still-open condition is ABSORBED into its open row (fresher
 * words, same row — a flapping MCP server holds one open row, not 200), recovery RESOLVES the row
 * (`acted_at`), and a re-occurrence whose previous row is resolved but still unread REOPENS that row
 * (bumped to the top) instead of double-counting a story the user never saw. Terminal categories
 * (`session_done`, `worktree_hazard`) are born acted and reuse their unread row the same way. Only
 * when every prior row for the key is read does a new occurrence write a new row — which is then
 * genuinely new information to a user who saw the old one.
 */
export class NotificationsService {
  constructor(private d: { store: NotificationsStore; settings: SettingsStore; rpc: RpcServer }) {}

  list(p: { cursor: string | null; limit: number }): { notifications: Notification[]; nextCursor: string | null; unread: number } {
    const { notifications, nextCursor } = this.d.store.list(p);
    return { notifications, nextCursor, unread: this.d.store.unreadCount() };
  }

  markRead(p: { ids: string[]; all: boolean }): { ok: true; unread: number } {
    const changed = p.all ? this.d.store.markAllRead() : this.d.store.markRead(p.ids);
    const unread = this.d.store.unreadCount();
    if (changed > 0) this.d.rpc.broadcast("notifications.changed", { notification: null, unread });
    return { ok: true as const, unread };
  }

  /** Disabled categories write no rows. Everything already written stays (see the contracts key's doc
   *  comment); the check guards the write path only. */
  private enabled(category: NotificationCategory): boolean {
    const raw = this.d.settings.get(NOTIFICATIONS_DISABLED_KEY);
    if (!Array.isArray(raw)) return true;
    return !raw.some((c) => NotificationCategorySchema.safeParse(c).success && c === category);
  }

  /** The one write path — dedup rule, toggle check, broadcast. */
  private notify(input: { category: NotificationCategory; spaceId: string | null; sessionId: string | null; refId: string | null; title: string; body: string | null; acted: boolean }): void {
    if (!this.enabled(input.category)) return;
    let surfaced: Notification | null = null;
    const open = input.refId ? this.d.store.findOpen(input.category, input.refId) : null;
    if (open) {
      this.d.store.absorb(open.id, { title: input.title, body: input.body });
    } else {
      const unread = input.refId ? this.d.store.findUnread(input.category, input.refId) : null;
      surfaced = unread
        ? this.d.store.reopen(unread.id, { title: input.title, body: input.body, acted: input.acted })
        : this.d.store.create(input);
    }
    this.d.rpc.broadcast("notifications.changed", { notification: surfaced, unread: this.d.store.unreadCount() });
  }

  /** Stamp a key's open row resolved (if any) and say how it ended. */
  private resolveOpen(category: NotificationCategory, refId: string, outcome: string): void {
    const open = this.d.store.findOpen(category, refId);
    if (!open) return;
    this.d.store.resolve(open.id, open.body ? `${open.body} — ${outcome}` : outcome);
    this.d.rpc.broadcast("notifications.changed", { notification: null, unread: this.d.store.unreadCount() });
  }

  /**
   * The SessionService hook — called from `onEvent` (the pump and `emitExternal` alike, so browser-broker
   * permissions ride the same rail) and from `markStaleOnBoot`'s synthetic denies. `session` is the row
   * as it stood BEFORE this event was applied, so `session.status` is the previous status.
   */
  handleSessionEvent(session: Session, ev: SessionEvent): void {
    if (ev.type === "permission_request") {
      this.notify({ category: "permission", spaceId: session.spaceId, sessionId: session.id, refId: ev.payload.requestId,
        title: session.title, body: ev.payload.title || ev.payload.toolName, acted: false });
      return;
    }
    if (ev.type === "permission_response") {
      // The staleness rule: HOWEVER the request was answered — session pane, notifications page, a boot
      // deny — the feed reconciles here, because every answer flows through this same event.
      const word = ev.payload.decision === "allow" ? "Allowed" : ev.payload.decision === "allow_always" ? "Always allowed" : "Denied";
      this.resolveOpen("permission", ev.payload.requestId, word);
      return;
    }
    if (ev.type === "status" && SETTLED_FROM.has(session.status) && SETTLED_TO.has(ev.payload.status)) {
      // A crash under an unanswered card leaves no permission_response behind — close the row honestly
      // rather than leaving it "pending" for a session that can no longer answer.
      if (session.status === "waiting_permission") {
        for (const open of this.d.store.listOpenForSession("permission", session.id)) {
          if (open.refId) this.resolveOpen("permission", open.refId, "The session ended before this was answered");
        }
      }
      this.notify({ category: "session_done", spaceId: session.spaceId, sessionId: session.id, refId: session.id,
        title: session.title, body: SETTLE_WORD[ev.payload.status] ?? "Settled", acted: true });
    }
  }

  /** The hub's `onStatus` hook (app.ts): a row entering error/circuit_open opens (or refreshes) the
   *  server's one open row; `connected` resolves it. `idle` is a deliberate no-op both ways — an
   *  invalidated client is not a failure, and it is not a recovery either. */
  mcpServerStatus(serverId: string, name: string | null, status: McpServerStatus): void {
    if (status === "error" || status === "circuit_open") {
      this.notify({ category: "mcp_health", spaceId: null, sessionId: null, refId: serverId,
        title: name ?? "MCP server", body: status === "circuit_open" ? "Circuit open after repeated failures" : "Connection failed", acted: false });
    } else if (status === "connected") {
      this.resolveOpen("mcp_health", serverId, "Recovered");
    }
  }

  /** The `probeAll` hook: compare against the durable last-known availability and report regressions
   *  (true → false). The first probe ever only seeds the baseline — "previously available" is a fact
   *  this service refuses to invent. */
  probeResults(results: ProbeResult[]): void {
    const raw = this.d.settings.get(LAST_PROBE_KEY);
    const last: Record<string, boolean> = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, boolean>) } : {};
    for (const r of results) {
      const label = AGENT_META[r.kind]?.label ?? r.kind;
      if (last[r.kind] === true && !r.available) {
        this.notify({ category: "agent_probe", spaceId: null, sessionId: null, refId: r.kind,
          title: `${label} is unavailable`, body: r.reason ?? (r.loggedIn === false ? "Not signed in" : "The CLI no longer probes as available"), acted: false });
      } else if (last[r.kind] === false && r.available) {
        this.resolveOpen("agent_probe", r.kind, "Available again");
      }
      last[r.kind] = r.available;
    }
    this.d.settings.set(LAST_PROBE_KEY, last);
  }

  /** The stale-ack refusal hook (EnvironmentService.removeWorktree / CheckpointService.restore): the
   *  tree moved under an open confirmation and the destructive action was refused. Born acted — the
   *  refusal is complete the moment it happens; what remains is for the user to look again. */
  worktreeHazard(input: { spaceId: string | null; environmentId: string; title: string; body: string }): void {
    this.notify({ category: "worktree_hazard", spaceId: input.spaceId, sessionId: null, refId: input.environmentId,
      title: input.title, body: input.body, acted: true });
  }
}
