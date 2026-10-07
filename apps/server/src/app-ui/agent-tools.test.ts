import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GateResult } from "../browsers/permissions";
import { APP_PROVIDER_NAME, createAppUiProvider, type AppUiToolsDeps } from "./agent-tools";

/**
 * The provider's own behaviour with main faked. What the refusal actually inspects — a live DOM,
 * `closest()` over `NO_AGENT_ATTR` — is main's, in `app-drive.ts`; what is tested here is that this
 * side gates before it dispatches, and that a refusal from over there arrives as a refusal rather
 * than as something an agent can retry its way past.
 */

const SPACE = "space1";
const SESSION = "sess1";
const CLICK = { kind: "click", ref: 11 } as const;

function setup(opts: { gate?: GateResult; enabled?: boolean; actResult?: unknown; actThrows?: Error } = {}) {
  const calls = {
    gates: [] as { toolKey: string; title: string }[],
    bridge: [] as { op: string; params: Record<string, unknown> }[],
  };
  const deps: AppUiToolsDeps = {
    mcp: { providerEnabled: () => opts.enabled ?? true },
    bridge: {
      call: async (op, params) => {
        calls.bridge.push({ op, params: params as Record<string, unknown> });
        if (op === "appSnapshot") return { url: "", title: "Realm", text: '[ref=11] button "New session"', elementCount: 1 };
        if (opts.actThrows) throw opts.actThrows;
        return opts.actResult ?? { ok: true, detail: "clicked" };
      },
    },
    broker: {
      gate: async (_sessionId, toolKey, title) => {
        calls.gates.push({ toolKey, title });
        return opts.gate ?? { allowed: true };
      },
    },
  };
  const provider = createAppUiProvider(deps);
  return { provider, calls, call: (tool: string, args: unknown = {}) => provider.call({ sessionId: SESSION, spaceId: SPACE }, tool, args) };
}

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe("the provider's surface", () => {
  it("offers nothing until the space switches it on", async () => {
    // THE MUTANT: default it on with the rest. Every space that exists would wake up holding "an
    // agent may press buttons in the app you are reading", which is the sentence a space should
    // have agreed to.
    const { provider, call } = setup({ enabled: false });
    expect(await provider.tools({ sessionId: SESSION, spaceId: SPACE })).toEqual([]);
    expect(text(await call("app_snapshot"))).toContain(APP_PROVIDER_NAME);
  });

  it("reads the interface without asking permission", async () => {
    const { call, calls } = setup();
    const r = await call("app_snapshot");
    expect(r.isError).toBe(false);
    expect(text(r)).toContain("New session");
    expect(calls.gates).toEqual([]);
  });

  it("does not fence its own interface as untrusted", async () => {
    // Realm's text, from Realm's state, in the user's own session. `fenceUntrusted` means a third
    // party wrote this; saying it here would teach an agent to distrust the one surface it can
    // trust, and would spend context on a warning that is not true.
    expect(text(await setup().call("app_snapshot"))).not.toContain("untrusted data");
  });
});

describe("acting", () => {
  it("gates before anything is dispatched", async () => {
    const { call, calls } = setup({ gate: { allowed: false, reason: "the user denied this action" } });
    expect((await call("app_act", { action: CLICK })).isError).toBe(true);
    expect(calls.bridge.filter((b) => b.op === "appAct")).toEqual([]);
  });

  it("names the element by ref on the card, not by Realm's own words", async () => {
    const { call, calls } = setup();
    await call("app_act", { action: CLICK });
    expect(calls.gates[0]).toEqual({ toolKey: "app_act", title: "Click element 11 in Realm's own window" });
  });

  /**
   * THE MUTANT: report `realm_protected` as an ordinary failure. An agent reads a plain error as
   * something to try differently — a different ref, a scroll and another click — and there is no
   * different way to press that button. It has to read as a wall.
   */
  it("passes main's protected-surface refusal through as a refusal", async () => {
    const { call } = setup({ actResult: { ok: false, refused: "realm_protected", error: "that element is inside Realm's permission request, which no agent may act in." } });
    const r = await call("app_act", { action: CLICK });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("refused:");
    expect(text(r)).toContain("permission request");
  });

  it("reports a window that is not there as an error rather than a crash", async () => {
    const { call } = setup({ actThrows: new Error("Realm's window is not open") });
    const r = await call("app_act", { action: CLICK });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("window is not open");
  });

  it("refuses an action that is not one of the four kinds", async () => {
    const { call, calls } = setup();
    const r = await call("app_act", { action: { kind: "drag", ref: 11 } });
    expect(r.isError).toBe(true);
    expect(calls.bridge).toEqual([]);
  });
});
