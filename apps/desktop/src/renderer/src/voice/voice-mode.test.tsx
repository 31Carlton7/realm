import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionEvent } from "@realm/contracts";
import { createAppStore } from "../state/store";
import { fakeApi, item, profile, session, space } from "../state/store.test-fakes";
import { emptyTranscript, reduceTranscript } from "../panes/session/transcript-model";
import { HOLD_MS, VoiceButton } from "./VoiceButton";
import { DEFAULT_VOICE_PREFS, VOICE_PREFS_KEY, readVoicePrefs } from "./voice-prefs";

afterEach(() => { vi.useRealTimers(); });

async function mount() {
  const api = fakeApi({
    profiles: [profile("p1", "Me")],
    spaces: [space("s1", "p1", "Realm")],
    items: { s1: [item("i1", "s1", { kind: "session", refId: "a", title: "A" })] },
    sessions: [session("a", "s1")],
  });
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
}

describe("voice mode in the store", () => {
  it("sends what was heard as a spoken message, with no draft or chips riding along", async () => {
    const { api, store } = await mount();
    store.getState().setDraft("a", "half-typed thought");
    await store.getState().sendSpoken("a", "What changed today?");
    // THE MUTANT: voice mode goes through `sendMessage` — the draft is sent instead, or with it.
    expect(api.sent).toEqual([{ id: "a", text: "What changed today?", attachments: [], spoken: true }]);
    expect(store.getState().drafts["a"]).toBe("half-typed thought");
  });

  it("opens over the window and takes the media viewer's place, and keeps its settings as one row", async () => {
    const { api, store } = await mount();
    store.getState().openVoice("a", true);
    expect(store.getState().voice).toEqual({ sessionId: "a", held: true });
    await store.getState().setVoicePrefs({ endOfTurnMs: 1200 });
    expect(api.data.settings[VOICE_PREFS_KEY]).toEqual({ ...DEFAULT_VOICE_PREFS, endOfTurnMs: 1200 });
    store.getState().closeVoice();
    expect(store.getState().voice).toBeNull();
  });
});

describe("readVoicePrefs", () => {
  it("falls back to the default for anything missing or out of range", () => {
    expect(readVoicePrefs(null)).toEqual(DEFAULT_VOICE_PREFS);
    // THE MUTANT: no clamp — a stored 0 ms pause sends after every syllable.
    expect(readVoicePrefs({ endOfTurnMs: 0, rate: 9, voice: "", handsFree: "yes" })).toEqual({ ...DEFAULT_VOICE_PREFS, endOfTurnMs: 400, rate: 1.5 });
  });
});

describe("the spoken mark", () => {
  it("rides from the event to the transcript's message, and only on a spoken one", () => {
    const spoken = reduceTranscript(emptyTranscript(), sessionEvent("user_message", { text: "hi", attachments: [], spoken: true }));
    expect(spoken.blocks[0]).toMatchObject({ kind: "user", text: "hi", spoken: true });
    const typed = reduceTranscript(emptyTranscript(), sessionEvent("user_message", { text: "hi", attachments: [] }));
    expect(typed.blocks[0]).not.toHaveProperty("spoken");
  });
});

describe("VoiceButton", () => {
  it("opens hands-free on a click, and already talking on a press held past the threshold", () => {
    vi.useFakeTimers();
    const onVoice = vi.fn();
    const { getByRole } = render(<VoiceButton name="Mina" onVoice={onVoice} />);
    const mic = getByRole("button", { name: "Voice mode" });
    expect(mic.title).toBe("Talk with Mina (hold to talk)");
    fireEvent.pointerDown(mic, { button: 0 });
    fireEvent.click(mic);
    expect(onVoice.mock.calls).toEqual([[false]]);
    fireEvent.pointerDown(mic, { button: 0 });
    act(() => { vi.advanceTimersByTime(HOLD_MS + 10); });
    // THE MUTANT: the release's click opens it a second time, hands-free, over the held turn.
    fireEvent.click(mic);
    expect(onVoice.mock.calls).toEqual([[false], [true]]);
  });
});
