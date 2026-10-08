import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SpacePage } from "./SpacePage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, type FakeData } from "../../state/store.test-fakes";

const pageItem = (spaceId: string) => item(`pg-${spaceId}`, spaceId, { kind: "space-page", title: "Overview", refId: spaceId });

/** The page on its Sessions tab. */
async function mount(overrides: FakeData = {}) {
  const api = fakeApi(overrides); const store = createAppStore(api); await store.getState().boot();
  store.getState().setSpacePageTab("s1", "sessions");
  const r = render(<StoreContext.Provider value={store}><SpacePage item={pageItem("s1")} visible /></StoreContext.Provider>);
  return { store, api, ...r };
}

const T = Date.now() - 3_600_000;
/** A session with its item, both in s1. */
function both(id: string, title: string, extra: Parameters<typeof session>[2] = {}, archived = false) {
  return {
    session: session(id, "s1", { title, createdAt: T, updatedAt: T, lastEventSeq: 3, seenSeq: 3, ...extra }),
    item: item(`it-${id}`, "s1", { kind: "session", title, refId: id, archived }),
  };
}
function data(rows: ReturnType<typeof both>[]): FakeData {
  return { items: { s1: rows.map((r) => r.item) }, sessions: rows.map((r) => r.session) };
}

const row = (name: RegExp | string) => screen.getByRole("button", { name }).closest(".space-sessions-row") as HTMLElement;

describe("the Sessions page", () => {
  it("draws no mark on an idle, read row — only on what is live or unread", async () => {
    // Mutant: the raw status dot is back, a grey dot on every row.
    await mount(data([both("a", "Quiet one"), both("b", "Busy one", { status: "running" }), both("c", "News", { lastEventSeq: 9, seenSeq: 2 })]));
    expect(row(/^Quiet one/).querySelector(".status-dot")).toBeNull();
    expect(row(/^Busy one/).querySelector(".status-dot")).toHaveAttribute("data-status", "running");
    expect(row(/^News/).querySelector(".status-dot")).toHaveAttribute("data-status", "unseen");
    expect(within(row(/^Busy one/)).getByText("Working…")).toBeInTheDocument();
  });

  it("carries no Archived chip; the Archived filter lists only archived sessions, with their counts", async () => {
    // Mutant: the chip is back on the row, or the filter is ignored.
    const { container } = await mount(data([both("a", "Live work"), both("b", "Put away", {}, true), both("c", "Also away", {}, true)]));
    expect(screen.getByRole("radio", { name: /Active/ }).closest("label")).toHaveTextContent("Active 1");
    expect(screen.getByRole("radio", { name: /Archived/ }).closest("label")).toHaveTextContent("Archived 2");
    const list = () => container.querySelectorAll(".space-sessions-list .space-sessions-title");
    expect([...list()].map((t) => t.textContent)).toEqual(["Live work"]);
    expect(container.querySelector(".space-sessions")!.textContent).not.toMatch(/Archived(?! \d)/);
    fireEvent.click(screen.getByRole("radio", { name: /Archived/ }));
    expect([...list()].map((t) => t.textContent).sort()).toEqual(["Also away", "Put away"]);
  });

  it("names a sub-agent without the server's prefix, and says it is an agent", async () => {
    // Mutant: the prefix shown, or the accessible name loses the kind.
    const lead = both("L", "bible app quiz");
    const kid = both("k", "Agent: You are researching TikTok", { dispatchedBy: { sessionId: "L", kind: "agent_run" } });
    await mount(data([lead, kid]));
    // Folded by default.
    expect(screen.queryByText("You are researching TikTok")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 agent of bible app quiz" }));
    expect(screen.getByText("You are researching TikTok")).toBeInTheDocument();
    expect(screen.queryByText(/Agent: You are/)).toBeNull();
    expect(screen.getByRole("button", { name: "You are researching TikTok, agent" })).toBeInTheDocument();
  });

  it("keeps the accent fill for an empty space's one action, and off a populated list", async () => {
    // Mutant: the accent New session is back on a populated page.
    const { unmount, api } = await mount(data([]));
    const primaries = document.querySelectorAll(".btn.primary");
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toHaveTextContent(/New session/);
    expect(screen.getByText("No sessions in Versed yet.")).toBeInTheDocument();
    fireEvent.click(primaries[0]!);
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("createSession:"))).toBe(true));
    unmount();
    await mount(data([both("a", "Work")]));
    expect(document.querySelectorAll(".btn.primary")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /^New session/ })).toHaveClass("btn");
  });

  it("dims a session nothing was sent in and says so", async () => {
    await mount(data([both("e", "New session", { lastEventSeq: 0, seenSeq: 0 })]));
    const r = row("New session, nothing sent yet");
    expect(r).toHaveAttribute("data-empty");
    expect(within(r).getByText("Nothing sent yet")).toBeInTheDocument();
  });

  it("searches titles, agents' included, and says when nothing matches", async () => {
    const lead = both("L", "bible app quiz");
    const kid = both("k", "Agent: research paywall copy", { dispatchedBy: { sessionId: "L", kind: "agent_run" } });
    await mount(data([lead, kid, both("x", "send email")]));
    const field = screen.getByRole("searchbox", { name: "Search sessions" });
    fireEvent.change(field, { target: { value: "paywall" } });
    // The lead comes back unfolded, its matching agent lit.
    expect(screen.queryByText("send email")).toBeNull();
    expect(row("research paywall copy, agent")).toHaveAttribute("data-hit");
    fireEvent.change(field, { target: { value: "zebra" } });
    expect(screen.getByText("No sessions match “zebra”.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("send email")).toBeInTheDocument();
  });
});
