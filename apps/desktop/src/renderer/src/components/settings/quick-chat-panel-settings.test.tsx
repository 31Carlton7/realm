import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QUICK_CHAT_HIDE_FROM_SHARING_KEY, QUICK_CHAT_SHORTCUT_KEY, type QuickChatShortcutState } from "@realm/contracts";

/** The rows read and write two settings over the socket, and ask main about the chord. */
const stored = new Map<string, unknown>();
const writes: { key: string; value: unknown }[] = [];
vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: () => () => {},
    call: async (method: string, params: { key: string; value?: unknown }) => {
      if (method === "settings.get") return { value: stored.get(params.key) ?? null };
      if (method === "settings.set") { writes.push({ key: params.key, value: params.value }); return {}; }
      throw new Error(`unexpected ${method}`);
    },
  }),
}));

import { QuickChatPanelSettings } from "./QuickChatPanelSettings";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

/** Main, as far as these rows see it: it answers every chord with what the system did. */
function mount(state: QuickChatShortcutState, taken: string[] = [], home: Record<string, unknown> = {}) {
  stored.clear();
  for (const [key, value] of Object.entries(home)) stored.set(key, value);
  writes.length = 0;
  const setShortcut = vi.fn(async (chord: string | null): Promise<QuickChatShortcutState> => ({ chord, registered: chord !== null && !taken.includes(chord) }));
  const setHideFromSharing = vi.fn();
  (window as any).realm = { platform: "darwin", quickChatPanel: { shortcut: async () => state, setShortcut, setHideFromSharing } };
  const store = createAppStore(fakeApi());
  render(<StoreContext.Provider value={store}><QuickChatPanelSettings /></StoreContext.Provider>);
  return { setShortcut, setHideFromSharing };
}

const recorder = () => screen.getByRole("button", { name: "Quick chat shortcut" });
const press = (init: KeyboardEventInit) => fireEvent.keyDown(recorder(), init);

afterEach(() => { delete (window as any).realm; });

describe("the quick chat shortcut row", () => {
  it("shows the chord main holds", async () => {
    mount({ chord: "ctrl+alt+space", registered: true });
    expect(await screen.findByText("⌃⌥Space")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so in words when the system refused the chord", async () => {
    mount({ chord: "ctrl+alt+space", registered: false });
    expect(await screen.findByRole("alert")).toHaveTextContent("macOS did not give Realm ⌃⌥Space, so it opens nothing. Another app may hold it.");
  });

  it("records the next chord pressed, registers it with main, and keeps it", async () => {
    const main = mount({ chord: "ctrl+alt+space", registered: true });
    await screen.findByText("⌃⌥Space");
    fireEvent.click(recorder());
    press({ key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(main.setShortcut).not.toHaveBeenCalled();
    press({ key: "j", code: "KeyJ", metaKey: true, shiftKey: true });
    await waitFor(() => expect(writes).toEqual([{ key: QUICK_CHAT_SHORTCUT_KEY, value: "mod+shift+j" }]));
    expect(main.setShortcut).toHaveBeenCalledWith("mod+shift+j");
    expect(await screen.findByText("⌘⇧J")).toBeInTheDocument();
  });

  it("reports a recorded chord the system would not give", async () => {
    mount({ chord: "ctrl+alt+space", registered: true }, ["mod+shift+j"]);
    await screen.findByText("⌃⌥Space");
    fireEvent.click(recorder());
    press({ key: "j", code: "KeyJ", metaKey: true, shiftKey: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("macOS did not give Realm ⌘⇧J");
  });

  it("does not take a key with no ⌘, ⌃ or ⌥, which every app types with", async () => {
    const main = mount({ chord: "ctrl+alt+space", registered: true });
    await screen.findByText("⌃⌥Space");
    fireEvent.click(recorder());
    press({ key: "a", code: "KeyA", shiftKey: true });
    expect(screen.getByText(/⇧A needs ⌘, ⌃ or ⌥ with it/)).toBeInTheDocument();
    expect(main.setShortcut).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("Escape leaves the chord as it was, and Delete clears it", async () => {
    const main = mount({ chord: "ctrl+alt+space", registered: true });
    await screen.findByText("⌃⌥Space");
    fireEvent.click(recorder());
    press({ key: "Escape", code: "Escape" });
    expect(main.setShortcut).not.toHaveBeenCalled();
    expect(screen.getByText("⌃⌥Space")).toBeInTheDocument();
    fireEvent.click(recorder());
    press({ key: "Backspace", code: "Backspace" });
    await waitFor(() => expect(writes).toEqual([{ key: QUICK_CHAT_SHORTCUT_KEY, value: "" }]));
    expect(main.setShortcut).toHaveBeenCalledWith(null);
    expect(await screen.findByText("No shortcut")).toBeInTheDocument();
  });
});

describe("the hide from screen sharing row", () => {
  const toggle = () => screen.getByRole("switch", { name: "Hide the quick chat from screen sharing" }) as HTMLInputElement;

  it("is on until it has been switched off", async () => {
    mount({ chord: null, registered: false });
    await screen.findByText("No shortcut");
    expect(toggle().checked).toBe(true);
  });

  it("switches the panel's protection off in main and keeps the choice", async () => {
    const main = mount({ chord: null, registered: false });
    await screen.findByText("No shortcut");
    fireEvent.click(toggle());
    await waitFor(() => expect(writes).toEqual([{ key: QUICK_CHAT_HIDE_FROM_SHARING_KEY, value: false }]));
    expect(main.setHideFromSharing).toHaveBeenCalledWith(false);
    expect(toggle().checked).toBe(false);
  });

  it("comes back off in a home where it was switched off", async () => {
    mount({ chord: null, registered: false }, [], { [QUICK_CHAT_HIDE_FROM_SHARING_KEY]: false });
    await waitFor(() => expect(toggle().checked).toBe(false));
  });

  it("promises nothing about being undetectable", async () => {
    mount({ chord: null, registered: false });
    await screen.findByText("No shortcut");
    expect(document.body.textContent).not.toMatch(/undetectable|invisible/i);
  });
});
