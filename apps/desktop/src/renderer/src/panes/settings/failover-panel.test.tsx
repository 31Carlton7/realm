import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createAppStore, StoreContext } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";
import { FailoverPanel } from "./FailoverPanel";

afterEach(() => cleanup());

async function mount(failover?: { retry: boolean; chain: string[] }) {
  const api = fakeApi(failover ? { failover: failover as never } : {});
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><FailoverPanel /></StoreContext.Provider>);
  await waitFor(() => expect(store.getState().failover).not.toBeNull());
  return { api, store };
}

const rowFor = (label: string) => screen.getByRole("switch", { name: `Hand over to ${label}` });

describe("the failover panel", () => {
  it("starts with retries on and nowhere to hand over, and says what that means", async () => {
    // The default, and the reason for it: a retry finishes the turn on the agent the user picked,
    // where a handoff changes who is doing their work and who is billed for it.
    await mount();
    expect(screen.getByRole("switch", { name: "Retry a stalled turn" })).toBeChecked();
    expect(screen.getByText(/the turn stops and says so/)).toBeInTheDocument();
  });

  it("names the chain in order once there is one", async () => {
    await mount({ retry: true, chain: ["codex", "acp:gemini"] });
    expect(screen.getByText(/In order: Codex → Gemini/)).toBeInTheDocument();
    // And says the one thing about a handoff a user could not otherwise learn.
    expect(screen.getByText(/carried across as text/)).toBeInTheDocument();
  });

  it("appends a newly-picked agent at the END of the chain", async () => {
    // The chain is an ORDER. Inserting at the list's own position would silently make the agent the
    // user just added the FIRST one asked, which is a different policy to the one they expressed.
    const { store } = await mount({ retry: true, chain: ["acp:gemini"] });
    fireEvent.click(rowFor("Codex"));
    await waitFor(() => expect(store.getState().failover?.chain).toEqual(["acp:gemini", "codex"]));
  });

  it("reorders without losing the rest of the chain", async () => {
    const { store } = await mount({ retry: true, chain: ["codex", "acp:gemini"] });
    fireEvent.click(screen.getByRole("button", { name: "Ask Gemini earlier" }));
    await waitFor(() => expect(store.getState().failover?.chain).toEqual(["acp:gemini", "codex"]));
  });

  it("cannot move the ends off the ends", async () => {
    await mount({ retry: true, chain: ["codex", "acp:gemini"] });
    expect(screen.getByRole("button", { name: "Ask Codex earlier" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ask Gemini later" })).toBeDisabled();
  });

  it("shows each chained agent's position, so the order is readable without counting rows", async () => {
    await mount({ retry: true, chain: ["acp:gemini", "codex"] });
    const gemini = rowFor("Gemini").closest("li")!;
    const codex = rowFor("Codex").closest("li")!;
    expect(within(gemini).getByText("1")).toBeInTheDocument();
    expect(within(codex).getByText("2")).toBeInTheDocument();
  });

  it("keeps whatever the server actually saved, not what was asked for", async () => {
    // Kinds this build has no adapter for are dropped rather than refused. Rendering the request
    // would show a chain that is not the one in force.
    const { store } = await mount({ retry: true, chain: [] });
    fireEvent.click(rowFor("Qwen Code"));
    await waitFor(() => expect(store.getState().failover?.chain).toEqual([]));
  });

  it("offers an agent that is not ready, rather than hiding it", async () => {
    // A list that is quietly different on every machine is a list nobody can reason about — and a
    // chain configured today should still mean what it said when the CLI arrives tomorrow.
    await mount();
    expect(rowFor("Claude")).toBeInTheDocument();
    expect(rowFor("Codex")).toBeInTheDocument();
  });
});
