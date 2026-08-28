import { describe, expect, it, vi } from "vitest";

/** Records every rpc().call so the wire params of the thin Api adapter can be asserted. */
const calls: { method: string; params: unknown }[] = [];
vi.mock("../rpc/client", () => ({
  rpc: () => ({ call: (method: string, params: unknown) => { calls.push({ method, params }); return Promise.resolve({}); } }),
}));
vi.mock("../panes/terminal-hub", () => ({ getTerminalHub: () => ({ dispose: () => {} }) }));

const { liveApi } = await import("./live-api");

/**
 * `live-api.ts` is one line per method, which is exactly why it is worth pinning the two lines W4 leans
 * on: a dropped `force` makes "Check again" silently useless, and a mangled `terminals.write` payload is
 * the auto-run hazard. Both failures are invisible to every store-level test, which sees only the fake.
 */
describe("liveApi wire params", () => {
  it("forwards agents.probe's force flag in both directions", async () => {
    calls.length = 0;
    await liveApi().probeAgents(true);
    await liveApi().probeAgents(false);
    expect(calls).toEqual([
      { method: "agents.probe", params: { force: true } },
      { method: "agents.probe", params: { force: false } },
    ]);
  });

  it("passes terminal writes through byte for byte — no newline is added on the way out", async () => {
    calls.length = 0;
    await liveApi().writeTerminal("t1", "npm install -g @anthropic-ai/claude-code");
    expect(calls).toEqual([
      { method: "terminals.write", params: { terminalId: "t1", data: "npm install -g @anthropic-ai/claude-code" } },
    ]);
  });
});
