import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictationCleanResult } from "@realm/contracts";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, session } from "../state/store.test-fakes";
import { SessionPane } from "../panes/session/SessionPane";
import { reduceAll } from "../panes/session/transcript-model";
import type { DictationEvents } from "./dictation";
import type { DictationPort } from "./use-dictation";
import { DEFAULT_VOICE_PREFS, VOICE_PREFS_KEY, readVoicePrefs } from "./voice-prefs";

/** The recogniser, held by the test: what it hears is whatever the test says it heard. */
const mic = vi.hoisted(() => ({
  events: null as DictationEvents | null,
  stops: 0,
  cleaned: [] as unknown[][],
  clean: null as null | ((raw: string) => Promise<DictationCleanResult>),
}));

vi.mock("./use-dictation", async (actual) => {
  const real = await actual<typeof import("./use-dictation")>();
  return {
    ...real,
    desktopDictation: (deps: { clean: DictationPort["clean"] }): DictationPort => ({
      open: (events) => {
        mic.events = events;
        return { start: async () => events.partial(""), stop: () => { mic.stops += 1; }, cancel: () => {} };
      },
      clean: (...args: [string]) => { mic.cleaned.push(args); return mic.clean ? mic.clean(args[0]) : deps.clean(...args); },
    }),
  };
});

afterEach(() => { cleanup(); mic.events = null; mic.stops = 0; mic.cleaned = []; mic.clean = null; });

async function mount(cleanUp = false) {
  const api = fakeApi({
    sessions: [session("se1", "s1", { status: "idle", agentKind: "claude", model: "claude-opus-5-5" })],
    items: { s1: [item("i9", "s1", { kind: "session", refId: "se1", title: "s" })] },
  });
  if (cleanUp) api.data.settings[VOICE_PREFS_KEY] = { cleanUp: true };
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
  render(
    <StoreContext.Provider value={store}>
      <SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible />
    </StoreContext.Provider>,
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
  return { api, store };
}

const box = () => screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
const dictating = () => document.querySelector(".composer-highlight .ch-dictating")?.textContent ?? null;
const typeAt = (value: string, at: number) => {
  fireEvent.change(box(), { target: { value } });
  box().setSelectionRange(at, at);
  fireEvent.select(box());
};
const heard = (text: string) => act(() => mic.events!.partial(text));
const finished = async (text: string) => { await act(async () => { mic.events!.done(text); await new Promise((res) => setTimeout(res, 0)); }); };

describe("dictating into the prompter", () => {
  it("draws what is heard at the caret, apart from the typed text, and lands it there without touching what was typed", async () => {
    const { store } = await mount();
    typeAt("Fix  please", 4);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    expect(screen.getByRole("button", { name: "Stop dictating" }).getAttribute("aria-pressed")).toBe("true");
    heard("the login");
    expect(box().value).toBe("Fix the login please");
    expect(dictating()).toBe("the login");
    expect(box().readOnly).toBe(true);
    // Not in the draft yet: a partial is the recogniser's guess, not text.
    expect(store.getState().drafts["se1"]).toBe("Fix  please");
    heard("the login test");
    expect(dictating()).toBe("the login test");

    await finished("the login test");
    expect(store.getState().drafts["se1"]).toBe("Fix the login test please");
    expect(dictating()).toBeNull();
    expect(box().readOnly).toBe(false);
    expect(box().selectionStart).toBe("Fix the login test".length);
  });

  it("puts spaces where the words would otherwise run into a word already there", async () => {
    const { store } = await mount();
    typeAt("Runtests", 3);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await finished("the");
    expect(store.getState().drafts["se1"]).toBe("Run the tests");
  });

  it("stops on Esc and on a second click", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(mic.stops).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop dictating" }));
    expect(mic.stops).toBe(2);
  });

  it("with Clean up dictation off, which it is until turned on, asks no model and lands the raw words", async () => {
    expect(DEFAULT_VOICE_PREFS.cleanUp).toBe(false);
    expect(readVoicePrefs({ rate: 1.2 }).cleanUp).toBe(false);
    const { api, store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await finished("um fix the uh test");
    expect(api.calls.filter((c) => c.startsWith("cleanDictation"))).toEqual([]);
    expect(store.getState().drafts["se1"]).toBe("um fix the uh test");
    expect(screen.queryByText("Cleaned")).toBeNull();
  });

  it("with it on, lands the cleaned words, sends only the words, and says so quietly", async () => {
    const { store } = await mount(true);
    mic.clean = async () => ({ outcome: "cleaned", text: "Fix the test." });
    typeAt("Then: ", 6);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await finished("um fix the uh test");
    expect(mic.cleaned).toEqual([["um fix the uh test"]]);
    expect(store.getState().drafts["se1"]).toBe("Then: Fix the test.");
    expect(screen.getByRole("status").textContent).toContain("Cleaned");
  });

  it("goes through the store's switch to the server when the fake is not standing in", async () => {
    const { api } = await mount(true);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await finished("um fix it");
    expect(api.calls.filter((c) => c.startsWith("cleanDictation"))).toEqual(["cleanDictation:um fix it"]);
  });

  it("Undo puts back exactly what was heard", async () => {
    const { store } = await mount(true);
    mic.clean = async () => ({ outcome: "cleaned", text: "Fix the test." });
    typeAt("Then: ", 6);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await finished("um fix the uh test");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(store.getState().drafts["se1"]).toBe("Then: um fix the uh test");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("⌘Z puts back exactly what was heard, once", async () => {
    const { store } = await mount(true);
    mic.clean = async () => ({ outcome: "cleaned", text: "Fix the test." });
    typeAt("Then: and ship", 6);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await finished("um  fix the, uh, test");
    expect(store.getState().drafts["se1"]).toBe("Then: Fix the test. and ship");
    fireEvent.keyDown(box(), { key: "z", metaKey: true });
    expect(store.getState().drafts["se1"]).toBe("Then: um  fix the, uh, test and ship");
    // The note is gone, so the next ⌘Z is the box's own again.
    const second = fireEvent.keyDown(box(), { key: "z", metaKey: true });
    expect(second).toBe(true);
    expect(store.getState().drafts["se1"]).toBe("Then: um  fix the, uh, test and ship");
  });

  it("the note goes when the draft is typed into, or put away", async () => {
    const { store } = await mount(true);
    mic.clean = async () => ({ outcome: "cleaned", text: "Fix it." });
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await finished("um fix it");
    fireEvent.change(box(), { target: { value: "Fix it. now" } });
    expect(screen.queryByRole("status")).toBeNull();
    // Gone with it: ⌘Z no longer reaches back past the edit.
    fireEvent.keyDown(box(), { key: "z", metaKey: true });
    expect(store.getState().drafts["se1"]).toBe("Fix it. now");

    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await finished("um and more");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says when the raw words were kept because the clean-up drifted", async () => {
    const { store } = await mount(true);
    mic.clean = async (raw) => ({ outcome: "kept", text: raw, reason: "drifted" });
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await finished("rename the helper");
    expect(store.getState().drafts["se1"]).toBe("rename the helper");
    expect(screen.getByRole("status").textContent).toContain("Kept as heard: the clean-up changed too much");
  });

  it("leaves the session's model alone", async () => {
    const { api, store } = await mount(true);
    mic.clean = async () => ({ outcome: "cleaned", text: "Fix it." });
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await finished("um fix it");
    expect(store.getState().sessions["se1"]?.model).toBe("claude-opus-5-5");
    expect(api.calls.some((c) => /setOptions|setAgent|setModel/.test(c))).toBe(false);
  });
});
