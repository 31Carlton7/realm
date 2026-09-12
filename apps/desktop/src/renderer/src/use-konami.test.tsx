import { describe, expect, it } from "vitest";
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { NOTIFICATIONS_SOUND_KEY } from "@realm/contracts";
import { useKonami } from "./use-konami";
import { createAppStore } from "./state/store";
import { fakeApi } from "./state/store.test-fakes";

const EGGS = "ui.easterEggs";
const UNLOCKED = "ui.konamiUnlocked";

/** Real store + the hook, driven by window KeyboardEvents — exactly what App.tsx mounts. */
async function mount(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(over);
  const store = createAppStore(api);
  await store.getState().boot();
  renderHook(() => useKonami(store));
  return { api, store };
}

const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
/** `fireEvent` hands back false for an event something called preventDefault on. */
const type = (keys: string[], target: Element | Window = window) => keys.map((key) => fireEvent.keyDown(target, { key }));
/** Let the unlock's promise chain settle, so a "nothing happened" assertion is about the code. */
const tick = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("the sequence", () => {
  it("pays out the palette, and a sound, with the switch on", async () => {
    const { api, store } = await mount({ settings: { [EGGS]: true } });
    type(KONAMI);
    await waitFor(() => expect(store.getState().konamiUnlocked).toBe(true));
    expect(api.data.settings[UNLOCKED]).toBe(true);
    expect(api.calls.some((c) => c.startsWith("playCue:chime"))).toBe(true);
  });

  it("does nothing at all with the eggs off", async () => {
    const { api, store } = await mount();
    expect(store.getState().easterEggs).toBe(false);
    type(KONAMI);
    await tick();
    expect(store.getState().konamiUnlocked).toBe(false);
    expect(api.data.settings[UNLOCKED]).toBeUndefined();
  });

  it("reaches a window that was already open when the switch was flipped", async () => {
    // THE mounted-once mutant: read the flag where the effect is set up rather than inside the
    // handler. The listener would be the one built at boot, with the switch off baked into it, and
    // the egg would not exist until the app was restarted.
    const { store } = await mount();
    await act(async () => { await store.getState().setEasterEggs(true); });
    type(KONAMI);
    await waitFor(() => expect(store.getState().konamiUnlocked).toBe(true));
  });

  it("lands while the caret is in a text field, where a hotkey binding would be swallowed", async () => {
    // hotkeys.ts drops anything typed into an editable target, which is right for ⌘K and wrong here:
    // the sequence has to work wherever the person happens to be.
    const { store } = await mount({ settings: { [EGGS]: true } });
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    type(KONAMI, field);
    await waitFor(() => expect(store.getState().konamiUnlocked).toBe(true));
    field.remove();
  });

  it("never eats the keys it is watching", async () => {
    // THE preventDefault mutant: consume the match, or worse, every arrow on the way to it. Arrow
    // keys move a selection, a caret and the transcript's scroll — an egg that ate them would be a
    // bug people hit long before they found it.
    await mount({ settings: { [EGGS]: true } });
    expect(type(KONAMI).every(Boolean)).toBe(true);
  });

  it("takes the letters however shift left them", async () => {
    const { store } = await mount({ settings: { [EGGS]: true } });
    type([...KONAMI.slice(0, 8), "B", "A"]);
    await waitFor(() => expect(store.getState().konamiUnlocked).toBe(true));
  });

  it("a near miss unlocks nothing, and the clean run after it still does", async () => {
    const { store } = await mount({ settings: { [EGGS]: true } });
    type([...KONAMI.slice(0, 9), "c"]);
    await tick();
    expect(store.getState().konamiUnlocked).toBe(false);
    type(KONAMI);
    await waitFor(() => expect(store.getState().konamiUnlocked).toBe(true));
  });

  it("a modifier means the keys belong to some other gesture", async () => {
    // ⌘← is the start of the line, not the fifth key of a cheat code.
    const { store } = await mount({ settings: { [EGGS]: true } });
    type(KONAMI.slice(0, 4));
    fireEvent.keyDown(window, { key: "ArrowLeft", metaKey: true });
    type(KONAMI.slice(4));
    await tick();
    expect(store.getState().konamiUnlocked).toBe(false);
  });

  it("pays out once, however many times it is entered", async () => {
    const { api, store } = await mount({ settings: { [EGGS]: true, [UNLOCKED]: true } });
    expect(store.getState().konamiUnlocked).toBe(true);
    type(KONAMI);
    await tick();
    expect(api.calls.some((c) => c.startsWith("playCue"))).toBe(false);
    expect(api.calls.filter((c) => c.startsWith(`setSetting:${UNLOCKED}`))).toEqual([]);
  });

  it("makes its one sound only if sounds are wanted", async () => {
    // The only noise Realm makes that no notification asked for. Someone who turned sound off meant
    // all of it — and the payout is the palette, not the chime, so it still lands.
    const { api, store } = await mount({ settings: { [EGGS]: true, [NOTIFICATIONS_SOUND_KEY]: false } });
    type(KONAMI);
    await waitFor(() => expect(store.getState().konamiUnlocked).toBe(true));
    expect(api.calls.some((c) => c.startsWith("playCue"))).toBe(false);
  });

  it("keeps what was earned when the eggs go back off", async () => {
    // Turning the switch off hides eggs nobody has found yet. It does not confiscate one that was.
    const { api, store } = await mount({ settings: { [EGGS]: true } });
    type(KONAMI);
    await waitFor(() => expect(store.getState().konamiUnlocked).toBe(true));
    await act(async () => { await store.getState().setEasterEggs(false); });
    expect(store.getState().konamiUnlocked).toBe(true);
    expect(api.data.settings[UNLOCKED]).toBe(true);
  });
});
