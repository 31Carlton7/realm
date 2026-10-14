import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CONNECTORS, PAGE_REF_IDS, connectorServerName, type McpSignInOptions } from "@realm/contracts";
import { ConnectionsPage } from "./ConnectionsPage";
import { SpacePage } from "../space/SpacePage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, mcpServer, type FakeData } from "../../state/store.test-fakes";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const github = CONNECTORS.find((c) => c.id === "github")!;
const row = (extra: Parameters<typeof mcpServer>[1] = {}) =>
  mcpServer("m1", { name: connectorServerName(github), transport: "http", url: github.url, scope: { kind: "space", spaceId: "s1" }, ...extra });
const options = (o: Partial<McpSignInOptions> = {}): McpSignInOptions => ({
  provider: "GitHub", cli: { name: "GitHub CLI", state: "signed-out" }, device: false,
  token: { url: "https://github.com/settings/tokens/new?scopes=repo,read:org", scopes: "repo read:org workflow" }, ...o,
});

async function mount(overrides: FakeData = {}) {
  const api = fakeApi({ mcpServers: [row()], ...overrides });
  const store = createAppStore(api);
  await store.getState().boot();
  const opened: string[] = [];
  vi.stubGlobal("open", (url: string) => { opened.push(url); return null; });
  render(<StoreContext.Provider value={store}><ConnectionsPage item={item("pg-s1", "s1", { kind: "connections-page", title: "Connections", refId: PAGE_REF_IDS["connections-page"] })} visible /></StoreContext.Provider>);
  const card = () => within(screen.getByRole("region", { name: "Connect an app" })).getByText("GitHub").closest(".market-card") as HTMLElement;
  await waitFor(() => expect(within(card()).getByRole("button", { name: "Finish signing in" })).toBeInTheDocument());
  const press = () => fireEvent.click(within(card()).getByRole("button", { name: "Finish signing in" }));
  return { api, store, opened, press };
}

describe("Connect GitHub without dynamic registration", () => {
  it("with the GitHub CLI signed in, Connect connects with no browser and no sheet", async () => {
    const { api, opened, press } = await mount({ mcpOauthStart: { m1: "cli" } });
    press();
    await waitFor(() => expect(api.calls).toContain("startMcpOauth:m1"));
    expect(opened).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refused for want of a client, Connect opens the ways in instead of an error toast", async () => {
    /* The mutant: let the refusal reach `run`, which toasts it — the door onto a wall design.md names. */
    const { store, opened, press } = await mount({ mcpOauthStart: { m1: "no-registration" }, mcpSignInOptions: { m1: options() } });
    press();
    const sheet = await screen.findByRole("dialog", { name: "Connect GitHub" });
    expect(sheet).toHaveTextContent("GitHub issues no client to apps it has not met");
    expect(store.getState().toasts).toHaveLength(0);
    expect(opened).toHaveLength(0);
    // The CLI is signed out: the sheet says what to run, and offers to look again rather than a dead button.
    expect(within(sheet).getByRole("region", { name: "GitHub CLI" })).toHaveTextContent("gh auth login");
    expect(within(sheet).queryByRole("button", { name: "Sign in with the GitHub CLI" })).toBeNull();
    expect(within(sheet).getByRole("button", { name: "Check again" })).toBeInTheDocument();
    // No app registered for the device flow: that route is not drawn at all, not drawn disabled.
    expect(within(sheet).queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
    expect(within(sheet).getByRole("link", { name: "Create one on GitHub" })).toHaveAttribute("href", expect.stringContaining("github.com/settings/tokens"));
  });

  it("a pasted token connects and closes the sheet; the call log never holds the token", async () => {
    const { api, press } = await mount({ mcpOauthStart: { m1: "no-registration" }, mcpSignInOptions: { m1: options() } });
    press();
    const sheet = await screen.findByRole("dialog", { name: "Connect GitHub" });
    const connect = within(sheet).getByRole("button", { name: "Connect with this token" });
    expect(connect).toBeDisabled();
    expect(connect).toHaveClass("primary"); // nothing else works with nothing typed
    fireEvent.change(within(sheet).getByLabelText("Token"), { target: { value: "github_pat_abc123" } });
    fireEvent.click(connect);
    await waitFor(() => expect(api.calls).toContain("setMcpToken:m1:17"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("with the CLI ready, it is the primary way in", async () => {
    const { api, press } = await mount({ mcpOauthStart: { m1: "no-registration" }, mcpSignInOptions: { m1: options({ cli: { name: "GitHub CLI", state: "ready" } }) } });
    press();
    const sheet = await screen.findByRole("dialog", { name: "Connect GitHub" });
    const cli = within(sheet).getByRole("button", { name: "Sign in with the GitHub CLI" });
    expect(cli).toHaveClass("primary");
    expect(within(sheet).getByRole("button", { name: "Connect with this token" })).not.toHaveClass("primary");
    fireEvent.click(cli);
    await waitFor(() => expect(api.calls).toContain("connectMcpWithCli:m1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("the device flow shows the code, opens GitHub's page, and closes once approved", async () => {
    const { api, opened, press } = await mount({ mcpOauthStart: { m1: "no-registration" }, mcpSignInOptions: { m1: options({ device: true }) } });
    press();
    const sheet = await screen.findByRole("dialog", { name: "Connect GitHub" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Sign in with GitHub" }));
    await waitFor(() => expect(api.calls).toContain("waitMcpDevice:m1"));
    expect(opened).toEqual(["https://github.com/login/device"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("an expired device code says so and offers to start again", async () => {
    const { press } = await mount({ mcpOauthStart: { m1: "no-registration" }, mcpSignInOptions: { m1: options({ device: true }) }, mcpDeviceError: "MCP_OAUTH_EXPIRED" });
    press();
    const sheet = await screen.findByRole("dialog", { name: "Connect GitHub" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Sign in with GitHub" }));
    expect(await within(sheet).findByText(/code expired/)).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Start again" })).toBeInTheDocument();
  });
});

describe("a token for any remote server", () => {
  async function mountEditor(overrides: FakeData) {
    const api = fakeApi(overrides);
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><SpacePage item={item("pg1", "s1", { kind: "space-page", title: "Overview", refId: "s1" })} visible /></StoreContext.Provider>);
    fireEvent.click(screen.getByRole("radio", { name: "Connections" }));
    const r = (await screen.findByText("srv1")).closest(".mcp-row") as HTMLElement;
    fireEvent.click(within(r).getByRole("button", { name: "Edit" }));
    return { api, row: r };
  }

  it("Use a token instead opens the sheet with no apology, and its submit does not save the editor behind it", async () => {
    /* The mutant: drop the sheet's stopPropagation — React bubbles the portalled submit into the
       server editor's own form, which saves and closes it. */
    const { api, row: r } = await mountEditor({ mcpServers: [mcpServer("m1", { name: "srv1", transport: "http", url: "https://mcp.example/", enabled: true })] });
    fireEvent.click(within(r).getByRole("button", { name: "Use a token instead" }));
    const sheet = await screen.findByRole("dialog", { name: "Connect srv1" });
    expect(sheet).not.toHaveTextContent("issues no client");
    expect(within(sheet).queryByRole("region", { name: "GitHub CLI" })).toBeNull();
    fireEvent.change(within(sheet).getByLabelText("Token"), { target: { value: "sk-live-123" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Connect with this token" }));
    await waitFor(() => expect(api.calls).toContain("setMcpToken:m1:11"));
    expect(api.calls.some((c) => c.startsWith("updateMcpServer"))).toBe(false);
  });

  it("a connected row says where its token came from", async () => {
    await mountEditor({ mcpServers: [mcpServer("m1", { name: "srv1", transport: "http", url: "https://api.githubcopilot.com/mcp/", authKind: "oauth", oauthStatus: "connected", oauthVia: "cli", enabled: true })] });
    expect(screen.getByText("Connected with the GitHub CLI's sign-in.")).toBeInTheDocument();
  });
});
