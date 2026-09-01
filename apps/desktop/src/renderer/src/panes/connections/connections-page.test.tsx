import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MCP_SECRET_STORAGE_NOTE, PAGE_REF_IDS } from "@realm/contracts";
import { ConnectionsPage } from "./ConnectionsPage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, mcpServer, type FakeData } from "../../state/store.test-fakes";

const pageItem = (spaceId: string) =>
  item(`con-${spaceId}`, spaceId, { kind: "connections-page", title: "Connections", refId: PAGE_REF_IDS["connections-page"] });

async function mount(overrides: FakeData = {}, spaceId = "s1") {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><ConnectionsPage item={pageItem(spaceId)} visible /></StoreContext.Provider>);
  return { store, api, ...r };
}

/** The page's body is McpSection itself — every behavior (groups, moves, providers, Test, the form)
 *  is covered by mcp-section.test.tsx ONCE, for both surfaces. What is proven here is the wiring:
 *  the right chrome, the right vantage, the always-on disclosure. */
describe("the Connections page (Plan 12 W4)", () => {
  it("mounts the shared McpSection for the ITEM's space, with scope groups and the storage note on screen", async () => {
    const { api } = await mount({ mcpServers: [
      mcpServer("m1", { name: "srv1", scope: { kind: "profile", profileId: "p1" } }),
      mcpServer("m2", { name: "srv2" }),
    ] });
    expect(screen.getByRole("heading", { name: "Connections" })).toBeInTheDocument();
    await waitFor(() => expect(api.calls).toContain("listMcpServers:s1"));
    expect(within(await screen.findByRole("region", { name: "From Work" })).getByText("srv1")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Everywhere" })).getByText("srv2")).toBeInTheDocument();
    // MCP_SECRET_STORAGE_NOTE is a property of the servers listed, on screen whenever the page is.
    expect(screen.getByText(MCP_SECRET_STORAGE_NOTE)).toBeInTheDocument();
    // The provider rows ride along.
    expect(screen.getByRole("checkbox", { name: "Provider realm-browser in this space" })).toBeInTheDocument();
  });

  it("keeps its vantage when opened for a non-active space", async () => {
    const { api } = await mount({}, "s2");
    await waitFor(() => expect(api.calls).toContain("listMcpServers:s2"));
    expect(api.calls).not.toContain("listMcpServers:s1");
    expect(screen.getByText(/seen from Homework/)).toBeInTheDocument();
  });

  it("says so when the page's space is gone", async () => {
    const api = fakeApi();
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><ConnectionsPage item={item("con-x", "sGone", { kind: "connections-page", refId: PAGE_REF_IDS["connections-page"] })} visible /></StoreContext.Provider>);
    expect(screen.getByText("This page's space no longer exists.")).toBeInTheDocument();
    // No fetch for a ghost space.
    expect(api.calls.some((c) => c.startsWith("listMcpServers"))).toBe(false);
  });
});
