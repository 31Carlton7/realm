import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserOrigins } from "./BrowserOrigins";
import { ALLOWLIST_GUARDRAIL_NOTE, allowlistKey, parseOriginInput, setBrowserBridgesForTests } from "../../panes/browser/browser-client";
import { fakeBrowserBridges } from "../../panes/browser/browser-bridges.test-fakes";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";

/* ——— parseOriginInput: the validator the editor stands on (Plan 14 W4) ——— */

describe("parseOriginInput", () => {
  it("accepts origins and normalizes bare hosts onto https", () => {
    expect(parseOriginInput("https://example.com")).toBe("https://example.com");
    expect(parseOriginInput("  example.com  ")).toBe("https://example.com");
    expect(parseOriginInput("https://example.com:8443")).toBe("https://example.com:8443");
    // The origin form as browsers print it — a single trailing slash is still just the origin.
    expect(parseOriginInput("https://example.com/")).toBe("https://example.com");
  });
  it("defaults loopback hosts to http, like main's normalizeAddress (dev servers speak no TLS)", () => {
    expect(parseOriginInput("localhost:3000")).toBe("http://localhost:3000");
    expect(parseOriginInput("127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(parseOriginInput("https://localhost:8443")).toBe("https://localhost:8443"); // explicit scheme wins
  });
  it("REJECTS full URLs — a stored path would silently widen to the whole origin", () => {
    // The named mutant: validation that accepts URLs stores entries that fence more than they say.
    expect(parseOriginInput("https://example.com/admin")).toBeNull();
    expect(parseOriginInput("example.com/admin")).toBeNull();
    expect(parseOriginInput("https://example.com?q=1")).toBeNull();
    expect(parseOriginInput("https://example.com/#top")).toBeNull();
    expect(parseOriginInput("https://user:pw@example.com")).toBeNull();
  });
  it("rejects non-http schemes, garbage and emptiness", () => {
    expect(parseOriginInput("file:///etc/passwd")).toBeNull();
    expect(parseOriginInput("data:text/html,x")).toBeNull();
    expect(parseOriginInput("not a url")).toBeNull();
    expect(parseOriginInput("")).toBeNull();
    expect(parseOriginInput("   ")).toBeNull();
  });
});

/* ——— The editor + the live re-fence ——— */

function fakeHost() {
  const setCalls: { id: string; list: string[] | null }[] = [];
  const bridges = fakeBrowserBridges({
    host: { setAllowlist: async (id, list) => { setCalls.push({ id, list }); } },
    server: { get: async () => { throw new Error("unused"); } },
  });
  return { bridges, setCalls };
}

async function mount(settings: Record<string, unknown> = {}) {
  const { bridges, setCalls } = fakeHost();
  setBrowserBridgesForTests(bridges);
  // The active space s1 has one OPEN browser pane (item b1) plus the default terminal — the live view
  // the write must re-fence — and s2 exists so cross-space leakage would have somewhere to go.
  const api = fakeApi({
    settings,
    items: { s1: [item("i1", "s1", { title: "Terminal" }), item("ib", "s1", { kind: "browser", refId: "b1", title: "Browser" })] },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><BrowserOrigins spaceId="s1" /></StoreContext.Provider>);
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  return { api, store, setCalls, ...r };
}

afterEach(() => setBrowserBridgesForTests(null));

describe("BrowserOrigins", () => {
  it("surfaces the default posture honestly and carries the guardrail doctrine verbatim", async () => {
    await mount();
    expect(screen.getByRole("radio", { name: "All origins" })).toBeChecked();
    expect(screen.getByText(/no list is configured, and browser panes can go anywhere/)).toBeInTheDocument();
    expect(screen.getByText(ALLOWLIST_GUARDRAIL_NOTE)).toBeInTheDocument();
    // Allow-all shows no add form: there is no list to add to until the posture says so.
    expect(screen.queryByRole("textbox", { name: "Origin to allow" })).toBeNull();
  });

  it("renders a configured list with the Only listed posture", async () => {
    await mount({ [allowlistKey("s1")]: ["https://example.com"] });
    expect(screen.getByRole("radio", { name: "Only listed" })).toBeChecked();
    expect(screen.getByText("https://example.com")).toBeInTheDocument();
  });

  it("adds a valid origin: persisted under the space's key AND pushed into the live pane", async () => {
    const { api, setCalls } = await mount({ [allowlistKey("s1")]: [] });
    fireEvent.change(screen.getByRole("textbox", { name: "Origin to allow" }), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add origin" }));
    await waitFor(() => expect(screen.getByText("https://example.com")).toBeInTheDocument());
    expect(api.calls).toContain(`setSetting:${allowlistKey("s1")}=https://example.com`);
    // The live re-fence (the named mutant): the OPEN browser view is re-pointed without a reopen —
    // and only the browser item, never the terminal sharing the space.
    expect(setCalls).toEqual([{ id: "b1", list: ["https://example.com"] }]);
  });

  it("refuses a URL where an origin belongs, and persists NOTHING", async () => {
    const { api, setCalls } = await mount({ [allowlistKey("s1")]: [] });
    fireEvent.change(screen.getByRole("textbox", { name: "Origin to allow" }), { target: { value: "https://example.com/admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Add origin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not an origin: https://example.com/admin");
    expect(api.calls.filter((c) => c.startsWith(`setSetting:${allowlistKey("s1")}`))).toEqual([]);
    expect(setCalls).toEqual([]);
  });

  it("removing an origin and returning to All origins both re-fence the live pane", async () => {
    const { setCalls } = await mount({ [allowlistKey("s1")]: ["https://a.com", "https://b.com"] });
    const row = screen.getByText("https://a.com").closest("li")!;
    fireEvent.click(row.querySelector("button")!);
    await waitFor(() => expect(setCalls).toEqual([{ id: "b1", list: ["https://b.com"] }]));
    // Removing the last entry keeps the honest "nothing allowed" posture, said out loud…
    fireEvent.click(screen.getByText("https://b.com").closest("li")!.querySelector("button")!);
    await waitFor(() => expect(screen.getByText(/No origins listed — browser panes can't go anywhere/)).toBeInTheDocument());
    expect(setCalls[1]).toEqual({ id: "b1", list: [] });
    // …and All origins is the deliberate way out: null reaches the pane, not [].
    fireEvent.click(screen.getByRole("radio", { name: "All origins" }));
    await waitFor(() => expect(setCalls[2]).toEqual({ id: "b1", list: null }));
  });

  it("does not touch another space's panes: an inactive space's write re-fences nothing", async () => {
    const { bridges, setCalls } = fakeHost();
    setBrowserBridgesForTests(bridges);
    const api = fakeApi({ items: { s1: [item("ib", "s1", { kind: "browser", refId: "b1", title: "Browser" })] } });
    const store = createAppStore(api);
    await store.getState().boot(); // active space is s1; the write below is for s2
    await store.getState().setBrowserAllowlist("s2", ["https://x.com"]);
    expect(api.calls).toContain(`setSetting:${allowlistKey("s2")}=https://x.com`);
    expect(setCalls).toEqual([]); // s1's open pane keeps s1's fence
  });
});
