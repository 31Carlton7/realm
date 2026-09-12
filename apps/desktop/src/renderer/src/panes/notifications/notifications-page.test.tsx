import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, sessionEvent, type StoredSessionEvent } from "@realm/contracts";
import { NotificationsPage, dayLabel } from "./NotificationsPage";
import { SidebarNotifications } from "../../components/sidebar/SidebarNotifications";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, notification, session, type FakeData } from "../../state/store.test-fakes";

const pageItem = item("np-s1", "s1", { kind: "notifications-page", title: "Notifications", refId: PAGE_REF_IDS["notifications-page"] });

const permissionEvents = (sessionId: string, requestId: string, title: string): StoredSessionEvent[] => [
  { seq: 1, sessionId, event: sessionEvent("user_message", { text: "go", attachments: [] }) },
  { seq: 2, sessionId, event: sessionEvent("permission_request", { requestId, toolName: "Bash", input: { command: "ls" }, title, suggestions: [] }) },
];

async function mount(overrides: FakeData = {}) {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><NotificationsPage item={pageItem} visible /></StoreContext.Provider>);
  return { store, api, ...r };
}

/** Click a row and wait for the detail column to catch up — selection goes through `run()`. */
async function select(title: string) {
  await waitFor(() => expect(screen.getByRole("button", { name: title })).toBeInTheDocument());
  screen.getByRole("button", { name: title }).click();
  await waitFor(() => expect(screen.getByRole("article", { name: title })).toBeInTheDocument());
}

describe("the Notifications page (Plan 12 W5)", () => {
  it("renders the feed newest-first, grouped by day, with unread rows visually distinct", async () => {
    const now = Date.now();
    await mount({ notifications: [
      notification("n1", { title: "old row", createdAt: now - 86_400_000, readAt: 5 }),
      notification("n2", { title: "fresh row", createdAt: now }),
    ] });
    await waitFor(() => expect(screen.getByText("fresh row")).toBeInTheDocument());
    // Day groups, in feed order: today's before yesterday's.
    const groups = screen.getAllByRole("region").map((el) => el.getAttribute("aria-label"));
    expect(groups).toEqual(["Today", "Yesterday"]);
    // Unread wears the dot and the data hook; read rows carry neither.
    const fresh = screen.getByRole("button", { name: "fresh row" });
    expect(fresh).toHaveAttribute("data-unread");
    expect(within(fresh).getByLabelText("Unread")).toBeInTheDocument();
    const old = screen.getByRole("button", { name: "old row" });
    expect(old).not.toHaveAttribute("data-unread");
    expect(within(old).queryByLabelText("Unread")).toBeNull();
  });

  it("is one measured column of cards, with no decorated ground under it", async () => {
    /* Both halves are deliberate reversals. The page was a two-column split at 968px whose detail
       column stood empty until something was selected — a rule down the middle of a page with one
       thing on it. And it was the only pane in the app wearing the accent wash, which competes with
       the attention a list of things needing attention is asking for. */
    const { container } = await mount({ notifications: [notification("n1", { title: "a row" })] });
    await waitFor(() => expect(screen.getByText("a row")).toBeInTheDocument());
    expect(container.querySelector(".notif-feed")).toBeInTheDocument();
    expect(container.querySelector(".page")).not.toHaveClass("wash");
  });

  it("shows a quiet, honest empty state", async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Nothing has needed you/)).toBeInTheDocument());
    expect(screen.queryByText("Mark all read")).toBeNull(); // no dead chrome over an empty feed
  });

  it("Mark all read goes through the global markRead and the rows settle read", async () => {
    const { api } = await mount({ notifications: [notification("n1", { title: "row one" })] });
    await waitFor(() => expect(screen.getByText("row one")).toBeInTheDocument());
    screen.getByText("Mark all read").click();
    await waitFor(() => expect(api.calls).toContain("markNotificationsRead:all"));
    await waitFor(() => expect(screen.getByRole("button", { name: "row one" })).not.toHaveAttribute("data-unread"));
  });

  it("opens the selected row over the feed, and draws no modal until one is picked", async () => {
    const { store } = await mount({ notifications: [
      notification("n1", { title: "row one", body: "what happened" }),
      notification("n2", { title: "row two", createdAt: 100 }),
    ] });
    await waitFor(() => expect(screen.getByText("row one")).toBeInTheDocument());
    // Nothing selected: nothing is drawn. The old shape kept an empty detail column standing.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "row one" })).not.toHaveAttribute("aria-current");

    await select("row one");
    const detail = screen.getByRole("article", { name: "row one" });
    expect(within(detail).getByText("what happened")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "row one" })).toHaveAttribute("aria-current", "true");
    // The feed stays behind it — this is a modal over the page, not a page swap.
    expect(screen.getByRole("button", { name: "row two" })).toBeInTheDocument();

    // The selection is USER-level state, not the pane's and not the space's.
    expect(store.getState().notificationsSelectedId).toBe("n1");
    await select("row two");
    expect(store.getState().notificationsSelectedId).toBe("n2");
    expect(screen.getByRole("button", { name: "row one" })).not.toHaveAttribute("aria-current");
  });

  it("opening a row IS having seen it", async () => {
    /* This went away for a version, on the reasoning that a row opened by accident should not be
       silently consumed. In practice the opposite is the annoyance: a feed you have read through
       that still says nine unread, and a button to press for each one. The modal reports the state;
       it does not ask you to set it. */
    const { api } = await mount({ notifications: [notification("n1", { title: "row one" })] });
    await waitFor(() => expect(screen.getByText("row one")).toBeInTheDocument());
    await select("row one");
    await waitFor(() => expect(api.calls).toContain("markNotificationsRead:n1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "row one" })).not.toHaveAttribute("data-unread"));
    // A label, never a control: a button here would be dead the moment it was drawn.
    expect(screen.queryByRole("button", { name: "Mark as read" })).toBeNull();
  });

  it("a selection whose row leaves the feed closes the modal rather than showing a stale card", async () => {
    const { store } = await mount({ notifications: [notification("n1", { title: "row one" })] });
    await waitFor(() => expect(screen.getByText("row one")).toBeInTheDocument());
    await select("row one");
    store.setState({ notifications: [] });
    await waitFor(() => expect(screen.getByText("Nothing has needed you.", { exact: false })).toBeInTheDocument());
    expect(screen.queryByRole("article", { name: "row one" })).toBeNull();
  });

  it("a PENDING permission row is answered from the detail with the session pane's own PermissionCard", async () => {
    await mount({
      sessions: [session("se1", "s1", { status: "waiting_permission" })],
      sessionEvents: { se1: permissionEvents("se1", "r1", "Run ls?") },
      notifications: [notification("n1", { category: "permission", sessionId: "se1", refId: "r1", actedAt: null, title: "Fake agent session", body: "Run ls?" })],
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Fake agent session" })).toBeInTheDocument());
    // The card belongs to the MODAL: an unselected feed offers no decisions.
    expect(screen.queryByRole("group", { name: "Permission request" })).toBeNull();
    await select("Fake agent session");
    // The card is the real component — same role, same options — fed by openSession's fetch.
    await waitFor(() => expect(screen.getByRole("group", { name: "Permission request" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    // The jump fallback is ALWAYS present alongside the card.
    expect(screen.getByRole("button", { name: "Go to session" })).toBeInTheDocument();
  });

  it("names the space and profile the row came from", async () => {
    // A feed collects rows from every space under every profile, so "finished a turn" alone is a
    // sentence about no particular place. Read from the store rather than stamped on the row, so a
    // renamed space reads by its name now instead of the one it had when the turn ended.
    await mount({
      sessions: [session("se1", "s1")],
      notifications: [notification("n1", { category: "session_done", sessionId: "se1", spaceId: "s1", title: "a turn", body: "Finished a turn" })],
    });
    await select("a turn");
    const sheet = screen.getByRole("article", { name: "a turn" });
    expect(sheet).toHaveTextContent("Versed");   // the space
    expect(sheet).toHaveTextContent("Work");     // the profile it belongs to
  });

  it("sends a quick reply to the row's own session without leaving the feed", async () => {
    const { api } = await mount({
      sessions: [session("se1", "s1"), session("se2", "s1")],
      notifications: [notification("n1", { category: "session_done", sessionId: "se1", spaceId: "s1", title: "a turn", body: "Finished a turn" })],
    });
    await select("a turn");
    const field = screen.getByRole("textbox", { name: "Reply to this session" });
    fireEvent.change(field, { target: { value: "keep going" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // THE mutant: send to "whatever session is open" rather than to the ROW's session.
    await waitFor(() => expect(api.sent.map((m) => [m.id, m.text])).toEqual([["se1", "keep going"]]));
    // …and no navigation happened: the point is to answer without going there.
    expect(api.calls).not.toContain("openSession:se2");
  });

  it("offers no reply on a session that is still running", async () => {
    // A field that queued text into a live turn would promise an ordering that belongs to the
    // harness, not to a notification.
    await mount({
      sessions: [session("se1", "s1", { status: "running" })],
      notifications: [notification("n1", { category: "session_done", sessionId: "se1", spaceId: "s1", title: "a turn" })],
    });
    await select("a turn");
    expect(screen.queryByRole("textbox", { name: "Reply to this session" })).toBeNull();
  });

  it("keeps the words when the send fails", async () => {
    const { api } = await mount({
      sessions: [session("se1", "s1")],
      notifications: [notification("n1", { category: "session_done", sessionId: "se1", spaceId: "s1", title: "a turn" })],
    });
    api.sendMessage = async () => { throw new Error("offline"); };
    await select("a turn");
    const field = screen.getByRole("textbox", { name: "Reply to this session" });
    fireEvent.change(field, { target: { value: "keep going" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Reply to this session" })).toHaveValue("keep going"));
  });

  it("THE wrong-session mutant: the detail's card answers the SELECTED row's session and requestId", async () => {
    const { api } = await mount({
      sessions: [session("se1", "s1", { status: "waiting_permission" }), session("se2", "s1", { status: "waiting_permission" })],
      sessionEvents: { se1: permissionEvents("se1", "r1", "Run ls?"), se2: permissionEvents("se2", "r2", "Read x?") },
      notifications: [
        notification("na", { category: "permission", sessionId: "se1", refId: "r1", actedAt: null, title: "session one", createdAt: 200 }),
        notification("nb", { category: "permission", sessionId: "se2", refId: "r2", actedAt: null, title: "session two", createdAt: 100 }),
      ],
    });
    // The SECOND row, while the first is the one at the top of the feed — "whatever is pending first"
    // is exactly the wrong answer this guards.
    await select("session two");
    await waitFor(() => expect(screen.getByRole("group", { name: "Permission request" })).toBeInTheDocument());
    screen.getByRole("button", { name: "Allow" }).click();
    await waitFor(() => expect(api.calls).toContain("respondPermission:se2:r2:allow"));
    expect(api.calls).not.toContain("respondPermission:se1:r1:allow");
  });

  it("…and with two pending requests on ONE session, the card is the one the row's refId names", async () => {
    const { api } = await mount({
      sessions: [session("se1", "s1", { status: "waiting_permission" })],
      sessionEvents: { se1: [
        { seq: 1, sessionId: "se1", event: sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "ls" }, title: "Run ls?", suggestions: [] }) },
        { seq: 2, sessionId: "se1", event: sessionEvent("permission_request", { requestId: "r2", toolName: "Read", input: { file_path: "/x" }, title: "Read x?", suggestions: [] }) },
      ] },
      notifications: [
        notification("na", { category: "permission", sessionId: "se1", refId: "r1", actedAt: null, title: "row one", createdAt: 200 }),
        notification("nb", { category: "permission", sessionId: "se1", refId: "r2", actedAt: null, title: "row two", createdAt: 100 }),
      ],
    });
    await select("row two");
    await waitFor(() => expect(screen.getByRole("group", { name: "Permission request" })).toBeInTheDocument());
    // r2's card, not "whatever is pending first". Scoped to the permission card: the sheet also
    // carries a "Read"/"Unread" state label now, and a bare text match finds both.
    expect(within(screen.getByRole("group", { name: "Permission request" })).getByText("Read")).toBeInTheDocument();
    screen.getByRole("button", { name: "Allow" }).click();
    await waitFor(() => expect(api.calls).toContain("respondPermission:se1:r2:allow"));
    expect(api.calls.filter((c) => c.startsWith("respondPermission"))).toEqual(["respondPermission:se1:r2:allow"]);
  });

  it("a resolved permission row shows what happened and offers only the jump — never a dead card", async () => {
    await mount({
      sessions: [session("se1", "s1", { status: "idle" })],
      notifications: [notification("n1", { category: "permission", sessionId: "se1", refId: "r1", actedAt: 10, title: "the session", body: "Run ls? — Allowed" })],
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "the session" })).toBeInTheDocument());
    await select("the session");
    expect(within(screen.getByRole("article", { name: "the session" })).getByText("Run ls? — Allowed")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Permission request" })).toBeNull();
    expect(screen.getByRole("button", { name: "Go to session" })).toBeInTheDocument();
  });

  it("THE staleness mutant, renderer half: a row still marked pending renders NO card once the session stopped waiting", async () => {
    // The row lags (still unacted) but the session answered elsewhere — status is the reconciler.
    await mount({
      sessions: [session("se1", "s1", { status: "running" })],
      sessionEvents: { se1: permissionEvents("se1", "r1", "Run ls?") },
      notifications: [notification("n1", { category: "permission", sessionId: "se1", refId: "r1", actedAt: null, title: "the session" })],
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "the session" })).toBeInTheDocument());
    await select("the session");
    expect(screen.queryByRole("group", { name: "Permission request" })).toBeNull();
  });

  it("dayLabel names today, yesterday, and dates plainly", () => {
    const now = new Date(2026, 7, 31, 12);
    expect(dayLabel(now.getTime(), now)).toBe("Today");
    expect(dayLabel(now.getTime() - 86_400_000, now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 7, 1).getTime(), now)).toMatch(/August 1/);
    expect(dayLabel(new Date(2025, 11, 31).getTime(), now)).toMatch(/2025/);
  });
});

/** The row became a bell in the head row; everything the row was tested for is still true of it,
 *  and one thing more — the count now has to reach a reader through the NAME, because a 16px chip
 *  at a glyph's shoulder is not something a screen reader can describe by its shape. */
describe("the head row's bell", () => {
  async function mountBell(overrides: FakeData = {}) {
    const api = fakeApi(overrides);
    const store = createAppStore(api);
    await store.getState().boot();
    const r = render(<StoreContext.Provider value={store}><SidebarNotifications /></StoreContext.Provider>);
    return { store, api, ...r };
  }

  it("wears the SERVER's unread count from boot, before any feed page was ever fetched — one source", async () => {
    const { store } = await mountBell({ notifications: [notification("n1"), notification("n2"), notification("n3", { readAt: 1 })] });
    const bell = screen.getByRole("button", { name: "Notifications, 2 unread" });
    expect(within(bell).getByText("2")).toHaveClass("sb-badge");
    expect(store.getState().notifications).toEqual([]); // no rows held — the badge cannot be a row count
  });

  it("shows no badge at zero (dead chrome ban), and opens the notifications page on click", async () => {
    const { api, store, container } = await mountBell();
    const bell = screen.getByRole("button", { name: "Notifications" });
    expect(container.querySelector(".sb-badge")).toBeNull();
    bell.click();
    // The page comes up OVER the workspace — no item created, nothing added to the sidebar.
    await waitFor(() => expect(store.getState().pageOverlay).toEqual({
      kind: "notifications-page", refId: PAGE_REF_IDS["notifications-page"], spaceId: store.getState().activeSpaceId,
    }));
    expect(api.calls.some((c) => c.startsWith("createItem:"))).toBe(false);
  });

  it("tracks notifications.changed broadcasts verbatim, in the badge AND in the name", async () => {
    const { store } = await mountBell();
    store.getState().applyNotificationsChanged({ notification: null, unread: 12 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications, 12 unread" })).toBeInTheDocument());
    expect(screen.getByText("12")).toHaveClass("sb-badge");
    /* Three digits do not fit beside a 14px glyph at the type floor, so past ninety-nine the badge
       says "a lot" and the exact number is on the page it opens — but the NAME keeps it, because
       nothing about a reader's ability to hear "127" depends on the width of a chip. */
    store.getState().applyNotificationsChanged({ notification: null, unread: 127 });
    await waitFor(() => expect(screen.getByText("99+")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Notifications, 127 unread" })).toBeInTheDocument();
  });
});
