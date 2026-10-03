import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { DEFAULT_KEYBINDINGS, type Keybinding } from "@realm/contracts";
import { createAppStore } from "../state/store";
import { fakeApi } from "../state/store.test-fakes";
import { appCommands } from "./commands";
import { useMenuBar } from "./menu-bar";

afterEach(() => { cleanup(); delete (window as { realm?: unknown }).realm; });

const bridge = () => {
  let pick: (command: string) => void = () => {};
  const setMenuKeybindings = vi.fn();
  (window as { realm?: unknown }).realm = { setMenuKeybindings, onAppCommand: (cb: (c: string) => void) => { pick = cb; return () => {}; } };
  return { setMenuKeybindings, pick: (c: string) => act(() => pick(c)) };
};

/* THE mutant: a menu row with no runner behind it — a menu item that does nothing when chosen. The
   menu is built in main, which this project cannot import, so its rows are read as source — the same
   way machine-pane.test.tsx reads main's menu. */
it("has a runner for every command the menu bar offers", async () => {
  const source = Object.values(import.meta.glob("../../../main/app-menu.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>)[0]!;
  const offered = [...source.matchAll(/row\("([a-zA-Z.]+)",/g)].map((m) => m[1]!);
  expect(offered.length).toBeGreaterThan(20);
  const commands = appCommands(createAppStore(fakeApi()));
  for (const id of offered) expect(commands[id], id).toBeTypeOf("function");
});

it("tells main the person's keybindings, and tells it again when they change", () => {
  const { setMenuKeybindings } = bridge();
  const store = createAppStore(fakeApi());
  const { rerender } = renderHook(({ rules }: { rules?: readonly Keybinding[] }) => useMenuBar(store, rules), { initialProps: {} });
  // Before the server has answered, the shipped table — what the keyboard is running meanwhile.
  expect(setMenuKeybindings).toHaveBeenLastCalledWith([...DEFAULT_KEYBINDINGS]);
  const mine: Keybinding[] = [{ key: "mod+alt+n", command: "session.new" }];
  rerender({ rules: mine });
  expect(setMenuKeybindings).toHaveBeenLastCalledWith(mine);
});

it("runs what the menu sends through the keystroke's own runner, and holds back while a sheet is up", async () => {
  const { pick } = bridge();
  const store = createAppStore(fakeApi());
  await store.getState().boot();
  renderHook(() => useMenuBar(store));
  pick("palette.toggle");
  expect(store.getState().paletteOpen).toBe(true);
  pick("palette.toggle");
  expect(store.getState().paletteOpen).toBe(false);
  store.setState({ sheet: { kind: "new-space" } as never });
  pick("palette.toggle");
  expect(store.getState().paletteOpen).toBe(false);
  // An id nothing runs is ignored rather than thrown on.
  store.setState({ sheet: null });
  expect(() => pick("no.such.command")).not.toThrow();
});
