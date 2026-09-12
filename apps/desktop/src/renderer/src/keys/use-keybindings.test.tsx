import { describe, expect, it } from "vitest";
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import type { Keybinding } from "@realm/contracts";
import { useKeybindings } from "./use-keybindings";
import { createAppStore } from "../state/store";
import { fakeApi, item, session, space } from "../state/store.test-fakes";

/** The real store and the real hook, driven by window KeyboardEvents — what production runs. */
async function mount(rules?: readonly Keybinding[], over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(over);
  const store = createAppStore(api);
  await store.getState().boot();
  const view = renderHook(({ r }: { r?: readonly Keybinding[] }) => useKeybindings(store, r), { initialProps: { r: rules } });
  return { api, store, view };
}

const key = (init: KeyboardEventInit & { key: string }, target: Element | Window = window) => fireEvent.keyDown(target, init);
/** Let a promise chain a command kicked off settle, so "nothing happened" assertions are real. */
const tick = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

/** One session, focused, with a pane holding it — the state ⌘J / ⌘U / Esc are guarded on. */
const focusedSession = {
  sessions: [session("sess1", "s1", { status: "idle" })],
  items: { s1: [item("i1", "s1", { kind: "session" as const, refId: "sess1", title: "Agent" })] },
};
/** Whether the fake recorded a call of this kind; its log entries carry their arguments. */
const made = (api: { calls: string[] }, kind: string) => api.calls.some((c) => c.startsWith(kind));

const focusSessionPane = (store: Awaited<ReturnType<typeof mount>>["store"]) =>
  act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i1" }, focusedLeafId: "L1" }));

describe("useKeybindings", () => {
  it("runs the shipped default when nothing overrides it", async () => {
    const { api } = await mount();
    let terminals = 0;
    api.onCreateTerminal = () => { terminals++; };
    key({ key: "t", metaKey: true });
    await waitFor(() => expect(terminals).toBe(1));
  });

  it("lets a later user rule defeat the shipped default for the same key", async () => {
    /* The end-to-end shape of the whole feature: this is what a user writes at the bottom of their
       keybindings.json, and it must beat the default above it. THE MUTANT: resolve forwards. */
    const { api } = await mount([
      { key: "mod+t", command: "terminal.new" },
      { key: "⌘T", command: "session.new" },
    ]);
    let terminals = 0;
    api.onCreateTerminal = () => { terminals++; };
    key({ key: "t", metaKey: true });
    await waitFor(() => expect(made(api, "createSession")).toBe(true));
    expect(terminals).toBe(0);
  });

  it("stops consuming a key the user unbound", async () => {
    /* THE MUTANT: preventDefault before checking for a command. An unbound ⌘T would then be a dead
       key rather than a key given back to the OS and to the focused field. */
    const { api } = await mount([{ key: "mod+t", command: "terminal.new" }, { key: "mod+t", command: "" }]);
    let terminals = 0;
    api.onCreateTerminal = () => { terminals++; };
    const notPrevented = key({ key: "t", metaKey: true });
    await tick();
    expect(notPrevented).toBe(true);
    expect(terminals).toBe(0);
  });

  it("does not consume a chord bound to a command with no runner", async () => {
    // A `script.<id>.run` binding before project scripts are wired, or an id from a newer Realm.
    // The resolver takes any id; this is where Realm stops being able to keep that promise.
    const { api } = await mount([{ key: "mod+t", command: "script.build.run" }]);
    let terminals = 0;
    api.onCreateTerminal = () => { terminals++; };
    expect(key({ key: "t", metaKey: true })).toBe(true);
    await tick();
    expect(terminals).toBe(0);
  });

  it("keeps out of an editable target, the way the old guard did", async () => {
    const { api, store } = await mount();
    let terminals = 0;
    api.onCreateTerminal = () => { terminals++; };
    const collapsed = store.getState().sidebarCollapsed;
    const input = document.createElement("input");
    document.body.appendChild(input);
    key({ key: "b", metaKey: true }, input);   // ⌘B is bold in the composer
    key({ key: "t", metaKey: true }, input);
    await tick();
    expect(terminals).toBe(0);
    expect(store.getState().sidebarCollapsed).toBe(collapsed);
    input.remove();
  });

  it("still fires the bindings whose clause allows an editable target", async () => {
    /* ⌘J has to work FROM the composer — that is the only place the hand is in a session pane — and
       it types nothing there. In the old layer this was a per-binding `inInputs` flag; here it is
       just a `when` that does not mention inputFocus. */
    const { store } = await mount(undefined, focusedSession);
    focusSessionPane(store);
    const input = document.createElement("input");
    document.body.appendChild(input);
    key({ key: "j", metaKey: true }, input);
    await waitFor(() => expect(store.getState().sessionDock.sess1).toEqual({ kind: "terminal" }));
    input.remove();
  });

  it("lets an overlay own the keyboard, except for the toggles that open it", async () => {
    const { api, store } = await mount();
    let terminals = 0;
    api.onCreateTerminal = () => { terminals++; };
    act(() => store.getState().setPaletteOpen(true));
    key({ key: "t", metaKey: true });
    await tick();
    expect(terminals).toBe(0);
    // …and ⌘K still closes it, which is the case `!sheetOpen` (rather than `!overlayOpen`) exists for.
    key({ key: "k", metaKey: true });
    await waitFor(() => expect(store.getState().paletteOpen).toBe(false));
  });

  it("swallows ⌘W even when the guard refuses the action", async () => {
    /* THE MUTANT: preventDefault only on a match. With a sheet open, ⌘W would reach Electron's
       default File → Close Window and shut the window on a running agent. A dead key is recoverable;
       that is not. */
    const { store } = await mount();
    act(() => store.getState().openSheet({ kind: "new-space" }));
    expect(key({ key: "w", metaKey: true })).toBe(false);
    await tick();
    expect(store.getState().sheet).toEqual({ kind: "new-space" });
  });

  it("ignores an event something closer to the target already consumed", async () => {
    const { api } = await mount();
    let terminals = 0;
    api.onCreateTerminal = () => { terminals++; };
    const e = new KeyboardEvent("keydown", { key: "t", metaKey: true, bubbles: true, cancelable: true });
    e.preventDefault();
    act(() => { window.dispatchEvent(e); });
    await tick();
    expect(terminals).toBe(0);
  });

  it("reads the physical key, so ⌘⇧\\ splits down rather than doing nothing", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i1" }, focusedLeafId: "L1" }));
    // A US layout reports "|" here; the chord is decided by `code`, so the rule can say `mod+shift+\`.
    key({ key: "|", code: "Backslash", metaKey: true, shiftKey: true });
    await waitFor(() => { const l = store.getState().layout!; expect(l.type === "split" && l.dir).toBe("col"); });
  });

  it("gates Escape on the session actually running", async () => {
    const { api, store } = await mount(undefined, focusedSession);
    focusSessionPane(store);
    key({ key: "Escape" });
    await tick();
    expect(made(api, "interrupt")).toBe(false);
    act(() => store.setState({ sessionStatus: { sess1: "running" } }));
    key({ key: "Escape" });
    await waitFor(() => expect(api.calls).toContain("interrupt:sess1"));
  });

  it("picks up a new keymap without missing a keystroke", async () => {
    // Rules arrive from the server after boot and change again whenever the file does. THE MUTANT:
    // capture `rules` in the listener's closure — the first keymap would be the only one that ever ran.
    const { api, view } = await mount([{ key: "mod+t", command: "terminal.new" }]);
    let terminals = 0;
    api.onCreateTerminal = () => { terminals++; };
    view.rerender({ r: [{ key: "mod+t", command: "session.new" }] });
    key({ key: "t", metaKey: true });
    await waitFor(() => expect(made(api, "createSession")).toBe(true));
    expect(terminals).toBe(0);
  });

  it("numbers spaces within the active profile", async () => {
    const { store } = await mount(undefined, {
      spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s3", "p2", "Thesis")],
      items: { s1: [], s2: [], s3: [] },
    });
    key({ key: "2", metaKey: true });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    key({ key: "3", metaKey: true }); // Work has no third space
    await tick();
    expect(store.getState().activeSpaceId).toBe("s2");
  });
});

/**
 * Project scripts are the open-ended half of the command namespace (`script.<id>.run`), so they take
 * a different path through the hook than every id in `appCommands`: the active space's own script
 * list decides, synchronously, whether the keystroke is swallowed at all.
 */
describe("useKeybindings — project scripts", () => {
  /* A real ULID: `parseScriptCommandId` validates the id against `IdSchema`, so a short
     placeholder would be rejected as malformed rather than as "not mine" — a different code path. */
  const SCRIPT_ID = "01J8ZQF9XK7M2NPR4TVWY3B5CD";
  const withScript = { scripts: { s1: [{ id: SCRIPT_ID, name: "Test", command: "pnpm test", cwd: null }] } };

  const pressShiftT = () => {
    const e = new KeyboardEvent("keydown", { key: "T", metaKey: true, shiftKey: true, cancelable: true });
    act(() => { window.dispatchEvent(e); });
    return e;
  };

  it("runs a bound script through the store, and swallows the key", async () => {
    const { api, store } = await mount([{ key: "mod+shift+t", command: `script.${SCRIPT_ID}.run` }], withScript);
    await act(async () => { await store.getState().refreshScripts("s1"); store.setState({ activeSpaceId: "s1" }); });
    const e = pressShiftT();
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() => expect(made(api, `runScript:s1:script.${SCRIPT_ID}.run`)).toBe(true));
  });

  it("does NOT swallow the key when this space defines no such script", async () => {
    /* A binding left over from another space must reach the browser rather than becoming a dead key.
       THE MUTANT: ask the server instead — `preventDefault` after an await is a no-op, so the key
       would be swallowed first and the answer learned second, which is the bug this shape avoids. */
    const { api, store } = await mount([{ key: "mod+shift+t", command: "script.01J8ZQF9XK7M2NPR4TVWY3B5CE.run" }], withScript);
    await act(async () => { await store.getState().refreshScripts("s1"); store.setState({ activeSpaceId: "s1" }); });
    const e = pressShiftT();
    expect(e.defaultPrevented).toBe(false);
    await tick();
    expect(made(api, "runScript")).toBe(false);
  });

  it("ignores a command id that only looks like a script id", async () => {
    /* `parseScriptCommandId` is a parse, not a prefix match: `script.run` names no script and must
       never reach the server. THE MUTANT: startsWith("script."). */
    const { api, store } = await mount([{ key: "mod+shift+y", command: "script.run" }], withScript);
    await act(async () => { await store.getState().refreshScripts("s1"); store.setState({ activeSpaceId: "s1" }); });
    key({ key: "Y", metaKey: true, shiftKey: true });
    await tick();
    expect(made(api, "runScript")).toBe(false);
  });
});
