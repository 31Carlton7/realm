import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, createEvent, waitFor, act, within } from "@testing-library/react";
import { AGENT_CLI_COMMANDS, AGENT_NOTES, MODEL_NOTES, canonicalModelKey, sessionEvent, type Environment } from "@realm/contracts";
import { StoreContext, createAppStore, type AgentProbe } from "../../state/store";
import { fakeApi, item, mcpServer, session, skillRow, externalSkillRow } from "../../state/store.test-fakes";
import { PanelBar } from "../../components/PanelBar";
import { TerminalHub, setTerminalHubForTests, type HubTransport, type TerminalLike } from "../terminal-hub";
import { SessionMeta, SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";
import { Markdown, renderMarkdown } from "./Markdown";
import { toolSummary } from "./tool-summary";

const seeded = () => reduceAll([
  sessionEvent("user_message", { text: "hi", attachments: [] }),
  sessionEvent("assistant_text", { messageId: "m", text: "**bold** hello" }),
  sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: { command: "ls -la" }, parentToolUseId: null }),
  sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "ls -la" }, title: "Run ls?", suggestions: [] }),
]);

async function mount(status: "idle" | "running" | "waiting_permission" = "waiting_permission", t = seeded()) {
  const api = fakeApi({ sessions: [session("se1", "s1", { status })] });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ sessionStatus: { se1: status }, transcripts: { se1: { lastSeq: 4, t } } });
  const r = render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "Fake agent session" })} visible /></StoreContext.Provider>);
  return { api, store, ...r };
}

/** Mounts the pane for a session of a given agent kind — the composer's option set is per-kind. */
async function mountKind(agentKind: "codex" | "acp:cursor") {
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind })] });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
  return render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
}

/** Opens the prompter's combined model picker (agent + model in one popover). */
const openPicker = () => fireEvent.click(screen.getByRole("button", { name: "Model" }));

describe("SessionPane", () => {
  it("renders transcript blocks, shows permission card, and sends composer text", async () => {
    const { api } = await mount();
    const sent: string[] = []; api.sendMessage = async (_id, text) => { sent.push(text); };
    const decided: string[] = []; api.respondPermission = async (_i, r, d) => { decided.push(`${r}:${d}`); };
    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByRole("button", { name: /Bash tool call/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Permission request/ })).toHaveTextContent("Run ls?");
    fireEvent.click(screen.getByRole("button", { name: /^Allow$/ }));
    expect(decided).toEqual(["r1:allow"]);
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "next" } });
    fireEvent.keyDown(box, { key: "Enter" }); // plain Enter sends by default (Settings ▸ App: "Enter")
    await waitFor(() => expect(sent).toEqual(["next"]));
    expect((box as HTMLTextAreaElement).value).toBe("");
    // A non-empty transcript is the DOCKED prompter: no greeting, no suggestion grid.
    expect(document.querySelector(".session-pane")).toHaveAttribute("data-composer", "docked");
    expect(document.querySelector(".hero-greeting")).toBeNull();
    expect(document.querySelector(".suggestions")).toBeNull();
  });

  it("⌘⇧↩ is NOT a send — the composer leaves the dispatch chord for the window binding (Plan 13 W2)", async () => {
    const { api } = await mount();
    const sent: string[] = []; api.sendMessage = async (_id, text) => { sent.push(text); };
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "to dispatch" } });
    // fireEvent returns false when the handler preventDefault'ed — a consumed chord would send AND
    // stop the global dispatch binding from ever seeing it: the dispatch-degrades-to-send mutant.
    const notConsumed = fireEvent.keyDown(box, { key: "Enter", metaKey: true, shiftKey: true });
    expect(notConsumed).toBe(true);
    expect(sent).toEqual([]);
    expect((box as HTMLTextAreaElement).value).toBe("to dispatch"); // the draft is still the user's
  });

  it("Shift+Enter is left alone (a newline) even under the default Enter-sends setting", async () => {
    const { api } = await mount();
    const sent: string[] = []; api.sendMessage = async (_id, text) => { sent.push(text); };
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "next" } });
    const notConsumed = fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(notConsumed).toBe(true); // not preventDefault'ed — the textarea's own newline goes through
    expect(sent).toEqual([]);
  });

  it("Settings ▸ App can switch back to ⌘/Ctrl+Enter-to-send, where plain Enter is a newline again", async () => {
    const { api, store } = await mount();
    const sent: string[] = []; api.sendMessage = async (_id, text) => { sent.push(text); };
    store.setState({ submitKey: "cmdEnter" });
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "next" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(sent).toEqual([]);
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(sent).toEqual(["next"]));
  });

  it("Allow always / Deny map to decisions; tool card expands", async () => {
    const { api } = await mount();
    const decided: string[] = []; api.respondPermission = async (_i, r, d) => { decided.push(`${r}:${d}`); };
    fireEvent.click(screen.getByRole("button", { name: /Allow always/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Deny$/ }));
    expect(decided).toEqual(["r1:allow_always", "r1:deny"]);
    const tool = screen.getByRole("button", { name: /Bash tool call/ });
    expect(tool).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(tool);
    // Plan 24 W1: a Bash card's input is DRAWN as the command it will run, not dumped as its JSON.
    const card = tool.closest(".tool-card") as HTMLElement;
    expect(card.querySelector(".cmd-line code")).toHaveTextContent("ls -la");
    expect(screen.getAllByText(/"command": "ls -la"/).length).toBeGreaterThanOrEqual(1); // the permission card still shows the raw details
    expect(screen.getByLabelText("running")).toBeInTheDocument(); // no result yet while the session is live
  });

  it("empty transcript is the HERO prompter: greeting + title-only suggestion rows; clicking one fills the composer without sending", async () => {
    const { api, store } = await mount("idle", reduceAll([]));
    const sent: string[] = []; api.sendMessage = async (_id, text) => { sent.push(text); };
    expect(document.querySelector(".session-pane")).toHaveAttribute("data-composer", "hero");
    const title = document.querySelector(".hero-greeting");
    // One line out of greeting.ts's pool, picked from the session id — never "what should we build",
    // since a space is as often a course as a repo.
    expect(title).toHaveTextContent("What's on your mind in Versed?");
    expect(title?.querySelector("em")).toHaveTextContent("Versed");
    // The name from `system.info` reaches the greeting: without one, the pool it draws from is the
    // smaller, name-less half, so the same session lands on a different line.
    act(() => store.setState({ userName: "" }));
    expect(document.querySelector(".hero-greeting")).toHaveTextContent("What are we working on in Versed?");
    act(() => store.setState({ userName: "Carlton" }));
    const chip = screen.getByRole("button", { name: /Say hello/ }); // default mount() session is agentKind "fake"
    expect(chip.querySelector(".suggestion-title")).toHaveTextContent("Say hello");
    // Ara refresh §3: rows are a leading glyph + one title line; the description line is retired
    // from the UI (the data keeps it, nothing renders it).
    expect(chip.querySelector(".suggestion-glyph")).not.toBeNull();
    expect(chip.querySelector(".suggestion-desc")).toBeNull();
    expect(chip).not.toHaveTextContent("A quick round trip through the fake agent");
    fireEvent.click(chip);
    const box = screen.getByRole("textbox", { name: /message/i });
    expect((box as HTMLTextAreaElement).value).toBe("Hello!");
    // Ara refresh §1: the placeholder names the session's agent, not "the agent".
    expect(box).toHaveAttribute("placeholder", "Ask Fake agent anything…");
    expect(sent).toEqual([]); // filled, not sent
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("data-state", "send"); // idle = send face up
  });

  it("hero → docked when the first block lands, and back only exists as hero for truly empty transcripts", async () => {
    const { store } = await mount("idle", reduceAll([]));
    expect(document.querySelector(".session-pane")).toHaveAttribute("data-composer", "hero");
    act(() => store.setState({ transcripts: { se1: { lastSeq: 1, t: reduceAll([sessionEvent("user_message", { text: "go", attachments: [] })]) } } }));
    expect(document.querySelector(".session-pane")).toHaveAttribute("data-composer", "docked");
    expect(document.querySelector(".hero-greeting")).toBeNull();
    expect(document.querySelector(".suggestions")).toBeNull();
  });

  it("transcript content rides the centered .transcript-col rails", async () => {
    await mount();
    const col = document.querySelector(".transcript .transcript-col");
    expect(col).not.toBeNull();
    expect(col!.querySelector(".msg-user-row")).not.toBeNull(); // blocks render inside the rail column
  });

  it("suggestion chips are keyed by the session's agent kind, not shared across kinds", async () => {
    await mountKind("codex");
    expect(screen.getByRole("button", { name: /Build a feature/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Say hello/ })).toBeNull();
  });

  it("permission chip carries data-warning only in bypassPermissions (reached via the confirm); menu selections call setSessionOptions with the right key", async () => {
    const { store } = await mount("idle", reduceAll([]));
    const chip = screen.getByRole("button", { name: "Permission mode" });
    expect(chip).not.toHaveAttribute("data-warning");
    expect(chip).toHaveTextContent("Ask");
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Accept edits" }));
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("acceptEdits"));
    expect(chip).toHaveTextContent("Accept edits");
    expect(chip).not.toHaveAttribute("data-warning");
    // Plan is no longer one of these: it is its own axis, on its own chip.
    expect(screen.queryByRole("menuitemcheckbox", { name: "Plan" })).toBeNull();
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Full access" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow everything? Confirm" }));
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("bypassPermissions"));
    expect(chip).toHaveAttribute("data-warning");
    expect(chip).toHaveTextContent("Full access");
  });

  it("selecting bypassPermissions from the menu applies nothing until the inline confirm is clicked (U-M7)", async () => {
    const { api, store } = await mount("idle", reduceAll([]));
    const chip = screen.getByRole("button", { name: "Permission mode" });
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Full access" }));
    // The chip stays on the current mode and no option was transmitted — the confirm is the only path.
    expect(chip).toHaveTextContent("Ask");
    expect(api.calls.filter((c) => c.startsWith("setSessionOptions"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Allow everything? Confirm" }));
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("bypassPermissions"));
    expect(screen.queryByRole("button", { name: "Allow everything? Confirm" })).toBeNull();
  });

  it("the bypass confirm expires after 5s without applying anything", async () => {
    const { api } = await mount("idle", reduceAll([]));
    const chip = screen.getByRole("button", { name: "Permission mode" });
    vi.useFakeTimers();
    try {
      fireEvent.click(chip);
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Full access" }));
      expect(screen.getByRole("button", { name: "Allow everything? Confirm" })).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(5100); });
      expect(screen.queryByRole("button", { name: "Allow everything? Confirm" })).toBeNull();
      expect(chip).toHaveTextContent("Ask");
      expect(api.calls.filter((c) => c.startsWith("setSessionOptions"))).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it("send morphs to Stop while running (both icons stay in the DOM) and interrupts; chip menus call setSessionOptions; opens the session on mount", async () => {
    const { api, store } = await mount("running", reduceAll([sessionEvent("assistant_delta", { messageId: "m1", delta: "str" })]));
    expect(api.calls).toContain("sessionEvents:se1:4");
    expect(screen.getByText("str")).toBeInTheDocument();
    expect(document.querySelector(".md-caret")).toBeNull();
    // The morph: one button, stop face up, send face still mounted for the cross-fade (§6).
    const morph = screen.getByRole("button", { name: "Stop" });
    expect(morph).toHaveAttribute("data-state", "stop");
    expect(morph.querySelector(".send-icon")).not.toBeNull();
    expect(morph.querySelector(".stop-icon")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull(); // it IS the same button, relabeled
    fireEvent.click(morph);
    await waitFor(() => expect(api.calls).toContain("interrupt:se1"));
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Accept edits" }));
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("acceptEdits"));
    openPicker();
    fireEvent.click(screen.getByRole("option", { name: /Fake agent/ }));
    await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("fake"));
    expect(store.getState().sessions.se1?.effort).toBeNull(); // the picker set model, not effort
  });

  it("Send is disabled with an empty draft while idle; the picker's Effort section sets the effort option", async () => {
    // Prompter rework re-pin: the standalone effort chip is retired — effort is edited inside the
    // model picker (its permanent Effort section) and worn by the chip as a gray suffix. What
    // carried over from the chip's tests: the edit applies via setSessionOptions with the `effort`
    // key and touches nothing else, and a null effort shows nothing (no placeholder, no suffix).
    const { store } = await mount("idle", reduceAll([]));
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("data-state", "send");
    expect(screen.queryByRole("button", { name: "Effort" })).toBeNull(); // the chip is gone
    expect(document.querySelector(".model-chip .chip-effort")).toBeNull(); // null effort = no suffix
    openPicker();
    const group = screen.getByRole("group", { name: "Effort" });
    expect(within(group).getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(group).getByRole("button", { name: "High" }));
    await waitFor(() => expect(store.getState().sessions.se1?.effort).toBe("high"));
    expect(store.getState().sessions.se1?.model).toBeNull(); // the effort edit set effort, not model
    expect(store.getState().sessions.se1?.permissionMode).toBe("default"); // …and not permission either
    expect(screen.queryByRole("dialog", { name: "Model picker" })).toBeNull(); // picking closes the picker
    expect(document.querySelector(".model-chip .chip-effort")).toHaveTextContent("High"); // the suffix wears it
  });

  it("model chip shows DEFAULT_MODEL_LABEL for the kind while session.model is null, and the chosen model after", async () => {
    const { store } = await mount("idle", reduceAll([]));
    const chip = screen.getByRole("button", { name: "Model" });
    expect(chip).toHaveTextContent("Fake"); // DEFAULT_MODEL_LABEL.fake
    // The chip wears the agent's mark again (prompter rework) — but `fake` has no vendor, so its
    // glyph is the generic Hugeicons bot, never a brand mark.
    expect(chip.querySelector("[data-brand]")).toBeNull();
    openPicker();
    fireEvent.click(screen.getByRole("option", { name: /Fake agent/ }));
    await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("fake"));
    expect(chip).toHaveTextContent("Fake"); // AGENT_MODELS label for the picked id
  });

  it("a kind with no enumerable models still gets a row naming its frontier default", async () => {
    // A provider Realm cannot enumerate is still a provider you can pick — the row stands for the
    // adapter's own default and selects the agent alone.
    await mountKind("codex");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("GPT-5.6");
    openPicker();
    const row = screen.getByRole("option", { name: /GPT-5\.6/ });
    expect(row).toHaveTextContent("Codex");
    expect(row).toHaveAttribute("aria-selected", "true");
  });

  it("the cwd chip is gone from the control row (prompter rework) — the folder is the sidebar's to name", async () => {
    await mount("idle", reduceAll([]));
    expect(document.querySelector(".composer-cwd")).toBeNull();
  });

  /** W2 gave the checkout its own chip (the "Work locally" slot); the prompter rework retires it —
   *  the diff pane and the sidebar still name the environment, and the row keeps only the branch as
   *  its way in. Pinned in both shapes so neither chip can quietly return. */
  describe("the environment chip is retired", () => {
    const envRow: Environment = { id: "env1", spaceId: "s1", path: "/tmp/worktrees/s1/fix-login", branch: "realm/fix-login",
      kind: "worktree", portBlockStart: 41020, createdAt: 0, updatedAt: 0 };

    async function mountIn(environment: Environment | null) {
      const api = fakeApi({
        sessions: [session("se1", "s1", { status: "idle", ...(environment ? { environmentId: environment.id, cwd: environment.path } : {}) })],
        environments: environment ? { s1: [environment] } : {},
      });
      const store = createAppStore(api); await store.getState().boot();
      store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
      render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
    }

    it("renders no environment (or cwd) chip for a worktree session", async () => {
      await mountIn(envRow);
      expect(document.querySelector(".composer-env")).toBeNull();
      expect(document.querySelector(".composer-cwd")).toBeNull();
      expect(screen.queryByText("Worktree")).toBeNull();
    });

    it("renders none for a session in the space's own checkout either", async () => {
      await mountIn(null);
      expect(document.querySelector(".composer-env")).toBeNull();
      expect(screen.queryByText("Work locally")).toBeNull();
    });
  });

  it("attributes a question another session delivered, and never attributes the user's own words", async () => {
    await mount("idle", reduceAll([
      sessionEvent("user_message", { text: "I typed this", attachments: [] }),
      sessionEvent("user_message", { text: "an agent asked this", attachments: [], from: { sessionId: "s2", title: "Refactor the parser" } }),
    ]));
    const rows = [...document.querySelectorAll(".msg-user-row")];
    expect(rows).toHaveLength(2);
    // Kills rendering the attribution always (every user message credited to a session) or never
    // (another agent's words shown as the user's — a lie by omission the user would act on).
    expect(rows[0]!.hasAttribute("data-from")).toBe(false);
    expect(rows[0]!.querySelector(".msg-user-from")).toBeNull();
    expect(rows[1]!.hasAttribute("data-from")).toBe(true);
    expect(rows[1]!.querySelector(".msg-user-from")).toHaveTextContent("Asked by Refactor the parser");
    // The fenced text itself is shown exactly as the peer received it: the user should be able to see
    // what the agent was actually handed, not a cleaned-up version of it.
    expect(rows[1]!.querySelector(".msg-user")).toHaveTextContent("an agent asked this");
  });

  it("the Thinking… under-strip shows only while the session is running", async () => {
    const { store } = await mount("running", reduceAll([sessionEvent("user_message", { text: "go", attachments: [] })]));
    expect(document.querySelector(".composer-thinking")).toHaveTextContent("Thinking…");
    act(() => store.getState().applySessionStatus("se1", "idle"));
    expect(document.querySelector(".composer-thinking")).toBeNull();
  });

  it("the Thinking… strip hides while the agent is blocked on the user (waiting_permission is not streaming)", async () => {
    // §4 scopes the strip to streaming. waiting_permission is the opposite state — the agent is idle,
    // waiting on a decision — so "Thinking…" there is a wrong-state message, not a slow one.
    const { store } = await mount("waiting_permission");
    expect(document.querySelector(".composer-thinking")).toBeNull();
    act(() => store.getState().applySessionStatus("se1", "running"));
    expect(document.querySelector(".composer-thinking")).toHaveTextContent("Thinking…");
  });

  it("Ctrl+Enter sends too — it is the only send gesture on Linux/Windows", async () => {
    const { api } = await mount("idle", reduceAll([]));
    const sent: string[] = []; api.sendMessage = async (_id, text) => { sent.push(text); };
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "from linux" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(sent).toEqual(["from linux"]));
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("a permission card arriving before the first block docks the prompter (blocks are empty but there IS something to read)", async () => {
    // Reachable on turn one: the agent asks permission before emitting any text. Hero would float the
    // prompter at 38% with the card stranded behind it.
    await mount("waiting_permission", reduceAll([
      sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "ls" }, title: "Run ls?", suggestions: [] }),
    ]));
    expect(screen.getByRole("group", { name: /Permission request/ })).toBeInTheDocument();
    expect(document.querySelector(".session-pane")).toHaveAttribute("data-composer", "docked");
    expect(document.querySelector(".hero-greeting")).toBeNull();
  });

  it("a pending permission that is NOT being waited on leaves the prompter in hero (nothing is on screen)", async () => {
    // The mirror of the case above: the card is filtered out by status, so the pane really is empty.
    await mount("idle", reduceAll([
      sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "ls" }, title: "Run ls?", suggestions: [] }),
    ]));
    expect(screen.queryByRole("group", { name: /Permission request/ })).toBeNull();
    expect(document.querySelector(".session-pane")).toHaveAttribute("data-composer", "hero");
  });

  it("a chip menu closes when its own chip is clicked a second time (I6)", async () => {
    await mount("idle", reduceAll([]));
    const chip = screen.getByRole("button", { name: "Permission mode" });
    fireEvent.pointerDown(chip); fireEvent.click(chip);
    expect(screen.getByRole("menu", { name: "Permission mode" })).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // arm Menu's outside-pointerdown listener
    fireEvent.pointerDown(chip); fireEvent.click(chip);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("a pending permission is only shown while the session is waiting_permission (stale after crash/relaunch)", async () => {
    const { store } = await mount("idle");
    expect(screen.queryByRole("group", { name: /Permission request/ })).toBeNull();
    act(() => store.getState().applySessionStatus("se1", "waiting_permission"));
    expect(screen.getByRole("group", { name: /Permission request/ })).toBeInTheDocument();
    act(() => store.getState().applySessionStatus("se1", "running"));
    expect(screen.queryByRole("group", { name: /Permission request/ })).toBeNull();
  });

  it("renders one card per open permission request and answers the right one", async () => {
    const t = reduceAll([
      sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "ls" }, title: "Run ls?", suggestions: [] }),
      sessionEvent("permission_request", { requestId: "r2", toolName: "Read", input: { file_path: "/x" }, title: "Read x?", suggestions: [] }),
    ]);
    const { api } = await mount("waiting_permission", t);
    const decided: string[] = []; api.respondPermission = async (_i, r, d) => { decided.push(`${r}:${d}`); };
    const cards = screen.getAllByRole("group", { name: /Permission request/ });
    expect(cards).toHaveLength(2);
    fireEvent.click(within(cards[1]!).getByRole("button", { name: /^Deny$/ }));
    fireEvent.click(within(cards[0]!).getByRole("button", { name: /^Allow$/ }));
    expect(decided).toEqual(["r2:deny", "r1:allow"]);
  });

  it("a finished run of consecutive tool calls reaches the pane as one collapsed `Worked for` ledger row (§5, Ara refresh §4)", async () => {
    await mount("idle", reduceAll([
      sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: { command: "ls" }, parentToolUseId: null }),
      sessionEvent("tool_result", { toolUseId: "t1", content: "ok", isError: false }),
      sessionEvent("tool_call", { toolUseId: "t2", name: "Read", input: { file_path: "/a.ts" }, parentToolUseId: null }),
      sessionEvent("tool_result", { toolUseId: "t2", content: "ok", isError: false }),
      sessionEvent("tool_call", { toolUseId: "t3", name: "Edit", input: { file_path: "/a.ts" }, parentToolUseId: null }),
      sessionEvent("tool_result", { toolUseId: "t3", content: "ok", isError: false }),
    ]));
    const line = screen.getByRole("button", { name: "3 tool calls" });
    expect(line).toHaveTextContent(/^Worked for /); // the events above land within the same second
    expect(line).toHaveAttribute("title", "3 tools · 1 file · 1 command"); // the counts survive as the tooltip
    expect(screen.queryByRole("button", { name: /Bash tool call/ })).toBeNull();
    fireEvent.click(line);
    expect(screen.getByRole("button", { name: /Bash tool call/ })).toBeInTheDocument();
  });

  it("idle session with an unresolved tool shows no spinner; error blocks render", async () => {
    await mount("idle", reduceAll([
      sessionEvent("tool_call", { toolUseId: "t1", name: "Read", input: { file_path: "/a/b.ts" }, parentToolUseId: null }),
      sessionEvent("error", { message: "OAuth session expired" }),
    ]));
    expect(screen.queryByLabelText("running")).toBeNull();
    expect(screen.getByLabelText("no result")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("OAuth session expired");
    expect(screen.getByText("/a/b.ts")).toBeInTheDocument();
  });

  it("offers the composer permission picker only for agents whose permission model Realm controls", async () => {
    const codex = await mountKind("codex");
    expect(screen.getByRole("button", { name: "Permission mode" })).toBeInTheDocument();
    codex.unmount();
    // AcpAdapter never transmits Realm's mode ids, so the picker would silently do nothing for an ACP agent.
    await mountKind("acp:cursor");
    expect(screen.queryByRole("button", { name: "Permission mode" })).toBeNull();
    // The rest of the bar is untouched: the model chip still opens the picker, whose permanent
    // Effort section exists for every kind (effort's home since the standalone chip retired).
    openPicker();
    expect(screen.getByRole("group", { name: "Effort" })).toBeInTheDocument();
  });
});

describe("permission keyboard (U-H4)", () => {
  async function mountFocused(focused: boolean) {
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "waiting_permission" })] });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "waiting_permission" }, transcripts: { se1: { lastSeq: 4, t: seeded() } } });
    const decided: string[] = []; api.respondPermission = async (_i, r, d) => { decided.push(`${r}:${d}`); };
    render(<StoreContext.Provider value={store}>
      <SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible focused={focused} />
    </StoreContext.Provider>);
    return { decided, card: screen.getByRole("group", { name: /Permission request/ }) };
  }

  it("autofocuses the Allow button on mount when the card is in the FOCUSED pane", async () => {
    const { } = await mountFocused(true);
    expect(screen.getByRole("button", { name: "Allow" })).toHaveFocus();
  });

  it("does NOT steal focus for an unfocused pane", async () => {
    await mountFocused(false);
    expect(screen.getByRole("button", { name: "Allow" })).not.toHaveFocus();
  });

  it("Enter=Allow, ⇧Enter=Always, ⌘⌫=Deny", async () => {
    const { decided, card } = await mountFocused(true);
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(card, { key: "Backspace", metaKey: true });
    await waitFor(() => expect(decided).toEqual(["r1:allow", "r1:allow_always", "r1:deny"]));
  });

  it("options are a numbered list (§5): a number chip and its shortcut on every row, hints in the footer", async () => {
    const { card } = await mountFocused(true);
    const rows = within(card).getAllByRole("button").filter((b) => b.classList.contains("permission-option"));
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Allow", "Allow always", "Deny"]);
    expect(rows.map((r) => r.querySelector(".permission-num")!.textContent)).toEqual(["1", "2", "3"]);
    expect(rows.map((r) => r.querySelector(".permission-option-kbd")!.textContent)).toEqual(["⏎", "⇧⏎", "⌘⌫"]);
    expect([...card.querySelectorAll(".permission-hints > span")].map((s) => s.textContent))
      .toEqual(["↑↓ Navigate", "↵ Select", "esc Deny"]);
    expect(within(card).getByRole("button", { name: "Submit" })).toHaveTextContent("↩");
    // Amber is a dot and a pill now, not a wash over the whole head (§5).
    expect(card.querySelector(".permission-dot")).not.toBeNull();
    expect(card.querySelector('.status-pill[data-tone="warning"]')).toHaveTextContent("Waiting");
  });

  it("the number keys decide outright — 1 allows, 2 allows always, 3 denies", async () => {
    const { decided, card } = await mountFocused(true);
    for (const key of ["1", "2", "3"]) fireEvent.keyDown(card, { key });
    await waitFor(() => expect(decided).toEqual(["r1:allow", "r1:allow_always", "r1:deny"]));
  });

  it("a modifier chord that merely contains a digit decides nothing — ⌘1 is switch-space, not Allow", async () => {
    const { decided, card } = await mountFocused(true);
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }])
      fireEvent.keyDown(card, { key: "1", ...mods });
    expect(decided).toEqual([]);
  });

  it("↑↓ move the selection, Submit sends whatever is selected, and focus follows the selection", async () => {
    const { decided, card } = await mountFocused(true);
    const selected = () => card.querySelector<HTMLElement>(".permission-option[data-selected]")!.getAttribute("aria-label");
    expect(selected()).toBe("Allow"); // Allow is the default, so a bare Enter still means Allow
    fireEvent.keyDown(card, { key: "ArrowDown" });
    fireEvent.keyDown(card, { key: "ArrowDown" });
    expect(selected()).toBe("Deny");
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();
    fireEvent.click(within(card).getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(decided).toEqual(["r1:deny"]));
  });

  it("the selection wraps, and Enter on the card decides the SELECTED option, not a hardcoded Allow", async () => {
    const { decided, card } = await mountFocused(true);
    fireEvent.keyDown(card, { key: "ArrowUp" }); // wraps from Allow to Deny
    expect(card.querySelector(".permission-option[data-selected]")).toHaveAttribute("aria-label", "Deny");
    fireEvent.keyDown(card, { key: "Enter" }); // fired on the card, not on a button
    await waitFor(() => expect(decided).toEqual(["r1:deny"]));
  });

  it("Escape denies (§5's footer hint) and does not leak to the app's global Escape handling", async () => {
    const { decided, card } = await mountFocused(true);
    const bubbled = vi.fn();
    window.addEventListener("keydown", bubbled);
    try {
      fireEvent.keyDown(card, { key: "Escape" });
      await waitFor(() => expect(decided).toEqual(["r1:deny"]));
      expect(bubbled).not.toHaveBeenCalled();
    } finally { window.removeEventListener("keydown", bubbled); }
  });

  it("plain Backspace and bare letters decide nothing", async () => {
    const { decided, card } = await mountFocused(true);
    fireEvent.keyDown(card, { key: "Backspace" });
    fireEvent.keyDown(card, { key: "a" });
    expect(decided).toEqual([]);
  });

  it("Enter on a FOCUSED Deny button denies — never the card-level Allow (security inversion)", async () => {
    const { decided } = await mountFocused(true);
    const deny = screen.getByRole("button", { name: "Deny" });
    deny.focus();
    fireEvent.keyDown(deny, { key: "Enter" });
    await waitFor(() => expect(decided).toEqual(["r1:deny"]));
    expect(decided).not.toContain("r1:allow");
  });

  it("Enter on the details summary expands without deciding (native toggle keeps its default)", async () => {
    const { decided } = await mountFocused(true);
    // "Raw input" once a drawn preview sits above it (Plan 24 W1), plain "Input" without one.
    const summary = screen.getByText(/^(Raw )?input$/i);
    summary.focus();
    const notPrevented = fireEvent.keyDown(summary, { key: "Enter" }); // true = default NOT prevented
    expect(notPrevented).toBe(true); // native <summary> Enter-toggle stays in charge
    expect(decided).toEqual([]);
  });
});

describe("composer context row (git chips)", () => {
  const gi = (over: Partial<{ branch: string; additions: number; deletions: number; dirty: number }> = {}) =>
    ({ branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0, ...over });

  async function mountWithGit(info: ReturnType<typeof gi> | null) {
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle" })] });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } },
      gitInfo: { "/tmp": info } }); // the fake session's cwd is /tmp
    const r = render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
    return { store, ...r };
  }

  it("renders branch + diff + dirty chips from store gitInfo for the session's cwd, in the control row's left group", async () => {
    await mountWithGit(gi({ branch: "feat/x", additions: 12, deletions: 3, dirty: 4 }));
    expect(document.querySelector(".composer-opts .git-branch")).toHaveTextContent("feat/x");
    expect(document.querySelector(".git-diff .diff-add")).toHaveTextContent("+12");
    expect(document.querySelector(".git-diff .diff-del")).toHaveTextContent("−3");
    expect(document.querySelector(".git-dirty")).toHaveTextContent("4 changed");
    expect(document.querySelector(".composer-cwd")).toBeNull(); // the cwd chip is retired, not moved
  });

  it("hides the diff chip when both counts are zero and the dirty chip at zero", async () => {
    await mountWithGit(gi({ branch: "main" }));
    expect(document.querySelector(".git-branch")).toHaveTextContent("main");
    expect(document.querySelector(".git-diff")).toBeNull();
    expect(document.querySelector(".git-dirty")).toBeNull();
  });

  it("renders no git chips at all when the cwd is not a repo (null)", async () => {
    await mountWithGit(null);
    expect(document.querySelector(".git-branch")).toBeNull();
    expect(document.querySelector(".git-diff")).toBeNull();
    expect(document.querySelector(".git-dirty")).toBeNull();
    expect(document.querySelector(".composer-opts")).not.toBeNull(); // the row itself still renders
  });
});

describe("control-row rework (prompter rework atop Ara refresh §3)", () => {
  it("left group runs '+' · permission · mode · branch, in that DOM order and nothing else", async () => {
    // The user's row: attach leads, the Ask/Build chips sit against it, the branch chip trails.
    // The cwd, environment and effort chips are gone — an extra child here is a regression.
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "claude" })] });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } },
      gitInfo: { "/tmp": { branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0 } } });
    render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
    const opts = document.querySelector(".composer-opts")!;
    const children = Array.from(opts.children);
    expect(children[0]).toBe(screen.getByRole("button", { name: "Add" })); // the "+" — now a menu (Plan 12 W1)
    expect(children[1]).toBe(screen.getByRole("button", { name: "Permission mode" }));
    expect(children[2]).toBe(screen.getByRole("button", { name: "Mode" }));
    expect(children[3]).toBe(document.querySelector(".composer-git"));
    expect(children).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Effort" })).toBeNull();
    const actions = document.querySelector(".composer-actions")!;
    expect(actions.contains(screen.getByRole("button", { name: "Model" }))).toBe(true);
    expect(actions.lastElementChild).toBe(screen.getByRole("button", { name: "Send" }));
  });

  it("the model chip wears the SESSION's vendor mark in brand colour; picker rows are coloured too", async () => {
    await mountFresh(); // claude
    const chip = screen.getByRole("button", { name: "Model" });
    const mark = chip.querySelector("[data-brand]")!;
    expect(mark).toHaveAttribute("data-brand", "claude"); // the session's agent, not a fixed vendor
    expect(mark.querySelector("path")).toHaveAttribute("fill", "#D97757"); // the coral spark, IN colour
    expect(chip.querySelector(".chip-caret")).not.toBeNull(); // `⟡ Fable 5 ⌄`
    openPicker();
    expect(document.querySelector(".mp-row [data-brand='claude'] path")).toHaveAttribute("fill", "#D97757");
  });

  it("a vendor with no brand colour keeps its mark in ink — no colour is invented", async () => {
    await mountKindFresh("codex");
    const mark = screen.getByRole("button", { name: "Model" }).querySelector("[data-brand]")!;
    expect(mark).toHaveAttribute("data-brand", "openai");
    expect(mark.querySelector("path")).toHaveAttribute("fill", "currentColor");
  });

  it("the gray suffix shows the SESSION's effort, capitalised (`xhigh` → XHigh), and hides when unset", async () => {
    const a = await mountFresh({ effort: "xhigh" });
    expect(document.querySelector(".model-chip .chip-effort")).toHaveTextContent("XHigh");
    a.unmount();
    const b = await mountFresh({ effort: "max" }); // another level renders ITS word, not a fixed one
    expect(document.querySelector(".model-chip .chip-effort")).toHaveTextContent("Max");
    b.unmount();
    await mountFresh();
    expect(document.querySelector(".model-chip .chip-effort")).toBeNull();
  });

  describe("overflow collapse", () => {
    /** jsdom has no layout, so the row's overflow is staged through the prototype getters the
     *  measurement reads: scrollWidth (what the chips need) vs clientWidth (what the row has). */
    function stageWidths(scroll: number, client: number) {
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return (this as HTMLElement).classList.contains("composer-opts") ? scroll : 0; } });
      Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return (this as HTMLElement).classList.contains("composer-opts") ? client : 0; } });
    }
    afterEach(() => {
      delete (HTMLElement.prototype as { scrollWidth?: unknown }).scrollWidth;
      delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
    });

    it("an overflowing row folds the permission chip into the model menu instead of wrapping", async () => {
      // Effort no longer collapses — it LIVES in the menu — so permission is the one chip left
      // with somewhere to fold to.
      stageWidths(700, 500);
      const { store } = await mountFresh();
      expect(screen.queryByRole("button", { name: "Permission mode" })).toBeNull();
      expect(document.querySelector(".composer-opts")).toHaveAttribute("data-collapsed");
      // …and it lives in the model menu as a labelled group, with working handlers.
      openPicker();
      const perms = screen.getByRole("group", { name: "Permissions" });
      fireEvent.click(within(perms).getByRole("button", { name: "Accept edits" }));
      await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("acceptEdits"));
      expect(screen.queryByRole("dialog", { name: "Model picker" })).toBeNull(); // picking closes the menu
    });

    it("bypassPermissions from the collapsed menu still goes through the inline confirm (U-M7)", async () => {
      stageWidths(700, 500);
      const { api, store } = await mountFresh();
      openPicker();
      fireEvent.click(within(screen.getByRole("group", { name: "Permissions" })).getByRole("button", { name: "Full access" }));
      // Nothing transmitted yet — the confirm chip on the row is still the only path in.
      expect(api.calls.filter((c) => c.startsWith("setSessionOptions"))).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Allow everything? Confirm" }));
      await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("bypassPermissions"));
    });

    it("a row that fits keeps the permission chip; the menu carries only its permanent Effort section", async () => {
      stageWidths(400, 500);
      await mountFresh();
      expect(screen.getByRole("button", { name: "Permission mode" })).toBeInTheDocument();
      openPicker();
      expect(screen.getByRole("group", { name: "Effort" })).toBeInTheDocument(); // permanent, not overflow
      expect(screen.queryByRole("group", { name: "Permissions" })).toBeNull();
    });
  });
});

describe("suggestion stagger runs once per session (§6 'never re-animate on revisit')", () => {
  /** Its own session id: the played-set is module-level and every other hero mount in this file
   *  marks "se1", which would make a first-mount assertion here order-dependent. */
  async function mountHero(id: string) {
    const api = fakeApi({ sessions: [session(id, "s1", { status: "idle" })] });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { [id]: "idle" }, transcripts: { [id]: { lastSeq: 0, t: reduceAll([]) } } });
    return render(<StoreContext.Provider value={store}><SessionPane item={item(`i-${id}`, "s1", { kind: "session", refId: id, title: "s" })} visible /></StoreContext.Provider>);
  }

  it("staggers on the first hero render and never again for that session, while a different session still gets its own", async () => {
    const first = await mountHero("se-stagger-a");
    expect(document.querySelector(".suggestions")).toHaveAttribute("data-animate");
    first.unmount();
    // Pane-slot keying remounts SessionPane on every tab-back; the chips must not replay.
    const second = await mountHero("se-stagger-a");
    expect(document.querySelector(".suggestions")).not.toHaveAttribute("data-animate");
    second.unmount();
    // ...but the guard is per session, not a global one-shot.
    await mountHero("se-stagger-b");
    expect(document.querySelector(".suggestions")).toHaveAttribute("data-animate");
  });
});

describe("durable drafts (A-M9)", () => {
  it("a typed draft survives unmounting and remounting the pane, and is keyed to its own session", async () => {
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle" }), session("se2", "s1", { status: "idle" })] });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ transcripts: { se1: { lastSeq: 0, t: reduceAll([]) }, se2: { lastSeq: 0, t: reduceAll([]) } } });
    const pane = (ref: string) => (
      <StoreContext.Provider value={store}><SessionPane item={item(`i-${ref}`, "s1", { kind: "session", refId: ref, title: "s" })} visible /></StoreContext.Provider>
    );
    const r = render(pane("se1"));
    fireEvent.change(screen.getByRole("textbox", { name: /message/i }), { target: { value: "keep me" } });
    expect(store.getState().drafts.se1).toBe("keep me");
    r.unmount();
    // Remount the same session: the draft is back.
    const r2 = render(pane("se1"));
    expect((screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement).value).toBe("keep me");
    r2.unmount();
    // A different session never sees it (keyed by session id, not by pane position).
    render(pane("se2"));
    expect((screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement).value).toBe("");
  });

  it("a suggestion chip fills the store draft for that session", async () => {
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle" })] });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
    render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: /Say hello/ }));
    expect(store.getState().drafts.se1).toBe("Hello!");
  });
});

describe("SessionMeta", () => {
  function mountMeta(over: { model?: string | null; costUsd?: number; numTurns?: number; status?: "idle" | "waiting_permission" } = {}) {
    const store = createAppStore(fakeApi());
    store.setState({
      sessions: { se1: session("se1", "s1", { model: over.model ?? null }) },
      sessionStatus: { se1: over.status ?? "idle" },
      transcripts: { se1: { lastSeq: 1, t: reduceAll([
        sessionEvent("usage", { costUsd: over.costUsd ?? 0, inputTokens: 1, outputTokens: 1, numTurns: over.numTurns ?? 0 }),
      ]) } },
    });
    return render(<StoreContext.Provider value={store}><SessionMeta item={item("i9", "s1", { kind: "session", refId: "se1", title: "Sess" })} /></StoreContext.Provider>);
  }

  it("shows the status dot and the cost once costUsd > 0", () => {
    mountMeta({ model: "fake-xl", status: "waiting_permission", costUsd: 0.5, numTurns: 3 });
    expect(screen.getByLabelText("Status: Needs permission")).toHaveAttribute("data-status", "waiting_permission");
    expect(screen.getByText("$0.50")).toBeInTheDocument();
  });

  it("shows the cost ALONE — not the model id, and not the turn count", () => {
    // The header used to lead with the model and trail the cost with turns. The model is named
    // properly by the prompter's own chip inches below, and printed here as whatever raw id the
    // harness pinned; the turn count was never the question a header answers.
    mountMeta({ model: "claude-fable-5-1[thinking=true,context=300k,effort=high]", costUsd: 0.5, numTurns: 3 });
    expect(screen.queryByText(/claude-fable/)).toBeNull();
    expect(screen.queryByText(/turn/)).toBeNull();
    expect(screen.getByText("$0.50")).toBeInTheDocument();
  });

  it("renders no cost while costUsd is 0, even after turns", () => {
    mountMeta({ model: "fake-xl", costUsd: 0, numTurns: 3 });
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.getByLabelText(/^Status:/)).toBeInTheDocument(); // the rest of the meta still renders
  });
});

describe("markdown + summaries", () => {
  it("sanitizes scripts and opens links externally", () => {
    const html = renderMarkdown('hello <script>alert(1)</script> [x](https://example.com) <img src=x onerror="alert(1)">');
    expect(html).not.toContain("<script"); expect(html).not.toContain("onerror");
    expect(html).toContain('target="_blank"'); expect(html).toContain('rel="noopener noreferrer"');
  });
  it("wraps tables in an .md-scroll container so a wide table scrolls itself, not the transcript (A-M1)", () => {
    const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain('<div class="md-scroll"><table>');
    expect(html.match(/<table>/g)).toHaveLength(1); // wrapped in place, not duplicated
    expect(renderMarkdown("no tables here")).not.toContain("md-scroll");
  });
  it("summarizes tool inputs", () => {
    expect(toolSummary("Bash", { command: "ls" })).toBe("ls");
    expect(toolSummary("Edit", { file_path: "/x", old_string: "a" })).toBe("/x");
    expect(toolSummary("Grep", { pattern: "foo", path: "/" })).toBe("foo");
    expect(toolSummary("Whatever", { n: 1, s: "first" })).toBe("first");
    expect(toolSummary("Whatever", {})).toBe("");
  });
  it("summarizes Codex-style tool inputs; unknown/ACP tool names fall back to the first string field", () => {
    expect(toolSummary("exec_command", { command: "npm test", cwd: "/repo" })).toBe("npm test");
    expect(toolSummary("apply_patch", { changes: [{ path: "/src/a.ts" }, { path: "/src/b.ts" }] })).toBe("/src/a.ts");
    expect(toolSummary("mcp__acp__some_tool", { foo: 1, note: "do the thing" })).toBe("do the thing");
  });
});

describe("fenced code (Plan 9 W2 — BUI CodeBlock)", () => {
  it("wraps a fence in an editor panel: a header naming the language beside a copy control, the <pre> as the body", () => {
    const html = renderMarkdown("```ts\nconst a = 1;\n```");
    expect(html).toContain('<div class="md-code">');
    expect(html).toContain('<span class="md-code-lang">ts</span>');
    expect(html).toMatch(/<button[^>]*aria-label="Copy code"/);
    expect(html.match(/<pre>/g)).toHaveLength(1); // wrapped in place, not duplicated
    expect(renderMarkdown("no code here")).not.toContain("md-code");
  });

  it("Copy code puts the fence's exact text on the clipboard and holds the ✓ for a beat (§6 icon swap)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.useFakeTimers();
    try {
      render(<Markdown text={"```ts\nconst a = 1;\nconst b = 2;\n```"} />);
      const copy = screen.getByRole("button", { name: "Copy code" });
      // Both glyphs stay mounted (the .tool-copy cross-fade rule serves this button too).
      expect(copy.querySelector(".copy-icon")).not.toBeNull();
      expect(copy.querySelector(".copied-icon")).not.toBeNull();
      fireEvent.click(copy);
      expect(writeText).toHaveBeenCalledWith("const a = 1;\nconst b = 2;\n");
      expect(copy).toHaveAttribute("data-copied");
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(copy).not.toHaveAttribute("data-copied");
    } finally { vi.useRealTimers(); }
  });

  it("a markdown block updates immediately, with no synthetic caret", () => {
    // The mutant this kills: a BUI-style char-reveal interval, which would re-play settled text on
    // every re-render (the transcript-enter regression named in Plan 9 W2).
    const { rerender, container } = render(<Markdown text="alpha beta" />);
    expect(container.textContent).toContain("alpha beta");
    expect(container.querySelector(".md-caret")).toBeNull();
    rerender(<Markdown text="alpha beta gamma" />);
    expect(container.textContent).toContain("alpha beta gamma");
    rerender(<Markdown text="alpha beta gamma" />);
    expect(container.querySelector(".md-caret")).toBeNull();
  });
});

/** Mounts the prompter for a session that has not run yet (no events anywhere), plus overrides. */
async function mountFresh(extra: Partial<Parameters<typeof session>[2]> = {}, lastSeq = 0, agentProbe?: AgentProbe[]) {
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "claude", ...extra })], ...(agentProbe ? { agentProbe } : {}) });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq, t: reduceAll([]) } } });
  const r = render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "Claude session" })} visible /></StoreContext.Provider>);
  return { api, store, ...r };
}

/** `mountFresh` for a non-Claude kind — the picker's contents are relative to the session's agent. */
async function mountKindFresh(agentKind: "codex" | "acp:cursor") {
  return mountFresh({ agentKind });
}

describe("prompter mode chip (Build / Plan)", () => {
  const modeChip = () => screen.getByRole("button", { name: "Mode" });
  const permissionChip = () => screen.queryByRole("button", { name: "Permission mode" });
  const setMode = (label: "Build" | "Plan") => {
    fireEvent.click(modeChip());
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: label }));
  };

  it("starts on Build and moves the session onto the plan permission mode", async () => {
    const { store } = await mountFresh();
    expect(modeChip()).toHaveTextContent("Build");
    setMode("Plan");
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("plan"));
    expect(modeChip()).toHaveTextContent("Plan");
  });

  it("returning to Build restores the permission the user was on, not `default`", async () => {
    // The whole reason the store parks a value: Plan travels as `permissionMode`, so the round trip
    // would otherwise silently demote Full access to Ask.
    const { store } = await mountFresh({ permissionMode: "bypassPermissions" });
    expect(permissionChip()).toHaveTextContent("Full access");
    setMode("Plan");
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("plan"));
    setMode("Build");
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("bypassPermissions"));
    expect(permissionChip()).toHaveTextContent("Full access");
    expect(store.getState().planReturn.se1).toBeUndefined(); // the park is spent, not left behind
  });

  it("survives a pane remount — the parked mode lives in the store, not the component", async () => {
    const { store, unmount } = await mountFresh({ permissionMode: "acceptEdits" });
    setMode("Plan");
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("plan"));
    unmount();
    render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "Claude session" })} visible /></StoreContext.Provider>);
    setMode("Build");
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("acceptEdits"));
  });

  it("names what Build will restore while in Plan, and stops offering a picker that would do nothing", async () => {
    const { store } = await mountFresh({ permissionMode: "acceptEdits" });
    setMode("Plan");
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("plan"));
    // Plan is read-only regardless of permission mode, so the control is a label, not a menu.
    expect(permissionChip()).toBeNull();
    const label = document.querySelector('.ghost-chip[data-static][title^="Plan is read-only"]');
    expect(label).toHaveTextContent("Accept edits");
    expect(label!.tagName).toBe("SPAN");
  });

  it("is hidden for an agent with no plan mode, and shown for the ones that have it", async () => {
    // Cursor: ACP mode ids are agent-defined and Realm's are never transmitted, so a Plan chip there
    // would be a button that changes nothing.
    const cursor = await mountKindFresh("acp:cursor");
    expect(screen.queryByRole("button", { name: "Mode" })).toBeNull();
    cursor.unmount();
    // Codex: codexPolicyFor("plan") really does start the thread read-only under untrusted approvals.
    await mountKindFresh("codex");
    expect(screen.getByRole("button", { name: "Mode" })).toBeInTheDocument();
  });
});

describe("attachment-only send (Plan 14 W5)", () => {
  const png = { path: "/tmp/a.png", mime: "image/png", name: "a.png", size: 10 };
  const pdf = { path: "/tmp/notes.pdf", mime: "application/pdf", name: "notes.pdf", size: 10 };

  it("a deliverable attachment unlocks Send with an empty draft, and the send carries empty text", async () => {
    const { api, store } = await mountFresh(); // claude: images are delivered inline
    act(() => store.setState({ pendingAttachments: { se1: [png] } }));
    const btn = screen.getByRole("button", { name: "Send" });
    expect(btn).not.toBeDisabled();
    expect(btn.title).toBe("Send (⌘↵)");
    fireEvent.click(btn);
    await waitFor(() => expect(api.sent).toEqual([{ id: "se1", text: "", attachments: [{ path: "/tmp/a.png", mime: "image/png" }] }]));
  });

  it("attachments the agent IGNORES cannot carry a message alone — Send stays off and says why", async () => {
    // The named mutant's UI half: Claude drops non-images entirely, so a PDF-only send would deliver
    // literally nothing. The gate refuses; the tooltip names the agent and the fix.
    const { api, store } = await mountFresh();
    act(() => store.setState({ pendingAttachments: { se1: [pdf] } }));
    const btn = screen.getByRole("button", { name: "Send" });
    expect(btn).toBeDisabled();
    expect(btn.title).toBe("Claude ignores these attachments — add a message to send");
    fireEvent.click(btn);
    expect(api.sent).toEqual([]);
    // One ignored + one deliverable: the deliverable one unlocks the send again.
    act(() => store.setState({ pendingAttachments: { se1: [pdf, png] } }));
    expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
  });

  it("an empty draft with no attachments still sends nothing", async () => {
    const { api } = await mountFresh();
    const btn = screen.getByRole("button", { name: "Send" });
    expect(btn).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: /message/i }), { key: "Enter", metaKey: true });
    expect(api.sent).toEqual([]);
  });
});

describe("ACP mode chip — per-session modes (Plan 14 W3)", () => {
  // The real cursor-agent 2026.07.25 triple, as the adapter's init event carries it.
  const CURSOR_MODES = [
    { id: "agent", name: "Agent", description: "Full agent capabilities with tool access" },
    { id: "plan", name: "Plan", description: "Read-only mode for planning and designing before implementation" },
    { id: "ask", name: "Ask", description: "Q&A mode - no edits or command execution" },
  ];
  const initEvent = (availableModes?: typeof CURSOR_MODES) =>
    sessionEvent("init", { providerSessionId: "sess_0", model: "composer", tools: [], cwd: "/w", ...(availableModes ? { availableModes } : {}) });

  /** A cursor session whose transcript already holds `events` (lastSeq > 0 ⇒ the session has started). */
  async function mountCursor(events: ReturnType<typeof sessionEvent>[], extra: Partial<Parameters<typeof session>[2]> = {}) {
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "acp:cursor", lastEventSeq: events.length, ...extra })] });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: events.length, t: reduceAll(events) } } });
    const r = render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
    return { api, store, ...r };
  }

  it("renders a DISABLED chip while a started session's handshake is still pending", async () => {
    // The materialize-honestly window: events exist, no init yet. A static label, not a button —
    // offering Plan before the agent has named its modes would be a guess.
    await mountCursor([sessionEvent("user_message", { text: "go", attachments: [] })]);
    expect(screen.queryByRole("button", { name: "Mode" })).toBeNull();
    const waiting = document.querySelector('.ghost-chip[data-static][title="Waiting for the agent\'s modes"]');
    expect(waiting).not.toBeNull();
    expect(waiting).toHaveTextContent("Build");
  });

  it("enables the chip once the init event carries a plan-equivalent, described in the agent's own words", async () => {
    await mountCursor([sessionEvent("user_message", { text: "go", attachments: [] }), initEvent(CURSOR_MODES)]);
    const chip = screen.getByRole("button", { name: "Mode" });
    expect(chip).toHaveTextContent("Build");
    expect(chip.title).toContain("Cursor's own Plan mode");
    expect(chip.title).toContain("Read-only mode for planning and designing before implementation");
    // Cursor advertises `ask` in the same handshake, so the chip describes that too — from Build the
    // title is what the user reads before choosing.
    expect(chip.title).toContain("Cursor's own Ask mode");
    expect(document.querySelector('.ghost-chip[data-static][title="Waiting for the agent\'s modes"]')).toBeNull();
  });

  it("shows NO chip for a session whose modes carry neither a plan- nor an ask-equivalent", async () => {
    // The named mutant: a chip here would drive session/set_mode toward a mode that does not exist.
    await mountCursor([sessionEvent("user_message", { text: "go", attachments: [] }),
      initEvent([{ id: "agent", name: "Agent", description: "d" }, { id: "review", name: "Review", description: "d" }])]);
    expect(screen.queryByRole("button", { name: "Mode" })).toBeNull();
    expect(document.querySelector('.ghost-chip[data-static][title="Waiting for the agent\'s modes"]')).toBeNull();
  });

  it("offers Ask alone when the agent advertises `ask` but no plan-equivalent", async () => {
    await mountCursor([sessionEvent("user_message", { text: "go", attachments: [] }),
      initEvent([{ id: "agent", name: "Agent", description: "d" }, { id: "ask", name: "Ask", description: "Q&A mode - no edits or command execution" }])]);
    const chip = screen.getByRole("button", { name: "Mode" });
    // The mutant: gating the whole chip on `canPlan`. An agent that offers only Ask would show no
    // mode control at all, and its one read-only mode would be unreachable.
    expect(chip).toHaveTextContent("Build");
    expect(chip.title).toContain("Cursor's own Ask mode");
    expect(chip.title).toContain("no edits or command execution");
    fireEvent.click(chip);
    // …and the menu offers exactly Build and Ask: Plan has nothing to map onto here.
    expect(screen.getAllByRole("menuitemcheckbox").map((r) => r.textContent)).toEqual(["Build", "Ask"]);
  });

  it("shows NO chip when the agent named no modes at all", async () => {
    await mountCursor([sessionEvent("user_message", { text: "go", attachments: [] }), initEvent()]);
    expect(screen.queryByRole("button", { name: "Mode" })).toBeNull();
    expect(document.querySelector('.ghost-chip[data-static][title="Waiting for the agent\'s modes"]')).toBeNull();
  });

  it("enters and leaves Plan WITHOUT the Claude-shaped permission park", async () => {
    // Cursor's Plan is its own mode: there is no chosen permission to preserve, so nothing is parked
    // and Build returns the row to its resting default.
    const { store } = await mountCursor([sessionEvent("user_message", { text: "go", attachments: [] }), initEvent(CURSOR_MODES)]);
    fireEvent.click(screen.getByRole("button", { name: "Mode" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Plan" }));
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("plan"));
    expect(store.getState().planReturn.se1).toBeUndefined(); // no park for an agent with no permission axis
    expect(screen.getByRole("button", { name: "Mode" })).toHaveTextContent("Plan");
    fireEvent.click(screen.getByRole("button", { name: "Mode" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Build" }));
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("default"));
  });
});

describe("prompter model picker", () => {
  const rowNames = () => screen.getAllByRole("option").map((n) => n.querySelector(".mp-row-name")!.textContent);

  it("one pick sets BOTH the agent and the model, in that order", async () => {
    // The whole point of merging the two chips. setAgent clears `model` server-side, so a pick that
    // sent them the other way round — or sent only one — would land on the wrong model or the wrong
    // agent. Assert the ordered pair, not just that something happened.
    const { api, store } = await mountKindFresh("codex");
    openPicker();
    fireEvent.click(screen.getByRole("option", { name: /Claude Opus 5/ }));
    await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("claude-opus-5"));
    expect(store.getState().sessions.se1?.agentKind).toBe("claude");
    const picks = api.calls.filter((c) => c.startsWith("setSessionAgent") || c.startsWith("setSessionOptions"));
    expect(picks).toEqual(["setSessionAgent:se1=claude", "setSessionOptions:se1"]);
  });

  it("picking a model inside the current agent leaves the agent alone", async () => {
    const { api, store } = await mountFresh({ model: "claude-opus-5" });
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Opus 5");
    openPicker();
    fireEvent.click(screen.getByRole("option", { name: /Claude Haiku 4\.5/ }));
    await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("claude-haiku-4-5"));
    expect(api.calls.filter((c) => c.startsWith("setSessionAgent"))).toHaveLength(0);
  });

  it("picking an agent with no enumerable models switches the agent and sets no model", async () => {
    const { api, store } = await mountFresh({ model: "claude-opus-5" });
    openPicker();
    fireEvent.click(screen.getByRole("option", { name: /GPT-5\.6/ }));
    await waitFor(() => expect(store.getState().sessions.se1?.agentKind).toBe("codex"));
    // A claude model id means nothing to Codex, and there is no Codex id to send in its place.
    expect(store.getState().sessions.se1?.model).toBeNull();
    expect(api.calls.filter((c) => c.startsWith("setSessionOptions"))).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("GPT-5.6");
  });

  it("lists every agent's models, current agent first, each carrying its provider's brand mark", async () => {
    await mountKindFresh("codex");
    openPicker();
    expect(rowNames()).toEqual(["GPT-5.6", "Claude Fable 5.1", "Claude Fable 5", "Claude Opus 5", "Claude Sonnet 5", "Claude Haiku 4.5",
      // Then the rest of SELECTABLE_AGENT_KINDS, in its order. The Plan 18 agents each contribute
      // one "Default" row: their real catalogs are enumerated live by the probe, and naming a guess
      // here would put a model the session is not on into the picker. DeepSeek is the exception —
      // its ACP server is booted with one model and enumerates nothing, so its two are curated.
      "Composer", "Gemini", "Default", "Default", "Default", "Default", "Default", "Default",
      "DeepSeek V4 Pro", "DeepSeek V4 Flash"]);
    const marks = screen.getAllByRole("option").map((n) => n.querySelector("[data-brand]")?.getAttribute("data-brand"));
    expect(marks).toEqual(["openai", "claude", "claude", "claude", "claude", "claude", "cursor", "gemini",
      "opencode", "githubCopilot", "goose", "qwen", "grok", "fx", "deepseek", "deepseek"]);
    expect(document.querySelector("[data-brand='qwen']")).toHaveAttribute("viewBox", "0 0 141.38 140");
    expect(document.querySelector("[data-brand='githubCopilot']")?.querySelectorAll("path")).toHaveLength(3);
  });

  it("six rows labelled Default are still told apart — the row carries its agent, not just its model", async () => {
    // The named mutant: DEFAULT_MODEL_LABEL giving every Plan 18 agent the same string is only safe
    // because the row's accessible name includes the agent. Drop `mp-row-provider` and the picker
    // becomes six identical options.
    await mountKindFresh("codex");
    openPicker();
    const defaults = screen.getAllByRole("option").filter((n) => n.querySelector(".mp-row-name")!.textContent === "Default");
    expect(defaults).toHaveLength(6);
    const names = defaults.map((n) => n.textContent);
    expect(new Set(names).size).toBe(6);
    expect(names.join("|")).toContain("OpenCode");
    expect(names.join("|")).toContain("Qwen Code");
  });

  it("never hides a session's own kind, even one that is not offered fresh", async () => {
    // `fake` is the dev adapter and absent from SELECTABLE_AGENT_KINDS; a fake session that could not
    // see itself would show a list with nothing selected.
    await mountFresh({ agentKind: "fake" });
    openPicker();
    expect(rowNames()).toEqual(["Fake", "Claude Fable 5.1", "Claude Fable 5", "Claude Opus 5", "Claude Sonnet 5", "Claude Haiku 4.5",
      "GPT-5.6", "Composer", "Gemini", "Default", "Default", "Default", "Default", "Default", "Default",
      "DeepSeek V4 Pro", "DeepSeek V4 Flash"]);
    expect(screen.getByRole("option", { name: /Fake agent/ })).toHaveAttribute("aria-selected", "true");
  });

  it("marks an unavailable CLI but keeps it pickable — the install card is where picking it leads", async () => {
    const { store } = await mountFresh({}, 0, [{ kind: "codex", available: false, version: null, loggedIn: null, reason: "not on PATH" }]);
    // The probe is fired from an effect on mount; the note cannot render before it lands.
    await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
    openPicker();
    const row = screen.getByRole("option", { name: /GPT-5\.6/ });
    expect(row).toHaveTextContent("not installed");
    expect(row).not.toHaveAttribute("aria-disabled");
    fireEvent.click(row);
    // Picking it switches the agent; SessionPane then swaps the prompter for the install card.
    await waitFor(() => expect(screen.getByText(AGENT_CLI_COMMANDS.codex.install!)).toBeInTheDocument());
  });

  describe("once the session has run", () => {
    it("shows cross-agent rows as unavailable, with the reason, and refuses to pick them", async () => {
      const { api, store } = await mountFresh({}, 1);
      openPicker();
      const codex = screen.getByRole("option", { name: /GPT-5\.6/ });
      expect(codex).toHaveAttribute("aria-disabled", "true");
      // The reason lives in the detail pane, where there is room for the whole sentence — the row
      // itself only has to say that something is wrong.
      fireEvent.mouseEnter(codex);
      expect(screen.getByRole("dialog", { name: "Model picker" })).toHaveTextContent(/already run/);
      fireEvent.click(codex);
      // Nothing transmitted, nothing changed, and the picker is still open to explain itself.
      expect(api.calls.filter((c) => c.startsWith("setSessionAgent"))).toHaveLength(0);
      expect(store.getState().sessions.se1?.agentKind).toBe("claude");
      expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument();
    });

    it("keeps models within the current agent selectable", async () => {
      const { store } = await mountFresh({}, 1);
      openPicker();
      const opus = screen.getByRole("option", { name: /Claude Opus 5/ });
      expect(opus).not.toHaveAttribute("aria-disabled");
      fireEvent.click(opus);
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("claude-opus-5"));
    });

    it("locks on a live event arriving into an open prompter, and on a row that already carries events", async () => {
      const { store } = await mountFresh({}, 0);
      openPicker();
      expect(screen.getByRole("option", { name: /GPT-5\.6/ })).not.toHaveAttribute("aria-disabled");
      act(() => store.getState().applySessionEvent({ seq: 7, sessionId: "se1", ephemeral: false, event: sessionEvent("user_message", { text: "hi", attachments: [] }) }));
      await waitFor(() => expect(screen.getByRole("option", { name: /GPT-5\.6/ })).toHaveAttribute("aria-disabled", "true"));

      // lastEventSeq comes back with sessions.list; the transcript is fetched afterwards. Trusting
      // only the transcript would flash a live agent switch on every revisit of a long session.
      const api = fakeApi({ sessions: [session("se2", "s1", { status: "idle", agentKind: "claude", lastEventSeq: 12 })] });
      const st = createAppStore(api); await st.getState().boot();
      st.setState({ sessionStatus: { se2: "idle" } });
      render(<StoreContext.Provider value={st}><SessionPane item={item("i8", "s1", { kind: "session", refId: "se2", title: "Claude session" })} visible /></StoreContext.Provider>);
      const chips = await screen.findAllByRole("button", { name: "Model" });
      fireEvent.click(chips[1]!);
      await waitFor(() => expect(screen.getAllByRole("option", { name: /GPT-5\.6/ })[0]).toHaveAttribute("aria-disabled", "true"));
    });
  });

  describe("search", () => {
    it("matches the model name and the agent name, and nothing else", async () => {
      await mountFresh();
      openPicker();
      const search = screen.getByRole("combobox", { name: "Search models" });
      fireEvent.change(search, { target: { value: "opus" } }); // model name only
      expect(rowNames()).toEqual(["Claude Opus 5"]);
      fireEvent.change(search, { target: { value: "cursor" } }); // agent name only
      expect(rowNames()).toEqual(["Composer"]);
      // Model *ids* are deliberately not searched: `claude-haiku-4-5` would make this match.
      fireEvent.change(search, { target: { value: "haiku-4-5" } });
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      expect(screen.getByText(/No models match/)).toBeInTheDocument();
    });

    it("a harness name finds every model that harness can run, not just the ones routed to it", async () => {
      // What the icon rail used to be for, and the only part of it worth keeping. Cursor proxies a
      // model the Claude CLI also runs: searching "cursor" has to surface it even though the row
      // resolved to Claude, or the search would deny Cursor a model it just listed.
      const { store } = await mountFresh({}, 0, [{ kind: "acp:cursor", available: true, version: "2026.09", loggedIn: null, reason: null,
        models: [{ id: "claude-fable-5.1", label: "Claude Fable 5.1" }] }]);
      await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
      openPicker();
      fireEvent.change(screen.getByRole("combobox", { name: "Search models" }), { target: { value: "cursor" } });
      expect(rowNames()).toContain("Claude Fable 5.1");
      expect(rowNames()).not.toContain("Claude Sonnet 5"); // claude-only; Cursor never offered it
    });

    it("groups by harness when idle and drops the headings while searching", async () => {
      // The list teaches which CLI runs what — but a filtered list is already an answer, and a
      // heading per result would push the third match below the fold to repeat the row's own line.
      await mountFresh();
      openPicker();
      const headings = () => [...document.querySelectorAll(".mp-group-label")].map((n) => n.textContent);
      expect(headings()).toContain("Claude");
      expect(headings()).toContain("Codex");
      fireEvent.change(screen.getByRole("combobox", { name: "Search models" }), { target: { value: "opus" } });
      expect(headings()).toEqual(["Run it through"]); // the detail pane's own label, not a list heading
    });

    it("Enter picks the highlighted row after arrowing down", async () => {
      const { store } = await mountFresh();
      openPicker();
      const search = screen.getByRole("combobox", { name: "Search models" });
      fireEvent.keyDown(search, { key: "ArrowDown" });
      fireEvent.keyDown(search, { key: "Enter" });
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("claude-fable-5")); // row 2 of Claude's list
    });
  });

  describe("with a live probe catalog", () => {
    // The shape cursor-agent reported live: parameterized ids, `default[]` for Auto.
    const catalog = [
      { id: "default[]", label: "Auto" },
      { id: "composer-2.5[fast=true]", label: "composer-2.5" },
      { id: "gpt-5.3-codex[reasoning=medium,fast=false]", label: "gpt-5.3-codex" },
    ];
    const cursorProbe = (models: AgentProbe["models"]): AgentProbe[] =>
      [{ kind: "acp:cursor", available: true, version: "2026.09", loggedIn: null, reason: null, models }];

    it("renders the catalog under its own kind, default row leading and selected", async () => {
      const { store } = await mountFresh({ agentKind: "acp:cursor" }, 0, cursorProbe(catalog));
      await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
      openPicker();
      // Cursor first (session's own kind): default row, then the catalog verbatim; Claude's static
      // list and Codex's default row are untouched by Cursor's probe models.
      expect(rowNames()).toEqual(["Composer", "Auto", "composer-2.5", "gpt-5.3-codex",
        "Claude Fable 5.1", "Claude Fable 5", "Claude Opus 5", "Claude Sonnet 5", "Claude Haiku 4.5", "GPT-5.6",
        // Every other offered kind still contributes exactly its own rows: one agent's probe catalog
        // must not leak onto another's.
        "Gemini", "Default", "Default", "Default", "Default", "Default", "Default",
        "DeepSeek V4 Pro", "DeepSeek V4 Flash"]);
      expect(screen.getByRole("option", { name: /Composer/ })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("option", { name: /Auto/ })).toHaveAttribute("aria-selected", "false");
    });

    it("picking a catalog row transmits its id verbatim — Auto's real id included", async () => {
      const { store } = await mountFresh({ agentKind: "acp:cursor" }, 0, cursorProbe(catalog));
      await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
      openPicker();
      fireEvent.click(screen.getByRole("option", { name: /gpt-5.3-codex/ }));
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("gpt-5.3-codex[reasoning=medium,fast=false]"));
      openPicker();
      // "Auto" is a REAL id in Cursor's catalog (set_model accepts `default[]`, rejects `auto`):
      // picking it transmits that id — it is never rewritten to null or to a literal "auto".
      fireEvent.click(screen.getAllByRole("option", { name: /Auto/ })[0]!);
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("default[]"));
    });

    it("search and keyboard still work across a 40-row catalog", async () => {
      const big = Array.from({ length: 40 }, (_, i) => ({ id: `m-${i}[x=1]`, label: `Model ${i}` }));
      const { store } = await mountFresh({ agentKind: "acp:cursor" }, 0, cursorProbe(big));
      await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
      openPicker();
      expect(screen.getAllByRole("option").length).toBeGreaterThan(40);
      const search = screen.getByRole("combobox", { name: "Search models" });
      fireEvent.change(search, { target: { value: "model 39" } });
      expect(rowNames()).toEqual(["Model 39"]);
      fireEvent.keyDown(search, { key: "Enter" });
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("m-39[x=1]"));
    });
  });

  describe("favourites", () => {
    const OPUS = canonicalModelKey("Claude Opus 5");
    const HAIKU = canonicalModelKey("Claude Haiku 4.5");
    const searchBox = () => screen.getByRole("combobox", { name: "Search models" });
    const starOn = (label: string | RegExp) =>
      within(screen.getByRole("option", { name: label })).getByRole("button", { name: /Favourite|Unfavourite/ });
    /** Preloads starred keys the way a previous session would have left them in `settings`. */
    const withFavorites = async (keys: string[]) => {
      const r = await mountFresh();
      await act(async () => { r.store.setState({ modelFavorites: keys }); });
      return r;
    };

    it("opens on search over a list, and shows no Favourites group when nothing is starred", async () => {
      // Search first, then the list: the popover opens for typing, and the groups are what the eye
      // falls to when the user has nothing to type.
      await mountFresh();
      openPicker();
      const picker = screen.getByRole("dialog", { name: "Model picker" });
      expect([...picker.children].map((n) => n.className)).toEqual(["mp-search", "mp-body"]);
      expect([...document.querySelectorAll(".mp-group-label")].map((n) => n.textContent)).not.toContain("Favourites");
    });

    it("leads the list with a Favourites group once something is starred", async () => {
      await withFavorites([OPUS]);
      openPicker();
      expect([...document.querySelectorAll(".mp-group-label")][0]).toHaveTextContent("Favourites");
    });

    it("starring a row persists a canonical KEY, not a model id", async () => {
      // A key is what survives the model being reached through a different harness later.
      const { api, store } = await mountFresh();
      openPicker();
      fireEvent.click(starOn(/Claude Opus 5/));
      await waitFor(() => expect(store.getState().modelFavorites).toEqual([OPUS]));
      expect(api.calls.some((c) => c.startsWith("setSetting:models.favorites"))).toBe(true);
      expect(OPUS).not.toBe("claude-opus-5"); // the id would have been the lazy thing to store
    });

    it("starring a row does not also pick it", async () => {
      // The star lives inside the row; without stopPropagation it would switch the session's model
      // as a side effect of bookmarking it.
      const { store } = await mountFresh({ model: "claude-fable-5-1" });
      openPicker();
      fireEvent.click(starOn(/Claude Opus 5/));
      await waitFor(() => expect(store.getState().modelFavorites).toEqual([OPUS]));
      expect(store.getState().sessions.se1?.model).toBe("claude-fable-5-1");
      expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument(); // and stays open
    });

    it("un-starring removes only that key", async () => {
      const { store } = await withFavorites([OPUS, HAIKU]);
      openPicker();
      // aria-pressed is not decoration here: it is the hook the filled-star CSS keys on, so a
      // starred row that failed to set it would look unstarred with no test noticing.
      expect(starOn(/Claude Opus 5/)).toHaveAttribute("aria-pressed", "true");
      expect(starOn(/Claude Sonnet 5/)).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(starOn(/Claude Opus 5/));
      await waitFor(() => expect(store.getState().modelFavorites).toEqual([HAIKU]));
    });

    it("floats favourites to the top and numbers them down the page", async () => {
      await withFavorites([HAIKU, OPUS]); // starred in this order; the badges must not follow it
      openPicker();
      expect(rowNames().slice(0, 2)).toEqual(["Claude Opus 5", "Claude Haiku 4.5"]); // list order, not starring order
      const badges = screen.getAllByRole("option").map((n) => n.querySelector(".mp-kbd")?.textContent ?? null);
      expect(badges.slice(0, 2)).toEqual(["⌘1", "⌘2"]);
      expect(badges.slice(2).every((b) => b === null)).toBe(true); // only favourites are numbered
    });

    it("numbers only the favourites still on screen, so ⌘1 is always the first visible one", async () => {
      // Numbering off the unfiltered list would leave ⌘1 pointing at a favourite the search has
      // hidden — pressing it would swap the model to something not on screen.
      const { store } = await withFavorites([OPUS, HAIKU]);
      openPicker();
      fireEvent.change(searchBox(), { target: { value: "haiku" } });
      expect(rowNames()).toEqual(["Claude Haiku 4.5"]);
      expect(screen.getByRole("option", { name: /Haiku/ }).querySelector(".mp-kbd")).toHaveTextContent("⌘1");
      fireEvent.keyDown(searchBox(), { key: "1", metaKey: true });
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("claude-haiku-4-5"));
    });

    it("⌘<n> picks the nth favourite", async () => {
      const { store } = await withFavorites([HAIKU, OPUS]);
      openPicker();
      fireEvent.keyDown(searchBox(), { key: "2", metaKey: true });
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("claude-haiku-4-5")); // ⌘2 = second ROW
    });

    it("a bare digit still types into the search box", async () => {
      // The reason the badge is ⌘-prefixed at all: "5" is something people search for. Asserted via
      // the popover staying open, which `pick` closes SYNCHRONOUSLY — checking the session's model
      // instead would race the RPC and pass against a picker that had already hijacked the key.
      const { api } = await withFavorites([OPUS]);
      openPicker();
      fireEvent.keyDown(searchBox(), { key: "1" });
      expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument();
      await act(async () => {});
      expect(api.calls.some((c) => c.startsWith("setSessionOptions"))).toBe(false);
    });

    it("⌘<n> past the last favourite does nothing", async () => {
      const { store } = await withFavorites([OPUS]);
      openPicker();
      fireEvent.keyDown(searchBox(), { key: "4", metaKey: true });
      expect(store.getState().sessions.se1?.model).toBeNull();
      expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument();
    });

    it("⌥↩ stars the highlighted row, which is the only keyboard path to the star", async () => {
      const { store } = await mountFresh();
      openPicker();
      fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
      fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
      fireEvent.keyDown(searchBox(), { key: "Enter", altKey: true });
      await waitFor(() => expect(store.getState().modelFavorites).toEqual([canonicalModelKey("Claude Opus 5")]));
      expect(store.getState().sessions.se1?.model).toBeNull(); // ⌥↩ stars; it does not pick
    });

    it("keeps the highlight on the row ⌥↩ just starred, after it sorts to the top", async () => {
      // Starring re-sorts the list under the highlight. Anchored to an index, the highlight would
      // stay in slot 2 while the starred row moved to slot 0 — so the very next Enter would pick
      // whichever model slid into that slot, not the one the user was looking at.
      const { store } = await mountFresh();
      openPicker();
      fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
      fireEvent.keyDown(searchBox(), { key: "ArrowDown" }); // Claude Opus 5, row 3 of the list
      fireEvent.keyDown(searchBox(), { key: "Enter", altKey: true });
      await waitFor(() => expect(store.getState().modelFavorites).toEqual([OPUS]));
      expect(rowNames()[0]).toBe("Claude Opus 5"); // it moved
      const active = document.querySelector(".mp-row[data-active] .mp-row-name")?.textContent;
      expect(active).toBe("Claude Opus 5"); // and the highlight moved with it
      fireEvent.keyDown(searchBox(), { key: "Enter" });
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("claude-opus-5"));
    });

    it("a starred model appears once — in Favourites, not also under its harness", async () => {
      await withFavorites([OPUS]);
      openPicker();
      const groups = [...document.querySelectorAll(".mp-group")];
      expect(groups[0]!.querySelector(".mp-group-label")).toHaveTextContent("Favourites");
      expect([...groups[0]!.querySelectorAll(".mp-row-name")].map((n) => n.textContent)).toEqual(["Claude Opus 5"]);
      expect(rowNames().filter((n) => n === "Claude Opus 5")).toHaveLength(1);
    });
  });

  describe("the route pills (the harness chip's replacement)", () => {
    /** Cursor proxying a model the Claude CLI also runs — the overlap a route switch has to carry. */
    const proxyProbe: AgentProbe[] = [
      { kind: "acp:cursor", available: true, version: "2026.09", loggedIn: null, reason: null,
        models: [{ id: "claude-fable-5.1", label: "Claude Fable 5.1" }, { id: "gpt-5.5", label: "GPT-5.5" }] },
    ];
    const detail = () => screen.getByRole("dialog", { name: "Model picker" });

    it("the prompter has ONE chip, and it names the harness as well as the model", async () => {
      // The harness menu is gone: a harness is only ever chosen FOR a model, so it moved inside the
      // picker. The chip still has to say which CLI is running the session, or that fact has no home.
      await mountFresh({ model: "claude-opus-5" });
      expect(screen.queryByRole("button", { name: "Harness" })).toBeNull();
      const chip = screen.getByRole("button", { name: "Model" });
      expect(chip).toHaveTextContent("Claude Opus 5");
      expect(chip.getAttribute("title")).toBe("Claude Opus 5 through Claude");
      expect(chip.querySelector("[data-brand]")).toHaveAttribute("data-brand", "claude"); // the HARNESS's mark
    });

    it("offers one pill per harness that can run the highlighted model, resolved one pressed", async () => {
      const { store } = await mountFresh({ model: "claude-fable-5-1" }, 0, proxyProbe);
      await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
      openPicker();
      fireEvent.mouseEnter(screen.getByRole("option", { name: /Claude Fable 5\.1/ }));
      const pills = within(detail()).getAllByRole("button", { name: /^Run Claude Fable 5\.1 through/ });
      expect(pills.map((p) => p.textContent)).toEqual(["Claude", "Cursor"]);
      expect(pills[0]).toHaveAttribute("aria-pressed", "true"); // the session's own harness wins the tie
    });

    it("switching the route and using the model re-maps the id for the harness that will run it", async () => {
      // The point of keeping the axes distinct: changing WHAT RUNS must not silently change WHAT IT
      // RUNS. Cursor names this model by a different id, so the switch re-maps rather than re-sends.
      const { api, store } = await mountFresh({ model: "claude-fable-5-1" }, 0, proxyProbe);
      await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
      openPicker();
      fireEvent.mouseEnter(screen.getByRole("option", { name: /Claude Fable 5\.1/ }));
      fireEvent.click(within(detail()).getByRole("button", { name: "Run Claude Fable 5.1 through Cursor" }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "Model picker" })).getByRole("button", { name: /model$/ }));
      await waitFor(() => expect(store.getState().sessions.se1?.agentKind).toBe("acp:cursor"));
      expect(store.getState().sessions.se1?.model).toBe("claude-fable-5.1"); // Cursor's id, not Claude's
      expect(api.calls.filter((c) => c.startsWith("setSessionAgent") || c.startsWith("setSessionOptions")))
        .toEqual(["setSessionAgent:se1=acp:cursor", "setSessionOptions:se1"]); // setAgent clears model, so order matters
    });

    it("←/→ walk the routes without leaving the search field", async () => {
      const { store } = await mountFresh({ model: "claude-fable-5-1" }, 0, proxyProbe);
      await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
      openPicker();
      const search = screen.getByRole("combobox", { name: "Search models" });
      fireEvent.change(search, { target: { value: "fable 5.1" } });
      fireEvent.keyDown(search, { key: "ArrowRight" });
      expect(within(detail()).getByRole("button", { name: /through Cursor/ })).toHaveAttribute("aria-pressed", "true");
      fireEvent.keyDown(search, { key: "Enter" });
      await waitFor(() => expect(store.getState().sessions.se1?.agentKind).toBe("acp:cursor"));
      expect(store.getState().sessions.se1?.model).toBe("claude-fable-5.1");
    });

    it("a route the user chose applies to that model only, not to the next one they look at", async () => {
      // A route is part of the choice being made, not a mode the picker is in — otherwise glancing
      // at one model would re-route the next.
      const { store } = await mountFresh({ model: "claude-fable-5-1" }, 0, proxyProbe);
      await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
      openPicker();
      fireEvent.mouseEnter(screen.getByRole("option", { name: /Claude Fable 5\.1/ }));
      fireEvent.click(within(detail()).getByRole("button", { name: "Run Claude Fable 5.1 through Cursor" }));
      fireEvent.mouseEnter(screen.getByRole("option", { name: /Claude Sonnet 5/ }));
      expect(within(detail()).getByRole("button", { name: /Claude Sonnet 5 through Claude/ })).toHaveAttribute("aria-pressed", "true");
    });

    it("says what the harness is for, and how it bills, next to the price it would charge", async () => {
      // The line that stops a per-token number from lying: Claude Code runs on a subscription, so
      // "$50 / Mtok" is context rather than a bill, and the picker has to say which.
      const { store } = await mountFresh();
      await act(async () => {
        store.setState({ modelInfo: { [canonicalModelKey("Claude Fable 5.1")]: {
          key: canonicalModelKey("Claude Fable 5.1"), label: "Claude Fable 5.1", vendor: "Anthropic",
          priceIn: 10, priceOut: 50, context: 1_000_000, efforts: ["max", "low"], blurb: "Vendor prose." } } });
      });
      openPicker();
      fireEvent.mouseEnter(screen.getByRole("option", { name: /Claude Fable 5\.1/ }));
      expect(detail()).toHaveTextContent("$10 / Mtok");
      expect(detail()).toHaveTextContent("$50 / Mtok");
      expect(detail()).toHaveTextContent("1M");
      expect(detail()).toHaveTextContent(AGENT_NOTES.claude.billing);
      // Realm's own sentence beats the catalog's marketing first line.
      expect(detail()).toHaveTextContent(MODEL_NOTES.get(canonicalModelKey("Claude Fable 5.1"))!);
      expect(detail()).not.toHaveTextContent("Vendor prose.");
    });

    it("renders a model the catalog has never heard of without inventing a price", async () => {
      // Composer and every "Default" row have no catalog entry at all. A picker that hid them, or
      // guessed, would be worse than one that shows the sentence and stops.
      await mountFresh();
      openPicker();
      fireEvent.mouseEnter(screen.getByRole("option", { name: /Composer/ }));
      expect(detail()).not.toHaveTextContent("/ Mtok");
      expect(detail()).toHaveTextContent(AGENT_NOTES["acp:cursor"].good);
    });

    it("warns about a harness that cannot do what its neighbours can", async () => {
      // DeepSeek's ACP server is automation-only. Offering the kind silently would be the dishonest
      // half of shipping it; this line is the other half.
      await mountFresh();
      openPicker();
      fireEvent.mouseEnter(screen.getByRole("option", { name: /DeepSeek V4 Pro/ }));
      expect(detail()).toHaveTextContent(AGENT_NOTES["acp:deepseek"].limits!);
      expect(detail()).toHaveTextContent(AGENT_NOTES["acp:deepseek"].billing);
    });

    it("cannot re-route a session that has already run, and says why", async () => {
      // sessions.setAgent refuses after the first event. The pills stay visible and disabled: a model
      // whose routes vanished would read as a bug rather than as a rule.
      await mountFresh({ lastEventSeq: 3 }, 3);
      openPicker();
      fireEvent.mouseEnter(screen.getByRole("option", { name: /GPT-5\.6/ }));
      const pill = within(detail()).getByRole("button", { name: /through Codex/ });
      expect(pill).toBeDisabled();
      expect(detail()).toHaveTextContent(/already run/);
      expect(within(detail()).getByRole("button", { name: /model$/ })).toBeDisabled();
    });
  });
});


/** A hub over a no-op transport and a stub xterm — the drawer only has to mount, not render a shell. */
function fakeHub() {
  const transport: HubTransport = { on: () => () => {}, call: async () => ({ ok: true }) };
  const term: TerminalLike = {
    cols: 80, rows: 24, open: () => {}, write: () => {}, dispose: () => {}, focus: () => {},
    onData: () => ({ dispose() {} }), onResize: () => ({ dispose() {} }),
  };
  return new TerminalHub(transport, () => ({ term, fit: { fit() {} } }));
}

describe("the session's terminal drawer (W4)", () => {
  beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
  afterEach(() => { setTerminalHubForTests(null); vi.unstubAllGlobals(); });

  const sessionItem = item("i9", "s1", { kind: "session", refId: "se1", title: "Fake agent session" });

  /** The pane AND its header, which is where the toggle lives (PanelBar renders per-kind actions). */
  async function mountPane(panel?: { open: boolean; width: number }) {
    setTerminalHubForTests(fakeHub());
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle" })] });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } }, ...(panel ? { terminalPanel: { se1: panel } } : {}) });
    const r = render(
      <StoreContext.Provider value={store}>
        <PanelBar item={sessionItem} leafId="l1" onSplit={() => {}} onClose={() => {}} />
        <SessionPane item={sessionItem} visible />
      </StoreContext.Provider>,
    );
    return { api, store, ...r };
  }

  const toggle = () => screen.getByRole("button", { name: /(Show|Hide) terminal for Fake agent session/ });

  it("is absent until the header toggle is pressed — mounting a session never spawns a shell", async () => {
    const { api, store } = await mountPane();
    expect(document.querySelector(".terminal-pane")).toBeNull();
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(api.calls.some((c) => c.startsWith("openSessionTerminal"))).toBe(false);

    fireEvent.click(toggle());
    await waitFor(() => expect(document.querySelector(".terminal-pane")).not.toBeNull());
    expect(api.calls).toContain("openSessionTerminal:se1");
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(store.getState().terminalPanel["se1"]).toEqual({ open: true, width: 38 });
    // The drawer is INTERNAL to the session pane: the transcript is still right there beside it.
    expect(document.querySelector(".session-split .session-pane")).not.toBeNull();
  });

  it("reopening a session whose drawer was left open restores it, at its persisted width", async () => {
    await mountPane({ open: true, width: 44 });
    await waitFor(() => expect(document.querySelector(".terminal-pane")).not.toBeNull());
    const panels = [...document.querySelectorAll(".session-split > [data-panel]")];
    expect(panels).toHaveLength(2);
    expect(panels[1]).toHaveStyle({ flexGrow: "44" }); // 38% is only the FIRST-open default
  });

  it("hiding it removes the view but keeps the terminal — nothing is disposed", async () => {
    const { api, store } = await mountPane({ open: true, width: 38 });
    await waitFor(() => expect(store.getState().sessionTerminals["se1"]).toBe("term-se1"));
    fireEvent.click(toggle());
    await waitFor(() => expect(document.querySelector(".terminal-pane")).toBeNull());
    expect(api.disposed).toEqual([]);
    expect(store.getState().sessionTerminals["se1"]).toBe("term-se1");
  });

  it("double-clicking the drawer divider restores the default width; the store follows", async () => {
    const { store } = await mountPane({ open: true, width: 72 }); // dragged wide in a previous run
    await waitFor(() => expect(document.querySelector(".terminal-pane")).not.toBeNull());
    const panels = [...document.querySelectorAll(".session-split > [data-panel]")];
    expect(panels[1]).toHaveStyle({ flexGrow: "72" });

    fireEvent.doubleClick(document.querySelector(".session-split .resize-handle")!);
    // This split is not born equal — "original" here is the drawer's default width, not 50/50.
    await waitFor(() => expect(store.getState().terminalPanel["se1"]!.width).toBe(38));
  });

  it("a terminal item's header has no such toggle — only sessions own one", () => {
    const api = fakeApi();
    const store = createAppStore(api);
    render(<StoreContext.Provider value={store}><PanelBar item={item("i1", "s1", { kind: "terminal", title: "zsh" })} leafId="l1" onSplit={() => {}} onClose={() => {}} /></StoreContext.Provider>);
    expect(screen.queryByRole("button", { name: /terminal for zsh/ })).toBeNull();
  });
});

describe("the CLI-missing install card (W4)", () => {
  beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
  afterEach(() => { setTerminalHubForTests(null); vi.unstubAllGlobals(); });

  const sessionItem = item("i9", "s1", { kind: "session", refId: "se1", title: "Claude session" });
  const ready: AgentProbe = { kind: "claude", available: true, version: "2.0.1", loggedIn: true, reason: null };
  const missing: AgentProbe = { kind: "claude", available: false, version: null, loggedIn: null, reason: "spawn claude ENOENT" };
  const signedOut: AgentProbe = { kind: "claude", available: true, version: "2.0.1", loggedIn: false, reason: "not logged in — run `claude auth login`" };

  async function mountAgent(agentProbe: AgentProbe[], status: "idle" | "running" = "idle") {
    setTerminalHubForTests(fakeHub());
    const api = fakeApi({ sessions: [session("se1", "s1", { status, agentKind: "claude" })], agentProbe });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: status }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
    const r = render(
      <StoreContext.Provider value={store}>
        <PanelBar item={sessionItem} leafId="l1" onSplit={() => {}} onClose={() => {}} />
        <SessionPane item={sessionItem} visible />
      </StoreContext.Provider>,
    );
    return { api, store, ...r };
  }

  const prompter = () => screen.queryByRole("textbox", { name: /message/i });

  it("an AVAILABLE agent keeps the prompter and shows no card", async () => {
    const { api } = await mountAgent([ready]);
    await waitFor(() => expect(api.calls).toContain("probeAgents:false"));
    expect(prompter()).toBeInTheDocument();
    expect(document.querySelector(".install-card")).toBeNull();
  });

  it("an un-probed agent keeps the prompter — the card never appears on a guess", async () => {
    const { store } = await mountAgent([{ ...ready, kind: "codex" }]);
    await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
    expect(prompter()).toBeInTheDocument();
    expect(document.querySelector(".install-card")).toBeNull();
  });

  it("a MISSING CLI replaces the prompter with the probe's reason and the INSTALL command", async () => {
    await mountAgent([missing]);
    await waitFor(() => expect(document.querySelector(".install-card")).not.toBeNull());
    expect(prompter()).toBeNull(); // replaced, not merely disabled
    expect(screen.getByRole("group", { name: /isn’t installed/ })).toBeInTheDocument();
    expect(screen.getByText("spawn claude ENOENT")).toBeInTheDocument();
    expect(screen.getByText(AGENT_CLI_COMMANDS.claude.install)).toBeInTheDocument();
    expect(screen.queryByText(AGENT_CLI_COMMANDS.claude.login)).toBeNull();
  });

  it("a SIGNED-OUT CLI is a different card with the LOGIN command", async () => {
    await mountAgent([signedOut]);
    await waitFor(() => expect(document.querySelector(".install-card")).not.toBeNull());
    expect(screen.getByRole("group", { name: /isn’t signed in/ })).toBeInTheDocument();
    expect(screen.getByText(AGENT_CLI_COMMANDS.claude.login)).toBeInTheDocument();
    expect(screen.queryByText(AGENT_CLI_COMMANDS.claude.install)).toBeNull();
  });

  it("never takes the prompter away mid-turn — Stop must survive a probe that goes sour", async () => {
    const { api } = await mountAgent([missing], "running");
    await waitFor(() => expect(api.calls).toContain("probeAgents:false"));
    expect(document.querySelector(".install-card")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("'Open in terminal' opens the session's panel with the command TYPED, never run", async () => {
    const { api } = await mountAgent([missing]);
    await waitFor(() => expect(document.querySelector(".install-card")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open in terminal" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("prefillTerminal:"))).toBe(true));
    expect(api.calls).toContain("openSessionTerminal:se1");
    expect(api.calls).toContain(`prefillTerminal:term-se1=${AGENT_CLI_COMMANDS.claude.install}`);
    expect(api.calls.find((c) => c.startsWith("prefillTerminal:"))).not.toMatch(/[\r\n]$/);
    await waitFor(() => expect(document.querySelector(".terminal-pane")).not.toBeNull());
  });

  it("'Check again' re-probes past the cache and the prompter comes back — no restart", async () => {
    const { api } = await mountAgent([missing]);
    await waitFor(() => expect(document.querySelector(".install-card")).not.toBeNull());
    api.data.agentProbe = [ready]; // the user installed it in another window
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(prompter()).toBeInTheDocument());
    expect(document.querySelector(".install-card")).toBeNull();
    expect(api.calls).toContain("probeAgents:true");
  });

  it("window focus re-probes too — the fix happens in another app", async () => {
    const { api } = await mountAgent([missing]);
    await waitFor(() => expect(document.querySelector(".install-card")).not.toBeNull());
    api.data.agentProbe = [ready];
    fireEvent.focus(window);
    await waitFor(() => expect(prompter()).toBeInTheDocument());
    expect(api.calls).toContain("probeAgents:true");
  });

  it("the model picker labels unavailable agents but still lets you pick one — the pick leads to the card", async () => {
    // The W3 regression this restores: the picker offered every agent unconditionally, so an
    // uninstalled pick failed at the first message instead of at pick time.
    const { api, store } = await mountAgent([
      { ...ready, kind: "codex" },
      { ...missing, kind: "claude" },
    ]);
    await waitFor(() => expect(document.querySelector(".install-card")).not.toBeNull());
    // Switch the session to the working agent from the card-less state: flip claude to ready first.
    api.data.agentProbe = [ready, { ...missing, kind: "codex" }];
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(prompter()).toBeInTheDocument());
    openPicker();
    const codex = screen.getByRole("option", { name: /GPT-5\.6/ });
    expect(codex).toHaveTextContent("not installed");
    expect(screen.getByRole("option", { name: /Claude Fable 5\.1/ })).not.toHaveTextContent("not installed");
    // Pickable, not disabled: choosing it is how the user reaches the install command.
    expect(codex).not.toHaveAttribute("aria-disabled");
    fireEvent.click(codex);
    await waitFor(() => expect(store.getState().sessions.se1!.agentKind).toBe("codex"));
    await waitFor(() => expect(document.querySelector(".install-card")).not.toBeNull());
    expect(prompter()).toBeNull();
  });
});

/**
 * Attachments in the prompter.
 *
 * The backend has taken `attachments` all along; what was missing was any way to put one there — and,
 * more importantly, any warning that the three adapters do three different things with the same file.
 * These lean hardest on that last part: the note must name the session's OWN agent and its OWN fate
 * for the file, because a note that is merely plausible is worse than none.
 */
describe("prompter attachments", () => {
  beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const picked = (path: string, mime: string, size = 10) =>
    ({ path, mime, name: path.split("/").pop()!, size });

  /** A dropped File carries its real path (Electron resolves it); a pasted one does not. */
  const dropped = (path: string, type: string, size = 10) =>
    Object.assign(new File([new Uint8Array(size)], path.split("/").pop()!, { type }), { path }) as unknown as File;
  const pastedImage = (name = "image.png") =>
    Object.assign(new File([new Uint8Array(4)], name, { type: "image/png" }),
      { arrayBuffer: async () => new ArrayBuffer(4) }) as unknown as File;

  /** Mount a fresh (hero) prompter for a given agent kind. */
  async function mountFor(agentKind: "claude" | "codex" | "acp:cursor" | "fake", pickFiles: ReturnType<typeof picked>[] = []) {
    const api = fakeApi({
      sessions: [session("se1", "s1", { status: "idle", agentKind })],
      agentProbe: [{ kind: agentKind, available: true, version: "1", loggedIn: true, reason: null }],
      pickFiles,
    });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
    const r = render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
    return { api, store, ...r };
  }

  /** The "+" menu's Add files… (Plan 12 W1): the plus opens a menu now, and the menu item reaches the
   *  SAME store action the bare attach button used to call — every assertion below is unchanged. */
  const attach = () => {
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Add files…/ })); // kbd hint ⌘U rides the accessible name
  };
  const chips = () => Array.from(document.querySelectorAll(".attach-tile")).map((c) => c.textContent ?? "");
  const notes = () => Array.from(document.querySelectorAll(".composer-attach-note")).map((n) => n.textContent ?? "");
  const composer = () => document.querySelector(".composer") as HTMLElement;
  const dt = (files: File[]) => ({ dataTransfer: { files, items: files.map(() => ({ kind: "file" })), types: ["Files"] } });

  it("the attach button opens the native picker and its files become chips", async () => {
    const { api } = await mountFor("claude", [picked("/x/shot.png", "image/png")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(chips()[0]).toContain("shot.png");
    expect(api.calls).toContain("pickFiles");
  });

  it("says what CLAUDE will do — and warns that a PDF is dropped on the floor", async () => {
    await mountFor("claude", [picked("/x/shot.png", "image/png"), picked("/x/report.pdf", "application/pdf")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(2));
    const warn = notes().find((t) => /ignores/.test(t))!;
    expect(warn).toContain("Claude");
    expect(warn).toContain("ignores non-image attachments");
    expect(warn).toContain("report.pdf");
    expect(warn).not.toContain("shot.png"); // the image is fine, and must not be tarred with it
    // The image gets no note of its own: being read is the expected outcome, and a row saying so
    // would only compete with the one warning that matters.
    expect(notes()).toHaveLength(1);
    expect(notes().join(" ")).not.toMatch(/reads image attachments inline/);
    // The doomed chip wears the warning fate; the image does not.
    const marked = Array.from(document.querySelectorAll(".attach-tile[data-disposition='ignored']"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent("report.pdf");
  });

  it("says something DIFFERENT for Codex — the same PDF, a path it will open", async () => {
    await mountFor("codex", [picked("/x/report.pdf", "application/pdf")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(notes().join(" ")).toContain("Codex");
    expect(notes().join(" ")).toContain("file path");
    expect(notes().join(" ")).not.toMatch(/ignores/);
    expect(document.querySelectorAll(".attach-tile[data-disposition='ignored']")).toHaveLength(0);
  });

  it("says something DIFFERENT again for Cursor — a link", async () => {
    await mountFor("acp:cursor", [picked("/x/report.pdf", "application/pdf")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(notes().join(" ")).toContain("Cursor");
    expect(notes().join(" ")).toContain("link");
  });

  it("never names an agent other than the session's own", async () => {
    await mountFor("codex", [picked("/x/report.pdf", "application/pdf")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(1));
    const text = notes().join(" ") + (document.querySelector(".attach-tile")!.textContent ?? "");
    for (const other of ["Claude", "Cursor", "Gemini"]) expect(text, other).not.toContain(other);
  });

  it("the tile's tip carries the name, the size and the same verdict — and not the path", async () => {
    await mountFor("claude", [picked("/very/long/path/report.pdf", "application/pdf", 2048)]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(1));
    const tip = document.querySelector(".attach-tip")!.textContent!;
    expect(tip).toContain("report.pdf");
    expect(tip).toContain("2.0 KB");
    expect(tip).toContain("Claude ignores non-image attachments");
    // No directory. The path used to be here because the chip TRUNCATED its label and a bare
    // basename could be ambiguous; nothing truncates now, and for the common case — a pasted
    // screenshot under Realm's own tmp — the folder was three lines of noise over the answer.
    expect(tip).not.toContain("/very/long/path");
  });

  it("the tile shows no name at rest, but is still named to a screen reader", async () => {
    await mountFor("codex", [picked("/x/report.pdf", "application/pdf")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(1));
    const tile = document.querySelector(".attach-tile")!;
    // Everything naming the file is either visually hidden or inside the hover tip — nothing else
    // in the tile carries text, which is what keeps a row of files to a row of squares.
    const visible = Array.from(tile.childNodes)
      .filter((n) => !(n instanceof HTMLElement && (n.classList.contains("visually-hidden") || n.classList.contains("attach-tip"))))
      .map((n) => n.textContent ?? "").join("");
    expect(visible).not.toContain("report");
    expect(tile.querySelector(".visually-hidden")!.textContent).toContain("report.pdf");
  });

  it("a removed chip is gone from the row AND never reaches the wire", async () => {
    const { api } = await mountFor("codex", [picked("/x/a.png", "image/png"), picked("/x/b.png", "image/png")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Remove b.png" }));
    await waitFor(() => expect(chips()).toHaveLength(1));
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "look" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]!.attachments).toEqual([{ path: "/x/a.png", mime: "image/png" }]);
  });

  it("sending clears the row — the next message must not carry them again", async () => {
    const { api } = await mountFor("codex", [picked("/x/a.png", "image/png")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(1));
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "one" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(chips()).toHaveLength(0));
    expect(document.querySelectorAll(".composer-attach-note")).toHaveLength(0);
    fireEvent.change(box, { target: { value: "two" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.sent).toHaveLength(2));
    expect(api.sent[1]!.attachments).toEqual([]);
  });

  it("refuses a file over the 20 MB cap in the UI, with the reason", async () => {
    const { store } = await mountFor("claude", [picked("/x/huge.png", "image/png", 21 * 1024 * 1024)]);
    attach();
    await waitFor(() => expect(store.getState().error).toBeTruthy());
    expect(chips()).toHaveLength(0);
    expect(store.getState().error).toContain("huge.png");
    expect(store.getState().error).toContain("20 MB");
  });

  it("dropping files on the card attaches them and marks the card while the drag is over it", async () => {
    const { api } = await mountFor("codex");
    const files = [dropped("/Users/me/a.png", "image/png"), dropped("/Users/me/b.pdf", "application/pdf")];
    fireEvent.dragEnter(composer(), dt(files));
    expect(composer()).toHaveAttribute("data-dropping");
    expect(screen.getByText("Drop to attach")).toBeInTheDocument();
    fireEvent.drop(composer(), dt(files));
    await waitFor(() => expect(chips()).toHaveLength(2));
    expect(composer()).not.toHaveAttribute("data-dropping");
    // A drop is not a copy: the files are attached at the paths they already have.
    expect(api.calls.filter((c) => c.startsWith("saveTempAttachment"))).toHaveLength(0);
  });

  it("a drag that carries no files is left alone — Realm drags its own sidebar rows onto panes", async () => {
    await mountFor("codex");
    fireEvent.dragEnter(composer(), { dataTransfer: { files: [], items: [], types: ["application/x-realm-item"] } });
    expect(composer()).not.toHaveAttribute("data-dropping");
  });

  it("nested dragenter/dragleave does not flicker the drop target off", async () => {
    await mountFor("codex");
    const files = [dropped("/x/a.png", "image/png")];
    fireEvent.dragEnter(composer(), dt(files));
    fireEvent.dragEnter(screen.getByRole("textbox", { name: /message/i }), dt(files)); // crossing into a child
    fireEvent.dragLeave(composer(), dt(files));                                        // …and out of the parent
    expect(composer()).toHaveAttribute("data-dropping");
    fireEvent.dragLeave(composer(), dt(files));
    await waitFor(() => expect(composer()).not.toHaveAttribute("data-dropping"));
  });

  it("pasting an image attaches it — it has no path, so it is written out first", async () => {
    const { api } = await mountFor("claude");
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.paste(box, { clipboardData: { files: [pastedImage()], items: [{ kind: "file" }], getData: () => "" } });
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(api.calls).toContain("saveTempAttachment:image.png");
    expect(chips()[0]).toContain("image.png");
  });

  it("pasting plain text is still just a paste", async () => {
    await mountFor("claude");
    const box = screen.getByRole("textbox", { name: /message/i });
    const e = createEvent.paste(box, { clipboardData: { files: [], items: [], getData: () => "hello" } });
    fireEvent(box, e);
    expect(e.defaultPrevented).toBe(false);
    expect(chips()).toHaveLength(0);
  });

  it("attachments survive a pane remount, exactly like the draft they belong to", async () => {
    const { store, unmount } = await mountFor("codex", [picked("/x/a.png", "image/png")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(1));
    unmount();
    render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(chips()[0]).toContain("a.png");
  });

  it("with a deliverable attachment and no text the send button is LIVE — attachments carry the message (Plan 14 W5)", async () => {
    // Until Plan 14 W5 this asserted the opposite (`sessions.send` required non-empty text). The
    // relaxation is the plan's own: a Codex image rides as a localImage item with no text at all.
    await mountFor("codex", [picked("/x/a.png", "image/png")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(1));
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).not.toBeDisabled();
    expect(send).toHaveAttribute("title", "Send (⌘↵)");
  });

  it("shows no chip row and no notes with nothing attached", async () => {
    await mountFor("claude");
    expect(document.querySelector(".composer-attachments")).toBeNull();
    expect(notes()).toHaveLength(0);
  });
});

/**
 * The prompter's under-strip (Plan 12 W1): machine label + workspace selector hanging below the card.
 *
 * The named mutants these exist to kill: the selector sending the WRONG environment id; the selector
 * staying interactive after the session's first event; "New worktree…" creating without selecting.
 */
describe("under-strip (Plan 12 W1)", () => {
  const env = (id: string, extra: Partial<Environment> = {}): Environment =>
    ({ id, spaceId: "s1", path: `/tmp/${id}`, branch: null, kind: "checkout", portBlockStart: null, createdAt: 0, updatedAt: 0, ...extra });
  const twoEnvs = () => ({
    envA: env("envA", { kind: "primary", path: "/tmp" }),
    envB: env("envB", { kind: "worktree", branch: "realm/fix-tests", path: "/tmp/wt" }),
  });
  async function mountStrip(extra: { lastEventSeq?: number; lastSeq?: number } = {}) {
    const { envA, envB } = twoEnvs();
    const api = fakeApi({
      sessions: [session("se1", "s1", { status: "idle", environmentId: "envA", cwd: "/tmp", lastEventSeq: extra.lastEventSeq ?? 0 })],
      environments: { s1: [envA, envB] },
    });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: extra.lastSeq ?? 0, t: reduceAll([]) } } });
    const r = render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
    return { api, store, ...r };
  }

  it("shows the machine label as plain text — no button, no caret, no menu", async () => {
    await mountStrip();
    const strip = document.querySelector(".composer-understrip")!;
    expect(strip).toHaveTextContent("Carlton's M4 MacBook Pro");
    const label = within(strip as HTMLElement).getByText("Carlton's M4 MacBook Pro");
    expect(label.closest("button")).toBeNull(); // display only: Realm runs agents on this Mac, full stop
    expect(label.closest(".ghost-chip")).toHaveAttribute("data-static");
  });

  it("labels the workspace chip: space name for the primary, branch for a worktree", async () => {
    const { store } = await mountStrip();
    expect(screen.getByRole("button", { name: "Workspace" })).toHaveTextContent("Versed"); // primary = the space's name
    act(() => store.setState({ sessions: { se1: { ...store.getState().sessions.se1!, environmentId: "envB", cwd: "/tmp/wt" } } }));
    expect(screen.getByRole("button", { name: "Workspace" })).toHaveTextContent("realm/fix-tests");
  });

  it("selecting an environment sends EXACTLY that id and the chip re-labels from the server's answer", async () => {
    const { api } = await mountStrip();
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const menu = screen.getByRole("menu", { name: "Workspace" });
    // Both environments listed, the current one checked.
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Versed" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "realm/fix-tests" }));
    await waitFor(() => expect(api.calls).toContain("setSessionEnvironment:se1=envB"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Workspace" })).toHaveTextContent("realm/fix-tests"));
  });

  it("'New worktree…' creates AND selects — the session lands in the worktree it just made", async () => {
    const { api, store } = await mountStrip();
    store.getState().setDraft("se1", "polish the under strip");
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New worktree…" }));
    await waitFor(() => expect(api.calls).toContain("createWorktree:s1"));
    const made = api.data.environments.s1!.at(-1)!;
    expect(made.branch).toBe("realm/polish-the-under-strip"); // titled from the draft's first words
    await waitFor(() => expect(store.getState().sessions.se1?.environmentId).toBe(made.id));
    expect(api.calls).toContain(`setSessionEnvironment:se1=${made.id}`);
    await waitFor(() => expect(screen.getByRole("button", { name: "Workspace" })).toHaveTextContent(made.branch!));
  });

  it("after the first event the selector is display-only — a label, not a button (named mutant)", async () => {
    await mountStrip({ lastEventSeq: 3 });
    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
    const strip = document.querySelector(".composer-understrip")!;
    expect(strip).toHaveTextContent("Versed"); // still names where the session ran
    expect(within(strip as HTMLElement).getByTitle(/can only change before its first message/)).toHaveAttribute("data-static");
  });

  it("events known only to the transcript lock it too — the row's seq is not the only witness", async () => {
    await mountStrip({ lastSeq: 2 });
    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
  });

  it("the strip lives INSIDE the dock, so the hero→docked transform moves it with the card", async () => {
    await mountStrip();
    expect(document.querySelector(".composer-dock .composer-understrip")).not.toBeNull();
  });

  it("streaming does not take the strip away — Thinking… rides INSIDE it, machine and workspace stay", async () => {
    // Where a session runs is standing context: the strip must survive the status flip, and the
    // answer must not move under the cursor as "Thinking…" comes and goes.
    const { store } = await mountStrip();
    const strip = document.querySelector(".composer-understrip")!;
    expect(strip.querySelector(".composer-thinking")).toBeNull();
    act(() => store.getState().applySessionStatus("se1", "running"));
    expect(document.querySelector(".composer-understrip")).toBe(strip); // same node, not a re-mount
    expect(strip.querySelector(".composer-thinking")).toHaveTextContent("Thinking…");
    expect(strip).toHaveTextContent("Carlton's M4 MacBook Pro");
    expect(screen.getByRole("button", { name: "Workspace" }).closest(".composer-understrip")).toBe(strip);
  });
});

/**
 * The "+" menu (Plan 12 W1): Add files…/Add folder…/Skills/Connectors. The attach suite above already
 * proves Add files… reaches the same store action the bare button used to call; these cover the rest.
 */
describe("the '+' menu (Plan 12 W1)", () => {
  async function mountPlus(over: Parameters<typeof fakeApi>[0] = {}, agentKind: "fake" | "claude" = "claude") {
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind })],
      skills: { s1: [skillRow("mac"), skillRow("web")] }, ...over });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
    const r = render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
    // The library only loads for an agent skills can be injected into — the fake never fetches it.
    if (agentKind !== "fake") await waitFor(() => expect(api.calls).toContain("listSkills:s1"));
    return { api, store, ...r };
  }
  const openPlus = () => fireEvent.click(screen.getByRole("button", { name: "Add" }));

  it("Enter/Space open it too — it is a real button with menu semantics", async () => {
    await mountPlus();
    const btn = screen.getByRole("button", { name: "Add" });
    expect(btn).toHaveAttribute("aria-haspopup", "menu");
    expect(btn).toHaveAttribute("aria-expanded", "false");
    openPlus();
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Add" })).toBeInTheDocument();
  });

  it("carries no Plugins item — the plan refuses inventing one for menu parity", async () => {
    await mountPlus();
    openPlus();
    const menu = screen.getByRole("menu", { name: "Add" });
    expect(within(menu).queryByText(/plugin/i)).toBeNull();
    // And the full expected set, in order: files, folder, skills, connectors.
    const labels = within(menu).getAllByRole("menuitem").map((b) => b.textContent);
    expect(labels[0]).toContain("Add files…");
    expect(labels[0]).toContain("⌘U"); // the shortcut label rides the item
    expect(labels[1]).toContain("Add folder…");
    expect(labels[2]).toContain("Skills");
    expect(labels[3]).toContain("Connectors");
  });

  it("Add folder… runs the existing project-link flow", async () => {
    const { api } = await mountPlus();
    openPlus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Add folder…" }));
    // pickFolder resolves "/tmp/picked-repo" in the fake; the project lands in THIS space.
    await waitFor(() => expect(api.data.projects.s1?.map((p) => p.rootPath)).toEqual(["/tmp/picked-repo"]));
  });

  it("Skills opens the picker, which lists skills this space has NOT enabled — the whole point of it", async () => {
    // The old behaviour primed the @-mention popover, which can only ever offer what is already ON.
    // A machine with a hundred installed skills and two enabled would show two; the named mutant is
    // reverting to a source that filters by `enabled`.
    await mountPlus({ skills: { s1: [skillRow("mac"), externalSkillRow("agents.apple-design")] } });
    openPlus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Skills" }));
    const picker = await screen.findByRole("dialog", { name: "Skills" });
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("mac"), expect.stringContaining("agents.apple-design"),
    ]);
    // Grouped by where each came from, so "why is this here" is answered on the row.
    expect(within(picker).getByText("Realm library")).toBeInTheDocument();
    expect(within(picker).getByText("~/.agents/skills")).toBeInTheDocument();
  });

  it("the picker's search filters across id, name and description", async () => {
    await mountPlus({ skills: { s1: [skillRow("mac"), externalSkillRow("agents.apple-design")] } });
    openPlus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Skills" }));
    const picker = await screen.findByRole("dialog", { name: "Skills" });
    fireEvent.change(within(picker).getByRole("combobox", { name: "Search skills" }), { target: { value: "apple" } });
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("agents.apple-design")]);
  });

  it("picking a skill that is OFF turns it on for the space, then mentions it — a mention of a disabled skill resolves to nothing", async () => {
    const { api, store } = await mountPlus({ skills: { s1: [externalSkillRow("agents.apple-design")] } });
    openPlus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Skills" }));
    const picker = await screen.findByRole("dialog", { name: "Skills" });
    fireEvent.click(within(picker).getByRole("option", { name: /apple-design/ }));
    await waitFor(() => expect(api.calls).toContain("setSkillEnabled:s1:agents.apple-design=true"));
    expect(store.getState().drafts.se1).toBe("@agents.apple-design ");
  });

  it("the mention it inserts leads with a space on a word — @ glued to text is an email, not a mention", async () => {
    const { store } = await mountPlus();
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "use" } });
    openPlus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Skills" }));
    const picker = await screen.findByRole("dialog", { name: "Skills" });
    fireEvent.click(within(picker).getByRole("option", { name: /mac/ }));
    expect(store.getState().drafts.se1).toBe("use @mac ");
  });

  it("hides Skills for an agent Realm cannot inject skills into — no affordance that silently does nothing", async () => {
    await mountPlus({}, "fake");
    openPlus();
    const menu = screen.getByRole("menu", { name: "Add" });
    expect(within(menu).queryByRole("menuitem", { name: "Skills" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /Add files…/ })).toBeInTheDocument(); // the rest stays
  });
});

/**
 * The "+" menu's Connectors submenu (Plan 12 W1): the space's ENABLED MCP servers with a health dot
 * from the hub's LAST KNOWN status — pushed via mcp.serverStatus, cached in the store. Named mutant:
 * a dot showing a fixed status. Honesty rule: opening the menu reads rows, it never probes a server.
 */
describe("the '+' menu — Connectors (Plan 12 W1)", () => {
  async function mountConn(servers: Parameters<typeof mcpServer>[1][] = []) {
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "claude" })],
      mcpServers: servers.map((extra, i) => mcpServer(`m${i + 1}`, extra)) });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
    const r = render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
    return { api, store, ...r };
  }
  const openConnectors = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Connectors" }));
    await waitFor(() => expect(screen.getByRole("menu", { name: "Connectors" })).toBeInTheDocument());
    return screen.getByRole("menu", { name: "Connectors" });
  };

  it("opening the + menu refreshes the cache with a ROW read — no probe, no test, ever", async () => {
    const { api } = await mountConn([{ name: "linear", enabled: true }]);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.calls).toContain("listMcpServers:s1"));
    expect(api.calls.some((c) => c.startsWith("testMcpServer"))).toBe(false); // the named honesty rule
  });

  it("lists only ENABLED servers, dot + honest note per the hub's pushed status", async () => {
    const { store } = await mountConn([
      { name: "linear", enabled: true, status: "connected" },
      { name: "posthog", enabled: true, status: "idle" },
      { name: "broken", enabled: true, status: "circuit_open" },
      { name: "disabled-one", enabled: false, status: "connected" },
    ]);
    const menu = await openConnectors();
    await waitFor(() => expect(within(menu).queryByText("linear")).not.toBeNull());
    expect(within(menu).queryByText("disabled-one")).toBeNull(); // not enabled here → not offered
    const row = (name: string) => within(menu).getByText(name).closest(".connector-row") as HTMLElement;
    expect(row("linear").querySelector(".connector-dot")).toHaveAttribute("data-tone", "ok");
    // idle = the hub has never connected: say "not checked", never a green dot nobody earned.
    expect(row("posthog").querySelector(".connector-dot")).toHaveAttribute("data-tone", "muted");
    expect(row("posthog")).toHaveTextContent("not checked");
    expect(row("broken").querySelector(".connector-dot")).toHaveAttribute("data-tone", "warning");
    expect(row("broken")).toHaveTextContent("unavailable");
  });

  it("a live mcp.serverStatus push turns the dot while the menu is open — never a fixed status", async () => {
    const { store } = await mountConn([{ name: "linear", enabled: true, status: "idle" }]);
    const menu = await openConnectors();
    await waitFor(() => expect(within(menu).queryByText("linear")).not.toBeNull());
    const dot = () => (within(screen.getByRole("menu", { name: "Connectors" })).getByText("linear").closest(".connector-row") as HTMLElement).querySelector(".connector-dot");
    expect(dot()).toHaveAttribute("data-tone", "muted");
    act(() => store.getState().applyMcpServerStatus({ id: "m1", status: "connected", oauthStatus: "unconfigured" }));
    expect(dot()).toHaveAttribute("data-tone", "ok");
    act(() => store.getState().applyMcpServerStatus({ id: "m1", status: "error", oauthStatus: "unconfigured" }));
    expect(dot()).toHaveAttribute("data-tone", "warning");
  });

  it("an empty space says so, and Manage connections… opens the space settings' Connections tab", async () => {
    const { store } = await mountConn([]);
    const menu = await openConnectors();
    await waitFor(() => expect(within(menu).queryByText("No connectors enabled in this space")).not.toBeNull());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Manage connections…" }));
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "space-page" && i.refId === "s1")).toBe(true));
    expect(store.getState().spacePageTab.s1).toBe("connections");
  });

  it("the back row returns to the root menu in place", async () => {
    await mountConn([]);
    const menu = await openConnectors();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Connectors" })); // the ‹ header row
    await waitFor(() => expect(screen.getByRole("menu", { name: "Add" })).toBeInTheDocument());
  });
});
