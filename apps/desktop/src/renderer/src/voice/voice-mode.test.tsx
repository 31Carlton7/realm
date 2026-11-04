import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, profile, session, space, teammate } from "../state/store.test-fakes";
import { emptyTranscript, reduceTranscript } from "../panes/session/transcript-model";
import { HOLD_MS, VoiceButton } from "./VoiceButton";
import { STARTING, VoiceControls, VoiceView, captionOf } from "./VoiceView";
import { speechBands } from "./audio-io";
import { DEFAULT_VOICE_PREFS, VOICE_PREFS_KEY, readVoicePrefs } from "./voice-prefs";

afterEach(() => { vi.useRealTimers(); cleanup(); });

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

  it("keeps a chosen microphone, and listens with the default for anything else", () => {
    expect(readVoicePrefs({ microphone: "built-in-id" }).microphone).toBe("built-in-id");
    expect(readVoicePrefs({ microphone: "" }).microphone).toBeNull();
    expect(readVoicePrefs({ microphone: 3 }).microphone).toBeNull();
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

describe("the caption under the bars", () => {
  const at = { ...STARTING, heard: "What is two plus two?", said: "It is four." };
  it("is the words heard, then the question while the agent works, then the sentence being spoken", () => {
    expect(captionOf({ ...at, phase: "hearing", partial: "what is two" })).toEqual({ text: "what is two", tone: "live" });
    expect(captionOf({ ...at, phase: "working", said: null })).toEqual({ text: "What is two plus two?", tone: "quiet" });
    expect(captionOf({ ...at, phase: "speaking" })).toEqual({ text: "It is four.", tone: "live" });
  });
  it("sits under the bars, so nothing above them changes when it appears", async () => {
    const { store } = await mount();
    store.getState().openVoice("a", false);
    render(<StoreContext.Provider value={store}><VoiceView /></StoreContext.Provider>);
    // THE MUTANT: the caption or the line moved above the bars, where its height would push them down.
    const stage = [...document.querySelector(".voice-stage")!.children].map((el) => el.className);
    expect(stage.slice(0, 3)).toEqual(["voice-bars", "voice-caption", "voice-state"]);
  });
  it("is empty while Realm only listens", () => {
    // THE MUTANT: the last reply stays up — a stale sentence reads as the prompt for the next turn.
    expect(captionOf({ ...at, phase: "listening" }).text).toBe("");
  });
});

describe("speechBands", () => {
  it("puts a low voice in the low band and a hiss in the high one", () => {
    const hzPerBin = 48_000 / 1024;
    const bins = new Uint8Array(512);
    bins[Math.round(150 / hzPerBin)] = 255;
    const out = new Float32Array(5);
    speechBands(bins, hzPerBin, out);
    expect(out[0]).toBeGreaterThan(0);
    expect(out.slice(1).every((v) => v === 0)).toBe(true);
    bins.fill(0);
    bins[Math.round(3_500 / hzPerBin)] = 255;
    speechBands(bins, hzPerBin, out);
    expect(out[4]).toBeGreaterThan(0);
    expect(out.slice(0, 4).every((v) => v === 0)).toBe(true);
  });
});

describe("the controls at the foot", () => {
  const controls = (over: Partial<typeof STARTING>) => {
    const fns = { onMute: vi.fn(), onStop: vi.fn(), onPress: vi.fn(), onRelease: vi.fn(), onEnd: vi.fn() };
    const view = render(<VoiceControls snap={{ ...STARTING, phase: "listening", ...over }} ready {...fns} />);
    return { ...view, ...fns };
  };

  it("say Mute while the microphone is live, and Unmute on a filled disc with a struck mic while it is not", () => {
    const live = controls({});
    const mute = live.getByRole("button", { name: "Mute" });
    // THE MUTANT: the glyph is the action (a struck mic) rather than the state — both discs read "off".
    expect(mute.dataset.on).toBeUndefined();
    const liveGlyph = mute.querySelector("svg")!.innerHTML;
    live.unmount();
    const muted = controls({ muted: true });
    const unmute = muted.getByRole("button", { name: "Unmute" });
    expect(unmute.dataset.on).toBe("true");
    expect(unmute.querySelector("svg")!.innerHTML).not.toBe(liveGlyph);
    fireEvent.click(unmute);
    expect(muted.onMute).toHaveBeenCalledOnce();
  });

  it("offer Talk while Realm listens, and Stop while it works or speaks", () => {
    const listening = controls({});
    expect(listening.getByRole("button", { name: "Talk" })).toBeTruthy();
    expect(listening.queryByRole("button", { name: "Stop" })).toBeNull();
    listening.unmount();
    for (const phase of ["working", "speaking"] as const) {
      const busy = controls({ phase });
      fireEvent.click(busy.getByRole("button", { name: "Stop" }));
      expect(busy.onStop).toHaveBeenCalledOnce();
      expect(busy.queryByRole("button", { name: "Talk" })).toBeNull();
      busy.unmount();
    }
  });

  it("end on a key of its own, named for what it does", () => {
    const { getByRole, onEnd } = controls({});
    const end = getByRole("button", { name: "End voice mode" });
    expect(end.dataset.key).toBe("end");
    expect(end.textContent).toBe("End");
    fireEvent.click(end);
    expect(onEnd).toHaveBeenCalledOnce();
  });
});

describe("the head", () => {
  it("is the teammate, by its blob and name, in a teammate's chat; the session's crumb otherwise", async () => {
    const { store } = await mount();
    store.setState({ teammates: { s1: [teammate("mina", "s1", { name: "Mina", homeSessionId: "a" })] } });
    store.getState().openVoice("a", false);
    render(<StoreContext.Provider value={store}><VoiceView /></StoreContext.Provider>);
    const head = document.querySelector(".voice-head")!;
    expect(head.querySelector(".voice-name")?.textContent).toBe("Mina");
    expect(head.querySelector(".voice-space-name")).toBeNull();
    expect(document.querySelector(".voice-view")?.getAttribute("aria-label")).toBe("Voice with Mina");
    act(() => store.setState({ teammates: { s1: [] } }));
    expect(head.querySelector(".voice-space-name")?.textContent).toBe("Realm");
    expect(head.querySelector(".voice-name")?.textContent).toBe("Fake agent session");
  });
});
