import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, createEvent, waitFor, act, within, cleanup } from "@testing-library/react";
import { AGENT_CLI_COMMANDS, AGENT_NOTES, MODEL_NOTES, canonicalModelKey, sessionEvent, type CliStatus, type Environment } from "@realm/contracts";
import { spaceColor } from "@realm/ui";
import { StoreContext, createAppStore, type AgentProbe } from "../../state/store";
import { fakeApi, item, mcpServer, session, skillRow, externalSkillRow, space } from "../../state/store.test-fakes";
import { PanelBar } from "../../components/PanelBar";
import { TerminalHub, setTerminalHubForTests, type HubTransport, type TerminalLike } from "../terminal-hub";
import { SessionMeta, SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";
import { EGG_RUN_LABELS, runLabelFor } from "./run-label";
import { Markdown, renderMarkdown } from "./Markdown";
import { toolSummary } from "./tool-summary";
import { exited } from "../../components/popover-exit.test-fakes";

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
    fireEvent.keyDown(box, { key: "Enter" }); // plain Enter sends by default (Settings ▸ General: "Enter")
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

  it("Settings ▸ General can switch back to ⌘/Ctrl+Enter-to-send, where plain Enter is a newline again", async () => {
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

  it("empty transcript is the HERO prompter: a greeting and the card, and nothing else", async () => {
    const { store } = await mount("idle", reduceAll([]));
    expect(document.querySelector(".session-pane")).toHaveAttribute("data-composer", "hero");
    const title = document.querySelector(".hero-greeting");
    // One line out of greeting.ts's pool, picked from the session id — never "what should we build",
    // since a space is as often a course as a repo.
    expect(title).toHaveTextContent("What's on your mind in Versed?");
    // The space's name is the line's link to the space's page now, not an emphasised word.
    expect(title?.querySelector("button.hero-greeting-place")).toHaveTextContent("Versed");
    // The name from `system.info` reaches the greeting: without one, the pool it draws from is the
    // smaller, name-less half, so the same session lands on a different line.
    act(() => store.setState({ userName: "" }));
    expect(document.querySelector(".hero-greeting")).toHaveTextContent("What are we working on in Versed?");
    act(() => store.setState({ userName: "Carlton" }));
    // The starter chips are gone: four stock sentences under a box whose own placeholder already
    // offers a session-specific one read as the app asking twice.
    expect(document.querySelector(".suggestions")).toBeNull();
    expect(document.querySelectorAll(".suggestion-chip")).toHaveLength(0);
    // And the placeholder no longer names the engine — what you can ask does not depend on it.
    expect(screen.getByRole("textbox", { name: /message/i })).toHaveAttribute("placeholder", "Ask anything");
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
    await exited();
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

  it("the permission control is a glyph and a word — each rung its own shield, worn by its menu row too, and no chevron", async () => {
    const { store } = await mount("idle", reduceAll([]));
    const chip = screen.getByRole("button", { name: "Permission mode" });
    const glyph = () => chip.querySelector("svg")?.innerHTML;
    // Codex's grammar: the mark and the label, nothing after them (the fill is styles.test.ts's half).
    expect(chip.querySelector(".chip-caret")).toBeNull();
    expect(chip.querySelectorAll("svg")).toHaveLength(1);
    fireEvent.click(chip);
    const rows = within(screen.getByRole("menu", { name: "Permission mode" })).getAllByRole("menuitemcheckbox");
    expect(rows.map((r) => r.textContent)).toEqual(["Ask each time", "Accept edits", "Full access"]);
    const marks = rows.map((r) => r.querySelector(".menu-icon svg")?.innerHTML);
    // THE mutant: one shared shield for every rung. Three rungs read as three marks or not at all.
    expect(marks.every(Boolean)).toBe(true);
    expect(new Set(marks).size).toBe(3);
    // The control wears the checked row's mark — what you pick is what it then shows.
    expect(glyph()).toBe(marks[0]);
    fireEvent.click(rows[1]!);
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("acceptEdits"));
    expect(glyph()).toBe(marks[1]);
    // Full access, reached through its confirm, wears the warning shield and the warning tone.
    await exited();
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Full access" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow everything? Confirm" }));
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("bypassPermissions"));
    expect(glyph()).toBe(marks[2]);
    expect(chip).toHaveAttribute("data-warning");
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
    fireEvent.click(screen.getByRole("option", { name: "Fake" }));
    await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("fake"));
    expect(store.getState().sessions.se1?.effort).toBeNull(); // the picker set model, not effort
  });

  it("Send is disabled with an empty draft while idle; the picker's effort track sets the effort option", async () => {
    // Effort is edited on the track in the picker's foot and worn by the chip as a grey suffix: the
    // edit applies via setSessionOptions with the `effort` key and touches nothing else. Unset, the
    // chip wears the level the turn runs at anyway — the model's default. A Claude session, because
    // Claude's adapter hands the level on.
    const { store } = await mountFresh();
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("data-state", "send");
    expect(screen.queryByRole("button", { name: "Effort" })).toBeNull(); // the chip is gone
    expect(document.querySelector(".model-chip .chip-effort")).toHaveTextContent("High"); // the default in force
    openPicker();
    const track = screen.getByRole("slider", { name: "Effort" });
    expect(track).toHaveAttribute("aria-valuetext", "High");
    expect(track).not.toHaveAttribute("data-effort"); // nothing chosen yet
    expect(screen.queryByRole("button", { name: "Reset effort" })).toBeNull(); // nothing to reset
    fireEvent.keyDown(track, { key: "ArrowLeft" });
    await waitFor(() => expect(store.getState().sessions.se1?.effort).toBe("medium"));
    expect(store.getState().sessions.se1?.model).toBeNull(); // the effort edit set effort, not model
    expect(store.getState().sessions.se1?.permissionMode).toBe("default"); // …and not permission either
    // A setting on the surface you are looking at: the track answers, and the picker stays open for
    // the model that may be next. Only picking a model closes it.
    await waitFor(() => expect(track).toHaveAttribute("aria-valuetext", "Medium"));
    expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument();
    expect(document.querySelector(".model-chip .chip-effort")).toHaveTextContent("Medium"); // the suffix wears it
    // The reset hands the level back to the model: no level of Realm's at all, not "high" by name.
    fireEvent.click(screen.getByRole("button", { name: "Reset effort" }));
    await waitFor(() => expect(store.getState().sessions.se1?.effort).toBeNull());
    await waitFor(() => expect(track).toHaveAttribute("aria-valuetext", "High"));
  });

  it("model chip shows DEFAULT_MODEL_LABEL for the kind while session.model is null, and the chosen model after", async () => {
    const { store } = await mount("idle", reduceAll([]));
    const chip = screen.getByRole("button", { name: "Model" });
    expect(chip).toHaveTextContent("Fake"); // DEFAULT_MODEL_LABEL.fake
    // The chip wears the agent's mark again (prompter rework) — but `fake` has no vendor, so its
    // glyph is the generic Hugeicons bot, never a brand mark.
    expect(chip.querySelector("[data-brand]")).toBeNull();
    openPicker();
    fireEvent.click(screen.getByRole("option", { name: "Fake" }));
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
    // The session's own agent leads under its own name, even with only its default to offer.
    expect(row.closest("[role=group]")).toHaveAttribute("aria-label", "Codex");
    expect(row).toHaveAttribute("aria-selected", "true");
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

  it("names a scheduled run's task above its first message, and keeps the note Realm added for the agent out of the bubble", async () => {
    const note = "(Scheduled task \"Morning triage\". Nobody is watching this run: end with a short report.)";
    const goal = "Read the new issues and group them by area.";
    await mount("idle", reduceAll([
      sessionEvent("user_message", { text: `${goal}\n\n${note}`, attachments: [], scheduled: { task: "Morning triage", note } }),
      // A run that stopped to ask, answered: the reply after the note is the person's, and stays.
      sessionEvent("user_message", { text: `${goal}\n\n${note}\n\nThe person supervising this run replied:\n\nUse the backlog.`, attachments: [], scheduled: { task: "Morning triage", note } }),
    ]));
    const [first, resumed] = [...document.querySelectorAll(".msg-user-row")];
    // THE mutants: draw the event's text as it was handed to the agent (the bubble ends in "Nobody is
    // watching this run…"), or drop the line that says the clock sent it.
    expect(first!.querySelector(".msg-user")!.textContent).toBe(goal);
    expect(first!.querySelector(".msg-user-from")).toHaveTextContent("Scheduled run · Morning triage");
    // The note is still the agent's to read, and the person's to find: under the pointer on that line.
    expect(first!.querySelector(".msg-user-from")).toHaveAttribute("title", note);
    // The person's own words: no "from another session" ring.
    expect(first!.hasAttribute("data-from")).toBe(false);
    expect(resumed!.querySelector(".msg-user")!.textContent).toBe(`${goal}\n\nThe person supervising this run replied:\n\nUse the backlog.`);
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

  it("puts the command that fixes an auth failure under the message that reports it", async () => {
    // The screenshot this came from: a red block saying the OAuth session expired, and nothing at
    // all to do about it. The command is offered to COPY and no more — "Check again" and "Open in
    // terminal" act on the session, and those live on the prompter.
    await mount("idle", reduceAll([
      sessionEvent("error", {
        message: "Claude could not authenticate. Claude reports that it is signed in.",
        failure: "auth",
        fix: { title: "Claude could not authenticate", hint: "…", command: "claude auth login" },
      }),
    ]));
    expect(screen.getByRole("alert")).toHaveTextContent("could not authenticate");
    expect(screen.getByText("claude auth login")).toBeInTheDocument();
    expect(screen.getByLabelText("Copy command")).toBeInTheDocument();
  });

  it("leaves an ordinary error exactly as bare as it was", async () => {
    // The mutant this catches: render the fix row unconditionally. Every error in the app grows an
    // empty command frame, and most errors have no fix to offer.
    await mount("idle", reduceAll([sessionEvent("error", { message: "TypeError: x is not a function" })]));
    expect(screen.getByRole("alert")).toHaveTextContent("TypeError");
    expect(screen.queryByLabelText("Copy command")).toBeNull();
  });

  it("says what a re-auth wait is waiting on, rather than just 'Retrying'", async () => {
    // Under a message that just said the session expired, a bare "Retrying…" reads as Realm having
    // ignored it. Realm re-read the agent's sign-in and found it sound; that is the fact that makes
    // another attempt sensible, so it is the one on screen.
    await mount("running", reduceAll([
      sessionEvent("error", { message: "OAuth session expired", failure: "auth" }),
      sessionEvent("retrying", { reason: "auth", attempt: 1, waitMs: 2000 }),
    ]));
    expect(screen.getByText(/Signed in — trying again/)).toBeInTheDocument();
  });

  it("carries the easter-egg switch to the two places in the pane that can wear it", async () => {
    // THE unwired-flag mutant: leave `easterEggs` on the store and never read it here. Every unit
    // below this passes — the label function takes the flag, the picker takes the prop — and the
    // switch in Settings does nothing at all.
    const started = 1_756_900_000_000; // a start time the second roll lands a friend's name on
    const { store } = await mount("running", reduceAll([]));
    await act(async () => {
      store.setState({ easterEggs: true, transcripts: { se1: { lastSeq: 0, t: { ...reduceAll([]), run: { startedAt: started, waitedMs: 0, waitingSince: null } } } } });
    });
    const named = runLabelFor(started, undefined, true);
    expect(EGG_RUN_LABELS).toContain(named);
    expect(document.querySelector(".msg-working")!.textContent).toBe(`${named.present}…`);
    // And the gradient's one attribute: every rule for it hangs off this, so its absence is the
    // whole feature's absence.
    openPicker();
    expect(document.querySelector(".model-picker")).toHaveAttribute("data-eggs");
  });

  it("says nothing unusual with the switch off, which is what everyone gets by default", async () => {
    const started = 1_756_900_000_000;
    const { store } = await mount("running", reduceAll([]));
    await act(async () => {
      store.setState({ transcripts: { se1: { lastSeq: 0, t: { ...reduceAll([]), run: { startedAt: started, waitedMs: 0, waitingSince: null } } } } });
    });
    expect(store.getState().easterEggs).toBe(false);
    expect(document.querySelector(".msg-working")!.textContent).toBe(`${runLabelFor(started).present}…`);
    openPicker();
    expect(document.querySelector(".model-picker")).not.toHaveAttribute("data-eggs");
  });

  it("offers the composer permission picker only for agents whose permission model Realm controls", async () => {
    const codex = await mountKind("codex");
    expect(screen.getByRole("button", { name: "Permission mode" })).toBeInTheDocument();
    codex.unmount();
    // AcpAdapter never transmits Realm's mode ids, so the picker would silently do nothing for an ACP agent.
    await mountKind("acp:cursor");
    expect(screen.queryByRole("button", { name: "Permission mode" })).toBeNull();
    // The model chip still opens the picker — with no effort track, because this Cursor offers no
    // thought_level option to hand a level to (it writes effort into its own model ids), and a control
    // wired to nothing is the thing the per-kind tables exist to prevent.
    openPicker();
    expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Effort" })).toBeNull();
  });
});

describe("reading a session by opening it", () => {
  /* The unread ring — and the session's row in every list of what needs you — stays until the session
     is read. Watching events arrive in the focused pane stamps them; this is the other half: what was
     already there when the pane got the keyboard. THE MUTANT is the old rule alone, where a session
     opened to read its news kept the ring until it said something new. */
  const mountAt = async (focused: boolean) => {
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", seenSeq: 2, lastEventSeq: 4 })] });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessions: { se1: { ...store.getState().sessions["se1"]!, seenSeq: 2, lastEventSeq: 4 } },
      sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 4, t: seeded() } } });
    const pane = (f: boolean) => <StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible focused={f} /></StoreContext.Provider>;
    const r = render(pane(focused));
    return { api, store, rerender: (f: boolean) => r.rerender(pane(f)) };
  };

  it("the focused pane reads what it holds", async () => {
    const { api, store } = await mountAt(true);
    await waitFor(() => expect(api.calls).toContain("markSessionSeen:se1@4"));
    expect(store.getState().sessions["se1"]!.seenSeq).toBe(4);
  });

  it("a pane without the keyboard reads nothing — until it gets it", async () => {
    const { api, store, rerender } = await mountAt(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(api.calls.some((c) => c.startsWith("markSessionSeen"))).toBe(false);
    expect(store.getState().sessions["se1"]!.seenSeq).toBe(2);
    rerender(true);
    await waitFor(() => expect(api.calls).toContain("markSessionSeen:se1@4"));
  });

  it("a focused pane in a window nobody is looking at reads nothing — until the window comes back", async () => {
    // THE MUTANTS: the effect without `windowActive` in its condition (it reads behind another app), or
    // without it in its dependencies (coming back never reads, and the dot stays on a session on screen).
    const { api, store, rerender } = await mountAt(false);
    act(() => store.getState().setWindowActive(false));
    rerender(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(api.calls.some((c) => c.startsWith("markSessionSeen"))).toBe(false);
    act(() => store.getState().setWindowActive(true));
    await waitFor(() => expect(api.calls).toContain("markSessionSeen:se1@4"));
  });
});

describe("opened from a list, the session takes the keyboard", () => {
  /* A session opened from the Active rows, another room's list or a notification lands with the
     keyboard in it, so the hand that clicked can type. THE MUTANTS: never take it (the caret stays on
     a sidebar row, or on nothing once that row is gone), or take it over a permission card that has
     already claimed it for the answer it needs. */
  const mountWith = async (status: "idle" | "waiting_permission", focused = true) => {
    const api = fakeApi({ sessions: [session("se1", "s1", { status })] });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: status }, transcripts: { se1: { lastSeq: 4, t: seeded() } } });
    render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible focused={focused} /></StoreContext.Provider>);
    return { store, ask: () => act(() => store.setState({ keyboardFor: { sessionId: "se1", n: (store.getState().keyboardFor?.n ?? 0) + 1 } })) };
  };

  it("lands in the prompter", async () => {
    const { ask } = await mountWith("idle");
    expect(document.activeElement).toBe(document.body);
    ask();
    await waitFor(() => expect(document.activeElement).toHaveClass("composer-input"));
  });

  it("a permission card waiting for an answer keeps it", async () => {
    const { ask } = await mountWith("waiting_permission");
    await waitFor(() => expect(document.activeElement?.closest(".permission-card")).not.toBeNull());
    ask();
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement?.closest(".permission-card")).not.toBeNull();
  });

  it("takes the keyboard once: the request is spent, so a remount never pulls the caret back", async () => {
    const { store, ask } = await mountWith("idle");
    ask();
    await waitFor(() => expect(document.activeElement).toHaveClass("composer-input"));
    expect(store.getState().keyboardFor).toBeNull();
  });

  it("a pane without the keyboard takes nothing, and a request for another session is not this one's", async () => {
    const { store, ask } = await mountWith("idle", false);
    ask();
    act(() => store.setState({ keyboardFor: { sessionId: "other", n: 9 } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement).toBe(document.body);
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

describe("the prompter wears its mode", () => {
  const card = () => document.querySelector(".composer")!;

  it("is neutral in Build and tinted in the two read-only modes", async () => {
    // Ask and Plan both mean "the agent will not change anything on disk", which is the most
    // consequential fact about the next send. Build is the default; a colour that is always on says
    // nothing, so it stays exactly as it was.
    const { store } = await mountFresh();
    expect(card()).toHaveAttribute("data-mode", "build");
    act(() => store.setState({ sessions: { ...store.getState().sessions, se1: { ...store.getState().sessions.se1!, permissionMode: "plan" } } }));
    expect(card()).toHaveAttribute("data-mode", "plan");
  });

  it("says the mode in WORDS too — the colour is never the only telling", async () => {
    const { store } = await mountFresh();
    act(() => store.setState({ sessions: { ...store.getState().sessions, se1: { ...store.getState().sessions.se1!, permissionMode: "plan" } } }));
    // In the "+" menu rather than on the row. The card's tint is still the ambient signal; this is
    // the place the mode is spelled out, and the only place Build — which has no tint — is.
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const modes = within(screen.getByRole("menu", { name: "Add" })).getByRole("group", { name: "Mode" });
    expect(within(modes).getByRole("menuitemcheckbox", { checked: true })).toHaveAccessibleName("Plan");
  });
});

describe("the prompter's / commands", () => {
  const box = () => screen.getByRole("textbox", { name: /message/i });
  const type = (text: string) => fireEvent.change(box(), { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
  const rows = () => [...document.querySelectorAll(".slash-row .mention-row-id")].map((n) => n.textContent);

  it("opens on a slash at the start of the draft, and never mid-sentence", async () => {
    // A slash is a path separator, a division sign and half of every URL. The picker firing inside
    // `src/renderer` while someone described a file is the failure the position-0 rule prevents.
    await mountFresh();
    type("/");
    expect(document.querySelector(".slash-picker")).not.toBeNull();
    type("look in src/renderer");
    expect(document.querySelector(".slash-picker")).toBeNull();
  });

  it("runs on Enter and takes its own token out of the draft", async () => {
    // The command RUNS; nothing about it is transmitted. That is the whole difference between this
    // picker and the @-mention beside it, so a send must not follow.
    const { api } = await mountFresh();
    const saveText = vi.fn().mockResolvedValue("/tmp/out.md");
    vi.stubGlobal("window", Object.assign(window, { realm: { ...(window as never as { realm?: object }).realm, saveText } }));
    try {
      type("/export");
      fireEvent.keyDown(box(), { key: "Enter" });
      await waitFor(() => expect(saveText).toHaveBeenCalledTimes(1));
      expect(saveText.mock.calls[0]![0].name).toMatch(/\.md$/);
      expect(api.sent).toEqual([]);
      expect(box()).toHaveValue("");
    } finally { vi.unstubAllGlobals(); }
  });

  it("Escape puts the picker away and leaves the draft alone", async () => {
    await mountFresh();
    type("/exp");
    // The popover hook arms its Escape listener on a deferred tick after IT mounts; settle that first.
    await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(document.querySelector(".slash-picker")).toBeNull();
    expect(box()).toHaveValue("/exp");
    // A fresh slash reopens it — the dismissal is about the token, not about the session.
    type("");
    type("/exp");
    expect(document.querySelector(".slash-picker")).not.toBeNull();
  });

  it("offers nothing it cannot do — /diff is absent while the session has no loaded checkout", async () => {
    // A command that could only no-op is worse in a picker than on a toolbar: the user typed its
    // name expecting it to work.
    await mountFresh();
    type("/");
    expect(rows()).not.toContain("/diff");
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

  it("renders branch + diff + dirty chips from store gitInfo for the session's cwd, in the OVER-strip", async () => {
    await mountWithGit(gi({ branch: "feat/x", additions: 12, deletions: 3, dirty: 4 }));
    // The branch group has a strip of its own above the card. It is neither on the control row (where
    // it competed for width with everything that changes the next send) nor in the row of workspace
    // chips under the prompter (where a number that moves every time the agent writes a file sat
    // among labels that never move). All three places are asserted, so a group that ended up in two
    // of them fails rather than passing on the one that was looked for.
    expect(document.querySelector(".composer-overstrip .git-branch")).toHaveTextContent("feat/x");
    expect(document.querySelector(".composer-opts .composer-git")).toBeNull();
    expect(document.querySelector(".composer-understrip .composer-git")).toBeNull();
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
    // Including the strip itself: an empty tab above the prompter is a claim on space with nothing
    // to put in it, and it would still push the card down by its own height.
    expect(document.querySelector(".composer-overstrip")).toBeNull();
    expect(document.querySelector(".git-branch")).toBeNull();
    expect(document.querySelector(".git-diff")).toBeNull();
    expect(document.querySelector(".git-dirty")).toBeNull();
    expect(document.querySelector(".composer-opts")).not.toBeNull(); // the row itself still renders
  });
});

describe("control-row rework (prompter rework atop Ara refresh §3)", () => {
  it("left group runs '+' · permission, in that DOM order and nothing else", async () => {
    // The user's row: attach leads, the permission chip sits against it. The branch group moved off
    // it, onto a strip of its own above the card; the cwd, environment and effort chips are gone
    // outright. An extra child here is a regression.
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "claude" })] });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } },
      gitInfo: { "/tmp": { branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0 } } });
    render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
    const opts = document.querySelector(".composer-opts")!;
    const children = Array.from(opts.children);
    expect(children[0]).toBe(screen.getByRole("button", { name: "Add" })); // the "+" — now a menu (Plan 12 W1)
    /* One chip, not a group. The session mode moved into the "+" menu, and with it the reason these
       two were drawn as a segmented control — so the permission chip is a direct child of the row
       wearing the same corner every other chip in it has. An extra child, or a re-introduced
       wrapper, is what this catches. */
    expect(children[1]).toBe(screen.getByRole("button", { name: "Permission mode" }));
    expect(children).toHaveLength(2);
    expect(children[1]).not.toHaveClass("chip-group");
    expect(document.querySelector(".chip-group")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mode" })).toBeNull();
    for (const c of children) expect(c).toHaveAttribute("aria-haspopup", "menu");
    // The branch group is off the row and above the card, on its own strip.
    expect(document.querySelector(".composer-overstrip .composer-git")).not.toBeNull();
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

  it("wears no effort on the chip of a model its harness lists no levels for", async () => {
    // A Codex session can hold a level set under Claude before the switch. Codex is handed a level
    // only where its own catalog lists it for the model, so with no catalog a suffix would claim a
    // setting nothing is applying.
    await mountFresh({ agentKind: "codex", effort: "high" });
    const chip = screen.getByRole("button", { name: "Model" });
    expect(chip.querySelector(".chip-effort")).toBeNull();
    expect(chip.getAttribute("title")).not.toContain("effort");
    openPicker();
    expect(screen.queryByRole("slider", { name: "Effort" })).toBeNull();
  });

  it("gives a Codex model the levels its own catalog lists, from its own default", async () => {
    const probe: AgentProbe[] = [{ kind: "codex", available: true, version: "0.154.0", loggedIn: true, reason: null,
      models: [
        { id: "gpt-sol", label: "GPT-Sol", isDefault: true, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
        { id: "gpt-terra", label: "GPT-Terra", efforts: ["low", "high"], defaultEffort: "high" },
      ] }];
    const { store } = await mountFresh({ agentKind: "codex" }, 0, probe);
    await waitFor(() => expect(document.querySelector(".model-chip .chip-effort")).toHaveTextContent("Medium"));
    openPicker();
    const track = screen.getByRole("slider", { name: "Effort" });
    expect(track).toHaveAttribute("aria-valuemax", "3"); // four levels, a dot each
    expect(track).toHaveAttribute("aria-valuetext", "Medium");
    fireEvent.keyDown(track, { key: "End" });
    await waitFor(() => expect(store.getState().sessions.se1?.effort).toBe("xhigh"));
    // Another model, its own levels: a level it does not list is shown as its default, not kept.
    await act(async () => { await store.getState().setSessionOptions("se1", { model: "gpt-terra" }); });
    await waitFor(() => expect(screen.getByRole("slider", { name: "Effort" })).toHaveAttribute("aria-valuemax", "1"));
    expect(screen.getByRole("slider", { name: "Effort" })).toHaveAttribute("aria-valuetext", "High");
  });

  it("the gray suffix shows the SESSION's effort, capitalised (`xhigh` → XHigh), and the model's default when unset", async () => {
    const a = await mountFresh({ effort: "xhigh" });
    expect(document.querySelector(".model-chip .chip-effort")).toHaveTextContent("XHigh");
    a.unmount();
    const b = await mountFresh({ effort: "max" }); // another level renders ITS word, not a fixed one
    expect(document.querySelector(".model-chip .chip-effort")).toHaveTextContent("Max");
    b.unmount();
    await mountFresh();
    expect(document.querySelector(".model-chip .chip-effort")).toHaveTextContent("High");
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
      await exited();
      // A setting on the picker's card like the rest: choosing it leaves the picker open.
      expect(screen.getByRole("dialog", { name: "Model picker" })).not.toHaveAttribute("data-closing");
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

    it("a row that fits keeps the permission chip; the menu carries only its permanent effort track", async () => {
      stageWidths(400, 500);
      await mountFresh();
      expect(screen.getByRole("button", { name: "Permission mode" })).toBeInTheDocument();
      openPicker();
      expect(screen.getByRole("slider", { name: "Effort" })).toBeInTheDocument(); // permanent, not overflow
      expect(screen.queryByRole("group", { name: "Permissions" })).toBeNull();
    });
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

  it("shows the status dot, and nothing else", () => {
    /* The meta slot has been emptied down to the dot in three passes now, and this is the last one:
       the model went (the prompter's chip names it properly, where this printed whatever raw id the
       harness pinned), the turn count went (never a question a header answers), and the cost has
       moved onto the summary button — which is where the rest of what a session produced already
       lives, and one fewer number competing with the title. */
    mountMeta({ model: "claude-fable-5-1[thinking=true,context=300k,effort=high]", status: "waiting_permission", costUsd: 0.5, numTurns: 3 });
    expect(screen.getByLabelText("Status: Needs permission")).toHaveAttribute("data-status", "waiting_permission");
    expect(screen.queryByText(/claude-fable/)).toBeNull();
    expect(screen.queryByText(/turn/)).toBeNull();
    expect(screen.queryByText("$0.50")).toBeNull();
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
  it("shows a simulator step by what it is for, prefixed in the transcript and bare on a permission card", () => {
    // The agent's arguments arrive in its own order, and the first string of a tap is the device's id.
    // THE MUTANT: fall through to the first string field, and every step reads as a ULID.
    const tap = { simulatorId: "01JSIMULATOR", element: "0.3", intent: "open the Wi-Fi settings" };
    expect(toolSummary("mcp__realm__realm-simulator__simulator_tap", tap)).toBe("open the Wi-Fi settings");
    expect(toolSummary("simulator_tap", tap)).toBe("open the Wi-Fi settings");
    expect(toolSummary("simulator_type", { simulatorId: "01JSIMULATOR", text: "hello", intent: "search for Wallpaper" })).toBe("search for Wallpaper");
    // The other simulator tools keep the ordinary rule.
    expect(toolSummary("simulator_launch", { simulatorId: "01JSIMULATOR", bundleId: "com.acme" })).toBe("01JSIMULATOR");
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

/* The mode lives in the "+" menu's Mode section, as rows to pick. The mode's SEMANTICS are untouched —
   parking the permission on the way into Plan, restoring it on the way out, the per-agent gating —
   which is why these tests were redirected rather than rewritten. */
const plusButton = () => screen.getByRole("button", { name: "Add" });
/**
 * The menu's Mode section, with the menu left OPEN — for asserting what it says.
 *
 * The open is conditional and the find is async because of §6's exit window: a dismissed popover
 * stays mounted for `EXIT_MS` and the button stays `aria-expanded` through it (popover-exit's own
 * note), so an unconditional click lands as a CLOSE on anything that read the section a moment earlier.
 */
const openModes = async () => {
  const btn = plusButton();
  if (btn.getAttribute("aria-expanded") !== "true") fireEvent.click(btn);
  return within(await screen.findByRole("menu", { name: "Add" })).getByRole("group", { name: "Mode" });
};
/** The section's rows, as their names read. */
const modeNames = (group: HTMLElement) => within(group).getAllByRole("menuitemcheckbox").map((r) => r.querySelector(".menu-label")!.textContent);
/** The checked row's name, and the menu closed again — waiting out the exit so a following
 *  interaction starts from a shut menu. */
const readMode = async () => {
  const group = await openModes();
  const text = within(group).getByRole("menuitemcheckbox", { checked: true }).querySelector(".menu-label")!.textContent ?? "";
  // The popover hook arms its Escape listener a tick after mount.
  await act(async () => { await new Promise((r) => setTimeout(r, 1)); });
  fireEvent.keyDown(window, { key: "Escape" });
  await exited();
  return text;
};

describe("prompter mode, in the \"+\" menu (Build / Plan)", () => {
  const permissionChip = () => screen.queryByRole("button", { name: "Permission mode" });
  const setMode = async (label: "Build" | "Plan") => {
    fireEvent.click(within(await openModes()).getByRole("menuitemcheckbox", { name: label }));
    await exited();
  };

  it("returning to Build restores the permission the user was on, not `default`", async () => {
    // The whole reason the store parks a value: Plan travels as `permissionMode`, so the round trip
    // would otherwise silently demote Full access to Ask.
    const { store } = await mountFresh({ permissionMode: "bypassPermissions" });
    expect(permissionChip()).toHaveTextContent("Full access");
    await setMode("Plan");
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("plan"));
    await setMode("Build");
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("bypassPermissions"));
    expect(permissionChip()).toHaveTextContent("Full access");
    expect(store.getState().planReturn.se1).toBeUndefined(); // the park is spent, not left behind
  });

  it("survives a pane remount — the parked mode lives in the store, not the component", async () => {
    const { store, unmount } = await mountFresh({ permissionMode: "acceptEdits" });
    await setMode("Plan");
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("plan"));
    unmount();
    render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "Claude session" })} visible /></StoreContext.Provider>);
    await setMode("Build");
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("acceptEdits"));
  });

  it("names what Build will restore while in Plan, and lets you change it there", async () => {
    const { store } = await mountFresh({ permissionMode: "acceptEdits" });
    await setMode("Plan");
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("plan"));
    // Still names the parked value — "what happens when I go back?" is the question this chip
    // answers in Plan, and it was answering it before the answer became settable.
    const chip = permissionChip()!;
    expect(chip).toHaveTextContent("Accept edits");

    /* And it is a real picker now. Choosing here writes the PARK, never the live permission: the
       session has to stay on the wire value that keeps it read-only, or picking "Ask each time"
       would quietly drop it out of Plan halfway through a plan. That split is the whole control. */
    fireEvent.click(chip);
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Ask each time" }));
    await waitFor(() => expect(store.getState().planReturn.se1).toBe("default"));
    expect(store.getState().sessions.se1?.permissionMode).toBe("plan");

    // …and Build restores what was chosen IN Plan, not what was parked on the way in.
    await setMode("Build");
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("default"));
  });

  it("is hidden for an agent with no plan mode, and shown for the ones that have it", async () => {
    // Cursor: ACP mode ids are agent-defined and Realm's are never transmitted, so a Plan chip there
    // would be a button that changes nothing.
    /* The section is always there — it is where the mode is READ, and a session always has one.
       What the agent's capability decides is whether there is anything to PICK: a Cursor session
       pre-handshake has nothing to switch to, so the section is its one mode as a static value. */
    const cursor = await mountKindFresh("acp:cursor");
    const fixed = within(await openModes()).getAllByRole("menuitemcheckbox");
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toBeDisabled();
    cursor.unmount();
    // Codex: codexPolicyFor("plan") really does start the thread read-only under untrusted approvals.
    await mountKindFresh("codex");
    const rows = within(await openModes()).getAllByRole("menuitemcheckbox");
    expect(modeNames(await openModes())).toContain("Plan");
    expect(rows.every((r) => !(r as HTMLButtonElement).disabled)).toBe(true);
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

  it("a PDF alone now unlocks Send — Claude is handed its path rather than dropping it", async () => {
    // The reverse of what this used to assert. Claude's non-image disposition is `path`: the adapter
    // names the file in the message text (claude-adapter.ts `fileListFor`), so a PDF-only send really
    // does deliver something and the gate has no reason to refuse it.
    const { api, store } = await mountFresh();
    act(() => store.setState({ pendingAttachments: { se1: [pdf] } }));
    const btn = screen.getByRole("button", { name: "Send" });
    expect(btn).not.toBeDisabled();
    expect(btn.title).toBe("Send (⌘↵)");
    void api;
  });

  it("…but an agent that genuinely reads none of them still refuses, and says why", async () => {
    // The gate itself is unchanged, and `fake` is what still exercises it: its adapter never looks at
    // `attachments`, so an attachment-only send there would deliver literally nothing.
    const { api, store } = await mountFresh({ agentKind: "fake" });
    act(() => store.setState({ pendingAttachments: { se1: [pdf] } }));
    const btn = screen.getByRole("button", { name: "Send" });
    expect(btn).toBeDisabled();
    expect(btn.title).toBe("Fake agent ignores these attachments — add a message to send");
    fireEvent.click(btn);
    expect(api.sent).toEqual([]);
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

  it("renders a DISABLED row while a started session's handshake is still pending", async () => {
    // The materialize-honestly window: events exist, no init yet. A static value, not a submenu —
    // offering Plan before the agent has named its modes would be a guess.
    await mountCursor([sessionEvent("user_message", { text: "go", attachments: [] })]);
    const rows = within(await openModes()).getAllByRole("menuitemcheckbox");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toBeDisabled();
    expect(row.title).toBe("Waiting for the agent's modes");
    expect(row).toHaveAccessibleName("Build");
    expect(row).toHaveAccessibleDescription("Waiting for the agent's modes");
  });

  it("enables the chip once the init event carries a plan-equivalent, described in the agent's own words", async () => {
    await mountCursor([sessionEvent("user_message", { text: "go", attachments: [] }), initEvent(CURSOR_MODES)]);
    const group = await openModes();
    expect(modeNames(group)).toEqual(["Build", "Plan", "Ask"]);
    const plan = within(group).getByRole("menuitemcheckbox", { name: "Plan" });
    expect(plan).not.toBeDisabled();
    expect(plan.title).toContain("Cursor's own Plan mode");
    expect(plan.title).toContain("Read-only mode for planning and designing before implementation");
    // Cursor advertises `ask` in the same handshake, so that row describes itself the same way —
    // each title is what the user reads before choosing it.
    expect(within(group).getByRole("menuitemcheckbox", { name: "Ask" }).title).toContain("Cursor's own Ask mode");
    expect(document.querySelector('.ghost-chip[data-static][title="Waiting for the agent\'s modes"]')).toBeNull();
  });

  it("offers Ask alone when the agent advertises `ask` but no plan-equivalent", async () => {
    await mountCursor([sessionEvent("user_message", { text: "go", attachments: [] }),
      initEvent([{ id: "agent", name: "Agent", description: "d" }, { id: "ask", name: "Ask", description: "Q&A mode - no edits or command execution" }])]);
    const group = await openModes();
    // The mutant: gating the section's choices on `canPlan`. An agent that offers only Ask would be
    // left with a static value, and its one read-only mode would be unreachable.
    // …and the section offers exactly Build and Ask: Plan has nothing to map onto here.
    expect(modeNames(group)).toEqual(["Build", "Ask"]);
    const ask = within(group).getByRole("menuitemcheckbox", { name: "Ask" });
    expect(ask).not.toBeDisabled();
    expect(ask.title).toContain("Cursor's own Ask mode");
    expect(ask.title).toContain("no edits or command execution");
  });

  it("enters and leaves Plan WITHOUT the Claude-shaped permission park", async () => {
    // Cursor's Plan is its own mode: there is no chosen permission to preserve, so nothing is parked
    // and Build returns the row to its resting default.
    const { store } = await mountCursor([sessionEvent("user_message", { text: "go", attachments: [] }), initEvent(CURSOR_MODES)]);
    fireEvent.click(within(await openModes()).getByRole("menuitemcheckbox", { name: "Plan" }));
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("plan"));
    expect(store.getState().planReturn.se1).toBeUndefined(); // no park for an agent with no permission axis
    await exited();
    expect(await readMode()).toBe("Plan");
    fireEvent.click(within(await openModes()).getByRole("menuitemcheckbox", { name: "Build" }));
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
    fireEvent.click(screen.getByRole("option", { name: /Claude Opus 5(?!\.)/ }));
    await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("claude-opus-5"));
    expect(store.getState().sessions.se1?.agentKind).toBe("claude");
    const picks = api.calls.filter((c) => c.startsWith("setSessionAgent") || c.startsWith("setSessionOptions"));
    expect(picks).toEqual(["setSessionAgent:se1=claude", "setSessionOptions:se1"]);
  });

  it("picking a model inside the current agent leaves the agent alone", async () => {
    const { api, store } = await mountFresh({ model: "claude-opus-5" });
    // The vendor's word is the mark's job on the chip; the tooltip says the whole name.
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Opus 5");
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

  it("lists the current agent's models first, then each agent with a list, then every other agent by name", async () => {
    await mountKindFresh("codex");
    openPicker();
    expect(rowNames()).toEqual(["GPT-5.6", "Fable 5.1", "Fable 5", "Opus 5.5", "Opus 5", "Sonnet 5", "Haiku 4.5",
      // DeepSeek's ACP server is booted with one model and enumerates nothing, so its two are curated
      // and keep their group. Every agent with nothing but its own default is one row, by name.
      "DeepSeek V4 Pro", "DeepSeek V4 Flash",
      "Cursor", "Gemini", "OpenCode", "GitHub Copilot", "goose", "Qwen Code", "Grok", "fx", "OpenHands", "Hermes"]);
    const marks = screen.getAllByRole("option").map((n) => n.querySelector("[data-brand]")?.getAttribute("data-brand"));
    // Hermes' row is the one with no `data-brand`: Nous Research publishes no vector mark, so it
    // wears Realm's own caduceus from the Hugeicons set instead of a vendored brand path.
    expect(marks).toEqual(["openai", "claude", "claude", "claude", "claude", "claude", "claude", "deepseek", "deepseek",
      "cursor", "gemini", "opencode", "githubCopilot", "goose", "qwen", "grok", "fx", "openhands", undefined]);
    expect(document.querySelector("[data-brand='qwen']")).toHaveAttribute("viewBox", "0 0 141.38 140");
    expect(document.querySelector("[data-brand='githubCopilot']")?.querySelectorAll("path")).toHaveLength(3);
  });

  it("tells the agents Realm cannot ask for a model apart by name, not eight rows reading Default", async () => {
    // The named mutant: labelling an Other agents row by its model. DEFAULT_MODEL_LABEL gives eight
    // ACP agents the same "Default", and the picker becomes eight identical options.
    await mountKindFresh("codex");
    openPicker();
    const others = within(screen.getByRole("group", { name: "Other agents" })).getAllByRole("option");
    expect(others.map((n) => n.querySelector(".mp-row-name")!.textContent)).not.toContain("Default");
    const names = others.map((n) => n.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["OpenCode", "Qwen Code", "OpenHands", "Hermes", "Cursor, Composer"]));
  });

  it("never hides a session's own kind, even one that is not offered fresh", async () => {
    // `fake` is the dev adapter and absent from SELECTABLE_AGENT_KINDS; a fake session that could not
    // see itself would show a list with nothing selected.
    await mountFresh({ agentKind: "fake" });
    openPicker();
    expect(rowNames()).toEqual(["Fake", "Fable 5.1", "Fable 5", "Opus 5.5", "Opus 5", "Sonnet 5", "Haiku 4.5",
      "DeepSeek V4 Pro", "DeepSeek V4 Flash",
      "Codex", "Cursor", "Gemini", "OpenCode", "GitHub Copilot", "goose", "Qwen Code", "Grok", "fx", "OpenHands", "Hermes"]);
    expect(screen.getByRole("option", { name: "Fake" })).toHaveAttribute("aria-selected", "true");
  });

  it("marks an unavailable CLI but keeps it pickable — the install card is where picking it leads", async () => {
    const { store } = await mountFresh({}, 0, [{ kind: "codex", available: false, version: null, loggedIn: null, reason: "not on PATH" }]);
    // The probe is fired from an effect on mount; the note cannot render before it lands.
    await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
    openPicker();
    const row = screen.getByRole("option", { name: /GPT-5\.6/ });
    expect(row).toHaveTextContent("not installed");
    expect(row).not.toHaveAttribute("aria-disabled");
    fireEvent.mouseEnter(row);
    expect(document.querySelector(".mp-about-note")).toHaveTextContent(/Codex isn’t installed/);
    fireEvent.click(row);
    // Picking it switches the agent; SessionPane then swaps the prompter for the install card.
    await waitFor(() => expect(screen.getByText(AGENT_CLI_COMMANDS.codex.install!)).toBeInTheDocument());
  });

  describe("once the session has run", () => {
    it("lists only what the session can still run, says why, and offers no way round it", async () => {
      const { api, store } = await mountFresh({}, 1);
      openPicker();
      expect(screen.queryByRole("option", { name: /GPT-5\.6/ })).toBeNull();
      expect(within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Claude"]);
      expect(document.querySelector(".mp-locked")).toHaveTextContent(/already run on Claude/);
      // A search that only other agents could answer says so, rather than "no match".
      fireEvent.change(screen.getByRole("combobox", { name: "Search models" }), { target: { value: "gpt" } });
      expect(document.querySelector(".mp-empty")).toHaveTextContent(/already run/);
      expect(api.calls.filter((c) => c.startsWith("setSessionAgent"))).toHaveLength(0);
      expect(store.getState().sessions.se1?.agentKind).toBe("claude");
    });

    it("keeps models within the current agent selectable", async () => {
      const { store } = await mountFresh({}, 1);
      openPicker();
      const opus = screen.getByRole("option", { name: /Claude Opus 5(?!\.)/ });
      expect(opus).not.toHaveAttribute("aria-disabled");
      fireEvent.click(opus);
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("claude-opus-5"));
    });

    it("locks on a live event arriving into an open prompter, and on a row that already carries events", async () => {
      const { store } = await mountFresh({}, 0);
      openPicker();
      expect(screen.getByRole("option", { name: /GPT-5\.6/ })).toBeInTheDocument();
      act(() => store.getState().applySessionEvent({ seq: 7, sessionId: "se1", ephemeral: false, event: sessionEvent("user_message", { text: "hi", attachments: [] }) }));
      await waitFor(() => expect(screen.queryByRole("option", { name: /GPT-5\.6/ })).toBeNull());
      expect(document.querySelector(".mp-locked")).not.toBeNull();

      // lastEventSeq comes back with sessions.list; the transcript is fetched afterwards. Trusting
      // only the transcript would flash a live agent switch on every revisit of a long session.
      const api = fakeApi({ sessions: [session("se2", "s1", { status: "idle", agentKind: "claude", lastEventSeq: 12 })] });
      const st = createAppStore(api); await st.getState().boot();
      st.setState({ sessionStatus: { se2: "idle" } });
      render(<StoreContext.Provider value={st}><SessionPane item={item("i8", "s1", { kind: "session", refId: "se2", title: "Claude session" })} visible /></StoreContext.Provider>);
      const chips = await screen.findAllByRole("button", { name: "Model" });
      fireEvent.click(chips[1]!);
      await waitFor(() => expect(screen.getAllByRole("dialog", { name: "Model picker" }).at(-1)).toHaveTextContent(/already run on Claude/));
    });
  });

  describe("search", () => {
    it("matches the model name and the agent name, and nothing else", async () => {
      await mountFresh();
      openPicker();
      const search = screen.getByRole("combobox", { name: "Search models" });
      fireEvent.change(search, { target: { value: "opus" } }); // model name only
      expect(rowNames()).toEqual(["Opus 5.5", "Opus 5"]);
      fireEvent.change(search, { target: { value: "cursor" } }); // agent name only
      expect(rowNames()).toEqual(["Composer"]);
      // Model *ids* are deliberately not searched: `claude-haiku-4-5` would make this match.
      fireEvent.change(search, { target: { value: "haiku-4-5" } });
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      expect(screen.getByText(/No models match/)).toBeInTheDocument();
    });

    it("groups by harness when idle and drops the headings while searching", async () => {
      // The list teaches which CLI runs what — but a filtered list is already an answer, and a
      // heading per result would push the third match below the fold to repeat the row's own mark.
      await mountFresh();
      openPicker();
      const headings = () => [...document.querySelectorAll(".mp-group-label")].map((n) => n.textContent);
      expect(headings()).toEqual(["Claude", "DeepSeek", "Other agents"]);
      fireEvent.change(screen.getByRole("combobox", { name: "Search models" }), { target: { value: "opus" } });
      expect(headings()).toEqual([]);
    });

    it("Enter picks the highlighted row after arrowing down", async () => {
      // The highlight opens on the current model (Fable 5.1, the default), so one step down is Fable 5.
      const { store } = await mountFresh();
      openPicker();
      const search = screen.getByRole("combobox", { name: "Search models" });
      fireEvent.keyDown(search, { key: "ArrowDown" });
      fireEvent.keyDown(search, { key: "Enter" });
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("claude-fable-5"));
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

    it("picking a catalog row transmits its id verbatim — Auto's real id included", async () => {
      const { store } = await mountFresh({ agentKind: "acp:cursor" }, 0, cursorProbe(catalog));
      await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
      openPicker();
      fireEvent.click(screen.getByRole("option", { name: /gpt-5.3-codex/ }));
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("gpt-5.3-codex[reasoning=medium,fast=false]"));
      // Still open after the pick: the next one is made in the same visit.
      // "Auto" is a REAL id in Cursor's catalog (set_model accepts `default[]`, rejects `auto`):
      // picking it transmits that id — it is never rewritten to null or to a literal "auto".
      fireEvent.click(screen.getAllByRole("option", { name: /Auto/ })[0]!);
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("default[]"));
    });
  });

  describe("favourites", () => {
    const OPUS = canonicalModelKey("Claude Opus 5");
    const HAIKU = canonicalModelKey("Claude Haiku 4.5");
    const searchBox = () => screen.getByRole("combobox", { name: "Search models" });
    /** A row's star, which is drawn on the row under the pointer (and on a starred one) — so the
     *  pointer goes there first, as a person's would. */
    const starOn = (label: string | RegExp) => {
      const row = screen.getByRole("option", { name: label });
      fireEvent.mouseEnter(row);
      return within(row).getByRole("button", { name: /Favourite|Unfavourite/ });
    };
    /** Preloads starred keys the way a previous session would have left them in `settings`. */
    const withFavorites = async (keys: string[]) => {
      const r = await mountFresh();
      await act(async () => { r.store.setState({ modelFavorites: keys }); });
      return r;
    };

    it("leads the list with a Favourites group once something is starred", async () => {
      await withFavorites([OPUS]);
      openPicker();
      expect([...document.querySelectorAll(".mp-group-label")][0]).toHaveTextContent("Favourites");
    });

    it("starring a row persists a canonical KEY, not a model id", async () => {
      // A key is what survives the model being reached through a different harness later.
      const { api, store } = await mountFresh();
      openPicker();
      fireEvent.click(starOn(/Claude Opus 5(?!\.)/));
      await waitFor(() => expect(store.getState().modelFavorites).toEqual([OPUS]));
      expect(api.calls.some((c) => c.startsWith("setSetting:models.favorites"))).toBe(true);
      expect(OPUS).not.toBe("claude-opus-5"); // the id would have been the lazy thing to store
    });

    it("starring a row does not also pick it", async () => {
      // The star lives inside the row; without stopPropagation it would switch the session's model
      // as a side effect of bookmarking it.
      const { store } = await mountFresh({ model: "claude-fable-5-1" });
      openPicker();
      fireEvent.click(starOn(/Claude Opus 5(?!\.)/));
      await waitFor(() => expect(store.getState().modelFavorites).toEqual([OPUS]));
      expect(store.getState().sessions.se1?.model).toBe("claude-fable-5-1");
      expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument(); // and stays open
    });

    it("un-starring removes only that key", async () => {
      const { store } = await withFavorites([OPUS, HAIKU]);
      openPicker();
      // aria-pressed is not decoration here: it is the hook the filled-star CSS keys on, so a
      // starred row that failed to set it would look unstarred with no test noticing.
      expect(starOn(/Claude Opus 5(?!\.)/)).toHaveAttribute("aria-pressed", "true");
      expect(starOn(/Claude Sonnet 5/)).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(starOn(/Claude Opus 5(?!\.)/));
      await waitFor(() => expect(store.getState().modelFavorites).toEqual([HAIKU]));
    });

    it("floats favourites to the top and numbers them down the page", async () => {
      await withFavorites([HAIKU, OPUS]); // starred in this order; the badges must not follow it
      openPicker();
      expect(rowNames().slice(0, 2)).toEqual(["Opus 5", "Haiku 4.5"]); // list order, not starring order
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
      expect(rowNames()).toEqual(["Haiku 4.5"]);
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
      fireEvent.keyDown(searchBox(), { key: "ArrowDown" }); // Claude Opus 5, three rows under the current Fable 5.1
      fireEvent.keyDown(searchBox(), { key: "Enter", altKey: true });
      await waitFor(() => expect(store.getState().modelFavorites).toEqual([canonicalModelKey("Claude Opus 5")]));
      expect(store.getState().sessions.se1?.model).toBeNull(); // ⌥↩ stars; it does not pick
    });

    it("keeps the highlight on the row ⌥↩ just starred, after it sorts to the top", async () => {
      // Starring re-sorts the list under the highlight. Anchored to an index, the highlight would
      // stay in slot 3 while the starred row moved to slot 0 — so the very next Enter would pick
      // whichever model slid into that slot, not the one the user was looking at.
      const { store } = await mountFresh();
      openPicker();
      fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
      fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
      fireEvent.keyDown(searchBox(), { key: "ArrowDown" }); // Claude Opus 5
      fireEvent.keyDown(searchBox(), { key: "Enter", altKey: true });
      await waitFor(() => expect(store.getState().modelFavorites).toEqual([OPUS]));
      expect(rowNames()[0]).toBe("Opus 5"); // it moved
      const active = document.querySelector(".mp-row[data-active] .mp-row-name")?.textContent;
      expect(active).toBe("Opus 5"); // and the highlight moved with it
      fireEvent.keyDown(searchBox(), { key: "Enter" });
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("claude-opus-5"));
    });
  });

  describe("a model's other harness, on its own row", () => {
    /** Cursor proxying a model the Claude CLI also runs — the overlap a route switch has to carry. */
    const proxyProbe: AgentProbe[] = [
      { kind: "acp:cursor", available: true, version: "2026.09", loggedIn: null, reason: null,
        models: [{ id: "claude-fable-5.1", label: "Claude Fable 5.1" }, { id: "gpt-5.5", label: "GPT-5.5" }] },
    ];
    const picker = () => screen.getByRole("dialog", { name: "Model picker" });

    it("the prompter has ONE chip, and it names the harness as well as the model", async () => {
      // The harness menu is gone: a harness is only ever chosen FOR a model, so it moved inside the
      // picker. The chip still has to say which CLI is running the session, or that fact has no home.
      await mountFresh({ model: "claude-opus-5" });
      expect(screen.queryByRole("button", { name: "Harness" })).toBeNull();
      const chip = screen.getByRole("button", { name: "Model" });
      expect(chip).toHaveTextContent("Opus 5");
      // …and the level the turn runs at, the model's default while the session has chosen none.
      expect(chip.getAttribute("title")).toBe("Claude Opus 5 through Claude · High effort");
      expect(chip.querySelector("[data-brand]")).toHaveAttribute("data-brand", "claude"); // the HARNESS's mark
    });

    it("lists the model ONCE, and offers its harnesses on its row, the session's own lit", async () => {
      /* The old list drew Fable under Claude and again under Cursor, with a detail pane of route pills
         beside it — the same model read as two, and the harness was chosen in a second place. */
      const { store } = await mountFresh({ model: "claude-fable-5-1" }, 0, proxyProbe);
      await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
      openPicker();
      const fable = screen.getAllByRole("option", { name: /Claude Fable 5\.1/ });
      expect(fable).toHaveLength(1);
      fireEvent.mouseEnter(fable[0]!);
      const ways = within(fable[0]!).getAllByRole("button", { name: /^Run Claude Fable 5\.1 through/ });
      expect(ways.map((b) => b.getAttribute("aria-label"))).toEqual(["Run Claude Fable 5.1 through Claude", "Run Claude Fable 5.1 through Cursor"]);
      expect(ways[0]).toHaveAttribute("aria-pressed", "true"); // the session's own harness wins the tie
    });

    it("one click on the other harness re-maps the id for the harness that will run it", async () => {
      // The point of keeping the axes distinct: changing WHAT RUNS must not silently change WHAT IT
      // RUNS. Cursor names this model by a different id, so the switch re-maps rather than re-sends.
      const { api, store } = await mountFresh({ model: "claude-fable-5-1" }, 0, proxyProbe);
      await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
      openPicker();
      const fable = screen.getByRole("option", { name: /Claude Fable 5\.1/ });
      fireEvent.mouseEnter(fable);
      fireEvent.click(within(fable).getByRole("button", { name: "Run Claude Fable 5.1 through Cursor" }));
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
      expect(within(picker()).getByRole("button", { name: /through Cursor/ })).toHaveAttribute("aria-pressed", "true");
      fireEvent.keyDown(search, { key: "Enter" });
      await waitFor(() => expect(store.getState().sessions.se1?.agentKind).toBe("acp:cursor"));
      expect(store.getState().sessions.se1?.model).toBe("claude-fable-5.1");
    });

    it("a route the user chose applies to that model only, not to the next one they pick", async () => {
      // A route is part of the choice being made, not a mode the picker is in — otherwise glancing
      // at one model would re-route the next.
      const { api, store } = await mountFresh({ model: "claude-fable-5-1" }, 0, proxyProbe);
      await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
      openPicker();
      const search = screen.getByRole("combobox", { name: "Search models" });
      fireEvent.mouseEnter(screen.getByRole("option", { name: /Claude Fable 5\.1/ }));
      fireEvent.keyDown(search, { key: "ArrowRight" }); // Fable now lit through Cursor
      fireEvent.mouseEnter(screen.getByRole("option", { name: /Claude Sonnet 5/ }));
      fireEvent.keyDown(search, { key: "Enter" });
      await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("claude-sonnet-5"));
      expect(api.calls.filter((c) => c.startsWith("setSessionAgent"))).toHaveLength(0);
    });

    it("describes the highlighted model in a line: what it is for, its context and its API price", async () => {
      // The specs are secondary — a line under the list, not a column — and the price is the
      // catalog's API list price: who actually bills for the harness is on the line's hover.
      const { store } = await mountFresh();
      await act(async () => {
        store.setState({ modelInfo: { [canonicalModelKey("Claude Fable 5.1")]: {
          key: canonicalModelKey("Claude Fable 5.1"), label: "Claude Fable 5.1", vendor: "Anthropic",
          priceIn: 10, priceOut: 50, context: 1_000_000, efforts: ["max", "low"], blurb: "Vendor prose." } } });
      });
      openPicker();
      fireEvent.mouseEnter(screen.getByRole("option", { name: /Claude Fable 5\.1/ }));
      const specs = picker().querySelector(".mp-about-specs")!;
      expect(specs).toHaveTextContent("1M context · $10 in · $50 out per Mtok");
      expect(specs.getAttribute("title")).toBe(AGENT_NOTES.claude.billing.replace(/`/g, ""));
      // Realm's own sentence beats the catalog's marketing first line.
      expect(picker()).toHaveTextContent(MODEL_NOTES.get(canonicalModelKey("Claude Fable 5.1"))!);
      expect(picker()).not.toHaveTextContent("Vendor prose.");
    });

    it("renders a model the catalog has never heard of without inventing a price", async () => {
      // Composer and every "Default" row have no catalog entry at all. A picker that hid them, or
      // guessed, would be worse than one that says who bills and stops.
      await mountFresh();
      openPicker();
      fireEvent.mouseEnter(screen.getByRole("option", { name: /Composer/ }));
      expect(picker()).not.toHaveTextContent("per Mtok");
      expect(picker().querySelector(".mp-about-specs")).toHaveTextContent(AGENT_NOTES["acp:cursor"].billing);
    });

    it("warns about a harness that cannot do what its neighbours can", async () => {
      // DeepSeek's ACP server is automation-only. Offering the kind silently would be the dishonest
      // half of shipping it; this line is the other half.
      await mountFresh();
      openPicker();
      fireEvent.mouseEnter(screen.getByRole("option", { name: /DeepSeek V4 Pro/ }));
      expect(picker()).toHaveTextContent(AGENT_NOTES["acp:deepseek"].limits!);
      expect(picker()).toHaveTextContent(AGENT_NOTES["acp:deepseek"].billing);
    });

    it("offers no other harness once the session has run, and says why", async () => {
      // sessions.setAgent refuses after the first event, so a second way to run a model would be a
      // click whose only outcome is a refusal.
      const { store } = await mountFresh({ model: "claude-fable-5-1", lastEventSeq: 3 }, 3, proxyProbe);
      await waitFor(() => expect(store.getState().agentProbe).toHaveLength(1));
      openPicker();
      fireEvent.mouseEnter(screen.getByRole("option", { name: /Claude Fable 5\.1/ }));
      expect(picker().querySelector(".mp-ways")).toBeNull();
      expect(picker()).toHaveTextContent(/already run on Claude/);
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

describe("the session's terminal (W4)", () => {
  beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
  afterEach(() => { setTerminalHubForTests(null); vi.unstubAllGlobals(); });

  const sessionItem = item("i9", "s1", { kind: "session", refId: "se1", title: "Fake agent session" });

  /** The pane AND its header, which is where the button lives (PanelBar renders per-kind actions).
   *  The dock is the BOTTOM placement's, so every test of it docks the terminal there. */
  async function mountPane(open = false, terminalDock: "right" | "bottom" = "bottom") {
    setTerminalHubForTests(fakeHub());
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle" })] });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } }, terminalDock,
      ...(open ? { sessionDock: { se1: { kind: "terminal" as const } } } : {}) });
    const r = render(
      <StoreContext.Provider value={store}>
        <PanelBar item={sessionItem} leafId="l1" onSplit={() => {}} onClose={() => {}} />
        <SessionPane item={sessionItem} visible />
      </StoreContext.Provider>,
    );
    return { api, store, ...r };
  }

  const toggle = () => screen.getByRole("button", { name: /(Show|Hide) terminal for Fake agent session/ });

  /* The bar carries what is about the session — the dock of what it made, and the terminal only where
     Settings docks it to this pane's foot. Everything it opens BESIDE itself is the side pane's to
     launch (side-tools.ts; pane-tabs.test.tsx holds the "+"). */
  const barButtons = () => [...document.querySelectorAll(".panel-actions button")].map((b) => b.getAttribute("aria-label"));

  it("carries none of the tools a session opens beside itself — those are the side pane's", async () => {
    // THE MUTANT: any of the seven glyphs back in the bar — the row of buttons the owner asked to lose.
    await mountPane(false, "right");
    expect(barButtons()).toEqual(["Summary and files for Fake agent session", "Pane menu for Fake agent session"]);
  });

  it("in its default place, has no terminal control and spawns nothing on mount — ⌘J and the side pane open it", async () => {
    const { api } = await mountPane(false, "right");
    expect(api.calls.some((c) => c.startsWith("createTerminal") || c.startsWith("openSessionTerminal"))).toBe(false);
    expect(screen.queryByRole("button", { name: /terminal for Fake agent session/ })).toBeNull();
  });

  it("docked to the foot, the toggle is the bar's one other control", async () => {
    await mountPane();
    expect(barButtons()).toEqual(["Summary and files for Fake agent session", "Show terminal for Fake agent session", "Pane menu for Fake agent session"]);
  });

  it("docked to the bottom, is absent until the header toggle is pressed — mounting a session never spawns a shell", async () => {
    const { api, store } = await mountPane();
    expect(document.querySelector(".terminal-pane")).toBeNull();
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(api.calls.some((c) => c.startsWith("openSessionTerminal"))).toBe(false);

    fireEvent.click(toggle());
    await waitFor(() => expect(document.querySelector(".terminal-pane")).not.toBeNull());
    expect(api.calls).toContain("openSessionTerminal:se1");
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(store.getState().sessionDock["se1"]).toEqual({ kind: "terminal" });
    // It opens along the pane's foot as a dialog — the transcript is above it, not cut in half by a
    // divider, which is what the split did and what this replaced.
    expect(screen.getByRole("dialog", { name: /Terminal for/ })).toBeInTheDocument();
    expect(document.querySelector(".session-split")).toBeNull();
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

  async function mountAgent(agentProbe: AgentProbe[], status: "idle" | "running" = "idle", cliStatus: CliStatus[] = []) {
    setTerminalHubForTests(fakeHub());
    const api = fakeApi({ sessions: [session("se1", "s1", { status, agentKind: "claude" })], agentProbe, cliStatus });
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

  it("offers Sign in on the signed-out card, and starts the flow for THAT agent, from THIS session", async () => {
    const { api } = await mountAgent([signedOut]);
    await waitFor(() => expect(document.querySelector(".install-card")).not.toBeNull());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign in" })); });
    // The session id is what puts the terminal and the consent page in this session's side pane; a
    // sign-in started without it opens panes the sidebar of sessions never shows.
    expect(api.calls).toContain("startSignIn:s1:claude:se1");
  });

  /**
   * THE MUTANT: offer it on the missing card too. There is nothing to sign into before the CLI is
   * there — the flow would spawn a terminal to run a command that does not exist, and the user would
   * read the resulting "command not found" as the sign-in failing.
   */
  it("does not offer Sign in when the CLI is not installed", async () => {
    await mountAgent([missing]);
    await waitFor(() => expect(document.querySelector(".install-card")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("says where Realm stops, on the card that offers to start", async () => {
    // The note is the whole of what the user is told about the consent click before they commit to
    // the errand; a card that started a sign-in without saying who approves it would be the feature
    // making a promise the browser tools then refuse.
    await mountAgent([signedOut]);
    await waitFor(() => expect(document.querySelector(".install-card")).not.toBeNull());
    expect(screen.getByText(/never presses Authorize for you/)).toBeInTheDocument();
  });

  it("never takes the prompter away mid-turn — Stop must survive a probe that goes sour", async () => {
    const { api } = await mountAgent([missing], "running");
    await waitFor(() => expect(api.calls).toContain("probeAgents:false"));
    expect(document.querySelector(".install-card")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("'Open in terminal' opens the session's terminal with the command TYPED, never run", async () => {
    const { api, store } = await mountAgent([missing]);
    await waitFor(() => expect(document.querySelector(".install-card")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open in terminal" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("prefillTerminal:"))).toBe(true));
    // Into the terminal the bar's button opens: a tab of the side pane, in the session's checkout.
    expect(api.calls).toContain("createTerminal:s1:/tmp");
    const term = store.getState().items.filter((i) => i.kind === "terminal").at(-1)!;
    expect(api.calls).toContain(`prefillTerminal:${term.refId}=${AGENT_CLI_COMMANDS.claude.install}`);
    expect(api.calls.find((c) => c.startsWith("prefillTerminal:"))).not.toMatch(/[\r\n]$/);
  });

  it("'Open in terminal' with the terminal docked to the bottom types into the dock's shell", async () => {
    const { api, store } = await mountAgent([missing]);
    store.setState({ terminalDock: "bottom" });
    await waitFor(() => expect(document.querySelector(".install-card")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open in terminal" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("prefillTerminal:"))).toBe(true));
    expect(api.calls).toContain("openSessionTerminal:se1");
    expect(api.calls).toContain(`prefillTerminal:term-se1=${AGENT_CLI_COMMANDS.claude.install}`);
    await waitFor(() => expect(document.querySelector(".terminal-pane")).not.toBeNull());
  });

  /** claude missing, with the server offering to install it — the only shape that grows a button. */
  const offersInstall: CliStatus[] = [{
    kind: "claude", installed: false, version: null, binPath: null, provenance: "unknown", latest: null,
    updateAvailable: false, action: "install",
    command: AGENT_CLI_COMMANDS.claude.install, refusal: null,
  }];

  it("grows an Install button only when the server is offering one", async () => {
    // The named mutant: a button rendered from the card's own idea of "missing". The offer is the
    // server's, so a CLI it will not install shows the command to copy and nothing to press.
    await mountAgent([missing]);
    await waitFor(() => expect(document.querySelector(".install-card")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();

    cleanup();
    await mountAgent([missing], "idle", offersInstall);
    await waitFor(() => expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument());
    // The command is still readable above the button that runs it.
    expect(screen.getByText(AGENT_CLI_COMMANDS.claude.install)).toBeInTheDocument();
  });

  it("Install runs the command and streams what it says, without leaving the pane", async () => {
    const { api, store } = await mountAgent([missing], "idle", offersInstall);
    await waitFor(() => screen.getByRole("button", { name: "Install" }));
    expect(api.calls.some((c) => c.startsWith("runCli:"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(api.calls).toContain("runCli:claude:install"));

    const id = store.getState().cliJobs.claude!.id;
    store.getState().applyCliOutput({ id, kind: "claude", chunk: "added 128 packages\n" });
    await waitFor(() => expect(screen.getByText(/added 128 packages/)).toBeInTheDocument());
    // Nothing else may be pressed while a package manager is writing to the machine.
    expect(screen.getByRole("button", { name: "Installing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Check again" })).toBeDisabled();
  });

  it("a SIGNED-OUT card never grows an Install button — logging in is not a command Realm can run", async () => {
    await mountAgent([signedOut], "idle", offersInstall);
    await waitFor(() => expect(screen.getByRole("group", { name: /isn’t signed in/ })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.getByText(AGENT_CLI_COMMANDS.claude.login)).toBeInTheDocument();
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

  /** The "+" menu's Files… row: the plus opens a menu, and the row reaches the SAME store action the
   *  bare attach button used to call — every assertion below is unchanged. */
  const attach = () => {
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Files…/ })); // kbd hint ⌘U rides the accessible name
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

  it("says NOTHING under the chips for Claude — a PDF is a path it will open, not a file it loses", async () => {
    await mountFor("claude", [picked("/x/shot.png", "image/png"), picked("/x/report.pdf", "application/pdf")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(2));
    // Both files reach the agent: the image inline, the PDF as a path in the message text. Neither
    // outcome is one the user could not otherwise learn, so neither earns a row. The mutant this
    // kills is the old `other: "ignored"` in DISPOSITIONS, which brings the warning back — along
    // with the dropped file behind it.
    expect(notes()).toHaveLength(0);
    expect(document.querySelectorAll(".attach-tile[data-disposition='ignored']")).toHaveLength(0);
  });

  it("still warns for an agent that really does drop the file, and the sentence leads INTO the names", async () => {
    await mountFor("fake", [picked("/x/report.pdf", "application/pdf"), picked("/x/shot.png", "image/png")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(2));
    const warn = notes().find((t) => /ignores/.test(t))!;
    expect(warn).toContain("Fake agent");
    // The reported bug: the sentence stopped dead in front of the list it was introducing, so the row
    // read "…will never see them.report.pdf". A colon is what makes the names finish the sentence.
    expect(warn).toContain("will never see them: report.pdf");
    expect(warn).not.toMatch(/them\.report/);
  });

  it("says NOTHING under the chips for Codex — the same PDF is a path it will open, which is not a warning", async () => {
    await mountFor("codex", [picked("/x/report.pdf", "application/pdf")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(1));
    // The named mutant: a note row for the "path" disposition. Every Codex message with a file then
    // carries a sentence of narration about a handoff Codex completes on its own.
    expect(notes()).toEqual([]);
    expect(document.querySelectorAll(".attach-tile[data-disposition='ignored']")).toHaveLength(0);
    // The fate is still one hover away, on the tile.
    expect(document.querySelector(".attach-tip")!.textContent).toContain("Codex gets the file path");
  });

  it("and nothing for Cursor either — a link is the same kind of ordinary handoff", async () => {
    await mountFor("acp:cursor", [picked("/x/report.pdf", "application/pdf")]);
    attach();
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(notes()).toEqual([]);
    expect(document.querySelector(".attach-tip")!.textContent).toContain("Cursor gets a link");
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
    expect(tip).toContain("Claude gets the file path in your message and opens it itself.");
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
    // in the tile carries text, which is what keeps a row of files to a row of squares. Read off a
    // clone with those two stripped, at any depth: the hidden name rides inside the open button, so
    // a filter over the tile's direct children alone would stop seeing it and pass on nothing.
    const bare = tile.cloneNode(true) as HTMLElement;
    for (const hidden of bare.querySelectorAll(".visually-hidden, .attach-tip")) hidden.remove();
    expect(bare.textContent).not.toContain("report");
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
    await waitFor(() => expect(store.getState().toasts).toHaveLength(1));
    expect(chips()).toHaveLength(0);
    expect(store.getState().toasts[0]!.text).toContain("huge.png");
    expect(store.getState().toasts[0]!.text).toContain("20 MB");
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

  it("lights for one of Realm's OWN items too, which now means something else entirely", async () => {
    /* Changed deliberately. This used to assert the prompter ignored an item drag, on the grounds
       that Realm drags its own sidebar rows onto panes and those had to pass through. The prompter
       now claims them, because dropping a session here points the draft at it.

       The cost is real and is the thing to weigh if this is ever revisited: a session dropped on the
       PROMPTER no longer reaches the pane behind it, so moving a session into a group by dropping it
       on that strip of the pane does not work any more. Everywhere else in the pane still does. */
    await mountFor("codex");
    fireEvent.dragEnter(composer(), { dataTransfer: { files: [], items: [], types: ["application/x-realm-item"] } });
    expect(composer()).toHaveAttribute("data-dropping");
  });

  it("a drag that is neither files nor one of Realm's items is still left alone", async () => {
    // Text dragged from another app, say. Neither hook owns it and the card must not light.
    await mountFor("codex");
    fireEvent.dragEnter(composer(), { dataTransfer: { files: [], items: [], types: ["text/plain"] } });
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

  /* The whole pane takes a file, not just the card. With a transcript on screen the prompter is a
     strip at the bottom, and aiming at it with a file in hand was the chore this removes. */
  const pane = () => document.querySelector(".session-pane") as HTMLElement;
  const glow = () => document.querySelector(".session-drop");

  it("dropping on the transcript — nowhere near the prompter — attaches the file to THIS session", async () => {
    const { store } = await mountFor("codex");
    const files = [dropped("/Users/me/far.png", "image/png")];
    fireEvent.dragEnter(document.querySelector(".transcript")!, dt(files));
    expect(pane()).toHaveAttribute("data-dropping");
    fireEvent.drop(document.querySelector(".transcript")!, dt(files));
    await waitFor(() => expect(chips()).toHaveLength(1));
    // Attached to the session this pane is showing, not to whichever one was last focused.
    expect(store.getState().pendingAttachments["se1"]?.map((a) => a.path)).toEqual(["/Users/me/far.png"]);
    expect(pane()).not.toHaveAttribute("data-dropping");
  });

  it("the highlight is the pane's, and it is the only one lit while the drag is out on the transcript", async () => {
    await mountFor("codex");
    const files = [dropped("/x/a.png", "image/png")];
    expect(glow()).toBeNull();
    fireEvent.dragEnter(document.querySelector(".transcript")!, dt(files));
    expect(glow()).not.toBeNull();
    // Decorative, and it must never eat the drop it is advertising.
    expect(glow()).toHaveAttribute("aria-hidden", "true");
    expect(composer()).not.toHaveAttribute("data-dropping");
  });

  it("over the prompter it is the CARD that lights up, and the pane stands down", async () => {
    await mountFor("codex");
    const files = [dropped("/x/a.png", "image/png")];
    fireEvent.dragEnter(document.querySelector(".transcript")!, dt(files));
    expect(pane()).toHaveAttribute("data-dropping");
    // Into the card: the browser fires enter on the new target, then leave on the old one.
    fireEvent.dragEnter(composer(), dt(files));
    fireEvent.dragLeave(document.querySelector(".transcript")!, dt(files));
    expect(composer()).toHaveAttribute("data-dropping");
    // Two lit targets would say the file is about to land in two places.
    expect(pane()).not.toHaveAttribute("data-dropping");
    expect(glow()).toBeNull();
  });

  it("a drop on the prompter is handled ONCE — the card claims it from the pane", async () => {
    await mountFor("codex");
    const files = [dropped("/x/once.png", "image/png")];
    fireEvent.drop(composer(), dt(files));
    // The named mutant: drop `claim` on the composer's target and the same file is attached twice.
    await waitFor(() => expect(chips()).toHaveLength(1));
  });

  it("a Realm pane drag over the transcript lights nothing — a session dragged between groups is not a file", async () => {
    await mountFor("codex");
    const itemDrag = { dataTransfer: { files: [], items: [], types: ["application/x-realm-item"] } };
    fireEvent.dragEnter(document.querySelector(".transcript")!, itemDrag);
    expect(pane()).not.toHaveAttribute("data-dropping");
    expect(glow()).toBeNull();
    // Not consumed either: PaneHost's own drop-edge handling is above this and has to still see it.
    expect(fireEvent.dragOver(document.querySelector(".transcript")!, itemDrag)).toBe(true);
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
  async function mountStrip(extra: { lastEventSeq?: number; lastSeq?: number; spaces?: ReturnType<typeof space>[]; plainFolder?: boolean; onlyPrimary?: boolean } = {}) {
    const { envA, envB } = twoEnvs();
    const api = fakeApi({
      sessions: [session("se1", "s1", { status: "idle", environmentId: "envA", cwd: "/tmp", lastEventSeq: extra.lastEventSeq ?? 0 })],
      environments: { s1: extra.onlyPrimary ? [envA] : [envA, envB] },
      ...(extra.spaces ? { spaces: extra.spaces } : {}),
      // The space's folder is a repository unless the test says it is a plain one.
      ...(extra.plainFolder ? {} : { gitInfo: { "/tmp": { branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0 } } }),
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

  it("wears the space's colour on the workspace chip's glyph, as the face can carry it (Plan 27)", async () => {
    // THE MUTANT: leave the glyph in the chip's own ink — the composer would no longer say which
    // space the next message runs in, now that the space is not a room on screen.
    await mountStrip();
    const tint = screen.getByRole("button", { name: "Workspace" }).querySelector<HTMLElement>(".chip-tint")!;
    // jsdom has no media queries, so the face is light; the default fixture's Versed is #7c6cff.
    const hex = spaceColor("#7c6cff", "light");
    const n = Number.parseInt(hex.slice(1), 16);
    expect(tint.style.color).toBe(`rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`);
    expect(tint.querySelector("svg")).not.toBeNull();
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

  /* A space made from nothing is a plain folder, and a plain folder has no worktrees. THE mutant: offer
     "New worktree…" anyway — the one thing it can do there is put "…is not a git repository, so it has
     no worktrees" on screen, which is how a space someone had just made came up under a red bar. */
  it("a plain folder offers no worktree — the checkout it has is the only one there is", async () => {
    const { api } = await mountStrip({ plainFolder: true });
    await waitFor(() => expect(api.calls).toContain("gitInfo:/tmp"));
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const menu = screen.getByRole("menu", { name: "Workspace" });
    expect(within(menu).queryByRole("menuitem", { name: "New worktree…" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Move to Homework" })).toBeInTheDocument();
  });

  it("…and with nowhere else to move, its chip is the folder's name rather than a menu of one row", async () => {
    await mountStrip({ plainFolder: true, onlyPrimary: true, spaces: [space("s1", "p1", "Versed")] });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull());
    expect(document.querySelector(".composer-understrip .ghost-chip[data-static][title^='Workspace']")).toHaveTextContent("Versed");
  });

  it("moves a session that has not started to another space of its profile, from the same chip (Plan 27)", async () => {
    // THE MUTANTS: leave the move off the chip, send the wrong space, offer the space it is already in,
    // or offer another profile's — which would take the session out of this window from a composer.
    const { api } = await mountStrip({ spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s4", "p1", "Lectures"), space("s3", "p2", "Thesis")] });
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const menu = screen.getByRole("menu", { name: "Workspace" });
    expect(within(menu).queryByRole("menuitem", { name: "Move to Versed" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Move to Thesis" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Move to Homework" })).toBeInTheDocument();
    // The second of two, so a row that sent the first space's id whichever was picked would fail here.
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Move to Lectures" }));
    await waitFor(() => expect(api.calls).toContain("moveSessionToSpace:se1=s4"));
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
 * The "+" menu: Add (files, a folder, skills, a goal), Mode and Connectors, drawn in the app as one
 * sectioned list. The attach suite above already proves Files… reaches the same store action the bare
 * button used to call; these cover the rest.
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

  it("is three named sections — Add, Mode, Connectors — each row a name and a line saying what it does", async () => {
    await mountPlus();
    openPlus();
    const menu = screen.getByRole("menu", { name: "Add" });
    // Drawn in the app, not handed to the OS: an OS menu row has no second line to carry the detail.
    expect(menu).toHaveClass("plus-menu");
    expect(within(menu).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Add", "Mode", "Connectors"]);
    const names = (group: string) => [...within(menu).getByRole("group", { name: group }).querySelectorAll('[role^="menuitem"]')]
      .map((b) => b.querySelector(".menu-label")!.textContent);
    expect(names("Add")).toEqual(["Files…", "Folder…", "Select in Realm", "Skills", "Goal…"]);
    expect(names("Mode")).toEqual(["Build", "Plan", "Ask"]);
    expect(names("Connectors")).toEqual(["Manage connections…"]);
    // The shortcut rides the name; the line is the row's DESCRIPTION, so a row is still found by
    // what it is called. THE mutant: the detail inside the label, which renames every row.
    const files = within(menu).getByRole("menuitem", { name: /^Files…/ });
    expect(files).toHaveAccessibleName(/^Files…\s*⌘U$/);
    expect(files).toHaveAccessibleDescription("Attach to this message");
    expect(within(menu).getByRole("menuitem", { name: "Folder…" })).toHaveAccessibleDescription("Link a folder to this space");
    // Select in Realm says the person's own chord for it, and is not an agent's to press (app_act
    // refuses anything inside `data-no-agent`): a pick is the person pointing.
    const select = within(menu).getByRole("menuitem", { name: /^Select in Realm/ });
    expect(select).toHaveAccessibleName(/^Select in Realm\s*⌘⇧C$/);
    expect(select).toHaveAccessibleDescription("Point at a part of the app");
    expect(select).toHaveAttribute("data-no-agent", "element picker");
    // Every row wears a glyph, in one slot, so the names stand on one edge.
    expect([...menu.querySelectorAll('[role^="menuitem"]')].every((b) => b.querySelector(".menu-icon > *"))).toBe(true);
    // No Plugins section: Realm has no plugin system, and parity is not a reason to invent one.
    expect(within(menu).queryByText(/plugin/i)).toBeNull();
  });

  it("stays drawn in the app where the OS would draw every other menu", async () => {
    /* In the app every other Menu goes to the OS (main/native-menu.ts). This one may not: its rows'
       descriptions are the point of it, and an OS menu row has no second line. THE mutant: the + menu
       dropping `inApp`, which jsdom alone cannot see, because jsdom has no OS menu to hand it to. */
    const popupMenu = vi.fn(() => Promise.resolve(null));
    (window as { realm?: unknown }).realm = { popupMenu, closeMenu: vi.fn(() => Promise.resolve()) };
    try {
      await mountPlus();
      openPlus();
      expect(await screen.findByRole("menu", { name: "Add" })).toHaveClass("plus-menu");
      await new Promise((r) => setTimeout(r, 5));
      expect(popupMenu).not.toHaveBeenCalled();
    } finally { delete (window as { realm?: unknown }).realm; }
  });

  it("the arrows walk every section as one list, and Escape hands focus back to the +", async () => {
    await mountPlus();
    const btn = screen.getByRole("button", { name: "Add" });
    btn.focus();
    openPlus();
    const menu = screen.getByRole("menu", { name: "Add" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: /^Files…/ }));
    // From the last row of Add straight into Mode — the heads are not stops.
    for (let i = 0; i < 5; i++) fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitemcheckbox", { name: "Build" }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Manage connections…" }));
    // The pointer moves the same highlight the keys do, so there is only ever one lit row.
    fireEvent.pointerMove(within(menu).getByRole("menuitem", { name: "Folder…" }));
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Folder…" }));
    // The popover hook arms its Escape listener a tick after mount.
    await act(async () => { await new Promise((r) => setTimeout(r, 1)); });
    fireEvent.keyDown(window, { key: "Escape" });
    await exited();
    expect(screen.queryByRole("menu", { name: "Add" })).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("Select in Realm puts the in-app picker up for THIS prompter, whichever session the window would pick", async () => {
    const { store } = await mountPlus();
    openPlus();
    fireEvent.click(within(screen.getByRole("menu", { name: "Add" })).getByRole("menuitem", { name: /^Select in Realm/ }));
    expect(store.getState().appPick).toEqual({ sessionId: "se1" });
  });

  /* The goal row ARMS the box rather than opening anything: the objective is the argument, and
     `/goal` with nothing after it has nothing to pursue. Anything already typed becomes that
     objective instead of being thrown away, which is the one way this differs from picking the
     command out of the `/` list. */
  it("Goal… puts the draft behind /goal rather than starting an empty one", async () => {
    const { api, store } = await mountPlus();
    /* The menu holds an exit for §6's length, and it stays `open` through it — so a second press
       inside that window reads as a CLOSE. Waiting for it to go is what makes "open it again" mean
       that, here and in every other test that visits this menu twice. */
    const armGoal = async () => {
      await waitFor(() => expect(screen.queryByRole("menu", { name: "Add" })).toBeNull());
      openPlus();
      const menu = await screen.findByRole("menu", { name: "Add" });
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Goal…" }));
    };
    await armGoal();
    await waitFor(() => expect(store.getState().drafts["se1"]).toBe("/goal "));
    expect(api.calls.filter((c) => c.startsWith("goalStart:"))).toHaveLength(0);

    store.getState().setDraft("se1", "ship the release notes");
    await armGoal();
    await waitFor(() => expect(store.getState().drafts["se1"]).toBe("/goal ship the release notes"));
    // Twice does not nest: the draft is already the call it would build.
    await armGoal();
    await waitFor(() => expect(store.getState().drafts["se1"]).toBe("/goal ship the release notes"));
  });

  it("Folder… runs the existing project-link flow", async () => {
    const { api } = await mountPlus();
    openPlus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Folder…" }));
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

  it("the picker's list dissolves into the search field and the footer instead of being cut by them", async () => {
    /* 15-skills-popover-cutoff.png: the last row sliced in half by "Manage skills & folders…". The
       dissolve is a mask on the LIST, so the field above and the footer below never go soft. THE
       mutant: drop the hook, and the list is a plain box with a hard edge at both ends again. */
    await mountPlus({ skills: { s1: Array.from({ length: 14 }, (_, i) => skillRow(`skill-${String(i).padStart(2, "0")}`)) } });
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.textContent ?? ""); };
    try {
      openPlus();
      fireEvent.click(screen.getByRole("menuitem", { name: "Skills" }));
      const picker = await screen.findByRole("dialog", { name: "Skills" });
      const list = picker.querySelector<HTMLElement>(".skill-picker-list")!;
      act(() => {
        Object.defineProperty(list, "scrollHeight", { configurable: true, value: 700 });
        Object.defineProperty(list, "clientHeight", { configurable: true, value: 300 });
        list.dispatchEvent(new Event("scroll"));
      });
      expect(list.dataset.dissolve).toBe("end");
      expect(picker.hasAttribute("data-dissolve")).toBe(false);
      expect(picker.querySelector(".skill-picker-search")!.hasAttribute("data-dissolve")).toBe(false);
      // Arrowing past the fold brings the highlight along — clear of the band, by the list's own
      // scroll-padding — where a pointer passing over a row leaves the list where it is.
      fireEvent.keyDown(within(picker).getByRole("combobox", { name: "Search skills" }), { key: "ArrowDown" });
      expect(scrolled.at(-1)).toContain("skill-01");
      const before = scrolled.length;
      fireEvent.mouseEnter(within(picker).getByRole("option", { name: /skill-09/ }));
      expect(scrolled.length).toBe(before);
    } finally { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; }
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
    expect(within(menu).getByRole("menuitem", { name: /^Files…/ })).toBeInTheDocument(); // the rest stays
  });
});

/**
 * The "+" menu's Connectors section (Plan 12 W1): the space's ENABLED MCP servers with a health dot
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
  /** The section, in the menu the "+" opens — it is a part of that menu now, not a view swapped in. */
  const openConnectors = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    return within(await screen.findByRole("menu", { name: "Add" })).getByRole("group", { name: "Connectors" });
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
    const row = (name: string) => within(menu).getByText(name).closest("[role=menuitem]") as HTMLElement;
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
    const dot = () => (within(screen.getByRole("group", { name: "Connectors" })).getByText("linear").closest("[role=menuitem]") as HTMLElement).querySelector(".connector-dot");
    expect(dot()).toHaveAttribute("data-tone", "muted");
    act(() => store.getState().applyMcpServerStatus({ id: "m1", status: "connected", oauthStatus: "unconfigured" }));
    expect(dot()).toHaveAttribute("data-tone", "ok");
    act(() => store.getState().applyMcpServerStatus({ id: "m1", status: "error", oauthStatus: "unconfigured" }));
    expect(dot()).toHaveAttribute("data-tone", "warning");
  });

  it("an empty space says so, and Manage connections… opens the space settings' Connections tab", async () => {
    const { store } = await mountConn([]);
    const menu = await openConnectors();
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "Manage connections…" })).toHaveAccessibleDescription("None enabled in this space"));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Manage connections…" }));
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("space-page"));
    expect(store.getState().spacePageTab.s1).toBe("connections");
  });

  it("a server's row leads to the space's Connections page, where acting on it lives", async () => {
    const { store } = await mountConn([{ name: "linear", enabled: true, status: "connected" }]);
    const menu = await openConnectors();
    await waitFor(() => expect(within(menu).queryByText("linear")).not.toBeNull());
    const row = within(menu).getByText("linear").closest("[role=menuitem]") as HTMLElement;
    expect(row).toHaveAccessibleDescription("connected");
    fireEvent.click(row);
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("space-page"));
    expect(store.getState().spacePageTab.s1).toBe("connections");
  });
});
