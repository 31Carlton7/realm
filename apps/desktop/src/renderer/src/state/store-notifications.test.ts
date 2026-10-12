import { describe, expect, it } from "vitest";
import { createAppStore } from "./store";
import { fakeApi, item, notification, session } from "./store.test-fakes";
import { allItems, navEntry, NOTIFICATIONS_DESKTOP_KEY, NOTIFICATIONS_SOUND_KEY, NOTIFICATIONS_SOUND_VOLUME_KEY } from "@realm/contracts";

const boot = async (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
};

describe("store — the notifications slice (Plan 12 W5)", () => {
  it("boot seeds the unread count from the server WITHOUT loading the feed — the Dock needs no rows", async () => {
    const { api, store } = await boot({ notifications: [notification("n1"), notification("n2"), notification("n3", { readAt: 5 })] });
    expect(store.getState().notificationsUnread).toBe(2);
    expect(store.getState().notifications).toEqual([]); // a clicked toast loads rows, not boot
    expect(api.calls.filter((c) => c.startsWith("listNotifications"))).toEqual(["listNotifications:-:1"]);
  });

  it("refreshNotifications replaces the held slice with the feed's first page", async () => {
    // 51 rows: one page of 50 plus a tail, with distinct createdAt so the order is deterministic.
    const rows = Array.from({ length: 51 }, (_, i) => notification(`n${String(i).padStart(3, "0")}`, { createdAt: 1000 - i }));
    const { store } = await boot({ notifications: rows });
    await store.getState().refreshNotifications();
    expect(store.getState().notifications).toHaveLength(50);
    expect(store.getState().notifications[0]!.id).toBe("n000");
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

  it("THE any-permission mutant: a permission toast lands on the session ITS row names, not on whichever one is waiting", async () => {
    // Both sessions are waiting, and one of them is in the space already on screen — which is exactly
    // the session an argument-less jumpToPermission would prefer. The row names the other one.
    const { store } = await boot({
      items: { s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "S" })], s2: [item("i2", "s2", { kind: "session", refId: "se2", title: "T" })] },
      sessions: [session("se1", "s1", { status: "waiting_permission" }), session("se2", "s2", { status: "waiting_permission" })],
      notifications: [notification("p1", { category: "permission", sessionId: "se2", spaceId: "s2", refId: "req1", actedAt: null })],
    });
    await store.getState().refreshAllSessions();
    expect(store.getState().activeSpaceId).toBe("s1");
    await store.getState().activateDesktopNotification("p1");
    expect(store.getState().activeSpaceId).toBe("s2");
    const pane = store.getState().items.find((i) => i.refId === "se2")!;
    // The FOCUSED pane holds it — which is the half that surfaces the card, not just the space switch.
    expect(navEntry(store.getState().paneHistory, store.getState().focusedLeafId!)).toEqual({ itemId: pane.id, view: null });
  });

  it("a sub-agent's permission toast lands on its lead, in the Agents tab, on that sub-agent's card", async () => {
    // THE MUTANT: land on the child's own pane — the request is answered from its lead's Agents tab,
    // the same place the lead's row in the sidebar sends you.
    const { store } = await boot({
      items: { s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "Lead" })], s2: [] },
      sessions: [session("se1", "s1"), session("se3", "s1", { status: "waiting_permission", dispatchedBy: { kind: "agent_run", sessionId: "se1" } })],
      notifications: [notification("p1", { category: "permission", sessionId: "se3", spaceId: "s1", refId: "req1", actedAt: null })],
    });
    await store.getState().refreshAllSessions();
    await store.getState().activateDesktopNotification("p1");
    expect(store.getState().agentsAsk["se1"]).toMatchObject({ childId: "se3" });
  });

  it("a row with no session lands on the page that owns it — an MCP server on Connections", async () => {
    const { api, store } = await boot({
      notifications: [notification("h1", { category: "mcp_health", sessionId: null, refId: "srv1", title: "srv1 stopped answering", actedAt: null })],
    });
    const layout = allItems(store.getState().layout!);
    await store.getState().activateDesktopNotification("h1");
    // Over the workspace, as every page is: no item, no pane, no split.
    expect(store.getState().pageOverlay?.kind).toBe("connections-page");
    expect(store.getState().items.some((i) => i.kind.endsWith("-page"))).toBe(false);
    expect(allItems(store.getState().layout!)).toEqual(layout);
    expect(api.calls).toContain("markNotificationsRead:h1");
  });

  it("…a probe on Engines, a budget on Usage, a run on Scheduled", async () => {
    const { store } = await boot({ notifications: [
      notification("p1", { category: "agent_probe", sessionId: null, refId: "codex" }),
      notification("b1", { category: "budget", sessionId: null, refId: "2026-09:0.8" }),
      notification("r1", { category: "run_done", sessionId: null, refId: "run1" }),
    ] });
    await store.getState().activateDesktopNotification("p1");
    expect(store.getState().pageOverlay?.kind).toBe("settings-page");
    expect(store.getState().settingsPageTab).toBe("engines");
    await store.getState().activateDesktopNotification("b1");
    expect(store.getState().settingsPageTab).toBe("usage");
    await store.getState().activateDesktopNotification("r1");
    expect(store.getState().pageOverlay?.kind).toBe("schedules-page");
  });

  it("a session row whose pane no longer exists reads the row and moves nothing", async () => {
    const { api, store } = await boot({
      items: { s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "S" })], s2: [] },
      sessions: [session("se1", "s1"), session("se2", "s2")],
      notifications: [notification("d1", { category: "session_done", sessionId: "se2", spaceId: "s2" })],
    });
    await store.getState().refreshAllSessions();
    const layout = store.getState().layout;
    await store.getState().activateDesktopNotification("d1");
    // THE MUTANT: a landing that falls through to some page — there is no feed to stand in for it.
    expect(store.getState().pageOverlay).toBeNull();
    expect(store.getState().layout).toBe(layout);
    expect(api.calls).toContain("markNotificationsRead:d1");
  });
});

describe("store — coming back to the window reads the feed", () => {
  it("reads everything announced while the window was away, once, on the way back", async () => {
    // With no feed page there is nowhere else to read a row, and the Dock's count would only climb.
    const { api, store } = await boot({ notifications: [notification("n1"), notification("n2")] });
    expect(api.data.badgeCount).toBe(2);
    store.getState().setWindowActive(false);
    await tick();
    expect(api.calls.some((c) => c.startsWith("markNotificationsRead"))).toBe(false);
    store.getState().setWindowActive(true);
    await tick();
    expect(api.calls.filter((c) => c.startsWith("markNotificationsRead"))).toEqual(["markNotificationsRead:all"]);
    expect(store.getState().notificationsUnread).toBe(0);
    expect(api.data.badgeCount).toBe(0);
  });

  it("asks nothing when there is nothing unread, and nothing for a focus that never left", async () => {
    const { api, store } = await boot({ notifications: [notification("n1", { readAt: 1 })] });
    store.getState().setWindowActive(false);
    store.getState().setWindowActive(true);
    const busy = await boot({ notifications: [notification("n2")] });
    busy.store.getState().setWindowActive(true); // already active: no transition, no read
    await tick();
    expect(api.calls.some((c) => c.startsWith("markNotificationsRead"))).toBe(false);
    expect(busy.api.calls.some((c) => c.startsWith("markNotificationsRead"))).toBe(false);
  });
});

describe("store — the sound cues", () => {
  it("a settle cues `ready` and a permission cues `chime` — the two moments that call you back", async () => {
    const { api, store } = await boot();
    store.getState().applyNotificationsChanged({ notification: notification("n1", { category: "session_done" }), unread: 1 });
    await tick();
    expect(api.calls).toContain("playCue:ready@0.5");
    store.getState().applyNotificationsChanged({ notification: notification("n2", { category: "permission", actedAt: null }), unread: 2 });
    await tick();
    expect(api.calls).toContain("playCue:chime@0.5");
  });

  it("THE widened-table mutant: infrastructure rows toast in silence", async () => {
    // Every category surfaces a row and every row toasts. Sound is the narrower set on purpose — a
    // failing MCP server, a CLI that stopped probing, a budget ceiling and a refused worktree removal
    // are facts their toast already carries, not a person being called back to do something.
    const { api, store } = await boot();
    for (const category of ["mcp_health", "agent_probe", "budget", "worktree_hazard"] as const) {
      store.getState().applyNotificationsChanged({ notification: notification(`n-${category}`, { category }), unread: 1 });
    }
    await tick();
    expect(api.data.shownNotifications).toHaveLength(4); // all four still reached the OS
    expect(api.calls.some((c) => c.startsWith("playCue"))).toBe(false);
  });

  it("THE focused-window mutant: main suppressed the toast, so there is nothing for a cue to accompany", async () => {
    const { api, store } = await boot({ windowFocused: true });
    store.getState().applyNotificationsChanged({ notification: notification("n1"), unread: 1 });
    await tick();
    expect(api.calls).toContain("showDesktopNotification:n1"); // asked, as always
    expect(api.calls.some((c) => c.startsWith("playCue"))).toBe(false);
  });

  it("THE ignored-setting mutant: sound off is silent, and the toast is untouched", async () => {
    const { api, store } = await boot({ settings: { [NOTIFICATIONS_SOUND_KEY]: false } });
    expect(store.getState().soundCues).toBe(false);
    store.getState().applyNotificationsChanged({ notification: notification("n1"), unread: 1 });
    await tick();
    expect(api.data.shownNotifications.map((n) => n.id)).toEqual(["n1"]);
    expect(api.calls.some((c) => c.startsWith("playCue"))).toBe(false);
  });

  it("the desktop switch is the wider gate: with toasts off nothing sounds either", async () => {
    const { api, store } = await boot({ settings: { [NOTIFICATIONS_DESKTOP_KEY]: false } });
    expect(store.getState().soundCues).toBe(true); // the sound preference itself is untouched
    store.getState().applyNotificationsChanged({ notification: notification("n1"), unread: 1 });
    await tick();
    expect(api.calls.some((c) => c.startsWith("playCue"))).toBe(false);
  });

  it("the stored volume rides every cue, and an unreadable one falls back rather than to silence", async () => {
    const { api, store } = await boot({ settings: { [NOTIFICATIONS_SOUND_VOLUME_KEY]: 0.2 } });
    expect(store.getState().soundVolume).toBe(0.2);
    store.getState().applyNotificationsChanged({ notification: notification("n1"), unread: 1 });
    await tick();
    expect(api.calls).toContain("playCue:ready@0.2");
    const bad = await boot({ settings: { [NOTIFICATIONS_SOUND_VOLUME_KEY]: 4 } });
    expect(bad.store.getState().soundVolume).toBe(0.5);
  });
});
