import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MODEL_FAST_SUPPORT_KEY, sessionEvent } from "@realm/contracts";
import { createAppStore, StoreContext, type AgentProbe } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { reduceAll } from "./transcript-model";
import { SessionPane } from "./SessionPane";
import { fastModeNote, fastModeUntried, type FastMode } from "./model-catalog";

afterEach(() => cleanup());

const fast = (over: Partial<FastMode> = {}): FastMode =>
  ({ on: false, state: null, reason: null, requested: null, onChange: () => {}, availability: { state: "offered", source: "session" }, tip: "Fast mode.", ...over });

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
    expect(fastModeNote(fast({ on: true, state: "cooldown" }))).toMatch(/rate limit/);
    expect(fastModeNote(fast({ on: true, state: "off", reason: "free" }))).toMatch(/plan does not include/);
    expect(fastModeNote(fast({ on: true, state: "off", reason: "model_not_allowed" }))).toMatch(/model cannot run it/);
  });

  it("passes on a reason it does not recognise rather than swallowing it", () => {
    expect(fastModeNote(fast({ on: true, state: "off", reason: "quota_exhausted" }))).toContain("quota_exhausted");
  });

  it("still says something when the harness refused without saying why", () => {
    expect(fastModeNote(fast({ on: true, state: "off", reason: null }))).toMatch(/did not say why/);
  });

  it("does not read a report on a turn that never asked as a refusal of the switch", () => {
    const stale = fast({ on: true, state: "off", reason: "sdk_opt_in_required", requested: false });
    expect(fastModeNote(stale)).toMatch(/next turn/);
    expect(fastModeUntried(stale)).toBe(true);
    expect(fastModeNote({ ...stale, requested: true })).toMatch(/^Fast mode isn’t running/);
    expect(fastModeNote({ ...stale, requested: null })).toMatch(/^Fast mode isn’t running/);
  });
});

let seq = 0;
const ev = (e: ReturnType<typeof sessionEvent>) => ({ ...e, seq: ++seq });

async function mount(events: ReturnType<typeof sessionEvent>[], extra: Parameters<typeof session>[2] = {}, settings: Record<string, unknown> = {}, agentProbe?: AgentProbe[]) {
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "claude", ...extra })], settings, ...(agentProbe ? { agentProbe } : {}) });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll(events) } } });
  render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
  if (agentProbe) await waitFor(() => expect(store.getState().agentProbe).toHaveLength(agentProbe.length));
  return { api, store };
}

const init = (over: Record<string, unknown> = {}) =>
  sessionEvent("init", { providerSessionId: "p1", model: "claude-opus-5", tools: [], cwd: "/tmp", ...over });

const openPicker = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  await waitFor(() => expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument());
};
/** The bolt at the head of the picker's foot — fast mode's one control now, as Codex draws it. */
const bolt = () => screen.queryByRole("button", { name: "Fast mode" });
const fastNote = () => document.querySelector(".mp-fast-note");

describe("the prompter's fast-mode bolt", () => {
  it("is there on a brand-new session before anything has answered, and says the first turn settles it", async () => {
    /* THE owner's report: "I don't see a fast mode option" on a new session on Claude Fable 5.1. The
       control used to wait for the harness's own handshake, which only arrives after the first
       prompt. Claude can be asked, so the bolt is a request from the first turn on, and its tooltip
       says nothing has confirmed this model yet — the line under it waits until it is pressed. */
    const { api, store } = await mount([]);
    await openPicker();
    expect(bolt()).toHaveAttribute("aria-pressed", "false");
    expect(bolt()!.getAttribute("title")).toContain("The first turn checks whether Fable 5.1 can run it.");
    expect(fastNote()).toBeNull();
    fireEvent.click(bolt()!);
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("setSessionOptions:"))).toBe(true));
    await waitFor(() => expect(store.getState().sessions.se1?.fastMode).toBe(true));
    expect(bolt()).toHaveAttribute("aria-pressed", "true");
    expect(fastNote()).toHaveTextContent("Fast mode is asked for — the first turn checks it.");
    // The line is the point, so pressing the bolt does not close the surface that says it.
    expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument();
  });

  it("is absent where Realm has no way to ask the harness at all", async () => {
    // Never a disabled bolt for an engine with no such concept: there is nothing to do about it.
    await mount([], { agentKind: "fake" });
    await openPicker();
    expect(bolt()).toBeNull();
    cleanup();
    await mount([], { agentKind: "acp:cursor" });
    await openPicker();
    expect(bolt()).toBeNull();
  });

  it("says the model cannot, and names the ones that can, where the harness said no", async () => {
    await mount([ev(init({ supportsFastMode: false }))], { model: "claude-opus-5" },
      { [MODEL_FAST_SUPPORT_KEY]: { "claude:claude-opus-5-5": true } });
    await openPicker();
    expect(bolt()).toHaveAttribute("aria-disabled", "true");
    expect(bolt()).toHaveAttribute("aria-pressed", "false");
    expect(bolt()!.getAttribute("title")).toBe("Fast mode isn’t offered on Opus 5 — Opus 5.5 offers it.");
  });

  it("shows what the session asked for once the harness says the model can", async () => {
    await mount([ev(init({ supportsFastMode: true }))], { fastMode: true, model: "claude-opus-5" });
    await openPicker();
    expect(bolt()).toHaveAttribute("aria-pressed", "true");
    // Asked for, confirmed, nothing reported yet: the honest note, not the first-turn one.
    expect(fastNote()).toHaveTextContent(/next turn/);
  });

  it("says what the harness DID, not what the bolt says", async () => {
    // The named mutant: rendering the note off `session.fastMode` alone.
    await mount([
      ev(init({ supportsFastMode: true })),
      ev(sessionEvent("usage", { costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1, fastMode: "off", fastModeReason: "free" })),
    ], { fastMode: true, model: "claude-opus-5" });
    await openPicker();
    expect(fastNote()).toHaveTextContent(/plan does not include it/);
    expect(bolt()).toHaveAttribute("aria-pressed", "true");
  });

  it("tells someone who just pressed it that it is coming, not that it failed", async () => {
    await mount([
      ev(init({ supportsFastMode: true })),
      ev(sessionEvent("usage", { costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1, fastMode: "off", fastModeReason: "sdk_opt_in_required", fastModeRequested: false })),
    ], { fastMode: true, model: "claude-opus-5" });
    await openPicker();
    expect(fastNote()).toHaveTextContent(/next turn/);
    expect(fastNote()).not.toHaveAttribute("data-tone");
  });

  it("still warns when the turn that was refused DID ask", async () => {
    await mount([
      ev(init({ supportsFastMode: true })),
      ev(sessionEvent("usage", { costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1, fastMode: "off", fastModeReason: "free", fastModeRequested: true })),
    ], { fastMode: true, model: "claude-opus-5" });
    await openPicker();
    expect(fastNote()).toHaveTextContent(/plan does not include/);
    expect(fastNote()).toHaveAttribute("data-tone", "warning");
  });

  it("stays quiet once it is genuinely serving", async () => {
    await mount([
      ev(init({ supportsFastMode: true })),
      ev(sessionEvent("usage", { costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1, fastMode: "on" })),
    ], { fastMode: true, model: "claude-opus-5" });
    await openPicker();
    expect(fastNote()).toBeNull();
  });
});

describe("the bolt before a session's first message", () => {
  const remembered = (answers: Record<string, boolean>) => ({ [MODEL_FAST_SUPPORT_KEY]: answers });
  const unchecked = () => bolt()!.getAttribute("title")!.includes("The first turn checks");

  it("is confirmed on what the last session on this model heard", async () => {
    const { api } = await mount([], { model: "claude-opus-5-5" }, remembered({ "claude:claude-opus-5-5": true }));
    await openPicker();
    expect(unchecked()).toBe(false); // nothing left to check
    fireEvent.click(bolt()!);
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("setSessionOptions:"))).toBe(true));
  });

  it("reads the harness default's own entry for a session with no model of its own", async () => {
    await mount([], { model: null }, remembered({ "claude:": true }));
    await openPicker();
    expect(bolt()).not.toHaveAttribute("aria-disabled");
    expect(unchecked()).toBe(false);
  });

  it("is not confirmed on another model's answer, and a remembered `no` is a no", async () => {
    await mount([], { model: "claude-sonnet-5" }, remembered({ "claude:claude-opus-5-5": true, "codex:claude-sonnet-5": true }));
    await openPicker();
    expect(unchecked()).toBe(true);
    cleanup();
    await mount([], { model: "claude-opus-5-5" }, remembered({ "claude:claude-opus-5-5": false }));
    await openPicker();
    expect(bolt()).toHaveAttribute("aria-disabled", "true");
    expect(bolt()!.getAttribute("title")).toBe("Fast mode isn’t offered on Opus 5.5.");
  });

  it("gives way to the session's own handshake the moment it has one", async () => {
    await mount([ev(init({ model: "claude-opus-5-5", supportsFastMode: false }))], { model: "claude-opus-5-5" }, remembered({ "claude:claude-opus-5-5": true }));
    await openPicker();
    expect(bolt()).toHaveAttribute("aria-disabled", "true");
  });

  it("picks up an answer another session hears while this one is open", async () => {
    // The server files it before it broadcasts the handshake; hearing ANY session's answer is the
    // store's cue to re-read, since the session that wants it is not the one that heard it.
    const { api, store } = await mount([], { model: "claude-opus-5-5" });
    await openPicker();
    expect(unchecked()).toBe(true);
    await api.setSetting(MODEL_FAST_SUPPORT_KEY, { "claude:claude-opus-5-5": true });
    act(() => store.getState().applySessionEvent({ seq: 1, sessionId: "elsewhere", event: init({ fastModeModels: { "claude-opus-5-5": true } }), ephemeral: false }));
    await waitFor(() => expect(unchecked()).toBe(false));
  });

  it("offers Codex's Fast tier from the probe's catalog, per model, in the catalog's own words", async () => {
    const codex: AgentProbe = { kind: "codex", available: true, version: "0.154.0", loggedIn: true, reason: null, models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", fastMode: true, fastDescription: "1.5x speed, increased usage", isDefault: true },
      { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", fastMode: false },
    ] };
    await mount([], { agentKind: "codex", model: null }, {}, [codex]);
    await openPicker();
    expect(bolt()).not.toHaveAttribute("aria-disabled"); // the marked default lists the tier
    expect(bolt()!.getAttribute("title")).toBe("Fast mode: 1.5x speed, increased usage.");
    cleanup();
    await mount([], { agentKind: "codex", model: "gpt-5.6-terra" }, {}, [codex]);
    await openPicker();
    expect(bolt()).toHaveAttribute("aria-disabled", "true");
    expect(bolt()!.getAttribute("title")).toBe("Fast mode isn’t offered on GPT-5.6-Terra — GPT-5.6-Sol offers it.");
  });
});

describe("the model chip", () => {
  const chip = () => screen.getByRole("button", { name: "Model" });

  it("wears a bolt beside the effort once the session asks for fast mode", async () => {
    await mount([ev(init({ supportsFastMode: true }))], { fastMode: true, effort: "high", model: "claude-opus-5" });
    expect(chip().querySelector(".chip-fast")).not.toBeNull();
    expect(chip()).toHaveTextContent(/High/);
    expect(chip().getAttribute("title")).toContain("fast mode");
  });

  it("wears it for a request the first turn will check, too", async () => {
    await mount([], { fastMode: true });
    expect(chip().querySelector(".chip-fast")).not.toBeNull();
  });

  it("does not claim a speed on a model that cannot run it, or after the turn that asked was refused", async () => {
    await mount([ev(init({ supportsFastMode: false }))], { fastMode: true, effort: "high", model: "claude-opus-5" });
    expect(chip().querySelector(".chip-fast")).toBeNull();
    cleanup();
    await mount([
      ev(init({ supportsFastMode: true })),
      ev(sessionEvent("usage", { costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1, fastMode: "off", fastModeReason: "free", fastModeRequested: true })),
    ], { fastMode: true, model: "claude-opus-5" });
    expect(chip().querySelector(".chip-fast")).toBeNull();
    expect(chip().getAttribute("title")).not.toContain("fast mode");
  });
});

describe("the init event", () => {
  it("a restated handshake replaces the one before it, carrying the capability forward", async () => {
    const { store } = await mount([
      ev(init({ tools: ["Read", "Write"] })),
      ev(init({ tools: ["Read", "Write"], supportsFastMode: true })),
    ]);
    const t = store.getState().transcripts.se1!.t;
    expect(t.init).toMatchObject({ providerSessionId: "p1", tools: ["Read", "Write"], supportsFastMode: true });
  });

  it("keeps the capability across a later handshake that says nothing about the same model", async () => {
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
