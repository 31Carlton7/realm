import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, sessionEvent, type Session } from "@realm/contracts";
import { AgentsPage } from "./AgentsPage";
import { createAppStore, StoreContext } from "../../state/store";
import { fakeApi, item, session, space } from "../../state/store.test-fakes";

afterEach(() => cleanup());

const row = (id: string, spaceId: string, over: Partial<Session> = {}) =>
  session(id, spaceId, { title: `Session ${id}`, ...over });

async function onTheWall(sessions: Session[]) {
  const api = fakeApi({ spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Plynn")], sessions });
  const store = createAppStore(api); await store.getState().boot();
  const { container } = render(<StoreContext.Provider value={store}>
    <AgentsPage item={item("pg", "s1", { kind: "agents-page", refId: PAGE_REF_IDS["agents-page"], title: "Agents" })} visible />
  </StoreContext.Provider>);
  await screen.findByRole("group", { name: "View" });
  fireEvent.click(screen.getByRole("button", { name: "Wall" }));
  return { api, store, container };
}

describe("the Agents wall", () => {
  it("draws the live ones as tiles and leaves history to the list", async () => {
    /* The mutant: draw every group. `Ready` is every session that ever finished — 254 on a real
       home — and a wall is a shape you count, so the three that matter would be lost in it. */
    await onTheWall([
      row("se1", "s1", { status: "waiting_permission", cwd: "/Users/me/versed", updatedAt: 9 }),
      row("se2", "s2", { status: "running", cwd: "/Users/me/plynn", updatedAt: 5 }),
      row("se3", "s1", { status: "idle", cwd: "/Users/me/versed", updatedAt: 1 }),
      row("se4", "s1", { status: "ended", cwd: "/Users/me/versed", updatedAt: 1 }),
    ]);
    expect(within(screen.getByRole("region", { name: "Needs you" })).getByRole("button", { name: /Session se1/ })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Working" })).getByRole("button", { name: /Session se2/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Ready" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Ended" })).toBeNull();
  });

  it("shows what each agent is doing now, and nothing where it has said nothing", async () => {
    /* The line is the whole reason the wall is not the list. The second mutant is the quiet one:
       default the missing line to "Working". An agent that has said nothing since this window
       connected is not an agent doing nothing, and only one of those two is knowable. */
    const { store } = await onTheWall([
      row("se1", "s1", { status: "running", cwd: "/Users/me/a", updatedAt: 9 }),
      row("se2", "s1", { status: "running", cwd: "/Users/me/b", updatedAt: 8 }),
    ]);
    store.getState().applySessionEvent({
      seq: 1, sessionId: "se1", ephemeral: false,
      event: sessionEvent("tool_call", { toolUseId: "t", name: "Bash", input: { command: "pnpm vitest run" }, parentToolUseId: null }, 1),
    });
    const working = screen.getByRole("region", { name: "Working" });
    await waitFor(() => expect(within(working).getByRole("button", { name: /Session se1/ })).toHaveTextContent("pnpm vitest run"));
    expect(within(working).getByRole("button", { name: /Session se2/ })).not.toHaveTextContent("pnpm vitest run");
    expect(within(working).getByRole("button", { name: /Session se2/ })).not.toHaveTextContent(/Working|Idle|Thinking/);
  });

  it("keeps the folder on the tile, which is what tells a fan-out's agents apart", async () => {
    /* One brief, one title, N worktrees: the checkout is the only thing that differs, so it is the
       part of the sub-line that may not be dropped. */
    await onTheWall([
      row("se1", "s1", { status: "running", cwd: "/Users/me/realm-fix-flake-1", updatedAt: 9 }),
      row("se2", "s1", { status: "running", cwd: "/Users/me/realm-fix-flake-2", updatedAt: 8 }),
    ]);
    const working = screen.getByRole("region", { name: "Working" });
    expect(within(working).getByRole("button", { name: /Session se1/ })).toHaveTextContent("realm-fix-flake-1");
    expect(within(working).getByRole("button", { name: /Session se2/ })).toHaveTextContent("realm-fix-flake-2");
  });

  it("says so when the wall is empty rather than drawing an empty field", async () => {
    await onTheWall([row("se3", "s1", { status: "idle", updatedAt: 1 })]);
    expect(screen.getByText(/No agents are working right now/)).toBeInTheDocument();
  });

  it("a tile goes to its session, like the row it replaces", async () => {
    const { store } = await onTheWall([row("se2", "s2", { status: "running", cwd: "/Users/me/plynn", updatedAt: 5 })]);
    fireEvent.click(screen.getByRole("button", { name: /Session se2/ }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  });

  it("the view buttons name the view and carry which one is on, never both in the label", async () => {
    /* "Wall, pressed" is a sentence at war with itself only when the label names the STATE. These
       name the view, so `aria-pressed` is free to say which is on. */
    await onTheWall([row("se2", "s1", { status: "running", updatedAt: 5 })]);
    expect(screen.getByRole("button", { name: "Wall" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  });
});
