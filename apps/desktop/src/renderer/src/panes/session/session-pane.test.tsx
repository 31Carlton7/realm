import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { PanelBar } from "../../components/PanelBar";
import { TerminalHub, setTerminalHubForTests, type HubTransport, type TerminalLike } from "../terminal-hub";
import { SessionMeta, SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";
import { renderMarkdown } from "./Markdown";
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
    fireEvent.keyDown(box, { key: "Enter" }); // plain Enter: newline, not send
    expect(sent).toEqual([]);
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(sent).toEqual(["next"]));
    expect((box as HTMLTextAreaElement).value).toBe("");
    // A non-empty transcript is the DOCKED prompter: no greeting, no suggestion grid.
    expect(document.querySelector(".session-pane")).toHaveAttribute("data-composer", "docked");
    expect(document.querySelector(".hero-greeting")).toBeNull();
    expect(document.querySelector(".suggestions")).toBeNull();
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
    expect(screen.getAllByText(/"command": "ls -la"/).length).toBeGreaterThanOrEqual(1); // tool body (and the permission card details)
    const card = tool.closest(".tool-card") as HTMLElement;
    expect(within(card).getByText(/"command": "ls -la"/).closest("pre")).toHaveClass("tool-well");
    expect(screen.getByLabelText("running")).toBeInTheDocument(); // no result yet while the session is live
  });

  it("empty transcript is the HERO prompter: greeting + titled/described suggestion chips; clicking one fills the composer without sending", async () => {
    const { api } = await mount("idle", reduceAll([]));
    const sent: string[] = []; api.sendMessage = async (_id, text) => { sent.push(text); };
    expect(document.querySelector(".session-pane")).toHaveAttribute("data-composer", "hero");
    const title = document.querySelector(".hero-greeting");
    expect(title).toHaveTextContent("What should we work on in Versed?");
    expect(title?.querySelector("em")).toHaveTextContent("Versed");
    const chip = screen.getByRole("button", { name: /Say hello/ }); // default mount() session is agentKind "fake"
    expect(chip.querySelector(".suggestion-title")).toHaveTextContent("Say hello");
    expect(chip.querySelector(".suggestion-desc")).toHaveTextContent("A quick round trip through the fake agent");
    fireEvent.click(chip);
    const box = screen.getByRole("textbox", { name: /message/i });
    expect((box as HTMLTextAreaElement).value).toBe("Hello!");
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
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Plan" }));
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("plan"));
    expect(chip).toHaveTextContent("Plan");
    expect(chip).not.toHaveAttribute("data-warning");
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
    expect(screen.getByText("▍")).toBeInTheDocument();
    // The morph: one button, stop face up, send face still mounted for the cross-fade (§6).
    const morph = screen.getByRole("button", { name: "Stop" });
    expect(morph).toHaveAttribute("data-state", "stop");
    expect(morph.querySelector(".send-icon")).not.toBeNull();
    expect(morph.querySelector(".stop-icon")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull(); // it IS the same button, relabeled
    fireEvent.click(morph);
    await waitFor(() => expect(api.calls).toContain("interrupt:se1"));
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Plan" }));
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("plan"));
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Fake" }));
    await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("fake"));
    expect(store.getState().sessions.se1?.effort).toBeNull(); // model menu set model, not effort
  });

  it("Send is disabled with an empty draft while idle; effort menu sets the effort option", async () => {
    const { store } = await mount("idle", reduceAll([]));
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("data-state", "send");
    const effort = screen.getByRole("button", { name: "Effort" });
    expect(effort).toHaveTextContent("Effort"); // placeholder while effort is null
    fireEvent.click(effort);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "high" }));
    await waitFor(() => expect(store.getState().sessions.se1?.effort).toBe("high"));
    expect(store.getState().sessions.se1?.model).toBeNull(); // effort menu set effort, not model
    expect(effort).toHaveTextContent("high");
  });

  it("model chip shows DEFAULT_MODEL_LABEL for the kind while session.model is null, and the chosen model after", async () => {
    const { store } = await mount("idle", reduceAll([]));
    const chip = screen.getByRole("button", { name: "Model" });
    expect(chip).toHaveTextContent("Fake agent · Fake"); // AGENT_META label + DEFAULT_MODEL_LABEL.fake
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Fake" }));
    await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("fake"));
    expect(chip).toHaveTextContent("Fake agent · Fake"); // AGENT_MODELS label for the picked id
  });

  it("a kind with no pickable models still names itself: static model chip with the frontier default, no menu", async () => {
    await mountKind("codex");
    // Nothing to pick, so it is a LABEL, not a disabled control: readable, out of the way of the tab
    // order, and never announced as "unavailable" when naming the model is its entire job.
    const chip = document.querySelector('.ghost-chip[data-static][title="Model"]');
    expect(chip).toHaveTextContent("Codex · GPT-5.6");
    expect(chip!.tagName).toBe("SPAN");
    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
  });

  it("the cwd context chip truncates with an ellipsis label and carries the full path as its title", async () => {
    await mount("idle", reduceAll([]));
    const chip = document.querySelector(".composer-context .composer-chip");
    expect(chip).toHaveAttribute("title", "/tmp"); // the fake session's cwd
    expect(chip!.querySelector(".chip-label")).not.toBeNull();
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
    expect(screen.getByRole("button", { name: "Effort" })).toBeInTheDocument(); // the rest of the bar is untouched
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

  it("Enter=Allow, ⇧Enter=Always, ⌘⌫=Deny — and buttons carry visible kbd hints", async () => {
    const { decided, card } = await mountFocused(true);
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(card, { key: "Backspace", metaKey: true });
    await waitFor(() => expect(decided).toEqual(["r1:allow", "r1:allow_always", "r1:deny"]));
    expect(screen.getByRole("button", { name: "Allow" }).querySelector("kbd")).toHaveTextContent("⏎");
    expect(screen.getByRole("button", { name: "Deny" }).querySelector("kbd")).toHaveTextContent("⌘⌫");
    expect(screen.getByRole("button", { name: "Allow always" }).querySelector("kbd")).toHaveTextContent("⇧⏎");
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
    const summary = screen.getByText("Input");
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

  it("renders branch + diff + dirty chips from store gitInfo for the session's cwd", async () => {
    await mountWithGit(gi({ branch: "feat/x", additions: 12, deletions: 3, dirty: 4 }));
    expect(document.querySelector(".composer-context .git-branch")).toHaveTextContent("feat/x");
    expect(document.querySelector(".git-diff .diff-add")).toHaveTextContent("+12");
    expect(document.querySelector(".git-diff .diff-del")).toHaveTextContent("−3");
    expect(document.querySelector(".git-dirty")).toHaveTextContent("4 changed");
    expect(document.querySelector(".composer-context .composer-chip")).toBeInTheDocument(); // cwd chip lives here too
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
    expect(document.querySelector(".composer-context .composer-chip")).toBeInTheDocument(); // cwd chip survives
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

  it("shows the model label, status dot, and cost once costUsd > 0", () => {
    mountMeta({ model: "fake-xl", status: "waiting_permission", costUsd: 0.5, numTurns: 3 });
    expect(screen.getByText("fake-xl")).toBeInTheDocument();
    expect(screen.getByLabelText("Status: Needs permission")).toHaveAttribute("data-status", "waiting_permission");
    expect(screen.getByText("$0.50 · 3 turns")).toBeInTheDocument();
  });

  it("renders no cost while costUsd is 0, even after turns", () => {
    mountMeta({ model: "fake-xl", costUsd: 0, numTurns: 3 });
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.getByText("fake-xl")).toBeInTheDocument(); // the rest of the meta still renders
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

/** Mounts the prompter for a session that has not run yet (no events anywhere), plus overrides. */
async function mountFresh(extra: Partial<Parameters<typeof session>[2]> = {}, lastSeq = 0) {
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "claude", ...extra })] });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq, t: reduceAll([]) } } });
  const r = render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "Claude session" })} visible /></StoreContext.Provider>);
  return { api, store, ...r };
}

describe("prompter agent chip (W3)", () => {
  it("switches the agent on an unstarted session and drops the old kind's model", async () => {
    const { api, store } = await mountFresh({ model: "claude-opus-5" });
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude · Claude Opus 5");
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Codex" }));
    await waitFor(() => expect(store.getState().sessions.se1?.agentKind).toBe("codex"));
    expect(api.calls).toContain("setSessionAgent:se1=codex");
    // A claude model id means nothing to Codex: the chip falls back to Codex's frontier default label.
    expect(store.getState().sessions.se1?.model).toBeNull();
    expect(document.querySelector('.ghost-chip[title="Model"]')).toHaveTextContent("Codex · GPT-5.6");
  });

  it("offers every selectable kind, with the current one checked", async () => {
    await mountFresh();
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getAllByRole("menuitemcheckbox").map((n) => n.textContent)).toEqual(["Claude", "Codex", "Cursor"]);
    expect(screen.getByRole("menuitemcheckbox", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
  });

  it("never hides a session's own kind, even one that is not offered fresh", async () => {
    // `fake` is the dev adapter and absent from SELECTABLE_AGENT_KINDS; a fake session that could not
    // see itself would show a menu with no checkmark anywhere.
    await mountFresh({ agentKind: "fake" });
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getAllByRole("menuitemcheckbox").map((n) => n.textContent)).toEqual(["Fake agent", "Claude", "Codex", "Cursor"]);
    expect(screen.getByRole("menuitemcheckbox", { name: "Fake agent" })).toHaveAttribute("aria-checked", "true");
  });

  it("goes static the moment the session has an event — the affordance is gone before the server would refuse", async () => {
    // A transcript that has already reduced one event locks it…
    const { store } = await mountFresh({}, 1);
    expect(screen.queryByRole("button", { name: "Agent" })).toBeNull();
    expect(document.querySelector('.ghost-chip[data-static][title^="Agent:"]')!.tagName).toBe("SPAN");
    // …and so does a live event arriving into an open, still-switchable prompter.
    store.setState({ transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Agent" })).toBeInTheDocument());
    act(() => store.getState().applySessionEvent({ seq: 7, sessionId: "se1", ephemeral: false, event: sessionEvent("user_message", { text: "hi", attachments: [] }) }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Agent" })).toBeNull());
  });

  it("a session whose row already carries events is locked even before its transcript loads", async () => {
    // lastEventSeq comes back with sessions.list; the transcript is fetched afterwards. Trusting only
    // the transcript would flash a live agent picker on every revisit of a long-running session.
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "claude", lastEventSeq: 12 })] });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" } });
    render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "Claude session" })} visible /></StoreContext.Provider>);
    await waitFor(() => expect(document.querySelector('.ghost-chip[title^="Agent:"]')).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Agent" })).toBeNull();
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
        <PanelBar item={sessionItem} onSplit={() => {}} onClose={() => {}} />
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

  it("a terminal item's header has no such toggle — only sessions own one", () => {
    const api = fakeApi();
    const store = createAppStore(api);
    render(<StoreContext.Provider value={store}><PanelBar item={item("i1", "s1", { kind: "terminal", title: "zsh" })} onSplit={() => {}} onClose={() => {}} /></StoreContext.Provider>);
    expect(screen.queryByRole("button", { name: /terminal for zsh/ })).toBeNull();
  });
});
