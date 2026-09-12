import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Session } from "@realm/contracts";
import { ChatFeed } from "./ChatFeed";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, session, space } from "../../state/store.test-fakes";

const day = (d: number, h = 12) => new Date(2026, 8, d, h).getTime();

/** A session in a given space, at a given moment, with a folder to name. */
const chat = (id: string, spaceId: string, at: number, over: Partial<Session> = {}): Session =>
  session(id, spaceId, { title: `chat ${id}`, cwd: "/code/realm", updatedAt: at, createdAt: at, ...over });

async function mount(sessions: Session[], spaces = [space("s1", "p1", "Work")]) {
  const api = fakeApi({ sessions, spaces });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><ChatFeed /></StoreContext.Provider>);
  await waitFor(() => expect(api.calls.some((c) => c.startsWith("listAllSessions"))).toBe(true));
  return { api, store };
}

describe("the sidebar chat feed", () => {
  it("lists chats from EVERY space, not just the one you are standing in", async () => {
    /* The whole reason this is not the space list with headings on it. THE MUTANT: filter to
       `activeSpaceId` — the feed would answer "what is open here", which the other lens already does. */
    await mount(
      [chat("a", "s1", day(9)), chat("b", "s2", day(9))],
      [space("s1", "p1", "Work"), space("s2", "p1", "School")],
    );
    await waitFor(() => expect(screen.getByText("chat a")).toBeInTheDocument());
    expect(screen.getByText("chat b")).toBeInTheDocument();
    expect(screen.getByText("School")).toBeInTheDocument();
  });

  it("puts a day heading over each group", async () => {
    await mount([chat("a", "s1", Date.now()), chat("b", "s1", Date.now() - 86_400_000 * 2)]);
    await waitFor(() => expect(screen.getByText("Today")).toBeInTheDocument());
    // The older one lands under some other heading — which one depends on the day this runs.
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("does not repeat the space's name as its folder", async () => {
    /* A space's folder is named after the space, so both chips would say the same word twice. THE
       MUTANT: render the folder unconditionally — every row carries a redundant chip and the line
       that exists to disambiguate stops disambiguating. */
    await mount([chat("a", "s1", day(9), { cwd: "/realm-home/work" })], [space("s1", "p1", "Work")]);
    await waitFor(() => expect(screen.getByText("chat a")).toBeInTheDocument());
    expect(screen.getAllByText(/^work$/i)).toHaveLength(1);
  });

  it("shows the folder when it differs — a linked project or a worktree", async () => {
    await mount([chat("a", "s1", day(9), { cwd: "/code/lateraldock" })], [space("s1", "p1", "Work")]);
    await waitFor(() => expect(screen.getByText("lateraldock")).toBeInTheDocument());
  });

  it("asks the server for ONE profile's chats, rather than filtering here", async () => {
    /* The codebase's own rule (see `search.query`): a Work surface must not show a School transcript,
       and a client-side filter is not trusted with it. THE MUTANT: call with no profile and filter
       the rows in the component. */
    const { api } = await mount([chat("a", "s1", day(9))]);
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("listAllSessions:") && !c.endsWith(":all"))).toBe(true));
  });

  it("carries the facts that tell two chats with the same title apart", async () => {
    /* Space and folder on every row. THE MUTANT: render the title alone — two chats called "Fix the
       login form" in different repos become indistinguishable, which is the bug this line exists for. */
    await mount([chat("a", "s1", day(9), { title: "Fix the login form", cwd: "/code/realm" })]);
    await waitFor(() => expect(screen.getByText("Fix the login form")).toBeInTheDocument());
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.getByText("realm")).toBeInTheDocument();
  });

  it("says nothing about a branch it does not know, rather than guessing", async () => {
    /* Environments are loaded per space, so a chat elsewhere has none here. THE MUTANT: fall back to
       the default branch name — the row would then assert a branch that may not be checked out. */
    await mount([chat("a", "s1", day(9), { environmentId: "env-unknown" })]);
    await waitFor(() => expect(screen.getByText("chat a")).toBeInTheDocument());
    expect(screen.queryByText("main")).toBeNull();
  });

  it("reveals the chat, handing over the space so a cross-space click switches", async () => {
    const { api } = await mount([chat("a", "s2", day(9))], [space("s1", "p1", "Work"), space("s2", "p1", "School")]);
    await waitFor(() => expect(screen.getByText("chat a")).toBeInTheDocument());
    fireEvent.click(screen.getByText("chat a").closest("button")!);
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("getSession:a") || c.includes("a"))).toBe(true));
  });

  it("says the list is empty rather than drawing nothing", async () => {
    await mount([]);
    await waitFor(() => expect(screen.getByText("No chats yet")).toBeInTheDocument());
  });
});
