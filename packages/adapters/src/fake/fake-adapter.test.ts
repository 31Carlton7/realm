import { describe, expect, it } from "vitest"; import { FakeAdapter } from "./fake-adapter";
describe("FakeAdapter", () => {
  it("scripts a turn: text, tool call needing permission, result", async () => {
    const a = new FakeAdapter({ script: [
      { on: "hi", emit: [{ kind: "text", text: "Hello!" }, { kind: "tool", name: "Bash", input: { command: "ls" }, needsPermission: true, result: "a b" }, { kind: "text", text: "Done." }] },
    ] });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const got: string[] = []; const collect = (async () => { for await (const e of h.events) { got.push(e.type); if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "allow"); if (e.type === "status" && e.payload.status === "idle" && got.includes("tool_result")) break; } })();
    h.send({ text: "hi", attachments: [] });
    await collect;
    expect(got).toEqual(expect.arrayContaining(["init", "status", "assistant_text", "tool_call", "permission_request", "permission_response", "tool_result", "usage"]));
    expect(got.indexOf("permission_request")).toBeLessThan(got.indexOf("tool_result"));
    await h.dispose();
  });
  it("deny skips tool result and reports error text", async () => {
    const a = new FakeAdapter({ script: [{ on: "x", emit: [{ kind: "tool", name: "Bash", input: {}, needsPermission: true, result: "never" }] }] });
    const h = a.start({ cwd: "/tmp", mcpServers: [] }); const types: string[] = [];
    const c = (async () => { for await (const e of h.events) { types.push(e.type); if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "deny"); if (e.type === "status" && e.payload.status === "idle" && types.includes("permission_response")) break; } })();
    h.send({ text: "x", attachments: [] }); await c;
    expect(types).not.toContain("tool_result"); await h.dispose();
  });
});
