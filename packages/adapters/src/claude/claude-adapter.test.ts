import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./claude-adapter";
import { readFileSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath } from "node:url";
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "turn.json"), "utf8")) as unknown[];

function fakeQuery(opts: { permissionOnTool?: string }) {
  return ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    const gen = (async function* () {
      // consume the first user message before emitting the fixture turn
      const it = prompt[Symbol.asyncIterator](); await it.next();
      for (const m of fixture) {
        if ((m as { type: string }).type === "assistant" && opts.permissionOnTool && options.canUseTool) {
          const r = await (options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<{ behavior: string }>)(opts.permissionOnTool, { file_path: "a" }, { signal: new AbortController().signal, title: "Read a?" });
          if (r.behavior === "deny") { yield { type: "result", subtype: "success", session_id: "sess_1", uuid: "r", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "denied", stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [] }; return; }
        }
        yield m;
      }
    })();
    return Object.assign(gen, { interrupt: async () => undefined, setPermissionMode: async () => {}, setModel: async () => {} });
  };
}
describe("ClaudeAdapter", () => {
  it("streams normalized events for a turn and marks idle at result", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({}) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] }); const types: string[] = [];
    const c = (async () => { for await (const e of h.events) { types.push(e.type); if (e.type === "status" && e.payload.status === "idle" && types.includes("usage")) break; } })();
    h.send({ text: "hi", attachments: [] }); await c; await h.dispose();
    expect(types).toEqual(expect.arrayContaining(["init", "status", "assistant_delta", "assistant_text", "tool_call", "tool_result", "usage"]));
  });
  it("routes canUseTool through permission_request/response", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Read" }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] }); const types: string[] = [];
    const c = (async () => { for await (const e of h.events) { types.push(e.type); if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "deny"); if (e.type === "status" && e.payload.status === "idle" && types.includes("permission_response")) break; } })();
    h.send({ text: "hi", attachments: [] }); await c; await h.dispose();
    expect(types).toContain("permission_request"); expect(types).toContain("permission_response");
    expect(types.filter((t) => t === "status")).toContain("status");
  });
});
