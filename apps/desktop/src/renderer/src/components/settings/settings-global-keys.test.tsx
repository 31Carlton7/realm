import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { KEYS_DOUBLE_TAP_KEY, KEYS_HOLD_KEY, type GlobalKeysEvent, type GlobalKeysState } from "@realm/contracts";

/** The section reads and writes its two settings over the socket and holds no store state for them. */
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
    setHold: async (key: string) => { asked.push(`hold:${key}`); },
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
  await waitFor(() => expect(calls.filter((c) => c.method === "settings.get")).toHaveLength(2));
  return view;
}

const row = (id: string) => document.querySelector(`[data-setting="${id}"]`) as HTMLElement;
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
    expect(screen.getByRole("radio", { name: "Fn" })).toBeChecked();
  });

  it("shows what was stored", async () => {
    stored[KEYS_DOUBLE_TAP_KEY] = false;
    stored[KEYS_HOLD_KEY] = "rightOption";
    bridge("active");
    await mount();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Double-tap Command opens the quick chat" })).not.toBeChecked());
    expect(screen.getByRole("radio", { name: "Right Option" })).toBeChecked();
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
    fireEvent.click(screen.getByRole("radio", { name: "Right Command" }));
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
    fireEvent.click(screen.getByRole("radio", { name: "Right Option" }));
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

  it("says on the double-tap's row that macOS uses the same keys for Siri", async () => {
    bridge("active");
    await mount();
    expect(row("double-tap-command")).toHaveTextContent("macOS uses the same keys for Siri when Siri is on. One of the two can be changed.");
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
