import { useEffect } from "react";
import { Icon } from "@realm/ui";
import type { Notification, NotificationCategory } from "@realm/contracts";
import { useApp } from "../../state/store";
import { PermissionCard } from "../session/PermissionCard";
import { grainVars } from "../../theme/grain";
import type { PaneProps } from "../registry";

const CATEGORY_ICON: Record<NotificationCategory, string> = {
  permission: "alert", session_done: "checkCircle", mcp_health: "plug", agent_probe: "bot", worktree_hazard: "branch", review_done: "diff",
  run_blocked: "alert", run_done: "checkCircle", budget: "target",
};

const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  permission: "Permission request", session_done: "Session", mcp_health: "MCP server", agent_probe: "Agent", worktree_hazard: "Worktree", review_done: "Review",
  run_blocked: "Run needs you", run_done: "Run", budget: "Spend",
};

/** Today / Yesterday / a date — the feed's day-group headers. */
export function dayLabel(ts: number, now = new Date()): string {
  const d = new Date(ts);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

const timeOf = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * The Notifications page (Plan 12 W5): the durable, USER-level feed of things that waited on you —
 * a `notifications-page` destination on W4's sentinel convention. Newest first, grouped by day;
 * unread rows carry the dot; a PENDING permission row is actionable through the SAME PermissionCard
 * the session pane renders (reused, never forked — see PendingPermissionInline).
 *
 * **Master–detail, at full width.** The list is a column of selectable rows and the row you pick opens
 * in the detail column beside it — the page fills its pane rather than the ~720px reading column the
 * other destination pages cap themselves at, because two columns need the room and a feed is scanned,
 * not read. Selection is the page's own coordinate, so it is also what the pane's back/forward arrows
 * step through (`selectNotification` → `navigateInPane`).
 *
 * **Scope: the user.** Not the space, and not the profile. The feed is one table with no space filter,
 * the unread count spans every space, and the SELECTION lives in one user-level store field — so
 * opening Notifications from any space lands on the same page showing the same row. The per-space
 * item row behind the pane is a layout handle (every pane must live in some space's layout); nothing
 * the user can observe about this page is derived from which space they happened to open it from.
 * The pane's `item` is therefore used only to name the pane on the history trail, never as a vantage.
 */
export function NotificationsPage({ item }: PaneProps) {
  const notifications = useApp((s) => s.notifications);
  const unread = useApp((s) => s.notificationsUnread);
  const selectedId = useApp((s) => s.notificationsSelectedId);
  const refreshNotifications = useApp((s) => s.refreshNotifications);
  const loadMoreNotifications = useApp((s) => s.loadMoreNotifications);
  const markNotificationsRead = useApp((s) => s.markNotificationsRead);
  const selectNotification = useApp((s) => s.selectNotification);
  const cursor = useApp((s) => s.notificationsCursor);
  const run = useApp((s) => s.run);

  useEffect(() => { void run(() => refreshNotifications()); }, [run, refreshNotifications]);

  const groups: { label: string; rows: Notification[] }[] = [];
  for (const n of notifications) {
    const label = dayLabel(n.createdAt);
    const g = groups.at(-1);
    if (g && g.label === label) g.rows.push(n);
    else groups.push({ label, rows: [n] });
  }
  // A selection whose row has left the held slice (marked read elsewhere, paged away) shows the empty
  // detail rather than a stale card — the feed is the truth, the selection is only a pointer into it.
  const selected = notifications.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="page notifications-page-pane wash" style={grainVars("notifications-page")}>
      <header className="page-head">
        <span className="page-glyph"><Icon name="notifications-page" size={20} /></span>
        <div className="page-title">
          <h1>Notifications</h1>
          <span className="page-sub">{unread > 0 ? `${unread} unread — everything that waited on you, across every space.` : "Everything that waited on you, across every space."}</span>
        </div>
        {unread > 0 && (
          <button className="btn notif-mark-all" onClick={() => run(() => markNotificationsRead("all"))}>Mark all read</button>
        )}
      </header>
      <div className="page-body notif-split">
        {notifications.length === 0 ? (
          <p className="notif-empty muted">Nothing has needed you. Permission requests, finished sessions and connection trouble will land here.</p>
        ) : (
          <>
            <div className="notif-list">
              {groups.map((g) => (
                <section key={g.label} className="notif-day" aria-label={g.label}>
                  <h2 className="notif-day-label">{g.label}</h2>
                  {g.rows.map((n) => (
                    <NotificationRow key={n.id} n={n} selected={n.id === selectedId}
                      onSelect={() => run(() => selectNotification(item.id, n.id))} />
                  ))}
                </section>
              ))}
              {cursor && <button className="btn notif-more" onClick={() => run(() => loadMoreNotifications())}>Load more</button>}
            </div>
            <div className="notif-detail" aria-label="Notification detail">
              {selected
                ? <NotificationDetail n={selected} />
                : <p className="notif-detail-empty muted">Select a notification to read it here.</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One selectable row. A plain `<button>`, not a clickable div: the list is a set of choices, and the
 * whole row is the target. That it is a button is also why the pending permission card lives in the
 * DETAIL column and not inline here — Allow/Deny are buttons, and buttons do not nest.
 */
function NotificationRow({ n, selected, onSelect }: { n: Notification; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="notif-row" onClick={onSelect} aria-label={n.title}
      aria-current={selected || undefined} data-selected={selected || undefined}
      data-unread={n.readAt === null || undefined} data-category={n.category}>
      <span className="notif-glyph"><Icon name={CATEGORY_ICON[n.category]} size={16} /></span>
      <span className="notif-main">
        <span className="notif-line">
          {n.readAt === null && <span className="notif-dot" aria-label="Unread" />}
          <span className="notif-title">{n.title}</span>
          <span className="notif-time">{timeOf(n.createdAt)}</span>
        </span>
        {n.body && <span className="notif-body">{n.body}</span>}
      </span>
    </button>
  );
}

/**
 * The selected row, in full: what it was, when, what it said, and everything it can still do — the
 * inline PermissionCard for a still-pending request, and the jump to its session.
 */
function NotificationDetail({ n }: { n: Notification }) {
  const openNotificationTarget = useApp((s) => s.openNotificationTarget);
  const run = useApp((s) => s.run);
  const pendingPermission = n.category === "permission" && n.actedAt === null;
  return (
    <article className="notif-detail-card" aria-label={n.title}>
      <header className="notif-detail-head">
        <span className="notif-glyph"><Icon name={CATEGORY_ICON[n.category]} size={16} /></span>
        <span className="notif-detail-kind">{CATEGORY_LABEL[n.category]}</span>
        <span className="notif-time">{dayLabel(n.createdAt)} · {timeOf(n.createdAt)}</span>
      </header>
      <h2 className="notif-detail-title">{n.title}</h2>
      {n.body && <p className="notif-detail-body">{n.body}</p>}
      {pendingPermission && <PendingPermissionInline n={n} />}
      {/* Jumping to the session is the fallback affordance and is ALWAYS present on session rows —
          answering here can only exist while the session still waits. */}
      {n.sessionId && (
        <button className="btn notif-jump" onClick={() => run(() => openNotificationTarget(n))}>Go to session</button>
      )}
    </article>
  );
}

/**
 * The card for a still-pending permission row — the EXISTING PermissionCard, fed from the same
 * transcript pipeline the session pane reads, so the two surfaces can never disagree about what is
 * pending: an answer from ANYWHERE removes the `pendingPermissions` entry (and flips the session out
 * of `waiting_permission`), and this renders nothing. The decision goes to the ROW's own session and
 * requestId — the transcript entry is looked up BY the row's refId, never "whatever is pending".
 */
function PendingPermissionInline({ n }: { n: Notification }) {
  const sessionId = n.sessionId;
  const status = useApp((s) => (sessionId ? s.sessionStatus[sessionId] : undefined));
  const transcript = useApp((s) => (sessionId ? s.transcripts[sessionId] : undefined));
  const openSession = useApp((s) => s.openSession);
  const respondPermission = useApp((s) => s.respondPermission);
  const run = useApp((s) => s.run);
  // The transcript is the source of the request's payload (tool, input, title); load it if this
  // session's pane was never opened. openSession is idempotent and cheap when already loaded.
  useEffect(() => { if (sessionId && !transcript) void run(() => openSession(sessionId)); }, [sessionId, transcript, run, openSession]);
  if (!sessionId || status !== "waiting_permission") return null;
  const pending = transcript?.t.pendingPermissions.find((p) => p.requestId === n.refId);
  if (!pending) return null;
  return (
    <div className="notif-inline-card">
      <PermissionCard permission={pending} onDecide={(d) => run(() => respondPermission(sessionId, pending.requestId, d))} />
    </div>
  );
}
