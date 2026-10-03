import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ThemeBridge } from "./App";
import { TerminalHub, setTerminalHubForTests, type HubTransport, type TerminalLike } from "./panes/terminal-hub";
import { StoreContext, createAppStore } from "./state/store";
import { fakeApi } from "./state/store.test-fakes";

/* xterm takes its colours when a terminal is made, so a terminal already open would keep the face it
   was opened in: white ink, after a switch to the light face, on a ground that is now near-white.
   THE mutants are the push never happening, and it keying off the preference rather than the face. */
afterEach(() => { cleanup(); setTerminalHubForTests(null); vi.unstubAllGlobals(); document.documentElement.removeAttribute("data-mode"); });

/** A hub holding one open terminal, whose live options the bridge writes into. */
function openTerminal(): TerminalLike {
  const term: TerminalLike = {
    cols: 80, rows: 24, options: {}, open: () => {}, write: () => {}, dispose: () => {}, focus: () => {},
    onData: () => ({ dispose() {} }), onResize: () => ({ dispose() {} }),
  };
  const transport: HubTransport = { on: () => () => {}, call: async () => ({ ok: true }) };
  const hub = new TerminalHub(transport, () => ({ term, fit: { fit() {} } }));
  setTerminalHubForTests(hub);
  hub.acquire("t1");
  return term;
}

async function bridge(themePref: "light" | "dark" | "system") {
  const store = createAppStore(fakeApi());
  await store.getState().boot();
  store.setState({ themePref });
  render(<StoreContext.Provider value={store}><ThemeBridge /></StoreContext.Provider>);
  return store;
}

it("re-colours the terminals already open when the face changes", async () => {
  const term = openTerminal();
  const store = await bridge("dark");
  expect(term.options!.theme!.background).toBe("#00000000");
  act(() => store.setState({ themePref: "light" }));
  expect(term.options!.theme!.background).toBe("#ffffff00");
  expect(term.options!.minimumContrastRatio).toBe(4.5);
});

it("follows the Mac's own switch under System, where the preference never changes", async () => {
  let flip: () => void = () => {};
  const query = { matches: true, addEventListener: (_: string, fn: () => void) => { flip = fn; }, removeEventListener: () => {} };
  vi.stubGlobal("matchMedia", () => query);
  const term = openTerminal();
  await bridge("system");
  expect(term.options!.theme!.background).toBe("#00000000");
  act(() => { query.matches = false; flip(); });
  expect(term.options!.theme!.background).toBe("#ffffff00");
});
