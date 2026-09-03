import { describe, expect, it } from "vitest";
import { createAppStore } from "./store";
import { fakeApi, item, notification, session } from "./store.test-fakes";
import { NOTIFICATIONS_DESKTOP_KEY } from "@realm/contracts";

const boot = async (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
};

describe("store — the notifications slice (Plan 12 W5)", () => {
  it("boot seeds the unread count from the server WITHOUT loading the feed — the pill needs no page", async () => {
    const { api, store } = await boot({ notifications: [notification("n1"), notification("n2"), notification("n3", { readAt: 5 })] });
    expect(store.getState().notificationsUnread).toBe(2);
    expect(store.getState().notifications).toEqual([]); // the page loads rows, not boot
    expect(api.calls.filter((c) => c.startsWith("listNotifications"))).toEqual(["listNotifications:-:1"]);
  });

  it("refreshNotifications replaces the held slice; loadMore pages on the cursor without duplicating", async () => {
    // 51 rows: one page of 50 plus a tail, with distinct createdAt so the order is deterministic.
    const rows = Array.from({ length: 51 }, (_, i) => notification(`n${String(i).padStart(3, "0")}`, { createdAt: 1000 - i }));
    const { store } = await boot({ notifications: rows });
    await store.getState().refreshNotifications();
    expect(store.getState().notifications).toHaveLength(50);
    expect(store.getState().notificationsCursor).not.toBeNull();
    await store.getState().loadMoreNotifications();
    const s = store.getState();
    expect(s.notifications).toHaveLength(51);
    expect(new Set(s.notifications.map((n) => n.id)).size).toBe(51);
    expect(s.notificationsCursor).toBeNull(); // short page = honest end
  });

  it("markNotificationsRead applies the SERVER's returned unread and flips the held rows", async () => {
    const { api, store } = await boot({ notifications: [notification("n1"), notification("n2")] });
    await store.getState().refreshNotifications();
    await store.getState().markNotificationsRead(["n1"]);
    expect(api.calls).toContain("markNotificationsRead:n1");
    const s = store.getState();
    expect(s.notificationsUnread).toBe(1);
    expect(s.notifications.find((n) => n.id === "n1")!.readAt).not.toBeNull();
    expect(s.notifications.find((n) => n.id === "n2")!.readAt).toBeNull();
    await store.getState().markNotificationsRead("all");
    expect(store.getState().notificationsUnread).toBe(0);
  });

  it("THE second-derivation mutant: applyNotificationsChanged applies the payload's unread verbatim, never a count of held rows", async () => {
    const { store } = await boot();
    // No rows held at all — the count still lands, because it is the server's number, not ours.
    store.getState().applyNotificationsChanged({ notification: null, unread: 7 });
    expect(store.getState().notificationsUnread).toBe(7);
    expect(store.getState().notifications).toEqual([]);
  });

  it("a surfaced row lands at the top of a held slice and MOVES on reopen rather than duplicating", async () => {
    const { store } = await boot({ notifications: [notification("n1", { createdAt: 100 }), notification("n2", { createdAt: 50 })] });
    await store.getState().refreshNotifications();
    store.getState().applyNotificationsChanged({ notification: notification("n2", { createdAt: 200, body: "again" }), unread: 2 });
    const ids = store.getState().notifications.map((n) => n.id);
    expect(ids).toEqual(["n2", "n1"]);
    expect(store.getState().notifications[0]!.body).toBe("again");
  });

  it("a change with no surfaced row refetches a held slice, so pending state cannot go stale on the open page", async () => {
    const { api, store } = await boot({ notifications: [notification("n1")] });
    await store.getState().refreshNotifications();
    const before = api.calls.filter((c) => c.startsWith("listNotifications")).length;
    api.data.notifications[0]!.readAt = 1; // the server-side truth moved (answered elsewhere)
    store.getState().applyNotificationsChanged({ notification: null, unread: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls.filter((c) => c.startsWith("listNotifications")).length).toBe(before + 1);
    expect(store.getState().notifications[0]!.readAt).not.toBeNull();
  });

  it("session_done for the FOCUSED session pane is auto-read the moment it arrives (the renderer owns focus)", async () => {
    const { api, store } = await boot({
      items: { s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "S" })] },
      sessions: [session("se1", "s1")],
    });
    await store.getState().openItem("i1"); // focuses the session pane
    store.getState().applyNotificationsChanged({ notification: notification("nd1", { category: "session_done", sessionId: "se1" }), unread: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls).toContain("markNotificationsRead:nd1");
  });

  it("…and a settle for any OTHER session stays unread — no blanket auto-read", async () => {
    const { api, store } = await boot({
      items: { s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "S" })] },
      sessions: [session("se1", "s1")],
    });
    await store.getState().openItem("i1");
    store.getState().applyNotificationsChanged({ notification: notification("nd2", { category: "session_done", sessionId: "seOTHER" }), unread: 1 });
    // A pending permission for the focused session is NOT auto-read either — only settles are.
    store.getState().applyNotificationsChanged({ notification: notification("nd3", { category: "permission", sessionId: "se1", refId: "r1", actedAt: null }), unread: 2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls.some((c) => c.startsWith("markNotificationsRead"))).toBe(false);
  });

  it("openNotificationTarget jumps cross-space to the session's item and marks the row read", async () => {
    const { api, store } = await boot({
      items: { s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "S" })], s2: [item("i2", "s2", { kind: "session", refId: "se2", title: "T" })] },
      sessions: [session("se1", "s1"), session("se2", "s2")],
    });
    await store.getState().refreshAllSessions();
    expect(store.getState().activeSpaceId).toBe("s1");
    await store.getState().openNotificationTarget(notification("n1", { sessionId: "se2", spaceId: "s2" }));
    expect(store.getState().activeSpaceId).toBe("s2");
    const focusedItem = store.getState().items.find((i) => i.refId === "se2");
    expect(focusedItem).toBeTruthy();
    expect(api.calls).toContain("markNotificationsRead:n1");
  });
});

/** The OS hop is fire-and-forget from the broadcast handler (a failed toast must never take the feed
 *  down), so a tick is what makes it observable. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("store — the desktop (OS) hop", () => {
  it("a SURFACED row asks main for a toast; a resolution asks for nothing", async () => {
    const { api, store } = await boot();
    store.getState().applyNotificationsChanged({ notification: notification("n1", { title: "a session", body: "Finished a turn" }), unread: 1 });
    await tick();
    expect(api.data.shownNotifications).toEqual([{ id: "n1", title: "a session", body: "Finished a turn" }]);
    // Null row = a permission answered, an MCP server recovered, a markRead elsewhere. Nothing new
    // happened to the user, so nothing leaves the app.
    store.getState().applyNotificationsChanged({ notification: null, unread: 0 });
    await tick();
    expect(api.data.shownNotifications).toHaveLength(1);
  });

  it("THE window-vs-pane mutant: a settle on the FOCUSED pane is auto-read and STILL toasts", async () => {
    // Gating the toast on the read bit would inherit the auto-read's blind spot exactly backwards —
    // a turn finishing while its pane is focused but Realm is behind another app is the single case
    // a toast exists for. The read bit is not consulted; main's window focus is.
    const { api, store } = await boot({
      items: { s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "S" })] },
      sessions: [session("se1", "s1")],
    });
    await store.getState().openItem("i1");
    store.getState().applyNotificationsChanged({ notification: notification("nd1", { category: "session_done", sessionId: "se1" }), unread: 1 });
    await tick();
    expect(api.calls).toContain("markNotificationsRead:nd1");
    expect(api.data.shownNotifications.map((n) => n.id)).toEqual(["nd1"]);
  });

  it("the renderer never second-guesses main: it asks with the window focused too, and main is the one that says no", async () => {
    const { api, store } = await boot({ windowFocused: true });
    store.getState().applyNotificationsChanged({ notification: notification("n1"), unread: 1 });
    await tick();
    expect(api.calls).toContain("showDesktopNotification:n1");
    expect(api.data.shownNotifications).toEqual([]);
  });

  it("the switch off: nothing is asked for, the dock reads zero — and the in-app pill still counts", async () => {
    const { api, store } = await boot({ settings: { [NOTIFICATIONS_DESKTOP_KEY]: false }, notifications: [notification("n0")] });
    expect(store.getState().desktopNotifications).toBe(false);
    expect(store.getState().notificationsUnread).toBe(1);
    expect(api.data.badgeCount).toBe(0);
    store.getState().applyNotificationsChanged({ notification: notification("n1"), unread: 2 });
    await tick();
    expect(api.calls.some((c) => c.startsWith("showDesktopNotification"))).toBe(false);
    expect(store.getState().notificationsUnread).toBe(2); // the feed is untouched by the OS switch
    expect(api.data.badgeCount).toBe(0);
  });

  it("an unreadable preference is not a preference to switch the feature off — the default stays on", async () => {
    const { api, store } = await boot({ settings: { [NOTIFICATIONS_DESKTOP_KEY]: "nonsense" } });
    expect(store.getState().desktopNotifications).toBe(true);
    store.getState().applyNotificationsChanged({ notification: notification("n1"), unread: 1 });
    await tick();
    expect(api.data.shownNotifications.map((n) => n.id)).toEqual(["n1"]);
  });

  it("EVERY unread change pushes the badge — boot, broadcast, refresh and markRead alike", async () => {
    const { api, store } = await boot({ notifications: [notification("n1"), notification("n2")] });
    expect(api.data.badgeCount).toBe(2); // boot's seed, before any page was opened
    store.getState().applyNotificationsChanged({ notification: null, unread: 5 });
    await tick();
    expect(api.data.badgeCount).toBe(5);
    await store.getState().refreshNotifications();
    expect(api.data.badgeCount).toBe(2);
    await store.getState().markNotificationsRead("all");
    expect(api.data.badgeCount).toBe(0);
  });

  it("setDesktopNotifications writes the key and republishes the badge — switching off CLEARS the dock", async () => {
    const { api, store } = await boot({ notifications: [notification("n1"), notification("n2")] });
    expect(api.data.badgeCount).toBe(2);
    await store.getState().setDesktopNotifications(false);
    expect(api.calls).toContain(`setSetting:${NOTIFICATIONS_DESKTOP_KEY}=false`);
    expect(api.data.badgeCount).toBe(0);
    expect(store.getState().notificationsUnread).toBe(2);
    await store.getState().setDesktopNotifications(true);
    expect(api.data.badgeCount).toBe(2);
  });

  it("a clicked toast lands on its row even when the feed was never opened — one refetch, then the jump", async () => {
    const { api, store } = await boot({
      items: { s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "S" })], s2: [item("i2", "s2", { kind: "session", refId: "se2", title: "T" })] },
      sessions: [session("se1", "s1"), session("se2", "s2")],
      notifications: [notification("n1", { sessionId: "se2", spaceId: "s2" })],
    });
    expect(store.getState().notifications).toEqual([]); // the page was never mounted
    await store.getState().activateDesktopNotification("n1");
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(store.getState().items.find((i) => i.refId === "se2")).toBeTruthy();
    expect(api.calls).toContain("markNotificationsRead:n1");
  });

  it("…and a click on a row that no longer exists is a quiet no-op, never a throw", async () => {
    const { store } = await boot();
    await expect(store.getState().activateDesktopNotification("gone")).resolves.toBeUndefined();
  });
});
