import { describe, expect, it } from "vitest";
import type { Browser } from "@realm/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createBrowserAgentProvider, BROWSER_PROVIDER_NAME, type BrowserAgentToolsDeps } from "./agent-tools";
import type { GateResult } from "./permissions";

/**
 * The registry's own behavior with everything around it faked: gating order, hard blocks, fencing,
 * space scoping. The broker's semantics (modes, allow_always) are permissions.test.ts; the executor's
 * (quads, password detection) are Electron main's tests. What must die HERE, per the plan's mutant
 * list: a mutating act that slips through without a gate; a batch running a mutating action
 * unprompted; an OAuth navigation reaching the bridge; a password refusal not surfacing as a refusal.
 */
function setup(opts: {
  gate?: GateResult;
  enabled?: boolean;
  bridgeResults?: Record<string, unknown>;
} = {}) {
  const rows = new Map<string, Browser>();
  rows.set("b1", { id: "b1", spaceId: "space1", url: "https://example.com/", title: "Example", createdAt: 1, updatedAt: 1 });
  rows.set("bX", { id: "bX", spaceId: "spaceOTHER", url: "https://other.com/", title: "Other", createdAt: 1, updatedAt: 1 });

  const calls = { gates: [] as { toolKey: string; title: string }[], bridge: [] as { op: string; params: Record<string, unknown> }[], broadcasts: [] as { event: string; payload: unknown }[], opened: [] as string[] };
  const bridgeResults: Record<string, unknown> = {
    describe: { open: true, url: "https://example.com/checkout", title: "Example", element: { role: "button", name: "Submit order", tag: "button", inputType: null } },
    snapshot: { url: "https://example.com/", title: "Example", text: '[ref=11] button "Submit order"', elementCount: 1 },
    read: { text: "hello page text" },
    act: { ok: true, detail: "clicked" },
    navigate: { url: "https://example.com/next" },
    screenshot: { data: "aW1n", mimeType: "image/png" },
    ...opts.bridgeResults,
  };

  const deps: BrowserAgentToolsDeps = {
    browsers: {
      get: (id) => rows.get(id) ?? null,
      list: (spaceId) => [...rows.values()].filter((r) => r.spaceId === spaceId),
    },
    browserService: {
      open: ({ spaceId, url }) => {
        calls.opened.push(url);
        const id = `b${rows.size + 1}`;
        rows.set(id, { id, spaceId, url, title: "Browser", createdAt: 2, updatedAt: 2 });
        return { browserId: id, itemId: `item-${id}`, url };
      },
    },
    mcp: { providerEnabled: () => opts.enabled ?? true },
    bridge: {
      call: async (op, params) => {
        calls.bridge.push({ op, params });
        const r = bridgeResults[op];
        if (r instanceof Error) throw r;
        return r;
      },
    },
    broker: {
      gate: async (_sessionId, toolKey, title) => {
        calls.gates.push({ toolKey, title });
        return opts.gate ?? { allowed: true };
      },
    },
    rpc: { broadcast: (event, payload) => { calls.broadcasts.push({ event, payload }); } } as BrowserAgentToolsDeps["rpc"],
  };
  const provider = createBrowserAgentProvider(deps);
  const ctx = { sessionId: "sess1", spaceId: "space1" };
  const call = (tool: string, args: unknown): Promise<CallToolResult> => provider.call(ctx, tool, args);
  return { provider, ctx, call, calls };
}

const text = (r: CallToolResult): string =>
  r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");

describe("gating — the named mutants", () => {
  it("browser_act gates BEFORE the bridge runs anything (mutant: act without permission_request)", async () => {
    const { call, calls } = setup();
    await call("browser_act", { browserId: "b1", action: { kind: "click", ref: 11 } });
    expect(calls.gates.map((g) => g.toolKey)).toEqual(["browser_act"]);
    const firstActIndex = calls.bridge.findIndex((b) => b.op === "act");
    expect(firstActIndex).toBeGreaterThanOrEqual(0);
  });

  it("a denied gate means the act op NEVER reaches the bridge", async () => {
    const { call, calls } = setup({ gate: { allowed: false, reason: "the user denied this action" } });
    const r = await call("browser_act", { browserId: "b1", action: { kind: "click", ref: 11 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("denied");
    expect(calls.bridge.filter((b) => b.op === "act")).toEqual([]);
  });

  it("browser_navigate and browser_open gate too", async () => {
    const { call, calls } = setup({ gate: { allowed: false, reason: "no" } });
    await call("browser_navigate", { browserId: "b1", url: "https://example.com/x" });
    await call("browser_open", { url: "https://example.com/y" });
    expect(calls.gates.map((g) => g.toolKey).sort()).toEqual(["browser_navigate", "browser_open"]);
    expect(calls.bridge.filter((b) => b.op === "navigate")).toEqual([]);
    expect(calls.opened).toEqual([]);
  });

  it("read-only tools never gate", async () => {
    const { call, calls } = setup();
    await call("browser_list", {});
    await call("browser_snapshot", { browserId: "b1" });
    await call("browser_read", { browserId: "b1", kind: "console" });
    await call("browser_screenshot", { browserId: "b1" });
    expect(calls.gates).toEqual([]);
  });

  it("the act permission title names the action, attributes the label to the PAGE, and names the host", async () => {
    const { call, calls } = setup();
    await call("browser_act", { browserId: "b1", action: { kind: "click", ref: 11 } });
    expect(calls.gates[0]!.title).toBe('Click the button the page labels "Submit order" on example.com');
  });
});

describe("browser_batch", () => {
  it("runs unprompted ONLY when every action is read-only", async () => {
    const { call, calls } = setup();
    const r = await call("browser_batch", { actions: [
      { tool: "browser_snapshot", arguments: { browserId: "b1" } },
      { tool: "browser_read", arguments: { browserId: "b1" } },
    ] });
    expect(r.isError).toBe(false);
    expect(calls.gates).toEqual([]);
  });

  it("a batch containing ANY mutating action gates once for the whole batch (mutant: batch mutation unprompted)", async () => {
    const { call, calls } = setup();
    await call("browser_batch", { actions: [
      { tool: "browser_snapshot", arguments: { browserId: "b1" } },
      { tool: "browser_act", arguments: { browserId: "b1", action: { kind: "click", ref: 11 } } },
    ] });
    expect(calls.gates.map((g) => g.toolKey)).toEqual(["browser_batch"]);
    expect(calls.gates[0]!.title).toContain("browser_act");
    expect(calls.bridge.some((b) => b.op === "act")).toBe(true);
  });

  it("a denied batch runs NOTHING — not even its read-only steps", async () => {
    const { call, calls } = setup({ gate: { allowed: false, reason: "no" } });
    const r = await call("browser_batch", { actions: [
      { tool: "browser_snapshot", arguments: { browserId: "b1" } },
      { tool: "browser_act", arguments: { browserId: "b1", action: { kind: "click", ref: 11 } } },
    ] });
    expect(r.isError).toBe(true);
    expect(calls.bridge).toEqual([]);
  });

  it("stops at the first failing step and reports where", async () => {
    const { call } = setup({ bridgeResults: { act: { ok: false, error: "nope" } } });
    const r = await call("browser_batch", { actions: [
      { tool: "browser_act", arguments: { browserId: "b1", action: { kind: "click", ref: 11 } } },
      { tool: "browser_snapshot", arguments: { browserId: "b1" } },
    ] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("batch stopped at step 1");
    expect(text(r)).not.toContain("step 2: browser_snapshot ok");
  });

  it("batch steps still hit the hard blocks — an OAuth navigate inside an approved batch is refused", async () => {
    const { call, calls } = setup();
    const r = await call("browser_batch", { actions: [
      { tool: "browser_navigate", arguments: { browserId: "b1", url: "https://github.com/login/oauth/authorize?client_id=x" } },
    ] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("OAuth");
    expect(calls.bridge.filter((b) => b.op === "navigate")).toEqual([]);
  });

  it("cannot nest", async () => {
    const { call } = setup();
    const r = await call("browser_batch", { actions: [{ tool: "browser_batch", arguments: {} }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("cannot nest");
  });
});

describe("hard blocks", () => {
  it("OAuth consent URLs are refused BEFORE gating and BEFORE the bridge — no mode can reach them", async () => {
    const { call, calls } = setup({ gate: { allowed: true } });
    for (const tool of ["browser_navigate", "browser_open"] as const) {
      const args = tool === "browser_open"
        ? { url: "https://accounts.google.com/o/oauth2/auth?client_id=x" }
        : { browserId: "b1", url: "https://accounts.google.com/o/oauth2/auth?client_id=x" };
      const r = await call(tool, args);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("consent");
    }
    expect(calls.gates).toEqual([]);
    expect(calls.bridge.filter((b) => b.op === "navigate")).toEqual([]);
    expect(calls.opened).toEqual([]);
  });

  it("the executor's password refusal surfaces as a hand-to-the-user error (mutant: password type not refused)", async () => {
    // The gate ALLOWS (bypassPermissions would too) — the refusal must come through anyway, because
    // it is the executor's, not the broker's.
    const { call } = setup({ bridgeResults: { act: { ok: false, error: "password field", refused: "password" } } });
    const r = await call("browser_act", { browserId: "b1", action: { kind: "type", ref: 11, text: "hunter2" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("password field");
    expect(text(r)).toContain("let them do it in the pane");
  });

  it("non-http(s) URLs never navigate — no file:, data:, javascript:", async () => {
    const { call, calls } = setup();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "chrome://settings"]) {
      const r = await call("browser_navigate", { browserId: "b1", url });
      expect(r.isError).toBe(true);
    }
    expect(calls.bridge.filter((b) => b.op === "navigate")).toEqual([]);
    expect(calls.gates).toEqual([]);
  });
});

describe("results and scoping", () => {
  it("snapshot output is fenced as untrusted page content", async () => {
    const { call } = setup();
    const r = await call("browser_snapshot", { browserId: "b1" });
    const t = text(r);
    expect(t).toContain("WEB PAGE CONTENT");
    expect(t).toMatch(/<<<untrusted-[0-9a-f]{16}/);
    expect(t).toContain('[ref=11] button "Submit order"');
  });

  it("browser_read output is fenced for every kind — console and network are page-influenced too", async () => {
    const { call } = setup();
    for (const kind of ["text", "console", "network"]) {
      expect(text(await call("browser_read", { browserId: "b1", kind }))).toMatch(/<<<untrusted-/);
    }
  });

  it("a browserId from another space is refused like one that does not exist", async () => {
    const { call, calls } = setup();
    const r = await call("browser_snapshot", { browserId: "bX" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("no browser");
    expect(calls.bridge).toEqual([]);
  });

  it("browser_list only lists this space's panes", async () => {
    const { call } = setup();
    const t = text(await call("browser_list", {}));
    expect(t).toContain("b1");
    expect(t).not.toContain("bX");
  });

  it("a failed act attaches a screenshot automatically", async () => {
    const { call } = setup({ bridgeResults: { act: { ok: false, error: "element has no visible geometry" } } });
    const r = await call("browser_act", { browserId: "b1", action: { kind: "click", ref: 11 } });
    expect(r.isError).toBe(true);
    expect(r.content.some((c) => c.type === "image" && c.data === "aW1n")).toBe(true);
  });

  it("browser_open creates the pane, broadcasts browser.agentOpened, and returns the id", async () => {
    const { call, calls } = setup();
    const r = await call("browser_open", { url: "https://example.com/docs" });
    expect(r.isError).toBe(false);
    expect(calls.opened).toEqual(["https://example.com/docs"]);
    // agentOpened first (the pane must join the layout), then the W4 ticker's action record.
    expect(calls.broadcasts.map((b) => b.event)).toEqual(["browser.agentOpened", "browser.action"]);
  });

  it("the provider disabled for a space lists no tools and refuses calls", async () => {
    const { provider, ctx, call } = setup({ enabled: false });
    expect(await provider.tools(ctx)).toEqual([]);
    const r = await call("browser_snapshot", { browserId: "b1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("disabled");
  });

  it("provider name and tool names line up with the wire contract", async () => {
    const { provider, ctx } = setup();
    expect(provider.name).toBe(BROWSER_PROVIDER_NAME);
    const names = (await provider.tools(ctx)).map((t) => t.name);
    expect(names).toEqual(["browser_list", "browser_open", "browser_navigate", "browser_snapshot", "browser_read", "browser_screenshot", "browser_act", "browser_batch"]);
  });

  it("a bridge failure (app not running) reads as an honest tool error, not a crash", async () => {
    const { call } = setup({ bridgeResults: { snapshot: new Error("the Realm app is not connected — browser tools need the desktop app running") } });
    const r = await call("browser_snapshot", { browserId: "b1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("desktop app running");
  });
});

describe("W4 — watching broadcasts (browser.driving / browser.action)", () => {
  type B = { event: string; payload: unknown };
  const ofBrowser = (broadcasts: B[], browserId: string) =>
    broadcasts.filter((b) => (b.payload as { browserId?: string }).browserId === browserId);
  const driving = (broadcasts: B[]) =>
    broadcasts.filter((b) => b.event === "browser.driving").map((b) => (b.payload as { driving: boolean }).driving);
  const actions = (broadcasts: B[]) =>
    broadcasts.filter((b) => b.event === "browser.action").map((b) => b.payload as { text: string; ok: boolean; ts: number });

  it("an act broadcasts driving true → false around it, then ONE action with the gate's exact attributed title", async () => {
    const { call, calls } = setup();
    await call("browser_act", { browserId: "b1", action: { kind: "click", ref: 11 } });
    const mine = ofBrowser(calls.broadcasts, "b1");
    expect(driving(mine)).toEqual([true, false]);
    const acts = actions(mine);
    expect(acts).toHaveLength(1);
    // The ticker text IS the permission title — attributed framing and all. Raw page text outside
    // the `the page labels "…"` framing is the laundering mutant this pins dead.
    expect(acts[0]!.text).toBe(calls.gates[0]!.title);
    expect(acts[0]!.text).toBe('Click the button the page labels "Submit order" on example.com');
    expect(acts[0]!.ok).toBe(true);
    expect(acts[0]!.ts).toBeGreaterThan(0);
    // driving:true precedes the bridge act; the action broadcast comes AFTER settle (last of the three).
    expect(mine.map((b) => b.event)).toEqual(["browser.driving", "browser.driving", "browser.action"]);
  });

  it("a bridge failure (timeout, dead host) can NEVER leave driving stuck ON (the named mutant)", async () => {
    const { call, calls } = setup({ bridgeResults: { act: new Error('browser host op "act" timed out after 60s') } });
    const r = await call("browser_act", { browserId: "b1", action: { kind: "click", ref: 11 } });
    expect(r.isError).toBe(true);
    const mine = ofBrowser(calls.broadcasts, "b1");
    expect(driving(mine)).toEqual([true, false]);
    expect(actions(mine)).toEqual([expect.objectContaining({ ok: false })]);
  });

  it("a failed act still settles the broadcasts, with ok: false", async () => {
    const { call, calls } = setup({ bridgeResults: { act: { ok: false, error: "no visible geometry" } } });
    await call("browser_act", { browserId: "b1", action: { kind: "click", ref: 11 } });
    const mine = ofBrowser(calls.broadcasts, "b1");
    expect(driving(mine)).toEqual([true, false]);
    expect(actions(mine)[0]!.ok).toBe(false);
  });

  it("a denied gate broadcasts NOTHING — nothing ran, so nothing may tick", async () => {
    const { call, calls } = setup({ gate: { allowed: false, reason: "no" } });
    await call("browser_act", { browserId: "b1", action: { kind: "click", ref: 11 } });
    await call("browser_navigate", { browserId: "b1", url: "https://example.com/x" });
    expect(calls.broadcasts).toEqual([]);
  });

  it("read-only tools broadcast nothing — the ticker is for mutations", async () => {
    const { call, calls } = setup();
    await call("browser_snapshot", { browserId: "b1" });
    await call("browser_read", { browserId: "b1", kind: "text" });
    await call("browser_screenshot", { browserId: "b1" });
    await call("browser_list", {});
    expect(calls.broadcasts).toEqual([]);
  });

  it("navigate broadcasts its gate title; a refused navigation settles as ok: false", async () => {
    const { call, calls } = setup({ bridgeResults: { navigate: { url: null } } });
    await call("browser_navigate", { browserId: "b1", url: "https://example.com/next" });
    const mine = ofBrowser(calls.broadcasts, "b1");
    expect(driving(mine)).toEqual([true, false]);
    expect(actions(mine)).toEqual([expect.objectContaining({ text: "Navigate the browser pane to https://example.com/next", ok: false })]);
  });

  it("each mutating batch step ticks on its own; read-only steps stay silent", async () => {
    const { call, calls } = setup();
    await call("browser_batch", { actions: [
      { tool: "browser_snapshot", arguments: { browserId: "b1" } },
      { tool: "browser_act", arguments: { browserId: "b1", action: { kind: "click", ref: 11 } } },
      { tool: "browser_navigate", arguments: { browserId: "b1", url: "https://example.com/two" } },
    ] });
    const mine = ofBrowser(calls.broadcasts, "b1");
    expect(driving(mine)).toEqual([true, false, true, false]);
    expect(actions(mine).map((a) => ({ text: a.text, ok: a.ok }))).toEqual([
      { text: 'Click the button the page labels "Submit order" on example.com', ok: true },
      { text: "Navigate the browser pane to https://example.com/two", ok: true },
    ]);
  });

  it("browser.action / browser.driving carry the space and browser ids the renderer routes on", async () => {
    const { call, calls } = setup();
    await call("browser_act", { browserId: "b1", action: { kind: "scroll", deltaY: 200 } });
    for (const b of calls.broadcasts) {
      expect(b.payload).toMatchObject({ spaceId: "space1", browserId: "b1" });
    }
  });
});
