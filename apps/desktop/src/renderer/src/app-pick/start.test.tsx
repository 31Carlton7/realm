import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import * as contracts from "@realm/contracts";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi } from "../state/store.test-fakes";
import { useSelectInRealm } from "./start";

vi.mock("@realm/contracts", async (real) => {
  const mod = await real<typeof import("@realm/contracts")>();
  return { ...mod, chordsForCommand: vi.fn(mod.chordsForCommand) };
});

/**
 * Every mounted session pane holds this hook, and the store notifies it on every streamed delta. The
 * bindings are parsed when they change, not once per notification per pane.
 */
describe("useSelectInRealm", () => {
  it("parses the keybindings once, not on every store change", async () => {
    const store = createAppStore(fakeApi());
    await store.getState().boot();
    const wrapper = ({ children }: { children: ReactNode }) => <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
    const { result } = renderHook(() => useSelectInRealm("se1"), { wrapper });
    const parsed = vi.mocked(contracts.chordsForCommand).mock.calls.length;
    expect(result.current.kbd).toBeTruthy();

    for (let i = 0; i < 20; i++) act(() => store.setState({ sessionActivityAt: { se1: i } }));
    expect(vi.mocked(contracts.chordsForCommand).mock.calls.length).toBe(parsed);
  });
});
