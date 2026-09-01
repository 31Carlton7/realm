import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MCP_SECRET_STORAGE_NOTE } from "@realm/contracts";
import { SpaceSettingsSheet } from "./SpaceSettingsSheet";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, mcpServer, mcpTool, session } from "../../state/store.test-fakes";

async function mount(overrides: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  store.getState().openSheet({ kind: "space-settings", spaceId: "s1" });
  render(<StoreContext.Provider value={store}><SpaceSettingsSheet spaceId="s1" /></StoreContext.Provider>);
  // Since the W5 merge the sheet is a settings HOME and opens on General; McpSection is the Connections
  // tab, so it does not mount (and does not fetch) until that tab is selected.
  fireEvent.click(screen.getByRole("radio", { name: "Connections" }));
  // McpSection fetches on mount — wait for that before asserting on its contents.
  await waitFor(() => expect(api.calls).toContain("listMcpServers:s1"));
  return { store, api };
}

describe("McpSection", () => {
  it("says a fresh space has no MCP servers rather than rendering an empty list", async () => {
    await mount();
    expect(screen.getByText(/No MCP servers yet — add one to give this space's agents tools\./)).toBeInTheDocument();
  });

  it("adding a server makes it appear, enabled for this space", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Add server…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Server name" }), { target: { value: "Everything" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Command" }), { target: { value: "npx" } });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    await waitFor(() => expect(screen.getByText("Everything")).toBeInTheDocument());
    const row = screen.getByText("Everything").closest(".mcp-row") as HTMLElement;
    expect(within(row).getByRole("checkbox", { name: "Enabled" })).toBeChecked();
    expect(store.getState().mcpServers.some((s) => s.name === "Everything" && s.enabled)).toBe(true);
  });

  it("toggling a tool checkbox sends the explicit allowlist; re-checking everything restores null", async () => {
    const srv = mcpServer("m1", { name: "srv1", enabled: true, tools: [mcpTool("a"), mcpTool("b")] });
    const { api } = await mount({ mcpServers: [srv] });
    const row = (await screen.findByText("srv1")).closest(".mcp-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("checkbox", { name: "a" }));
    await waitFor(() => expect(api.calls).toContain("setMcpAllowedTools:s1:m1=b"));
    fireEvent.click(within(row).getByRole("checkbox", { name: "a" }));
    await waitFor(() => expect(api.calls.at(-1)).toBe("setMcpAllowedTools:s1:m1=null"));
  });

  it("an oauth-authKind server with no connection yet shows Connect, never the key form", async () => {
    const srv = mcpServer("m2", { name: "srv2", transport: "http", url: "https://mcp.example/", authKind: "oauth", oauthStatus: "unconfigured", enabled: true });
    await mount({ mcpServers: [srv] });
    const row = (await screen.findByText("srv2")).closest(".mcp-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    expect(within(row).getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(within(row).queryByRole("textbox", { name: "Headers key" })).toBeNull();
  });

  it("reconnect_needed shows Reconnect and a warning, never the key form", async () => {
    const srv = mcpServer("m3", { name: "srv3", transport: "http", url: "https://mcp.example/", authKind: "oauth", oauthStatus: "reconnect_needed", enabled: true });
    await mount({ mcpServers: [srv] });
    const row = (await screen.findByText("srv3")).closest(".mcp-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    expect(within(row).getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(within(row).getByText(/needs to be reauthorized/)).toBeInTheDocument();
    expect(within(row).queryByRole("textbox", { name: "Headers key" })).toBeNull();
  });

  it("mcp.serverStatus patches the status dot idempotently", async () => {
    const srv = mcpServer("m4", { name: "srv4", status: "idle" });
    const { store } = await mount({ mcpServers: [srv] });
    await screen.findByText("srv4");
    const payload = { id: "m4", status: "connected" as const, oauthStatus: "unconfigured" as const };
    store.getState().applyMcpServerStatus(payload);
    const once = store.getState().mcpServers.find((s) => s.id === "m4");
    store.getState().applyMcpServerStatus(payload);
    const twice = store.getState().mcpServers.find((s) => s.id === "m4");
    expect(once).toEqual(twice);
    await waitFor(() => expect(screen.getByTitle("Connected")).toBeInTheDocument());
  });

  it("shows the secret storage note on the key form", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Add server…" }));
    // Scoped to the FORM: the tab carries the same note at panel level (W5's always-on disclosure), so
    // an unscoped query would pass on that one and stop proving the field itself is covered.
    const form = document.querySelector(".mcp-form") as HTMLElement;
    expect(within(form).getByText(MCP_SECRET_STORAGE_NOTE)).toBeInTheDocument();
  });

  it("editing the URL of an oauth-connected server warns before saving", async () => {
    const srv = mcpServer("m5", { name: "srv5", transport: "http", url: "https://old.example/", authKind: "oauth", oauthStatus: "connected", enabled: true });
    await mount({ mcpServers: [srv] });
    const row = (await screen.findByText("srv5")).closest(".mcp-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const urlInput = within(row).getByRole("textbox", { name: "Server URL" });
    fireEvent.change(urlInput, { target: { value: "https://new.example/" } });
    expect(within(row).getByText(/disconnects this server's OAuth connection/)).toBeInTheDocument();
  });

  it("a refresh-tools failure renders inline as a result, never as the app's error banner", async () => {
    const srv = mcpServer("m6", { name: "srv6", enabled: true, tools: [] });
    const { store } = await mount({ mcpServers: [srv], mcpToolsError: { m6: "connection refused: ECONNREFUSED" } });
    const row = (await screen.findByText("srv6")).closest(".mcp-row") as HTMLElement;
    expect(within(row).getByText(/Not connected yet — Refresh tools to connect\./)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Refresh tools" }));
    await waitFor(() => expect(within(row).getByText("connection refused: ECONNREFUSED")).toBeInTheDocument());
    expect(store.getState().error).toBeNull();
  });

  it("circuit_open shows Retry with the reconnect-and-refresh copy", async () => {
    const srv = mcpServer("m7", { name: "srv7", status: "circuit_open", enabled: true });
    const { api } = await mount({ mcpServers: [srv] });
    const row = (await screen.findByText("srv7")).closest(".mcp-row") as HTMLElement;
    expect(within(row).getByText(/Retry reconnects and refreshes the connection\./)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.calls).toContain("retryMcpServer:m7"));
  });

  it("names the space's agents and flags the ACP no-http-MCP caveat", async () => {
    await mount({ sessions: [session("se1", "s1", { agentKind: "acp:cursor" })] });
    await screen.findByText(/No MCP servers yet/);
    expect(screen.getByText(/Cursor reaches this space's enabled servers through Realm's gateway/)).toBeInTheDocument();
    expect(screen.getByText(/A build without http MCP support gets no tools\./)).toBeInTheDocument();
  });

  // Spec-review defects (fix commit): the oauth warning/controls used to live inside the non-stdio
  // branch, so switching an oauth row's Transport select to stdio silently hid them AND rendered the
  // forbidden env-var key form for an authKind==="oauth" row.
  it("switching an oauth row's transport in the edit form still warns and never shows the key form", async () => {
    const srv = mcpServer("m8", { name: "srv8", transport: "http", url: "https://mcp.example/", authKind: "oauth", oauthStatus: "connected", enabled: true });
    await mount({ mcpServers: [srv] });
    const row = (await screen.findByText("srv8")).closest(".mcp-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(row).getByRole("combobox", { name: "Transport" }), { target: { value: "stdio" } });
    expect(within(row).getByText(/disconnects this server's OAuth connection/)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(within(row).queryByRole("textbox", { name: "Environment variables key" })).toBeNull();
  });

  // The preserve-vs-replace gate used to be `secretRows.length > 0`, so an empty "+ Add key" row (key
  // and value both blank) built `secrets: {}`, which `mcp.update` treats as REPLACE-WITH-NOTHING —
  // silently deleting every stored key on Save.
  it("clicking + Add key without typing anything, then Save, preserves existing keys", async () => {
    const srv = mcpServer("m9", { name: "srv9", enabled: true, envKeys: ["API_KEY"] });
    const { api, store } = await mount({ mcpServers: [srv] });
    const row = (await screen.findByText("srv9")).closest(".mcp-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(row).getByRole("button", { name: "+ Add key" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.calls).toContain("updateMcpServer:m9"));
    expect(store.getState().mcpServers.find((s) => s.id === "m9")?.envKeys).toEqual(["API_KEY"]);
  });

  it("shows the secret storage note on the edit form too, not just add", async () => {
    const srv = mcpServer("m10", { name: "srv10", enabled: true });
    await mount({ mcpServers: [srv] });
    const row = (await screen.findByText("srv10")).closest(".mcp-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    expect(within(row).getByText(MCP_SECRET_STORAGE_NOTE)).toBeInTheDocument();
  });

  // ── folded in from W5's connections panel at the merge, against the surviving surface ──

  it("Test reports the live check's outcome, reached or failed", async () => {
    const srv = mcpServer("m20", { name: "srv20", enabled: true });
    const { api } = await mount({ mcpServers: [srv], mcpTest: { m20: { reached: false, detail: "could not start: spawn nope ENOENT" } } });
    const row = (await screen.findByText("srv20")).closest(".mcp-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Test" }));
    expect(await within(row).findByText("could not start: spawn nope ENOENT")).toBeInTheDocument();
    expect(api.calls).toContain("testMcpServer:m20");
  });

  it("refuses a name the wire would reject, naming the rule rather than failing on save", async () => {
    const { api } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Add server…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Server name" }), { target: { value: "my server!" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Command" }), { target: { value: "npx" } });
    expect(screen.getByText("Letters, digits, underscore or hyphen only.")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Add server" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(api.calls.some((c) => c.startsWith("addMcpServer:"))).toBe(false);
  });

  it("Disconnect calls mcp.oauth.disconnect", async () => {
    const srv = mcpServer("m11", { name: "srv11", transport: "http", url: "https://mcp.example/", authKind: "oauth", oauthStatus: "connected", enabled: true });
    const { api } = await mount({ mcpServers: [srv] });
    const row = (await screen.findByText("srv11")).closest(".mcp-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(row).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(api.calls).toContain("disconnectMcpOauth:m11"));
  });

  it("a reconnect_needed server shows a reauth badge in the LIST, before Edit is ever opened", async () => {
    const srv = mcpServer("m12", { name: "srv12", transport: "http", url: "https://mcp.example/", authKind: "oauth", oauthStatus: "reconnect_needed", enabled: true });
    await mount({ mcpServers: [srv] });
    const row = (await screen.findByText("srv12")).closest(".mcp-row") as HTMLElement;
    expect(within(row).getByText("Needs reauth")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Reconnect" })).toBeNull();
  });
});
