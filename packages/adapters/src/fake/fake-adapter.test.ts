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
describe("FakeAdapter lifecycle", () => {
  it("dispose resolves pending permissions as deny and ends the stream", async () => {
    const a = new FakeAdapter({ script: [{ on: "x", emit: [{ kind: "tool", name: "Bash", input: {}, needsPermission: true, result: "never" }] }] });
    const h = a.start({ cwd: "/tmp", mcpServers: [] }); const types: string[] = []; const decisions: string[] = [];
    const c = (async () => { for await (const e of h.events) { types.push(e.type); if (e.type === "permission_response") decisions.push(e.payload.decision); if (e.type === "permission_request") void h.dispose(); } })();
    await h.send({ text: "x", attachments: [] }); await c;
    expect(decisions).toEqual(["deny"]); expect(types.at(-1)).toBe("status"); expect(types).not.toContain("tool_result");
  });
  it("send after dispose emits an error and does not run", async () => {
    const a = new FakeAdapter(); const h = a.start({ cwd: "/tmp", mcpServers: [] });
    await h.dispose();
    await h.send({ text: "late", attachments: [] });
    const got: string[] = []; for await (const e of h.events) got.push(e.type);
    expect(got).toEqual(["init", "status", "status"]);
  });
  it("a throwing step emits error and the handle stays usable", async () => {
    const a = new FakeAdapter({ script: [{ on: "boom", emit: [{ kind: "throw", message: "kaboom" }] }, { on: "ok", emit: [{ kind: "text", text: "fine" }] }] });
    const h = a.start({ cwd: "/tmp", mcpServers: [] }); const got: string[] = []; let errMsg = "";
    const c = (async () => { for await (const e of h.events) { got.push(e.type); if (e.type === "error") errMsg = e.payload.message; if (e.type === "assistant_text" && e.payload.text === "fine") break; } })();
    await h.send({ text: "boom", attachments: [] }); await h.send({ text: "ok", attachments: [] }); await c;
    expect(errMsg).toBe("kaboom"); expect(got.filter((t) => t === "error")).toHaveLength(1);
    await h.dispose();
  });
});
