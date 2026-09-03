/**
 * Desktop (OS) notifications — the last hop of the notifications feed.
 *
 * Everything upstream of this file already decided WHETHER a thing is worth telling the user about:
 * NotificationsService is the one writer, it honors the per-category switches, and its dedup rule
 * means a flapping MCP server surfaces one row rather than two hundred. Only rows it actually
 * SURFACES (`notification` non-null on the `notifications.changed` broadcast) ever get here, so a
 * toast inherits that dedup for free and this module never re-litigates any of it.
 *
 * What it decides is the one thing the server cannot know: whether the user is already looking.
 *
 * **The focus gate is WINDOW focus, deliberately not the feed's read bit.** The store auto-reads a
 * `session_done` for the focused session PANE — a rule about which pane, written before anything
 * left the app. Gating toasts on unread would inherit that rule's blind spot exactly backwards: a
 * turn finishing while its pane is focused but Realm is in the background is auto-read, and that is
 * precisely the moment a toast is worth showing. So the read bit is not consulted here at all;
 * `windowFocused()` is, and a focused window shows nothing because the user is already there.
 */

/** What the renderer hands over: the row's id (to route a click back), plus the words to show. */
export type DesktopNotificationInput = { id: string; title: string; body: string | null };

/** The slice of Electron's `Notification` this module drives, injected like updater.ts's
 *  `UpdaterLike` so the gate can be proven without Electron in the room. */
export type NativeNotification = { show(): void; on(event: "click", cb: () => void): unknown };

export class DesktopNotifier {
  constructor(private readonly d: {
    /** `Notification.isSupported()` — false on a machine with no notification service at all. */
    supported: () => boolean;
    /** The Realm window's focus, as the main process sees it. False when there is no window. */
    windowFocused: () => boolean;
    create: (o: { title: string; body: string }) => NativeNotification;
    /** Bring Realm forward — a click on a toast is a request to be here. */
    focusWindow: () => void;
    /** Hand the row id back to the renderer, which owns jumping to its target. */
    activate: (id: string) => void;
    setBadge: (count: number) => void;
  }) {}

  /** Show a toast for a surfaced row. Answers whether one was actually posted — the renderer logs
   *  nothing on a false, but a test can tell "suppressed" from "shown" without watching Electron. */
  show(input: DesktopNotificationInput): boolean {
    if (!this.d.supported()) return false;
    if (this.d.windowFocused()) return false;
    const n = this.d.create({ title: input.title, body: input.body ?? "" });
    n.on("click", () => { this.d.focusWindow(); this.d.activate(input.id); });
    n.show();
    return true;
  }

  /** The dock badge. Clamped here rather than trusted: the count arrives over IPC, and
   *  `setBadgeCount` with a negative or fractional number is undefined behaviour on every platform.
   *  Zero clears the badge, which is what makes "mark all read" visibly land on the dock. */
  badge(count: number): void {
    this.d.setBadge(Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0);
  }
}
