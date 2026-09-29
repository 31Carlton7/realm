import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MODEL_FAST_SUPPORT_KEY, sessionEvent } from "@realm/contracts";
import { createAppStore, StoreContext } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { reduceAll } from "./transcript-model";
import { SessionPane } from "./SessionPane";
import { fastModeNote, fastModeUntried, type FastMode } from "./ModelPicker";

afterEach(() => cleanup());

const fast = (over: Partial<FastMode> = {}): FastMode =>
  ({ on: false, state: null, reason: null, requested: null, onChange: () => {}, ...over });

describe("fastModeNote", () => {
  it("says nothing in the two ordinary cases", () => {
    // Not asked for; and asked for and serving. A note that appears every time is a note nobody
    // reads by the third session.
    expect(fastModeNote(fast({ on: false }))).toBeNull();
    expect(fastModeNote(fast({ on: false, state: "off", reason: "free" }))).toBeNull();
    expect(fastModeNote(fast({ on: true, state: "on" }))).toBeNull();
  });

  it("admits it has not taken effect yet rather than implying it has", () => {
    expect(fastModeNote(fast({ on: true, state: null }))).toMatch(/next turn/);
  });

  it("tells a rate-limit pause apart from a refusal", () => {
    // These are different things to tell someone: one resolves on its own, the other never will.
    expect(fastModeNote(fast({ on: true, state: "cooldown" }))).toMatch(/rate limit/);
    expect(fastModeNote(fast({ on: true, state: "off", reason: "free" }))).toMatch(/plan does not include/);
    expect(fastModeNote(fast({ on: true, state: "off", reason: "model_not_allowed" }))).toMatch(/model cannot run it/);
  });

  it("passes on a reason it does not recognise rather than swallowing it", () => {
    // A build newer than this one knows something worth showing.
    expect(fastModeNote(fast({ on: true, state: "off", reason: "quota_exhausted" }))).toContain("quota_exhausted");
  });

  it("still says something when the harness refused without saying why", () => {
    expect(fastModeNote(fast({ on: true, state: "off", reason: null }))).toMatch(/did not say why/);
  });

  it("does not read a report on a turn that never asked as a refusal of the switch", () => {
    /* THE BUG: switched on after a turn that ran without it, that turn's report still says "off",
       with the harness's reason for a request nobody made — here the SDK's opt-in refusal — and the
       note told the user fast mode could not run. */
    const stale = fast({ on: true, state: "off", reason: "sdk_opt_in_required", requested: false });
    expect(fastModeNote(stale)).toMatch(/next turn/);
    expect(fastModeUntried(stale)).toBe(true);
    // Once a turn HAS asked, the same report is the verdict it looks like…
    expect(fastModeNote({ ...stale, requested: true })).toMatch(/^Not running/);
    // …and a transcript from before the stamp keeps the old reading rather than guessing either way.
    expect(fastModeNote({ ...stale, requested: null })).toMatch(/^Not running/);
  });
});

let seq = 0;
const ev = (e: ReturnType<typeof sessionEvent>) => ({ ...e, seq: ++seq });

async function mount(events: ReturnType<typeof sessionEvent>[], extra: Parameters<typeof session>[2] = {}, settings: Record<string, unknown> = {}) {
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "claude", ...extra })], settings });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll(events) } } });
  render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
  return { api, store };
}

const init = (over: Record<string, unknown> = {}) =>
  sessionEvent("init", { providerSessionId: "p1", model: "claude-opus-5", tools: [], cwd: "/tmp", ...over });

const openPicker = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  await waitFor(() => expect(document.querySelector(".mp-detail-foot")).not.toBeNull());
};

describe("the prompter's Speed control", () => {
  it("is absent until the harness has said the model can run fast mode", async () => {
    // Never a disabled switch: there is nothing a user could do about a capability nobody claimed.
    await mount([ev(init())]);
    await openPicker();
    expect(screen.queryByRole("group", { name: "Speed" })).toBeNull();
  });

  it("is absent when the harness said the model CANNOT", async () => {
    await mount([ev(init({ supportsFastMode: false }))]);
    await openPicker();
    expect(screen.queryByRole("group", { name: "Speed" })).toBeNull();
  });

  it("appears once the harness says it can, showing what the session asked for", async () => {
    await mount([ev(init({ supportsFastMode: true }))], { fastMode: true });
    await openPicker();
    const group = screen.getByRole("group", { name: "Speed" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fast" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Standard" })).toHaveAttribute("aria-pressed", "false");
  });

  it("writes the request through, and does not close the popover over its own answer", async () => {
    // The note under the switch is the point of the control; dismissing the surface that carries it
    // would tell the user something they never get to read.
    const { api } = await mount([ev(init({ supportsFastMode: true }))]);
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Fast" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("setSessionOptions:"))).toBe(true));
    expect(document.querySelector(".mp-detail-foot")).not.toBeNull();
  });

  it("says what the harness DID, not what the switch says", async () => {
    // The named mutant: rendering the note off `session.fastMode` alone. The switch is on, the plan
    // does not include it, and a control that showed only the request would keep claiming a speed
    // the agent is not running at.
    await mount([
      ev(init({ supportsFastMode: true })),
      ev(sessionEvent("usage", { costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1, fastMode: "off", fastModeReason: "free" })),
    ], { fastMode: true });
    await openPicker();
    expect(screen.getByText(/plan does not include fast mode/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fast" })).toHaveAttribute("aria-pressed", "true");
  });

  it("tells someone who just switched it on that it is coming, not that it failed", async () => {
    // The user's report, reproduced: the last turn ran without it and the SDK said why; the switch
    // was flipped after. The note, and its tone, are about the next turn.
    await mount([
      ev(init({ supportsFastMode: true })),
      ev(sessionEvent("usage", { costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1, fastMode: "off", fastModeReason: "sdk_opt_in_required", fastModeRequested: false })),
    ], { fastMode: true });
    await openPicker();
    const note = document.querySelector(".mp-fast-note")!;
    expect(note).toHaveTextContent(/next turn/);
    expect(note).not.toHaveAttribute("data-tone");
  });

  it("still warns when the turn that was refused DID ask", async () => {
    await mount([
      ev(init({ supportsFastMode: true })),
      ev(sessionEvent("usage", { costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1, fastMode: "off", fastModeReason: "free", fastModeRequested: true })),
    ], { fastMode: true });
    await openPicker();
    const note = document.querySelector(".mp-fast-note")!;
    expect(note).toHaveTextContent(/plan does not include/);
    expect(note).toHaveAttribute("data-tone", "warning");
  });

  it("stays quiet once it is genuinely serving", async () => {
    await mount([
      ev(init({ supportsFastMode: true })),
      ev(sessionEvent("usage", { costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1, fastMode: "on" })),
    ], { fastMode: true });
    await openPicker();
    expect(document.querySelector(".mp-fast-note")).toBeNull();
  });
});

describe("the Speed control before a session's first message", () => {
  const remembered = (answers: Record<string, boolean>) => ({ [MODEL_FAST_SUPPORT_KEY]: answers });

  it("is offered on what the last session on this model heard", async () => {
    /* THE BUG: the switch waited for this session's own handshake, which only arrives after the first
       prompt — so the one prompt it could never be on for was the first. */
    const { api } = await mount([], { model: "claude-opus-5-5" }, remembered({ "claude:claude-opus-5-5": true }));
    await openPicker();
    expect(screen.getByRole("group", { name: "Speed" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fast" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("setSessionOptions:"))).toBe(true));
  });

  it("reads the harness default's own entry for a session with no model of its own", async () => {
    await mount([], { model: null }, remembered({ "claude:": true }));
    await openPicker();
    expect(screen.getByRole("group", { name: "Speed" })).toBeInTheDocument();
  });

  it("is not offered on another model's answer, or on a `no`", async () => {
    // Remembered, never guessed: a model no session has run keeps waiting for its own harness.
    await mount([], { model: "claude-sonnet-5" }, remembered({ "claude:claude-opus-5-5": true, "codex:claude-sonnet-5": true }));
    await openPicker();
    expect(screen.queryByRole("group", { name: "Speed" })).toBeNull();
    cleanup();
    await mount([], { model: "claude-opus-5-5" }, remembered({ "claude:claude-opus-5-5": false }));
    await openPicker();
    expect(screen.queryByRole("group", { name: "Speed" })).toBeNull();
  });

  it("gives way to the session's own handshake the moment it has one", async () => {
    await mount([ev(init({ supportsFastMode: false }))], { model: "claude-opus-5-5" }, remembered({ "claude:claude-opus-5-5": true }));
    await openPicker();
    expect(screen.queryByRole("group", { name: "Speed" })).toBeNull();
  });

  it("picks up an answer another session hears while this one is open", async () => {
    // The server files it before it broadcasts the handshake; hearing ANY session's answer is the
    // store's cue to re-read, since the session that wants it is not the one that heard it.
    const { api, store } = await mount([], { model: "claude-opus-5-5" });
    await openPicker();
    expect(screen.queryByRole("group", { name: "Speed" })).toBeNull();
    await api.setSetting(MODEL_FAST_SUPPORT_KEY, { "claude:claude-opus-5-5": true });
    act(() => store.getState().applySessionEvent({ seq: 1, sessionId: "elsewhere", event: init({ supportsFastMode: true }), ephemeral: false }));
    await waitFor(() => expect(screen.getByRole("group", { name: "Speed" })).toBeInTheDocument());
  });
});

describe("the model chip", () => {
  it("says Fast beside the effort once the session asks for it and the harness can serve it", async () => {
    await mount([ev(init({ supportsFastMode: true }))], { fastMode: true, effort: "high" });
    const chip = screen.getByRole("button", { name: "Model" });
    expect(chip.querySelector(".chip-fast")).toHaveTextContent("Fast");
    expect(chip).toHaveTextContent(/High\s*Fast/);
    expect(chip.getAttribute("title")).toContain("fast mode");
  });

  it("does not claim a speed where nothing has said the model can run it", async () => {
    // The switch's own rule, applied to the label: `fastMode` on the row alone is a request, and a
    // chip that wore it for an engine that never answered would be claiming a speed it is not at.
    await mount([ev(init())], { fastMode: true, effort: "high" });
    expect(screen.getByRole("button", { name: "Model" }).querySelector(".chip-fast")).toBeNull();
    await mount([ev(init({ supportsFastMode: true }))], { fastMode: false, effort: "high" });
    expect(screen.getAllByRole("button", { name: "Model" }).at(-1)!.querySelector(".chip-fast")).toBeNull();
  });
});

describe("the init event", () => {
  it("a restated handshake replaces the one before it, carrying the capability forward", async () => {
    // The Claude adapter emits init twice: once from the CLI's message, once when it has learned
    // whether the model can run fast mode. The second is the same record plus one fact.
    const { store } = await mount([
      ev(init({ tools: ["Read", "Write"] })),
      ev(init({ tools: ["Read", "Write"], supportsFastMode: true })),
    ]);
    const t = store.getState().transcripts.se1!.t;
    expect(t.init).toMatchObject({ providerSessionId: "p1", tools: ["Read", "Write"], supportsFastMode: true });
  });

  it("keeps the capability across a later handshake that says nothing about the same model", async () => {
    // THE bug this fixes: `supportedModels()` answers one round trip after the init that asked, so
    // the enriched record is always followed by ordinary handshakes — a resume, the next query's own
    // init. Replacing wholesale threw the answer away every time, and the Speed control blinked out
    // of the picker mid-session. That is the "fast mode only shows up occasionally".
    const { store } = await mount([
      ev(init({ supportsFastMode: true })),
      ev(init()),
    ]);
    expect(store.getState().transcripts.se1!.t.init).toMatchObject({ supportsFastMode: true });
  });

  it("drops it when the handshake lands on a DIFFERENT model — that answer was about the old one", async () => {
    const { store } = await mount([
      ev(init({ supportsFastMode: true })),
      ev(init({ model: "some-other-model" })),
    ]);
    expect(store.getState().transcripts.se1!.t.init).not.toHaveProperty("supportsFastMode");
  });

  it("lets a later handshake say no — `false` is an answer, not silence", async () => {
    const { store } = await mount([
      ev(init({ supportsFastMode: true })),
      ev(init({ supportsFastMode: false })),
    ]);
    expect(store.getState().transcripts.se1!.t.init).toMatchObject({ supportsFastMode: false });
  });

  it("a handshake that says nothing about the capability leaves it unstated", async () => {
    const { store } = await mount([ev(init())]);
    expect(store.getState().transcripts.se1!.t.init).not.toHaveProperty("supportsFastMode");
  });
});
