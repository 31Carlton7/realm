import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { createAppStore, StoreContext, type AgentProbe, type SessionOptions } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { reduceAll } from "./transcript-model";
import { SessionPane } from "./SessionPane";

afterEach(() => cleanup());

/** What the switch's tooltip says wherever Ultracode can run. */
const TIP = "Claude plans a workflow of sub-agents for every substantial task. It uses many more tokens.";

/** A Claude session's pane over a transcript built from `events`, mounted as the fast-mode suite
 *  mounts one. */
async function mount(events: ReturnType<typeof sessionEvent>[], extra: Parameters<typeof session>[2] = {}, agentProbe?: AgentProbe[]) {
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "claude", ...extra })], ...(agentProbe ? { agentProbe } : {}) });
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
const chip = () => screen.getByRole("button", { name: "Model" });
const row = () => document.querySelector<HTMLLabelElement>(".mp-ultracode");
const toggle = () => screen.queryByRole("switch", { name: "Ultracode" }) as HTMLInputElement | null;
/** The line under the track. Fast mode holds it open, and it carries Ultracode's note when fast mode
 *  has none. */
const line = () => document.querySelector(".mp-fast-note");

describe("the prompter's Ultracode switch", () => {
  it("is on a Claude session's card before the harness has said anything, off and free to press", async () => {
    await mount([]);
    await openPicker();
    expect(toggle()).toBeEnabled();
    expect(toggle()).not.toBeChecked();
    expect(line()!.textContent).toBe("");
  });

  it("says, before the harness has said anything, that the first turn checks whether the session can run it", async () => {
    await mount([]);
    await openPicker();
    expect(row()!.getAttribute("title")).toBe(`${TIP} The first turn checks whether this session can run it.`);
  });

  it("reaches the store as one option of the session when a person presses it, on and then off", async () => {
    const { api, store } = await mount([]);
    const asked: SessionOptions[] = [];
    const set = api.setSessionOptions;
    api.setSessionOptions = async (id, o) => { asked.push(o); return set(id, o); };
    await openPicker();
    fireEvent.click(toggle()!);
    await waitFor(() => expect(store.getState().sessions.se1?.ultracode).toBe(true));
    expect(asked).toEqual([{ ultracode: true }]);
    await waitFor(() => expect(toggle()).toBeChecked());
    fireEvent.click(toggle()!);
    await waitFor(() => expect(store.getState().sessions.se1?.ultracode).not.toBe(true));
    expect(asked).toEqual([{ ultracode: true }, { ultracode: false }]);
    await waitFor(() => expect(toggle()).not.toBeChecked());
  });

  it("leaves its card as it was through a press: the same row, the same line under the track, and the picker still open", async () => {
    await mount([]);
    await openPicker();
    const before = { row: row(), line: line(), foot: [...document.querySelector(".mp-foot")!.children].map((c) => c.className) };
    fireEvent.click(toggle()!);
    await waitFor(() => expect(toggle()).toBeChecked());
    expect(row()).toBe(before.row);
    expect(line()).toBe(before.line);
    expect(line()!.textContent).toBe("");
    expect([...document.querySelector(".mp-foot")!.children].map((c) => c.className)).toEqual(before.foot);
    expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument();
  });

  it("puts its mark on the chip, and its name at the end of the chip's tooltip, for as long as the session asks for it", async () => {
    const { store } = await mount([], { ultracode: true, effort: "high", model: "claude-opus-5" });
    expect(chip().querySelector(".chip-ultracode")).not.toBeNull();
    expect(chip().getAttribute("title")).toBe("Claude Opus 5 through Claude · High effort · Ultracode");
    await act(async () => { await store.getState().setSessionOptions("se1", { ultracode: false }); });
    expect(chip().querySelector(".chip-ultracode")).toBeNull();
    expect(chip().getAttribute("title")).toBe("Claude Opus 5 through Claude · High effort");
  });

  it("is not drawn for an agent Realm cannot ask, on a card that agent does have", async () => {
    const codex: AgentProbe = { kind: "codex", available: true, version: "0.154.0", loggedIn: true, reason: null,
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", fastMode: true, isDefault: true }] };
    await mount([], { agentKind: "codex", model: null, ultracode: true }, [codex]);
    await openPicker();
    expect(screen.getByRole("button", { name: "Fast mode" })).toBeInTheDocument();
    expect(row()).toBeNull();
    expect(toggle()).toBeNull();
    expect(chip().querySelector(".chip-ultracode")).toBeNull();
  });

  it("is on and says only what Ultracode is once the harness says this session can run it", async () => {
    await mount([init({ ultracodeAvailable: true })], { ultracode: true, model: "claude-opus-5" });
    await openPicker();
    expect(toggle()).toBeEnabled();
    expect(toggle()).toBeChecked();
    expect(row()!.getAttribute("title")).toBe(TIP);
    expect(line()!.textContent).toBe("");
  });

  it("is off and cannot be pressed once Claude Code says the session cannot run it, though the session asks for it", async () => {
    await mount([init({ ultracodeAvailable: false })], { ultracode: true, model: "claude-opus-5" });
    await openPicker();
    expect(toggle()).toBeDisabled();
    expect(toggle()).not.toBeChecked();
    expect(row()!.getAttribute("title")).toBe("Claude Code says this session can’t run Ultracode.");
  });

  it("is off and cannot be pressed for a session pinned to a model id with a bracketed variant, once Claude Code says that session cannot run it", async () => {
    await mount([init({ model: "claude-opus-5-5[1m]", ultracodeAvailable: false })], { ultracode: true, model: "claude-opus-5-5[1m]" });
    await openPicker();
    expect(toggle()).toBeDisabled();
    expect(toggle()).not.toBeChecked();
  });

  it("takes its mark off the chip once Claude Code says the session cannot run what it asks for", async () => {
    await mount([init({ ultracodeAvailable: false })], { ultracode: true, model: "claude-opus-5" });
    expect(chip().querySelector(".chip-ultracode")).toBeNull();
    expect(chip().getAttribute("title")).not.toContain("Ultracode");
  });

  it("says on the line under the track that a request Claude Code refused is not running, in the warning tone", async () => {
    await mount([init({ ultracodeAvailable: false })], { ultracode: true, model: "claude-opus-5" });
    await openPicker();
    expect(line()).toHaveTextContent("Ultracode isn’t running. Claude Code says this session can’t run it.");
    expect(line()).toHaveAttribute("data-tone", "warning");
  });

  it("says nothing on the line under a refused switch that was never pressed", async () => {
    await mount([init({ ultracodeAvailable: false })], { model: "claude-opus-5" });
    await openPicker();
    expect(toggle()).toBeDisabled();
    expect(line()!.textContent).toBe("");
    expect(line()).not.toHaveAttribute("data-tone");
  });

  it("does not take a refusal that was about another model for one about the model the session asks for", async () => {
    await mount([init({ model: "claude-sonnet-5", ultracodeAvailable: false })], { ultracode: true, model: "claude-opus-5" });
    await openPicker();
    expect(toggle()).toBeEnabled();
    expect(toggle()).toBeChecked();
    expect(row()!.getAttribute("title")).toBe(`${TIP} The first turn checks whether this session can run it.`);
  });

  it("stays refused through the next turn's plain handshake for the same model", async () => {
    const { store } = await mount([init({ ultracodeAvailable: false })], { model: "claude-opus-5" });
    await openPicker();
    act(() => store.getState().applySessionEvent({ seq: 1, sessionId: "se1", event: init({ providerSessionId: "p2" }), ephemeral: false }));
    expect(store.getState().transcripts.se1!.t.init).toMatchObject({ providerSessionId: "p2", ultracodeAvailable: false });
    expect(toggle()).toBeDisabled();
  });

  it("is a request again once the session has moved to another model and that model's handshake has said nothing", async () => {
    const { store } = await mount([init({ ultracodeAvailable: false })], { model: "claude-opus-5" });
    await openPicker();
    expect(toggle()).toBeDisabled();
    await act(async () => { await store.getState().setSessionOptions("se1", { model: "claude-sonnet-5" }); });
    act(() => store.getState().applySessionEvent({ seq: 1, sessionId: "se1", event: init({ model: "claude-sonnet-5" }), ephemeral: false }));
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(store.getState().transcripts.se1!.t.init).not.toHaveProperty("ultracodeAvailable");
    expect(row()!.getAttribute("title")).toBe(`${TIP} The first turn checks whether this session can run it.`);
  });

  it("is off and cannot be pressed in Ask mode, whatever the harness offered", async () => {
    await mount([init({ ultracodeAvailable: true })], { ultracode: true, model: "claude-opus-5", permissionMode: "ask" });
    await openPicker();
    expect(toggle()).toBeDisabled();
    expect(toggle()).not.toBeChecked();
    expect(row()!.getAttribute("title")).toBe("Ask mode can’t start a workflow.");
    expect(chip().querySelector(".chip-ultracode")).toBeNull();
  });

  it("says on the line under the track that a request is not running in Ask mode, in the warning tone", async () => {
    await mount([init({ ultracodeAvailable: true })], { ultracode: true, model: "claude-opus-5", permissionMode: "ask" });
    await openPicker();
    expect(line()).toHaveTextContent("Ultracode isn’t running. Ask mode can’t start a workflow.");
    expect(line()).toHaveAttribute("data-tone", "warning");
  });

  it("is on again when the session leaves Ask, because the session kept the request", async () => {
    const { store } = await mount([init({ ultracodeAvailable: true })], { ultracode: true, model: "claude-opus-5", permissionMode: "ask" });
    await openPicker();
    expect(toggle()).not.toBeChecked();
    await act(async () => { await store.getState().setSessionOptions("se1", { permissionMode: "default" }); });
    expect(store.getState().sessions.se1?.ultracode).toBe(true);
    expect(toggle()).toBeEnabled();
    expect(toggle()).toBeChecked();
    expect(line()!.textContent).toBe("");
    expect(chip().querySelector(".chip-ultracode")).not.toBeNull();
  });

  it("leaves the line to fast mode when fast mode has something to say about its own request", async () => {
    await mount([init({ ultracodeAvailable: false })], { ultracode: true, fastMode: true, model: "claude-opus-5" });
    await openPicker();
    expect(line()).toHaveTextContent("Fast mode is asked for — the first turn checks it.");
    expect(line()).not.toHaveAttribute("data-tone");
  });
});
