import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, sessionEvent, type StoredSessionEvent } from "@realm/contracts";
import { NotificationsPage, dayLabel } from "./NotificationsPage";
import { Destinations } from "../../components/sidebar/Destinations";
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

  it("shows a quiet, honest empty state", async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Nothing has needed you/)).toBeInTheDocument());
    expect(screen.queryByText("Mark all read")).toBeNull(); // no dead chrome over an empty feed
    expect(screen.queryByLabelText("Notification detail")).toBeNull(); // nor an empty detail column
  });

  it("Mark all read goes through the global markRead and the rows settle read", async () => {
    const { api } = await mount({ notifications: [notification("n1", { title: "row one" })] });
    await waitFor(() => expect(screen.getByText("row one")).toBeInTheDocument());
    screen.getByText("Mark all read").click();
    await waitFor(() => expect(api.calls).toContain("markNotificationsRead:all"));
    await waitFor(() => expect(screen.getByRole("button", { name: "row one" })).not.toHaveAttribute("data-unread"));
  });

  it("opens the selected row in the detail column, marks it read, and shows nothing until one is picked", async () => {
    const { api, store } = await mount({ notifications: [
      notification("n1", { title: "row one", body: "what happened" }),
      notification("n2", { title: "row two", createdAt: 100 }),
    ] });
    await waitFor(() => expect(screen.getByText("row one")).toBeInTheDocument());
    // Nothing selected: the detail column is present but empty, and no row is current.
    expect(screen.getByText("Select a notification to read it here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "row one" })).not.toHaveAttribute("aria-current");

    await select("row one");
    const detail = screen.getByRole("article", { name: "row one" });
    expect(within(detail).getByText("what happened")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "row one" })).toHaveAttribute("aria-current", "true");
    // Opening a row IS having seen it.
    await waitFor(() => expect(api.calls).toContain("markNotificationsRead:n1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "row one" })).not.toHaveAttribute("data-unread"));
    // The list stays put beside the detail — this is master-detail, not a page swap.
    expect(screen.getByRole("button", { name: "row two" })).toBeInTheDocument();

    // The selection is USER-level state, not the pane's and not the space's.
    expect(store.getState().notificationsSelectedId).toBe("n1");
    await select("row two");
    expect(store.getState().notificationsSelectedId).toBe("n2");
    expect(screen.getByRole("button", { name: "row one" })).not.toHaveAttribute("aria-current");
  });

  it("a selection whose row leaves the feed falls back to the empty detail rather than a stale card", async () => {
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
    // The card belongs to the DETAIL: an unselected feed offers no decisions.
    expect(screen.queryByRole("group", { name: "Permission request" })).toBeNull();
    await select("Fake agent session");
    // The card is the real component — same role, same options — fed by openSession's fetch.
    await waitFor(() => expect(screen.getByRole("group", { name: "Permission request" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    // The jump fallback is ALWAYS present alongside the card.
    expect(screen.getByRole("button", { name: "Go to session" })).toBeInTheDocument();
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
    expect(screen.getByText("Read")).toBeInTheDocument(); // r2's card, not "whatever is pending first"
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

describe("the sidebar Destinations row (W5)", () => {
  async function mountSidebar(overrides: FakeData = {}) {
    const api = fakeApi(overrides);
    const store = createAppStore(api);
    await store.getState().boot();
    const r = render(<StoreContext.Provider value={store}><Destinations /></StoreContext.Provider>);
    return { store, api, ...r };
  }

  it("wears the SERVER's unread count from boot, before any feed page was ever fetched — one source", async () => {
    const { store } = await mountSidebar({ notifications: [notification("n1"), notification("n2"), notification("n3", { readAt: 1 })] });
    const row = screen.getByRole("button", { name: /Notifications/ });
    expect(within(row).getByLabelText("2 unread")).toHaveTextContent("2");
    expect(store.getState().notifications).toEqual([]); // no rows held — the pill cannot be a row count
  });

  it("shows no pill at zero (dead chrome ban), and opens the notifications page on click", async () => {
    const { api, store } = await mountSidebar();
    const row = screen.getByRole("button", { name: /Notifications/ });
    expect(within(row).queryByLabelText(/unread/)).toBeNull();
    row.click();
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("createItem:"))).toBe(true));
    const created = store.getState().items.find((i) => i.kind === "notifications-page");
    expect(created?.refId).toBe(PAGE_REF_IDS["notifications-page"]);
  });

  it("tracks notifications.changed broadcasts verbatim", async () => {
    const { store } = await mountSidebar();
    store.getState().applyNotificationsChanged({ notification: null, unread: 12 });
    await waitFor(() => expect(screen.getByLabelText("12 unread")).toHaveTextContent("12"));
  });
});
