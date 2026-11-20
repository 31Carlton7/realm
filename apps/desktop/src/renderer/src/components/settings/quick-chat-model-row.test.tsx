import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuickChatModelRow } from "./QuickChatModelRow";
import { StoreContext, createAppStore, type AgentProbe } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

afterEach(cleanup);

const claude: AgentProbe = { kind: "claude", available: true, version: "2.1.300", loggedIn: true, reason: null,
  models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }, { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }, { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" }] };

async function mount() {
  const api = fakeApi({ agentProbe: [claude] });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().refreshSettingsPrefs();
  const view = () => <StoreContext.Provider value={store}><QuickChatModelRow stored={store.getState().settingsPrefs!.quickChatModel} /></StoreContext.Provider>;
  const r = render(view());
  return { api, store, rerender: () => r.rerender(view()) };
}

describe("the Quick chat model row", () => {
  it("shows Haiku when nothing is stored, from the CLI's own list", async () => {
    await mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Haiku 5.5"));
  });

  it("stores the pick, agent and model, under quickChatModel", async () => {
    const { api, rerender } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("option", { name: /Sonnet 5\.5/ }));
    await waitFor(() => expect(api.calls).toContain("setSetting:quickChatModel=[object Object]"));
    rerender();
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Sonnet 5.5");
  });
});
