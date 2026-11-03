import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent, type Environment, type MoveOptions, type SessionStatus } from "@realm/contracts";
import { StoreContext, createAppStore, useApp } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { MoveSheet } from "./MoveSheet";

const env = (id: string, extra: Partial<Environment> = {}): Environment =>
  ({ id, spaceId: "s1", path: `/tmp/${id}`, branch: null, kind: "checkout", portBlockStart: null, createdAt: 0, updatedAt: 0, ...extra });
const envA = env("envA", { kind: "primary", path: "/Users/me/realm" });
const envB = env("envB", { kind: "worktree", branch: "realm/fix-tests", path: "/Users/me/Realm/worktrees/fix-tests" });
const place = (environmentId: string, cwd: string, branch: string | null) => ({ machine: null, environmentId, cwd, branch });

/** The pane and whatever sheet the store opens, as the app draws them. */
function Host() {
  const sheet = useApp((s) => s.sheet);
  return sheet?.kind === "move-session" ? <MoveSheet sessionId={sheet.sessionId} to={sheet.to} /> : null;
}

/** A session that has RUN (its first message is behind it) in the space's own folder, with a worktree beside it. */
async function mount({ status = "idle", moveOptions = {}, permission = false, worktree = envB }: {
  status?: SessionStatus; moveOptions?: Partial<MoveOptions>; permission?: boolean; worktree?: Environment;
} = {}) {
  const events = [sessionEvent("user_message", { text: "fix the tests", attachments: [] }),
    ...(permission ? [sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", title: "Run rm -rf build", input: { command: "rm -rf build" }, suggestions: [] })] : [])];
  const api = fakeApi({
    sessions: [session("se1", "s1", { status, environmentId: "envA", cwd: envA.path, lastEventSeq: events.length })],
    sessionEvents: { se1: events.map((event, i) => ({ seq: i + 1, sessionId: "se1", event })) },
    environments: { s1: [envA, worktree] },
    gitInfo: { [envA.path]: { branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0 } },
    moveOptions: { se1: { from: place("envA", envA.path, "main"), ...moveOptions } },
  });
  const store = createAppStore(api); await store.getState().boot();
  await store.getState().openSession("se1");
  store.setState({ sessionStatus: { se1: status } });
  render(<StoreContext.Provider value={store}>
    <SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible />
    <Host />
  </StoreContext.Provider>);
  // The pane reads the log again as it opens; what streams in meanwhile is the reload's to catch up.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { api, store };
}

const pick = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  const menu = screen.getByRole("menu", { name: "Workspace" });
  fireEvent.click(within(menu).getByRole(name === "New worktree…" ? "menuitem" : "menuitemcheckbox", { name }));
};
const sheet = () => screen.findByRole("dialog", { name: "Move this session" });
const moveCall = (calls: string[]) => {
  const c = calls.find((x) => x.startsWith("moveSession:se1="));
  return c ? JSON.parse(c.slice("moveSession:se1=".length)) : null;
};

describe("the workspace selector on a started session", () => {
  it("opens the Move sheet for another checkout instead of switching", async () => {
    // THE MUTANT: the started session's pick calls setSessionEnvironment, which the server refuses.
    const { api, store } = await mount();
    pick("realm/fix-tests");
    expect(store.getState().sheet).toEqual({ kind: "move-session", sessionId: "se1", to: { kind: "environment", environmentId: "envB" } });
    expect(api.calls.some((c) => c.startsWith("setSessionEnvironment"))).toBe(false);
    const dialog = await sheet();
    await within(dialog).findByText("~/realm");
    expect(within(dialog).getByText("~/Realm/worktrees/fix-tests")).toBeInTheDocument();
    expect(within(dialog).getByText("realm/fix-tests")).toBeInTheDocument();
  });

  it("cuts a long path in the middle under its name, whole in the tooltip", async () => {
    const long = "/Users/me/Realm/worktrees/01M6HDE0JV8Y1B2DVQZN8B29YC/fix-tests";
    await mount({ worktree: { ...envB, path: long } });
    pick("realm/fix-tests");
    const path = await within(await sheet()).findByText("~/Realm/worktrees/…/fix-tests");
    expect(path).toHaveAttribute("title", long);
  });

  it("opens the sheet for a new worktree without making one first", async () => {
    const { api, store } = await mount();
    pick("New worktree…");
    expect(store.getState().sheet).toMatchObject({ kind: "move-session", to: { kind: "worktree" } });
    expect(api.calls.some((c) => c.startsWith("createWorktree"))).toBe(false);
    expect(await within(await sheet()).findByText(/New worktree/)).toBeInTheDocument();
  });

  it("does nothing on the checkout the session is already in", async () => {
    const { store } = await mount();
    pick("Versed"); // the space's own folder goes by the space's name
    expect(store.getState().sheet).toBeNull();
  });

  it("is a label while the session is moving", async () => {
    await mount({ status: "moving" });
    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
    expect(document.querySelector(".composer-understrip")).toHaveTextContent("Versed");
  });
});

describe("the Move sheet", () => {
  it("lists what goes and what stays, and how the conversation continues", async () => {
    await mount({ moveOptions: { conversation: "notes", changedFiles: 12, leftBehind: ["the terminal", ".env"] } });
    pick("realm/fix-tests");
    const dialog = await sheet();
    const goes = await within(dialog).findByRole("region", { name: "Goes with it" });
    expect(goes).toHaveTextContent("Fake agent continues from notes");
    expect(goes).toHaveTextContent("12 changed files");
    const stays = within(dialog).getByRole("region", { name: "Stays here" });
    expect(stays).toHaveTextContent("The terminal, which closes");
    expect(stays).toHaveTextContent("Ignored files, including .env");
    expect(stays).toHaveTextContent("Rewinding to before the move");
  });

  it("sends Move now, leaving this checkout's changes by default", async () => {
    const { api, store } = await mount();
    pick("realm/fix-tests");
    fireEvent.click(await within(await sheet()).findByRole("button", { name: "Move" }));
    await waitFor(() => expect(moveCall(api.calls)).toEqual({ to: { kind: "environment", environmentId: "envB" }, keepSourceChanges: true, when: "now" }));
    expect(store.getState().sheet).toBeNull();
  });

  it("leaves a failed move to the transcript's notice, and toasts any other refusal", async () => {
    const { api, store } = await mount();
    const refuse = (code: string, message: string) => {
      api.moveSession = async () => { throw Object.assign(new Error(message), { code }); };
    };
    refuse("MOVE_FAILED", "Could not move this session: the changes conflict.");
    await store.getState().moveSession("se1", { kind: "worktree" }, { keepSourceChanges: true, when: "now", toLabel: "a new worktree", busy: false });
    refuse("ENVIRONMENT_BUSY", "another session is working in that checkout");
    store.getState().run(() => store.getState().moveSession("se1", { kind: "worktree" }, { keepSourceChanges: true, when: "now", toLabel: "a new worktree", busy: false }));
    await waitFor(() => expect(store.getState().toasts.map((t) => t.text)).toEqual(["another session is working in that checkout"]));
  });

  it("sends keepSourceChanges false when the switch is off", async () => {
    const { api } = await mount();
    pick("New worktree…");
    const dialog = await sheet();
    fireEvent.click(await within(dialog).findByRole("switch", { name: "Leave my changes here too" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(moveCall(api.calls)).toEqual({ to: { kind: "worktree" }, keepSourceChanges: false, when: "now" }));
  });

  it("mid-turn, Stop and move sends stop", async () => {
    const { api } = await mount({ status: "running" });
    pick("realm/fix-tests");
    const dialog = await sheet();
    expect(within(dialog).queryByRole("button", { name: "Move" })).toBeNull();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Stop and move" }));
    await waitFor(() => expect(moveCall(api.calls)).toMatchObject({ when: "stop" }));
  });

  it("mid-turn, Move after this turn queues it, and the queue's Cancel calls it off", async () => {
    // THE MUTANT: no pending entry — the move waits with nothing on screen saying so.
    const { api, store } = await mount({ status: "running" });
    pick("realm/fix-tests");
    fireEvent.click(await within(await sheet()).findByRole("button", { name: "Move after this turn" }));
    await waitFor(() => expect(moveCall(api.calls)).toMatchObject({ when: "after-turn" }));
    const queue = await screen.findByRole("region", { name: "Queued move" });
    expect(queue).toHaveTextContent("Move after this turn");
    expect(queue).toHaveTextContent("to realm/fix-tests");
    fireEvent.click(within(queue).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.calls).toContain("cancelSessionMove:se1"));
    expect(screen.queryByRole("region", { name: "Queued move" })).toBeNull();
    expect(store.getState().pendingMoves).toEqual({});
  });

  it("waits on an open permission before it can move after the turn; Stop and move stays", async () => {
    await mount({ status: "waiting_permission", permission: true });
    pick("realm/fix-tests");
    const dialog = await sheet();
    expect(await within(dialog).findByRole("button", { name: "Move after this turn" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Stop and move" })).toBeEnabled();
    expect(dialog).toHaveTextContent("Stop and move, which denies it");
  });

  it("says why a session cannot move, and offers no Move", async () => {
    await mount({ moveOptions: { blocked: "A sub-agent it started is still running." } });
    pick("realm/fix-tests");
    const dialog = await sheet();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A sub-agent it started is still running.");
    expect(within(dialog).getByRole("button", { name: "Move" })).toBeDisabled();
  });
});

describe("a move in the transcript", () => {
  const movedEvent = { seq: 5, sessionId: "se1", ephemeral: false, event: sessionEvent("moved", {
    moveId: "m1", from: place("envA", envA.path, "main"), to: place("envB", envB.path, "realm/fix-tests"),
    conversation: "native" as const, changedFiles: 2, leftBehind: ["the terminal"], preface: "p",
    note: "Moved from /Users/me/realm to /Users/me/Realm/worktrees/fix-tests. The conversation continued." }) };
  const moving = (step: "snapshot" | "boot") => ({ seq: -1, sessionId: "se1", ephemeral: true, event: sessionEvent("moving", { moveId: "m1", step }) });

  it("draws the progress row from the moving event, and the moved line in its place", async () => {
    // THE MUTANT: the ephemeral `moving` dropped with the rest of the ephemeral events — no row at all.
    const { store, api } = await mount({ status: "moving" });
    act(() => store.getState().applySessionEvent(moving("snapshot")));
    const row = await screen.findByRole("status", { name: "Moving: Saving a checkpoint" });
    expect(row.querySelector('[data-state="now"]')).toHaveTextContent("Saving a checkpoint");
    // A done step is its check, its name kept for the reader and the tooltip.
    expect(row.querySelector('[data-state="done"]')).toHaveTextContent("Checking");
    expect(row.querySelector('[data-state="done"]')).toHaveAttribute("title", "Checking");
    expect(row.querySelector('[data-state="done"] .visually-hidden')).toHaveTextContent("Checking");
    act(() => store.getState().applySessionEvent(moving("boot")));
    expect(await screen.findByRole("status", { name: "Moving: Starting Fake agent" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("status", { name: "Moving: Starting Fake agent" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.calls).toContain("cancelSessionMove:se1"));

    act(() => {
      store.getState().applySessionEvent(movedEvent);
      store.getState().applySessionStatus("se1", "idle");
    });
    // Named as the sheet names the ends; the server's sentence, with its paths, is not what is drawn.
    const line = await screen.findByText("Moved from realm (main) to fix-tests. The conversation continued.");
    expect(line.getAttribute("title")).toContain(`${envA.path} → ${envB.path}`);
    expect(screen.queryByText(/Moved from \//)).toBeNull();
    expect(screen.queryByRole("status", { name: /^Moving/ })).toBeNull();
  });

  it("draws a move once when its event arrives live and again on a read of the log", async () => {
    const { store } = await mount({ status: "moving" });
    act(() => store.getState().applySessionEvent(movedEvent));
    act(() => store.getState().applySessionEvent(movedEvent));
    await screen.findByText(/^Moved from realm/);
    expect(screen.getAllByText(/^Moved from realm/)).toHaveLength(1);
  });

  it("tells a failed move calmly: the lead, the step, and the reason with its path shortened", async () => {
    const { store } = await mount({ status: "moving" });
    const note = "Could not move this session: /Users/me/Realm/worktrees/01M6HDE0JV8Y1B2DVQZN8B29YC/fix-tests is not a git repository. It is still in ~/realm, as it was.";
    act(() => store.getState().applySessionEvent({ seq: 5, sessionId: "se1", ephemeral: false, event: sessionEvent("move_failed", {
      moveId: "m1", step: "place", reason: "/Users/me/Realm/worktrees/01M6HDE0JV8Y1B2DVQZN8B29YC/fix-tests is not a git repository", note }) }));
    const line = (await screen.findByText("Couldn't move this session.", { exact: false })).closest(".msg-handoff")!;
    expect(line.querySelector(".move-failed-head")).toHaveTextContent("Couldn't move this session.Setting up the checkout");
    expect(line.querySelector(".move-failed-reason")).toHaveTextContent("~/Realm/worktrees/…/fix-tests is not a git repository.");
    expect(line).not.toHaveTextContent("It is still in");
    expect(line).toHaveAttribute("title", note);
    expect(line.closest('[role="alert"]')).toBeNull();
  });
});
