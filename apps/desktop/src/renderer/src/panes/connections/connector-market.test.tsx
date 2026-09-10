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

  it("a vendor that issues no client asks for the user's own app first, then signs in through the relay", async () => {
    /* Slack: no dynamic registration, and no loopback redirect. The mutant: start OAuth straight
       away, which the server refuses with "no client registered". */
    const { api, opened } = await mount();
    fireEvent.click(within(card("Slack")).getByRole("button", { name: "Connect" }));
    const sheet = screen.getByRole("dialog", { name: "Connect Slack" });
    expect(sheet).toHaveTextContent("https://realm.computer/oauth/callback"); // the one thing nobody guesses right
    expect(opened).toHaveLength(0);
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Client ID" }), { target: { value: "123.456" } });
    fireEvent.change(within(sheet).getByLabelText("Client secret"), { target: { value: "shh" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Continue to Slack" }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(api.calls.some((c) => /^setMcpOauthClient:mcp\d+:123\.456:relay$/.test(c))).toBe(true);
    expect(api.calls.indexOf(api.calls.find((c) => c.startsWith("setMcpOauthClient"))!)).toBeLessThan(api.calls.indexOf(api.calls.find((c) => c.startsWith("startMcpOauth"))!));
  });

  it("a row left behind by a Connect that failed for want of a client still asks for the app", async () => {
    /* The mutant: gate the form on `state === "none"`. The user pressed Connect once, the server
       refused ("no client registered"), and the row exists without a client — a second press must
       open the form, not fail the same way again. */
    const slack = CONNECTORS.find((c) => c.id === "slack")!;
    const { opened } = await mount({ mcpServers: [mcpServer("m1", { name: connectorServerName(slack), transport: "http", url: slack.url, authKind: "none", scope: { kind: "space", spaceId: "s1" } })] });
    await waitFor(() => expect(within(card("Slack")).getByRole("button", { name: "Finish signing in" })).toBeInTheDocument());
    fireEvent.click(within(card("Slack")).getByRole("button", { name: "Finish signing in" }));
    expect(screen.getByRole("dialog", { name: "Connect Slack" })).toBeInTheDocument();
    expect(opened).toHaveLength(0);
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
