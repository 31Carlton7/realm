import { describe, expect, it } from "vitest";
import { createAppStore } from "./store";
import { fakeApi, item, notification, session } from "./store.test-fakes";

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
