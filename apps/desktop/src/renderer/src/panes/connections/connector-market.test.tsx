import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CONNECTORS, PAGE_REF_IDS, connectorServerName } from "@realm/contracts";
import { ConnectionsPage, connectorState } from "./ConnectionsPage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, mcpServer, type FakeData } from "../../state/store.test-fakes";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const pageItem = (spaceId: string) => item(`pg-${spaceId}`, spaceId, { kind: "connections-page", title: "Connections", refId: PAGE_REF_IDS["connections-page"] });

async function mount(overrides: FakeData = {}) {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  const opened: string[] = [];
  vi.stubGlobal("open", (url: string) => { opened.push(url); return null; });
  render(<StoreContext.Provider value={store}><ConnectionsPage item={pageItem("s1")} visible /></StoreContext.Provider>);
  return { store, api, opened };
}

const linear = CONNECTORS.find((c) => c.id === "linear")!;
const card = (name: string) => within(screen.getByRole("region", { name: "Connect an app" })).getByText(name).closest(".market-card") as HTMLElement;

describe("the connector marketplace", () => {
  it("shows every app as a card with its mark, and Connect as the one action", async () => {
    await mount();
    const market = screen.getByRole("region", { name: "Connect an app" });
    for (const c of CONNECTORS) expect(within(market).getByText(c.name)).toBeInTheDocument();
    expect(card("Linear").querySelector("[data-brand='linear']")).not.toBeNull();
    expect(within(card("Linear")).getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("Connect creates the vendor's remote server row ONCE and opens its sign-in", async () => {
    /* The mutant: mint a new row per press. An abandoned OAuth tab and a second press would leave
       two "realm-linear" servers, and the tools policy would apply to whichever won. */
    const { api, opened, store } = await mount();
    fireEvent.click(within(card("Linear")).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(api.calls.filter((c) => c === "addMcpServer:realm-linear")).toHaveLength(1);
    const row = store.getState().mcpServers.find((s) => s.name === connectorServerName(linear))!;
    expect(row).toMatchObject({ transport: "http", url: linear.url });
    expect(api.calls).toContain(`startMcpOauth:${row.id}`);
    expect(opened[0]).toContain(row.id);
    // Second press: same row, no second server.
    fireEvent.click(within(card("Linear")).getByRole("button", { name: /Connect|Finish signing in/ }));
    await waitFor(() => expect(opened).toHaveLength(2));
    expect(api.calls.filter((c) => c.startsWith("addMcpServer:"))).toHaveLength(1);
  });

  it("reads each card's state off the server row it registered", () => {
    const rows = [mcpServer("m1", { name: connectorServerName(linear), authKind: "oauth", oauthStatus: "connected" })];
    expect(connectorState(linear, rows)).toBe("connected");
    expect(connectorState(linear, [mcpServer("m1", { name: connectorServerName(linear), authKind: "oauth", oauthStatus: "reconnect_needed" })])).toBe("reconnect");
    expect(connectorState(linear, [mcpServer("m1", { name: connectorServerName(linear) })])).toBe("pending");
    expect(connectorState(linear, [])).toBe("none");
  });

  it("a connected app says so instead of offering Connect", async () => {
    await mount({ mcpServers: [mcpServer("m1", { name: connectorServerName(linear), transport: "http", url: linear.url, authKind: "oauth", oauthStatus: "connected", scope: { kind: "space", spaceId: "s1" } })] });
    await waitFor(() => expect(within(card("Linear")).getByText("Connected")).toBeInTheDocument());
    expect(within(card("Linear")).queryByRole("button", { name: "Connect" })).toBeNull();
  });
});
