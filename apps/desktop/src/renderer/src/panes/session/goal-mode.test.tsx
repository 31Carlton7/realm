import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent, type Goal } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";

/** The prompter, with a session that has a draft to type into. */
async function mount(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle" })], ...over });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
  const paneItem = item("i9", "s1", { kind: "session", refId: "se1", title: "Fake agent session" });
  const r = render(<StoreContext.Provider value={store}><SessionPane item={paneItem} visible /></StoreContext.Provider>);
  return { api, store, ...r };
}

const box = () => screen.getByRole("textbox", { name: /message/i });
/** Type into the prompter the way the picker sees it: one value, caret at the end. */
const type = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.select(box(), { target: { selectionStart: text.length, selectionEnd: text.length } });
};
const command = (id: string) => screen.getByRole("option", { name: new RegExp(`^/${id}\\b`) });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the mode commands", () => {
  it("offers /build, /plan and /ask, and picking one moves the session", async () => {
    const { store } = await mount();
    type("/");
    for (const id of ["build", "plan", "ask"]) expect(command(id)).toBeInTheDocument();
    fireEvent.click(command("plan"));
    await waitFor(() => expect(store.getState().sessions["se1"]!.permissionMode).toBe("plan"));
    // …and the prompter card wears the mode, which is the same switch drawn where the user is.
    expect(document.querySelector(".composer")).toHaveAttribute("data-mode", "plan");
    type("/ask");
    fireEvent.click(command("ask"));
    await waitFor(() => expect(store.getState().sessions["se1"]!.permissionMode).toBe("ask"));
    type("/build");
    fireEvent.click(command("build"));
    // Build is the ABSENCE of the other two — it writes a permission back, not the word "build".
    await waitFor(() => expect(store.getState().sessions["se1"]!.permissionMode).not.toBe("ask"));
  });

  it("keeps what was typed after the command, so /plan <prompt> leaves the sentence ready", async () => {
    // The picker steps aside once the caret leaves the token, so this is picked while the caret is
    // still inside `/plan` — which is the only moment the list is up.
    const { store } = await mount();
    fireEvent.change(box(), { target: { value: "/plan look at the auth code" } });
    fireEvent.select(box(), { target: { selectionStart: 5, selectionEnd: 5 } });
    fireEvent.click(command("plan"));
    await waitFor(() => expect(store.getState().sessions["se1"]!.permissionMode).toBe("plan"));
    expect((box() as HTMLTextAreaElement).value).toBe("look at the auth code");
  });

  it("offers no mode the agent could not be put into", async () => {
    /* THE list-everything mutant: offer all three for every kind. An ACP agent that advertises no
       plan mode would get a `/plan` that sets a permission nothing enforces — which is the lie the
       per-kind tables exist to prevent, and the chip beside it already refuses. */
    await mount({ sessions: [session("se1", "s1", { status: "idle", agentKind: "acp:cursor" })] });
    type("/");
    expect(command("build")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^\/plan\b/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /^\/ask\b/ })).toBeNull();
  });
});

describe("/goal", () => {
  it("arms the box rather than starting an empty goal, and Enter finishes the gesture", async () => {
    /* Two halves of one gesture, and neither works alone. Picking `/goal` from the list cannot start
       anything — nothing has been typed yet — so it leaves the command in the box. And by the time
       an objective HAS been typed the picker is gone (`slashQueryAt` closes it as the caret leaves
       the token), so Enter is what runs it.
       THE empty-goal mutant starts one with no objective: a session taking turns on a blank prompt,
       with nothing in the strip to say what it is for. */
    const { api, store } = await mount();
    type("/goal");
    fireEvent.click(command("goal"));
    await waitFor(() => expect((box() as HTMLTextAreaElement).value).toBe("/goal "));
    expect(api.calls.some((c) => c.startsWith("goalStart"))).toBe(false);

    type("/goal ship the release notes");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(api.calls).toContain("goalStart:se1"));
    expect(store.getState().goals["se1"]).toMatchObject({ objective: "ship the release notes", status: "active" });
    // …and it was NOT sent to the agent as a message, which is the whole point of intercepting Enter.
    expect(api.sent.some((m) => m.text.includes("/goal"))).toBe(false);
    expect((box() as HTMLTextAreaElement).value).toBe("");
  });

  it("Enter on the bare command sends nothing and keeps the box armed", async () => {
    const { api } = await mount();
    type("/goal ");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(api.sent).toHaveLength(0);
    expect(api.calls.some((c) => c.startsWith("goalStart"))).toBe(false);
  });
});

const GOAL: Goal = {
  sessionId: "se1", objective: "ship the release notes", status: "active",
  tokenBudget: 10_000, tokensUsed: 2_500, turns: 3, note: null, startedAt: 0, updatedAt: 0,
};

describe("the goal strip", () => {
  it("is absent until there is a goal, and then says what is being pursued and how it is going", async () => {
    const { store, container } = await mount();
    expect(container.querySelector(".composer-goal")).toBeNull();
    act(() => store.getState().applyGoalChanged({ sessionId: "se1", goal: GOAL }));
    const strip = container.querySelector(".composer-goal") as HTMLElement;
    expect(strip).not.toBeNull();
    expect(within(strip).getByText("Pursuing")).toBeInTheDocument();
    expect(within(strip).getByText("ship the release notes")).toBeInTheDocument();
    // Turns and budget, in the fewest words that stay true.
    expect(within(strip).getByText("3 turns · 25% of budget")).toBeInTheDocument();
  });

  it("offers pause while it runs, and resume once something has stopped it", async () => {
    const { api, store, container } = await mount();
    act(() => store.getState().applyGoalChanged({ sessionId: "se1", goal: GOAL }));
    // While it runs there is one control that moves it: pause. Resuming something that is running is
    // a button with nothing to do.
    expect(screen.queryByRole("button", { name: "Resume this goal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pause this goal" }));
    await waitFor(() => expect(api.calls).toContain("goalSet:se1=paused"));
    // …and the pair swaps the moment it lands: a paused goal offers the way back.
    expect(await screen.findByRole("button", { name: "Resume this goal" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause this goal" })).toBeNull();

    act(() => store.getState().applyGoalChanged({ sessionId: "se1", goal: { ...GOAL, status: "blocked", note: "The deploy key is missing." } }));
    const strip = container.querySelector(".composer-goal") as HTMLElement;
    expect(within(strip).getByText("Blocked")).toBeInTheDocument();
    // The agent's own last word is on screen — a strip that said only "Blocked" would send the user
    // hunting through the transcript for the reason.
    expect(within(strip).getByText("The deploy key is missing.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume this goal" }));
    await waitFor(() => expect(api.calls).toContain("goalResume:se1"));
  });

  it("a finished goal offers neither pause nor resume, only a way to drop it", async () => {
    const { api, store } = await mount();
    act(() => store.getState().applyGoalChanged({ sessionId: "se1", goal: { ...GOAL, status: "complete", note: "Released 1.2.0." } }));
    expect(screen.queryByRole("button", { name: "Pause this goal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume this goal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Drop this goal" }));
    await waitFor(() => expect(api.calls).toContain("goalClear:se1"));
  });

  it("comes back on a pane that mounts onto a session already pursuing one", async () => {
    // The store only hears about a goal when it CHANGES; a pane opened a week later has missed
    // every event that ever carried this one.
    const { container } = await mount({ goals: { se1: GOAL } });
    await waitFor(() => expect(container.querySelector(".composer-goal")).not.toBeNull());
  });
});

describe("a turn the goal started", () => {
  it("is attributed, so nobody reads it as something they typed", async () => {
    /* The same treatment a peer session's question gets, for the same reason. THE unmarked mutant
       leaves a paragraph of instructions in the log looking exactly like the user's own words. */
    const { store } = await mount();
    act(() => store.setState({ transcripts: { se1: { lastSeq: 2, t: reduceAll([
      sessionEvent("user_message", { text: "ship the release notes", attachments: [] }),
      sessionEvent("user_message", { text: "Continue working towards this objective…", attachments: [], goal: "continuation" }),
    ]) } } }));
    // One line, shut: the continuation is five paragraphs of boilerplate derived from an objective
    // that is already on screen, and a ten-turn goal drawn open would be mostly this text.
    const marker = screen.getByRole("button", { name: /Realm continued this goal/ });
    expect(marker).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Continue working towards this objective/)).toBeNull();
    fireEvent.click(marker);
    // …and still THERE, because what the agent was handed is a fact about the run.
    expect(screen.getByText(/Continue working towards this objective/)).toBeInTheDocument();
    // The objective itself is the user's — they typed it — and carries no attribution.
    const rows = document.querySelectorAll(".msg-user-row");
    expect(rows[0]!.querySelector(".msg-user-from")).toBeNull();
    expect(rows[1]!.getAttribute("data-from")).toBe("");
  });
});
