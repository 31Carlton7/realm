import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ASSISTANT_CHORDS, KEYS_ASSISTANT_KEY, KEYS_DOUBLE_TAP_KEY, KEYS_DOUBLE_TAP_SIDE_KEY, KEYS_HOLD_KEY, MEETING_CONSENT_KEY, type GlobalKeysEvent, type GlobalKeysState } from "@realm/contracts";

/** The section reads and writes its four settings, reads the assistant's consent, over the socket and holds no store state for them. */
const stored: Record<string, unknown> = {};
const calls: { method: string; params: any }[] = [];
vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: () => () => {},
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "settings.get") return { key: params.key, value: stored[params.key] ?? null };
      if (method === "settings.set") { stored[params.key] = params.value; return {}; }
      throw new Error(`unexpected ${method}`);
    },
  }),
}));

import { GlobalKeysRows } from "./GlobalKeysSection";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

/** Main's side of the bridge: what the page asked of it, and a way to speak as the helper. */
function bridge(state: GlobalKeysState) {
  const asked: string[] = [];
  let onEvent: (event: GlobalKeysEvent) => void = () => {};
  let onState: (state: GlobalKeysState) => void = () => {};
  const keys = {
    state: async () => state,
    setDoubleTap: async (on: boolean) => { asked.push(`doubleTap:${on}`); },
    setDoubleTapSide: async (side: string) => { asked.push(`side:${side}`); },
    setHold: async (key: string) => { asked.push(`hold:${key}`); },
    setAssistant: async (on: boolean) => { asked.push(`assistant:${on}`); },
    watch: (on: boolean) => { asked.push(`watch:${on}`); },
    onEvent: (cb: typeof onEvent) => { onEvent = cb; return () => { onEvent = () => {}; }; },
    onState: (cb: typeof onState) => { onState = cb; return () => { onState = () => {}; }; },
  };
  (window as any).realm = { keys };
  return { asked, says: (event: GlobalKeysEvent) => act(() => onEvent(event)), becomes: (next: GlobalKeysState) => act(() => onState(next)) };
}

async function mount(api = fakeApi()) {
  calls.length = 0;
  const store = createAppStore(api);
  await store.getState().boot();
  const view = render(<StoreContext.Provider value={store}><ul><GlobalKeysRows /></ul></StoreContext.Provider>);
  await waitFor(() => expect(calls.filter((c) => c.method === "settings.get")).toHaveLength(5));
  return view;
}

const row = (id: string) => document.querySelector(`[data-setting="${id}"]`) as HTMLElement;
const sideRadio = (name: string) => within(row("double-tap-side")).getByRole("radio", { name });
const holdRadio = (name: string) => within(row("assistant-hold-key")).getByRole("radio", { name });
const tryKey = (key: string) => within(row("keys-try")).getByText(key).closest(".keys-try-key") as HTMLElement;

afterEach(() => {
  delete (window as any).realm;
  for (const key of Object.keys(stored)) delete stored[key];
});

describe("Settings ▸ Keys ▸ From anywhere", () => {
  it("is on, and on Fn, until somebody chooses otherwise", async () => {
    bridge("active");
    await mount();
    expect(screen.getByRole("switch", { name: "Double-tap Command opens the quick chat" })).toBeChecked();
    expect(holdRadio("Fn")).toBeChecked();
  });

  it("shows what was stored", async () => {
    stored[KEYS_DOUBLE_TAP_KEY] = false;
    stored[KEYS_HOLD_KEY] = "rightOption";
    bridge("active");
    await mount();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Double-tap Command opens the quick chat" })).not.toBeChecked());
    expect(holdRadio("Right Option")).toBeChecked();
  });

  it("stores the switch and tells main, so the helper follows without a relaunch", async () => {
    const { asked } = bridge("active");
    await mount();
    fireEvent.click(screen.getByRole("switch", { name: "Double-tap Command opens the quick chat" }));
    await waitFor(() => expect(stored[KEYS_DOUBLE_TAP_KEY]).toBe(false));
    expect(asked).toContain("doubleTap:false");
  });

  it("stores the held key and tells main", async () => {
    const { asked } = bridge("active");
    await mount();
    fireEvent.click(holdRadio("Right Command"));
    await waitFor(() => expect(stored[KEYS_HOLD_KEY]).toBe("rightCommand"));
    expect(asked).toContain("hold:rightCommand");
    expect(within(row("keys-try")).getByText("Right Command")).toBeInTheDocument();
  });

  it("watches while it is on screen and stops when it leaves", async () => {
    const { asked } = bridge("active");
    const view = await mount();
    expect(asked).toEqual(["watch:true"]);
    view.unmount();
    expect(asked.at(-1)).toBe("watch:false");
  });

  it("asks main to look again when the window comes back to the front", async () => {
    const { asked } = bridge("listening");
    await mount();
    fireEvent(window, new Event("focus"));
    expect(asked).toEqual(["watch:true", "watch:true"]);
  });

  it("Try it says nothing was seen until a key arrives, then says which", async () => {
    const { says } = bridge("active");
    await mount();
    expect(tryKey("⌘⌘")).toHaveTextContent("Not seen yet");
    expect(tryKey("Fn")).toHaveTextContent("Not seen yet");

    says({ t: "hold", down: true });
    expect(tryKey("Fn")).toHaveTextContent("Held");
    expect(tryKey("Fn")).toHaveAttribute("data-lit");
    says({ t: "hold", down: false });
    expect(tryKey("Fn")).toHaveTextContent("Seen");
    expect(tryKey("Fn")).not.toHaveAttribute("data-lit");
    expect(tryKey("⌘⌘")).toHaveTextContent("Not seen yet");

    says({ t: "doubleTap" });
    expect(tryKey("⌘⌘")).toHaveTextContent("Seen");
    expect(tryKey("⌘⌘")).toHaveAttribute("data-lit");
  });

  it("forgets the held key it saw when another is chosen", async () => {
    const { says } = bridge("active");
    await mount();
    says({ t: "hold", down: true });
    fireEvent.click(holdRadio("Right Option"));
    await waitFor(() => expect(tryKey("Right Option")).toHaveTextContent("Not seen yet"));
  });

  it("draws no Accessibility line while macOS holds nothing back", async () => {
    bridge("active");
    await mount();
    await waitFor(() => expect(tryKey("Fn")).toBeInTheDocument());
    expect(row("keys-access")).toBeNull();
  });

  it("without Accessibility, says what still works and opens the Accessibility pane", async () => {
    bridge("listening");
    const api = fakeApi();
    const openTccPane = vi.spyOn(api, "openTccPane");
    await mount(api);
    await waitFor(() => expect(row("keys-access")).not.toBeNull());
    expect(row("keys-access")).toHaveTextContent("Realm needs Accessibility");
    expect(row("keys-access")).toHaveTextContent("Double-tap Command works as it is.");
    expect(tryKey("⌘⌘")).toBeInTheDocument();
    fireEvent.click(within(row("keys-access")).getByRole("button", { name: "Open System Settings" }));
    await waitFor(() => expect(openTccPane).toHaveBeenCalledWith("accessibility"));
  });

  describe("the Command key to double-tap", () => {
    const siri = "Siri can be set to a double-tap of Right Command too. If both answer it, pick Left Command.";

    it("is Left Command until somebody chooses otherwise, with no word of Siri and Try it naming it", async () => {
      bridge("active");
      await mount();
      expect(sideRadio("Left Command")).toBeChecked();
      expect(sideRadio("Right Command")).not.toBeChecked();
      expect(sideRadio("Either")).not.toBeChecked();
      expect(row("double-tap-side")).not.toHaveTextContent("Siri");
      expect(row("double-tap-command")).toHaveAttribute("title", expect.stringContaining("Tap Left Command twice"));
      expect(row("keys-try")).toHaveTextContent("Double-tap Left Command, or hold Fn, and it shows here.");
    });

    it("shows what was stored, and the Siri line with it", async () => {
      stored[KEYS_DOUBLE_TAP_SIDE_KEY] = "either";
      bridge("active");
      await mount();
      await waitFor(() => expect(sideRadio("Either")).toBeChecked());
      expect(row("double-tap-side")).toHaveTextContent(siri);
      expect(row("keys-try")).toHaveTextContent("Double-tap either Command key, or hold Fn");
    });

    it("reads a value it does not know as Left", async () => {
      stored[KEYS_DOUBLE_TAP_SIDE_KEY] = "both";
      bridge("active");
      await mount();
      expect(sideRadio("Left Command")).toBeChecked();
    });

    it("stores each choice and tells main, and says Siri only off Left", async () => {
      const { asked } = bridge("active");
      await mount();
      fireEvent.click(sideRadio("Right Command"));
      await waitFor(() => expect(stored[KEYS_DOUBLE_TAP_SIDE_KEY]).toBe("right"));
      expect(asked).toContain("side:right");
      expect(row("double-tap-side")).toHaveTextContent(siri);
      expect(row("double-tap-command")).toHaveAttribute("title", expect.stringContaining("Tap Right Command twice"));
      expect(row("keys-try")).toHaveTextContent("Double-tap Right Command, or hold Fn");

      fireEvent.click(sideRadio("Either"));
      await waitFor(() => expect(stored[KEYS_DOUBLE_TAP_SIDE_KEY]).toBe("either"));
      expect(asked).toContain("side:either");
      expect(row("double-tap-side")).toHaveTextContent(siri);

      fireEvent.click(sideRadio("Left Command"));
      await waitFor(() => expect(stored[KEYS_DOUBLE_TAP_SIDE_KEY]).toBe("left"));
      expect(asked.at(-1)).toBe("side:left");
      expect(row("double-tap-side")).not.toHaveTextContent("Siri");
    });

    it("forgets the double-tap Try it saw when another key is chosen", async () => {
      const { says } = bridge("active");
      await mount();
      says({ t: "doubleTap" });
      expect(tryKey("⌘⌘")).toHaveTextContent("Seen");
      fireEvent.click(sideRadio("Either"));
      await waitFor(() => expect(tryKey("⌘⌘")).toHaveTextContent("Not seen yet"));
    });

    it("leaves the switch as it was: the side and the switch are two settings", async () => {
      bridge("active");
      await mount();
      fireEvent.click(sideRadio("Right Command"));
      await waitFor(() => expect(stored[KEYS_DOUBLE_TAP_SIDE_KEY]).toBe("right"));
      expect(stored[KEYS_DOUBLE_TAP_KEY]).toBeUndefined();
      expect(screen.getByRole("switch", { name: "Double-tap Command opens the quick chat" })).toBeChecked();
    });
  });

  it("with Accessibility and no Input Monitoring, names Input Monitoring, opens its pane and offers nothing to try", async () => {
    const { becomes } = bridge("needsInputMonitoring");
    const api = fakeApi();
    const openTccPane = vi.spyOn(api, "openTccPane");
    await mount(api);
    await waitFor(() => expect(row("keys-access")).not.toBeNull());
    expect(row("keys-access")).toHaveTextContent("Realm needs Input Monitoring");
    expect(row("keys-access")).toHaveTextContent("the double-tap does nothing");
    expect(row("keys-access")).not.toHaveTextContent("Accessibility");
    expect(row("keys-try")).toHaveTextContent("Realm is not seeing keys right now.");
    expect(row("keys-try").querySelector(".keys-try")).toBeNull();
    fireEvent.click(within(row("keys-access")).getByRole("button", { name: "Open System Settings" }));
    await waitFor(() => expect(openTccPane).toHaveBeenCalledWith("inputMonitoring"));

    becomes("active");
    expect(row("keys-access")).toBeNull();
    expect(tryKey("⌘⌘")).toBeInTheDocument();
  });

  it("with no access at all, says neither works and offers nothing to try", async () => {
    const { becomes } = bridge("denied");
    await mount();
    await waitFor(() => expect(row("keys-access")).toHaveTextContent("neither of these works"));
    expect(row("keys-try")).toHaveTextContent("Realm is not seeing keys right now.");
    expect(row("keys-try").querySelector(".keys-try")).toBeNull();

    becomes("active");
    expect(row("keys-access")).toBeNull();
    expect(tryKey("⌘⌘")).toBeInTheDocument();
  });
});

describe("Settings ▸ Keys ▸ the assistant's shortcuts", () => {
  const chordRows = () => ASSISTANT_CHORDS.map(({ key }) => row(`assistant-chord:${key}`));

  it("is on, and lists every chord with the held key", async () => {
    bridge("active");
    await mount();
    expect(screen.getByRole("switch", { name: "Assistant shortcuts" })).toBeChecked();
    expect(chordRows().map((r) => r.textContent)).toEqual([
      "Show or hide the assistantFn R", "Start or stop listeningFn L", "Answer what was just askedFn G", "Type a questionFn T",
      "Scroll downFn J", "Scroll upFn K", "Move the panel leftFn ,", "Move the panel rightFn .",
    ]);
  });

  it("names the held key that was chosen", async () => {
    stored[KEYS_HOLD_KEY] = "rightCommand";
    bridge("active");
    await mount();
    await waitFor(() => expect(row("assistant-chord:R").textContent).toBe("Show or hide the assistantRight Command R"));
    fireEvent.click(holdRadio("Right Option"));
    expect(row("assistant-chord:G").textContent).toBe("Answer what was just askedRight Option G");
  });

  it("stores the switch and tells main, and lists no chord while it is off", async () => {
    const { asked } = bridge("active");
    await mount();
    fireEvent.click(screen.getByRole("switch", { name: "Assistant shortcuts" }));
    await waitFor(() => expect(stored[KEYS_ASSISTANT_KEY]).toBe(false));
    expect(asked).toContain("assistant:false");
    expect(chordRows().every((r) => r === null)).toBe(true);
  });

  it("says the keys wait on the assistant's first Start until its sheet is accepted", async () => {
    bridge("active");
    await mount();
    const waiting = "They start working after your first Start in the meeting assistant.";
    await waitFor(() => expect(row("assistant-chords").textContent).toContain(waiting));
    cleanup();
    stored[MEETING_CONSENT_KEY] = 1_700_000_000_000;
    await mount();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Assistant shortcuts" })).toBeChecked());
    expect(row("assistant-chords").textContent).not.toContain(waiting);
  });

  it("says nothing of the first Start while the switch is off", async () => {
    stored[KEYS_ASSISTANT_KEY] = false;
    bridge("active");
    await mount();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Assistant shortcuts" })).not.toBeChecked());
    expect(row("assistant-chords").querySelector(".settings-row-desc")).toBeNull();
  });

  it("shows it off when it was stored off", async () => {
    stored[KEYS_ASSISTANT_KEY] = false;
    bridge("active");
    await mount();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Assistant shortcuts" })).not.toBeChecked());
  });
});
