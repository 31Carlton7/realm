import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, findSidePane, sessionEvent, type Notification } from "@realm/contracts";
import { PaneHost } from "./PaneHost";
import { useItemContextMenu } from "./sidebar/ItemContextMenu";
import { StoreContext, createAppStore, useApp } from "../state/store";
import { fakeApi, item, notification, session, space } from "../state/store.test-fakes";
import { registerPane } from "../panes/registry";
import { SessionPane } from "../panes/session/SessionPane";
import { AgentsPage } from "../panes/agents/AgentsPage";
import { NotificationsPage } from "../panes/notifications/NotificationsPage";
import { setBrowserBridgesForTests } from "../panes/browser/browser-client";
import { fakeBrowserBridges } from "../panes/browser/browser-bridges.test-fakes";

/**
 * A peek as the person meets it (W11b): the tab marked as one that will not stay, the transcript and
 * its card with no prompter under them, and the two ways in — a session row's menu and the Agents
 * page's rows.
 */

registerPane("session", SessionPane);

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  setBrowserBridgesForTests(fakeBrowserBridges());
});
afterEach(() => { cleanup(); setBrowserBridgesForTests(null); vi.unstubAllGlobals(); });

/** The lead focused in Versed; "Other" in Homework, waiting on a card; "Idle" unopened in Versed. */
async function setup(notifications: Notification[] = []) {
  const api = fakeApi({
    notifications,
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework")],
    items: {
      s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }), item("i-idle", "s1", { kind: "session", refId: "idle", title: "Idle" })],
      s2: [item("i-other", "s2", { kind: "session", refId: "other", title: "Other" })],
    },
    sessions: [session("lead", "s1", { title: "Lead" }), session("idle", "s1", { title: "Idle" }), session("other", "s2", { title: "Other", status: "waiting_permission" }),
      // A quick chat: a session with no row in any space's list.
      session("chat", "s2", { title: "Quick question" })],
    sessionEvents: {
      other: [
        { seq: 1, sessionId: "other", event: sessionEvent("user_message", { text: "Tidy the build", attachments: [] }) },
        { seq: 2, sessionId: "other", event: sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "rm -rf build" }, title: "Remove build/?", suggestions: [] }) },
      ],
    },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-lead");
  return { api, store };
}

/** The pane host as App draws it: this space's rows, and the peek's own. */
function Host() {
  const layout = useApp((s) => s.layout)!;
  const items = useApp((s) => s.items);
  const peek = useApp((s) => s.peek?.item ?? null);
  const focusedLeafId = useApp((s) => s.focusedLeafId);
  return <PaneHost layout={layout} items={peek && !items.some((i) => i.id === peek.id) ? [...items, peek] : items}
    focusedLeafId={focusedLeafId} onFocus={() => {}} onClose={() => {}} onSplit={() => {}} />;
}

async function mountPeek() {
  const ctx = await setup();
  await ctx.store.getState().peekSession("other", "s2");
  render(<StoreContext.Provider value={ctx.store}><Host /></StoreContext.Provider>);
  const panel = () => document.querySelector<HTMLElement>(`[data-leaf-id="${findSidePane(ctx.store.getState().layout!, "i-lead")!.id}"]`)!;
  return { ...ctx, panel };
}

describe("a peek's tab and pane", () => {
  it("marks the tab as a peek, which does not drag into the person's own layout", async () => {
    // THE MUTANT: draw it as any tab — nothing on screen says it goes with the space, and a drag to an
    // edge would make another space's session part of this one's saved arrangement.
    const { panel } = await mountPeek();
    const tab = within(panel()).getByRole("tab", { name: "Peek: Other" });
    expect(tab.closest(".pane-tab")).toHaveAttribute("data-peek");
    expect(tab).toHaveAttribute("draggable", "false");
  });

  it("shows the transcript and answers its card, with no prompter", async () => {
    // THE MUTANT: the ordinary prompter under a peek. The user decided a peek only answers cards.
    const { api, panel } = await mountPeek();
    const card = await within(panel()).findByRole("group", { name: "Permission request" });
    expect(card).toHaveTextContent("Remove build/?");
    expect(within(panel()).queryByRole("textbox", { name: /message/i })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(api.calls).toContain("respondPermission:other:r1:allow"));
  });

  it("says which space the session lives in, and opens it there from Open session", async () => {
    const { store, panel } = await mountPeek();
    const bar = within(panel()).getByRole("group", { name: "Peek" });
    expect(bar).toHaveTextContent("Peek · Homework");
    fireEvent.click(within(bar).getByRole("button", { name: "Open session" }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    expect(store.getState().peek).toBeNull();
  });

  it("carries none of the session's own actions, nor rename or delete, in its menu", async () => {
    // THE MUTANT: a peek's ⋯ menu as any session tab's — Delete, two clicks from a glance at a session
    // in another space.
    const { panel } = await mountPeek();
    fireEvent.click(within(panel()).getByRole("button", { name: "Pane menu for Other" }));
    const menu = within(await screen.findByRole("menu", { name: "Actions for Other" }));
    const rows = [...menu.getAllByRole("menuitem"), ...menu.queryAllByRole("menuitemcheckbox")].map((r) => r.textContent ?? "");
    expect(rows.some((r) => r.startsWith("Rename") || r.startsWith("Delete") || r.startsWith("Files") || r.startsWith("Terminal"))).toBe(false);
    expect(rows.some((r) => r.startsWith("Close"))).toBe(true);
  });
});

/** A session row's context menu, the way the sidebar opens it. */
function RowMenu({ itemId }: { itemId: string }) {
  const it = useApp((s) => s.items.find((i) => i.id === itemId))!;
  const { onContextMenu, element } = useItemContextMenu(() => {});
  return <><button type="button" onContextMenu={onContextMenu(it)}>{it.title}</button>{element}</>;
}

describe("the ways in", () => {
  it("offers Peek on an unopened session's row, and peeks from it", async () => {
    const { store } = await setup();
    render(<StoreContext.Provider value={store}><RowMenu itemId="i-idle" /></StoreContext.Provider>);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Idle" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Peek" }));
    await waitFor(() => expect(store.getState().peek?.item.id).toBe("i-idle"));
  });

  it("does not offer Peek on a row whose session is already on screen", async () => {
    // THE MUTANT: offer it on every session row. A peek of a pane that is already open goes to it,
    // which is what a click on the row does — two names for one thing.
    const { store } = await setup();
    render(<StoreContext.Provider value={store}><RowMenu itemId="i-lead" /></StoreContext.Provider>);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Lead" }));
    expect(within(await screen.findByRole("menu")).queryByRole("menuitem", { name: "Peek" })).toBeNull();
  });

  it("offers a peek on the Agents page for another space's session, not for one open here", async () => {
    const { store } = await setup();
    render(<StoreContext.Provider value={store}><AgentsPage item={item("p", "s1", { kind: "agents-page" })} visible /></StoreContext.Provider>);
    const peekOther = await screen.findByRole("button", { name: "Peek at Other" });
    expect(screen.queryByRole("button", { name: "Peek at Lead" })).toBeNull();
    fireEvent.click(peekOther);
    await waitFor(() => expect(store.getState().peek?.item.id).toBe("i-other"));
    expect(store.getState().activeSpaceId).toBe("s1");
  });

  it("offers no peek for a session with no row in any space, as a quick chat has none", async () => {
    // THE MUTANT: offer it for every session of another space. A quick chat has no row to make a tab
    // of, so its eye would be a button whose only outcome is nothing.
    const { store } = await setup();
    render(<StoreContext.Provider value={store}><AgentsPage item={item("p", "s1", { kind: "agents-page" })} visible /></StoreContext.Provider>);
    await screen.findByRole("button", { name: "Peek at Other" });
    expect(screen.getByText("Quick question")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Peek at Quick question" })).toBeNull();
  });

  it("offers no peek anywhere when there is no session on screen to be beside", async () => {
    // THE MUTANT: offer it regardless — a control whose only outcome is nothing.
    const { store } = await setup();
    await store.getState().closeFromLayout("i-lead");
    await store.getState().newTerminal();
    expect(store.getState().peekOwner()).toBeNull();
    render(<StoreContext.Provider value={store}><AgentsPage item={item("p", "s1", { kind: "agents-page" })} visible /></StoreContext.Provider>);
    await screen.findByText("Other");
    expect(screen.queryByRole("button", { name: /^Peek at/ })).toBeNull();
  });
});

/** The Notifications page over the same two spaces, with the lead focused under it. */
async function feed(notifications: Notification[]) {
  const ctx = await setup(notifications);
  const page = item("np", "s1", { kind: "notifications-page", title: "Notifications", refId: PAGE_REF_IDS["notifications-page"] });
  render(<StoreContext.Provider value={ctx.store}><NotificationsPage item={page} visible /></StoreContext.Provider>);
  return ctx;
}
const eyes = () => screen.queryAllByRole("button", { name: /^Peek at/ }).map((b) => b.getAttribute("aria-label"));

describe("the way in from a notification row", () => {
  it("peeks at another space's session from the row's eye, which sits beside the row and not in it", async () => {
    // THE MUTANT: the eye inside the row's button. One click would peek and open the row's sheet at once.
    const { api, store } = await feed([notification("n-other", { category: "permission", sessionId: "other", spaceId: "s2", refId: "r1", actedAt: null, title: "Other" })]);
    const eye = await screen.findByRole("button", { name: "Peek at Other" });
    const row = screen.getByRole("button", { name: "Other" });
    expect(row.contains(eye)).toBe(false);
    expect(eye.closest("li")).toBe(row.closest("li"));
    fireEvent.click(eye);
    await waitFor(() => expect(store.getState().peek?.item.id).toBe("i-other"));
    expect(store.getState()).toMatchObject({ activeSpaceId: "s1", notificationsSelectedId: null });
    // A look at the session is a look at what the row was about, so the row is read, as opening it would make it.
    await waitFor(() => expect(api.calls).toContain("markNotificationsRead:n-other"));
  });

  it("offers it on exactly the rows the Agents page would offer it on", async () => {
    /* THE MUTANT: a guard of the page's own — any row that names a session. The eye would then go on a
       session already open here (a click on the row shows it) and on a quick chat, which has no row
       anywhere to make a tab of. */
    await feed([
      notification("n-lead", { sessionId: "lead", spaceId: "s1", title: "Lead" }),
      notification("n-idle", { sessionId: "idle", spaceId: "s1", title: "Idle" }),
      notification("n-chat", { sessionId: "chat", spaceId: "s2", title: "Quick question" }),
      notification("n-mcp", { category: "mcp_health", sessionId: null, spaceId: null, title: "GitHub" }),
    ]);
    await screen.findByRole("button", { name: "Peek at Idle" });
    expect(eyes()).toEqual(["Peek at Idle"]);
  });

  it("takes where the session lives now over the space the row was written in", async () => {
    // THE MUTANT: trust the row's own space. A notification outlives a move, and its eye would be a
    // second way to reach a pane that is already on screen here.
    await feed([
      notification("n-lead", { sessionId: "lead", spaceId: "s2", title: "Lead, before it moved" }),
      notification("n-idle", { sessionId: "idle", spaceId: "s1", title: "Idle" }),
    ]);
    await screen.findByRole("button", { name: "Peek at Idle" });
    expect(eyes()).toEqual(["Peek at Idle"]);
  });

  it("offers none with no session on screen to be beside", async () => {
    const { store } = await setup([notification("n-idle", { sessionId: "idle", spaceId: "s1", title: "Idle" })]);
    await store.getState().closeFromLayout("i-lead");
    await store.getState().newTerminal();
    expect(store.getState().peekOwner()).toBeNull();
    const page = item("np", "s1", { kind: "notifications-page", title: "Notifications", refId: PAGE_REF_IDS["notifications-page"] });
    render(<StoreContext.Provider value={store}><NotificationsPage item={page} visible /></StoreContext.Provider>);
    await screen.findByRole("button", { name: "Idle" });
    expect(eyes()).toEqual([]);
  });
});
