import { useEffect } from "react";
import { Icon } from "@realm/ui";
import type { Notification, NotificationCategory } from "@realm/contracts";
import { useApp } from "../../state/store";
import { PermissionCard } from "../session/PermissionCard";
import { Sheet } from "../../components/Sheet";
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
 * **One centred column, and a modal for the row you pick.** It was a master–detail split at full
 * width, and that shape was wrong for what this page holds: the detail column stood empty most of
 * the time (nothing is selected until you click), the rule between the two halves ran down a page
 * that had one thing on it, and a feed of one-line rows does not need 968px to be scanned. A single
 * measured column reads like the list it is, and the detail — which is a thing you finish and
 * dismiss, not a place you work — opens over it. Selection is still the page's own coordinate, so
 * the pane's back/forward arrows step through it (`selectNotification` → `navigateInPane`); closing
 * the modal clears it.
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
    /* No `wash`. This was the one pane in the app wearing the accent gradient, and a decorated
       ground under a list of things that need attention competes with the attention. */
    <div className="page notifications-page-pane">
      <header className="page-head">
        <div className="page-title"><h1>Notifications</h1></div>
        {/* The count rides the header as a fact rather than a sentence. "3 unread" is the only part
            of the old sub-title that was not restating the page's own name. */}
        {unread > 0 && <span className="notif-unread-count">{unread} unread</span>}
        {unread > 0 && (
          <button className="btn notif-mark-all" onClick={() => run(() => markNotificationsRead("all"))}>Mark all read</button>
        )}
      </header>
      <div className="page-body">
        <div className="page-content notif-feed">
          {notifications.length === 0 ? (
            <div className="notif-empty">
              <p className="notif-empty-line">Nothing has needed you.</p>
              <p className="notif-empty-sub">Permission requests, finished sessions and connection trouble land here.</p>
            </div>
          ) : (
            <>
              {groups.map((g) => (
                <section key={g.label} className="notif-day" aria-label={g.label}>
                  <h2 className="notif-day-label">{g.label}</h2>
                  <ul className="notif-cards">
                    {g.rows.map((n) => (
                      <NotificationRow key={n.id} n={n} selected={n.id === selectedId}
                        onSelect={() => run(() => selectNotification(item.id, n.id))} />
                    ))}
                  </ul>
                </section>
              ))}
              {cursor && <button className="btn notif-more" onClick={() => run(() => loadMoreNotifications())}>Load more</button>}
            </>
          )}
        </div>
      </div>
      {/* Over the feed rather than beside it. Reading one of these is something you finish and
          dismiss; it is not a place you work, and it does not deserve half the page while empty. */}
      {selected && <NotificationSheet n={selected} onClose={() => run(() => selectNotification(item.id, null))} />}
    </div>
  );
}

/**
 * One card. A plain `<button>`, not a clickable div: the list is a set of choices, and the whole
 * card is the target. That it is a button is also why the pending permission card lives in the
 * MODAL and not inline here — Allow/Deny are buttons, and buttons do not nest.
 */
function NotificationRow({ n, selected, onSelect }: { n: Notification; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button type="button" className="notif-row" onClick={onSelect} aria-label={n.title}
        aria-current={selected || undefined} data-selected={selected || undefined}
        data-unread={n.readAt === null || undefined} data-category={n.category}>
        <span className="notif-glyph"><Icon name={CATEGORY_ICON[n.category]} size={16} /></span>
        <span className="notif-main">
          <span className="notif-line">
            <span className="notif-title">{n.title}</span>
            {/* The kind, named. The glyph alone made a reader learn nine icons to know whether a row
                was a permission or a finished run — and design.md bans state carried by mark alone. */}
            <span className="notif-kind">{CATEGORY_LABEL[n.category]}</span>
            <span className="notif-time">{timeOf(n.createdAt)}</span>
          </span>
          {n.body && <span className="notif-body">{n.body}</span>}
        </span>
        {n.readAt === null && <span className="notif-dot" aria-label="Unread" />}
      </button>
    </li>
  );
}

/**
 * The selected notification, over the feed.
 *
 * "Mark as read" is offered here and nowhere else per-row, because this is the only place a reader
 * has actually read one. It is also the one action the old detail column never had: rows were marked
 * read as a side effect of selection, so a row you opened by accident was silently consumed and a row
 * you meant to come back to had no way to stay unread.
 */
function NotificationSheet({ n, onClose }: { n: Notification; onClose: () => void }) {
  const markNotificationsRead = useApp((s) => s.markNotificationsRead);
  const openNotificationTarget = useApp((s) => s.openNotificationTarget);
  const run = useApp((s) => s.run);
  const pendingPermission = n.category === "permission" && n.actedAt === null;
  return (
    <Sheet title={CATEGORY_LABEL[n.category]} onClose={onClose} width={520}>
      {/* An `<article>` inside the dialog: the sheet is the container, the notification is the thing.
          It is also what names this row for a screen reader — the sheet's own title is the kind. */}
      <article className="notif-sheet" aria-label={n.title}>
        <p className="notif-sheet-when">{dayLabel(n.createdAt)} · {timeOf(n.createdAt)}</p>
        <h2 className="notif-detail-title">{n.title}</h2>
        {n.body && <p className="notif-detail-body">{n.body}</p>}
        {pendingPermission && <PendingPermissionInline n={n} />}
        <div className="sheet-actions">
          {n.readAt === null
            ? <button type="button" className="btn-quiet" onClick={() => run(() => markNotificationsRead([n.id]))}>Mark as read</button>
            : <span className="notif-sheet-read">Read</span>}
          <span className="diff-head-spacer" />
          {/* Always present on a session row — answering in place can only exist while the session
              still waits, and jumping is the affordance that never stops working. */}
          {n.sessionId && (
            <button type="button" className="btn" onClick={() => run(() => openNotificationTarget(n))}>Go to session</button>
          )}
        </div>
      </article>
    </Sheet>
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
