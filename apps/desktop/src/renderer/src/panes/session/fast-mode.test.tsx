import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { createAppStore, StoreContext } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { reduceAll } from "./transcript-model";
import { SessionPane } from "./SessionPane";
import { fastModeNote, type FastMode } from "./ModelPicker";

afterEach(() => cleanup());

const fast = (over: Partial<FastMode> = {}): FastMode =>
  ({ on: false, state: null, reason: null, onChange: () => {}, ...over });

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
});

let seq = 0;
const ev = (e: ReturnType<typeof sessionEvent>) => ({ ...e, seq: ++seq });

async function mount(events: ReturnType<typeof sessionEvent>[], extra: Parameters<typeof session>[2] = {}) {
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "claude", ...extra })] });
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

  it("stays quiet once it is genuinely serving", async () => {
    await mount([
      ev(init({ supportsFastMode: true })),
      ev(sessionEvent("usage", { costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1, fastMode: "on" })),
    ], { fastMode: true });
    await openPicker();
    expect(document.querySelector(".mp-fast-note")).toBeNull();
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

  it("a handshake that says nothing about the capability leaves it unstated", async () => {
    const { store } = await mount([ev(init())]);
    expect(store.getState().transcripts.se1!.t.init).not.toHaveProperty("supportsFastMode");
  });
});
