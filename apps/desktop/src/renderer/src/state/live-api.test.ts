import { describe, expect, it, vi } from "vitest";

/** Records every rpc().call so the wire params of the thin Api adapter can be asserted. */
const calls: { method: string; params: unknown }[] = [];
vi.mock("../rpc/client", () => ({
  rpc: () => ({ call: (method: string, params: unknown) => { calls.push({ method, params }); return Promise.resolve({}); } }),
}));
vi.mock("../panes/terminal-hub", () => ({ getTerminalHub: () => ({ dispose: () => {} }) }));

const { liveApi } = await import("./live-api");

/**
 * `live-api.ts` is one line per method, which is exactly why it is worth pinning the few that carry a
 * decision: a dropped `force` makes "Check again" silently useless, a mangled `terminals.write` payload
 * is the auto-run hazard, and `sessions.send` decides whether a chip-free message still looks like one.
 * All three are invisible to every store-level test, which sees only the fake.
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

  it("omits `elements` entirely when a draft has no chips — the send is byte-identical to before chips existed", async () => {
    calls.length = 0;
    await liveApi().sendMessage("se1", "plain", [], []);
    await liveApi().sendMessage("se1", "plain", [], [], []);
    // Key ABSENT, not present-and-empty: an `elements: []` on every send would change what every
    // message on this wire looks like, for the benefit of the messages that have none.
    expect(calls.map((c) => Object.keys(c.params as object))).toEqual([
      ["id", "text", "attachments", "mentions"],
      ["id", "text", "attachments", "mentions"],
    ]);
  });

  it("carries the picked elements when the draft has some", async () => {
    calls.length = 0;
    const chip = {
      label: "button", element: {
        ref: 1, url: "https://example.com", title: "t", rect: { x: 0, y: 0, w: 1, h: 1 },
        selector: "#a", tag: "button", role: "button", name: "Go", text: "Go", html: "<button>Go</button>",
      },
    };
    await liveApi().sendMessage("se1", "this @[button]", [], [], [chip]);
    expect(calls).toEqual([
      { method: "sessions.send", params: { id: "se1", text: "this @[button]", attachments: [], mentions: [], elements: [chip] } },
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
