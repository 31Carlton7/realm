import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SandboxState } from "@realm/contracts";
import { SandboxPanel } from "./SandboxPanel";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

const state = (over: Partial<SandboxState> = {}): SandboxState => ({
  prefs: { posture: "off", network: true },
  inherited: true,
  defaults: { posture: "off", network: true },
  policy: { posture: "off", network: true, writableRoots: [], readableRoots: [], readOnlyPaths: [], protectedRoots: [] },
  summary: "Not sandboxed — this session runs with your full account.",
  available: true,
  unavailableReason: null,
  ...over,
});

async function mount(sandbox: SandboxState = state()) {
  const api = fakeApi({ sandbox });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><SandboxPanel spaceId="s1" /></StoreContext.Provider>);
  await waitFor(() => expect(api.calls).toContain("getSandbox:s1"));
  return { api, store };
}

describe("the sandbox panel", () => {
  it("ships off and says the setting came from the default", async () => {
    /* The posture a user has not chosen is the one that changes nothing, and the page has to say so —
       otherwise "No sandbox" reads as a choice someone made here. THE MUTANT: default to
       workspace-write, or render the inherited and overridden cases identically. */
    await mount();
    expect(screen.getByRole("radio", { name: /No sandbox/ })).toBeChecked();
    expect(screen.getByText(/Inherited from the default/)).toBeInTheDocument();
  });

  it("writes an override for this space when a posture is picked", async () => {
    const { api } = await mount();
    fireEvent.click(screen.getByRole("radio", { name: /Workspace write/ }));
    await waitFor(() => expect(api.calls).toContain("setSandbox:s1:workspace-write/net"));
  });

  it("clears the override back to the default", async () => {
    const { api } = await mount(state({ prefs: { posture: "workspace-write", network: true }, inherited: false }));
    fireEvent.click(screen.getByRole("button", { name: /Use the default instead/ }));
    await waitFor(() => expect(api.calls).toContain("setSandbox:s1:inherit"));
  });

  it("names the Codex limitation while a sandbox is selected, and not when it is off", async () => {
    /* Otherwise this is met as a session that will not start. THE MUTANT: show it unconditionally, or
       never — the first is noise on the page where it cannot apply, the second is the trap. */
    await mount(state({ prefs: { posture: "workspace-write", network: true }, inherited: false }));
    expect(screen.getByText(/Codex sessions cannot be sandboxed/)).toBeInTheDocument();
  });

  it("says nothing about Codex when the space is not sandboxed", async () => {
    await mount();
    expect(screen.queryByText(/Codex sessions cannot be sandboxed/)).toBeNull();
  });

  it("shows the writable roots, which are the only checkable claim a posture makes", async () => {
    await mount(state({
      prefs: { posture: "workspace-write", network: true }, inherited: false,
      policy: { posture: "workspace-write", network: true, writableRoots: ["/repo", "/tmp"], readableRoots: [], readOnlyPaths: [], protectedRoots: [] },
    }));
    expect(screen.getByText("Writable roots (2)")).toBeInTheDocument();
    expect(screen.getByText("/repo")).toBeInTheDocument();
  });

  it("surfaces Realm's own reason when Seatbelt cannot be applied at all", async () => {
    /* Two of the three choices refuse to start a session on such a machine. THE MUTANT: swallow it —
       the picker would then offer three options of which two silently fail. */
    await mount(state({ available: false, unavailableReason: "sandbox-exec is not on this machine." }));
    expect(screen.getByRole("alert")).toHaveTextContent("sandbox-exec is not on this machine.");
  });
});
