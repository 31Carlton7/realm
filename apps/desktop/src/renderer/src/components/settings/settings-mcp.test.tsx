import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { McpPanel } from "./McpPanel";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, mcpRow, type FakeData } from "../../state/store.test-fakes";

/** Never a real key; every assertion about it is that it does NOT appear somewhere. */
const KEY = "tok-do-not-render-me";

async function mount(overrides: FakeData = {}) {
  const api = fakeApi({
    mcpRows: [mcpRow("m1", "github", { command: "npx", args: ["-y", "gh-mcp"], secrets: { GITHUB_TOKEN: KEY } })],
    mcpEnabled: { s1: ["m1"], s2: ["m1"] },
    ...overrides,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><McpPanel spaceId="s1" /></StoreContext.Provider>);
  await screen.findByText("github");
  return { api, store };
}

describe("the connections panel", () => {
  it("displays the secret-storage note the server sends with every list", async () => {
    // W2 returns MCP_SECRET_STORAGE_NOTE on every mcp.list precisely so this panel cannot forget it.
    await mount();
    expect(screen.getByText(/stored in plain text in Realm's database/)).toBeInTheDocument();
  });

  it("shows key NAMES with 'set' — the value appears nowhere on the panel", async () => {
    // The named mutant: a secret value rendered after save. The wire cannot even carry one
    // (McpServerSchema has no field), so any appearance would mean the panel invented a path.
    await mount();
    expect(screen.getByText(/GITHUB_TOKEN — set/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("states each agent's transport reality, including Codex's missing SSE", async () => {
    await mount();
    expect(screen.getByText(/Codex connects to this space's enabled stdio and http servers; it has no sse support, so those are skipped\./)).toBeInTheDocument();
    expect(screen.getByText(/Claude connects to this space's enabled stdio and http and sse servers\./)).toBeInTheDocument();
  });

  it("says the enable set is per-space opt-in", async () => {
    await mount();
    expect(screen.getByText(/each space opts in on its own/)).toBeInTheDocument();
  });

  it("disabling writes THIS space's opt-in set — the other space keeps the server armed", async () => {
    // The named mutant: a toggle that writes global state. s2 opted in too; it must not move.
    const { api } = await mount();
    fireEvent.click(screen.getByRole("switch", { name: "Server github in this space" }));
    await waitFor(() => expect(api.calls).toContain("setMcpEnabled:s1:m1=false"));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Server github in this space" })).not.toBeChecked());
    expect(api.data.mcpEnabled.s2).toEqual(["m1"]);
  });

  it("enabling writes THIS space's opt-in set — a space that never opted in stays off", async () => {
    // The same mutant, other direction: W2's whole point is that a server armed in Work must not arm
    // itself in School.
    const { api } = await mount({ mcpEnabled: { s2: ["m1"] } });
    const sw = await screen.findByRole("switch", { name: "Server github in this space" });
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    await waitFor(() => expect(api.calls).toContain("setMcpEnabled:s1:m1=true"));
    expect(api.data.mcpEnabled.s1).toEqual(["m1"]);
    expect(api.data.mcpEnabled.s2).toEqual(["m1"]); // untouched, not re-written
  });

  it("adds a remote server: the header value goes on the wire once and never comes back to the screen", async () => {
    const { api } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Add server…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Server name" }), { target: { value: "vercel" } });
    fireEvent.click(screen.getByRole("radio", { name: "http" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Server URL" }), { target: { value: "https://mcp.vercel.com" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Key 1" }), { target: { value: "Authorization" } });
    fireEvent.change(screen.getByLabelText("Value for Authorization"), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    await waitFor(() => expect(screen.getByText("vercel")).toBeInTheDocument());
    // On the wire exactly once, as headers, scoped to this space…
    expect(api.mcpWrites).toEqual([{ spaceId: "s1", name: "vercel", transport: "http", url: "https://mcp.vercel.com", headers: { Authorization: KEY } }]);
    // …enabled here and nowhere else…
    expect(api.data.mcpEnabled.s1).toContain("mcp101");
    expect(api.data.mcpEnabled.s2).toEqual(["m1"]);
    // …and the value is gone from the screen for good (the named mutant).
    expect(document.body.textContent).not.toContain(KEY);
    expect(screen.getByText(/headers: Authorization — set/)).toBeInTheDocument();
  });

  it("the add form starts with one empty key row and can grow more", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Add server…" }));
    expect(screen.getByRole("textbox", { name: "Key 1" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    expect(screen.getByRole("textbox", { name: "Key 2" })).toBeInTheDocument();
    // An empty key row is dropped at save, not sent as "": exercised by the add test's exact wire shape.
  });

  it("a rename sends NO env — the key the form was never shown survives the save", async () => {
    // mcp.update's omitted-means-kept contract, exercised from the UI side: touching the name must
    // not wipe the stored secret.
    const { api } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Server name" }), { target: { value: "github2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));
    await waitFor(() => expect(screen.getByText("github2")).toBeInTheDocument());
    const write = api.mcpWrites[0]!;
    expect("env" in write).toBe(false);
    expect("headers" in write).toBe(false);
    expect(api.data.mcpRows[0]!.secrets).toEqual({ GITHUB_TOKEN: KEY });
  });

  it("the edit form shows the key as set, offers replace, and never prefills a value", async () => {
    const { api } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("GITHUB_TOKEN · set")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(KEY);
    fireEvent.click(screen.getByRole("button", { name: "Replace keys…" }));
    // The key NAME carries over; the value field is empty — the client never had the value to show.
    expect(screen.getByRole("textbox", { name: "Key 1" })).toHaveValue("GITHUB_TOKEN");
    expect(screen.getByLabelText("Value for GITHUB_TOKEN")).toHaveValue("");
    expect(screen.getByText(/Saving replaces every key and value/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Value for GITHUB_TOKEN"), { target: { value: "fresh-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));
    await waitFor(() => expect(api.data.mcpRows[0]!.secrets).toEqual({ GITHUB_TOKEN: "fresh-token" }));
    const write = api.mcpWrites[0]! as { env?: Record<string, string> };
    expect(write.env).toEqual({ GITHUB_TOKEN: "fresh-token" });
  });

  it("Test reports the live check's outcome, reached or failed", async () => {
    await mount({
      mcpRows: [mcpRow("m1", "github", { command: "npx" }), mcpRow("m2", "dead", { command: "gone" })],
      mcpEnabled: { s1: ["m1"] },
      mcpTest: {
        m1: { reached: true, detail: "reached — fake-mcp 9.9" },
        m2: { reached: false, detail: "could not start: spawn gone ENOENT" },
      },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Test" })[0]!);
    expect(await screen.findByText("reached — fake-mcp 9.9")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Test" })[1]!);
    expect(await screen.findByText(/could not start/)).toBeInTheDocument();
  });

  it("removal asks first, names its blast radius, and forgets every space's opt-in", async () => {
    const { api } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
    expect(screen.getByText(/from every space, keys included/)).toBeInTheDocument();
    expect(api.calls.some((c) => c.startsWith("removeMcpServer"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.calls.some((c) => c.startsWith("removeMcpServer"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("github")).toBeNull());
    expect(api.data.mcpRows).toEqual([]);
    expect(api.data.mcpEnabled.s2).toEqual([]);
  });

  it("refuses to save a server with no endpoint or a name the wire would reject", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Add server…" }));
    const save = screen.getByRole("button", { name: "Add server" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Server name" }), { target: { value: "bad name!" } });
    expect(screen.getByText(/Letters, digits, underscore or hyphen only/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Server name" }), { target: { value: "ok_name" } });
    expect(save).toBeDisabled(); // still no command
    fireEvent.change(screen.getByRole("textbox", { name: "Command" }), { target: { value: "npx" } });
    expect(save).not.toBeDisabled();
  });
});
