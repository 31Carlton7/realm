import { useEffect } from "react";
import { Icon } from "@realm/ui";
import type { Notification, NotificationCategory } from "@realm/contracts";
import { useApp } from "../../state/store";
import { PermissionCard } from "../session/PermissionCard";
import type { PaneProps } from "../registry";

const CATEGORY_ICON: Record<NotificationCategory, string> = {
  permission: "alert", session_done: "checkCircle", mcp_health: "plug", agent_probe: "bot", worktree_hazard: "branch", review_done: "diff",
  run_blocked: "alert", run_done: "checkCircle",
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

/**
 * The Notifications page (Plan 12 W5): the durable, GLOBAL feed of things that waited on the user —
 * a `notifications-page` destination on W4's sentinel convention. Newest first, grouped by day;
 * unread rows carry the dot; a PENDING permission row is actionable inline through the SAME
 * PermissionCard the session pane renders (reused, never forked — see PendingPermissionInline).
 *
 * The pane's `item` goes unused on purpose: unlike Library/Connections this page has no per-space
 * vantage — the feed is global, exactly like the sidebar row's count.
 */
export function NotificationsPage(_props: PaneProps) {
  const notifications = useApp((s) => s.notifications);
  const unread = useApp((s) => s.notificationsUnread);
  const refreshNotifications = useApp((s) => s.refreshNotifications);
  const loadMoreNotifications = useApp((s) => s.loadMoreNotifications);
  const markNotificationsRead = useApp((s) => s.markNotificationsRead);
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

  return (
    <div className="page notifications-page-pane">
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
      <div className="page-body">
        <div className="page-content">
          {notifications.length === 0 ? (
            <p className="notif-empty muted">Nothing has needed you. Permission requests, finished sessions and connection trouble will land here.</p>
          ) : (
            <>
              {groups.map((g) => (
                <section key={g.label} className="notif-day" aria-label={g.label}>
                  <h2 className="notif-day-label">{g.label}</h2>
                  {g.rows.map((n) => <NotificationRow key={n.id} n={n} />)}
                </section>
              ))}
              {cursor && <button className="btn notif-more" onClick={() => run(() => loadMoreNotifications())}>Load more</button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NotificationRow({ n }: { n: Notification }) {
  const openNotificationTarget = useApp((s) => s.openNotificationTarget);
  const run = useApp((s) => s.run);
  const pendingPermission = n.category === "permission" && n.actedAt === null;
  const time = new Date(n.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return (
    <article className="notif-row" data-unread={n.readAt === null || undefined} data-category={n.category} aria-label={n.title}>
      <span className="notif-glyph"><Icon name={CATEGORY_ICON[n.category]} size={16} /></span>
      <div className="notif-main">
        <div className="notif-line">
          {n.readAt === null && <span className="notif-dot" aria-label="Unread" />}
          <span className="notif-title">{n.title}</span>
          <span className="notif-time">{time}</span>
        </div>
        {n.body && <div className="notif-body">{n.body}</div>}
        {pendingPermission && <PendingPermissionInline n={n} />}
        {/* Jumping to the session is the fallback affordance and is ALWAYS present on session rows —
            inline answering can only exist while the session still waits. */}
        {n.sessionId && (
          <button className="btn notif-jump" onClick={() => run(() => openNotificationTarget(n))}>Go to session</button>
        )}
      </div>
    </article>
  );
}

/**
 * The inline card for a still-pending permission row — the EXISTING PermissionCard, fed from the same
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
