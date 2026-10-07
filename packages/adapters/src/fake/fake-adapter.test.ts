import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import type { SessionEvent } from "@realm/contracts";
import { FakeAdapter } from "./fake-adapter";
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
  it("paces a text step a word at a time when asked, and ends it on the whole text", async () => {
    const a = new FakeAdapter({ script: [{ on: "go", emit: [{ kind: "text", text: "one two  three", paceMs: 5 }] }] });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const deltas: string[] = []; const at: number[] = []; let final = "";
    const c = (async () => { for await (const e of h.events) {
      if (e.type === "assistant_delta") { deltas.push(e.payload.delta); at.push(Date.now()); }
      if (e.type === "assistant_text") final = e.payload.text;
      if (e.type === "status" && e.payload.status === "idle" && final) break;
    } })();
    await h.send({ text: "go", attachments: [] }); await c;
    // Words keep their own trailing space, so the deltas join back into exactly the text.
    expect(deltas).toEqual(["one ", "two  ", "three"]);
    expect(final).toBe("one two  three");
    // Paced, not burst: the last word lands at least two paces after the first.
    expect(at.at(-1)! - at[0]!).toBeGreaterThanOrEqual(8);
    await h.dispose();
  });

  it("ends a paced message where a stop caught it", async () => {
    const a = new FakeAdapter({ script: [{ on: "go", emit: [{ kind: "text", text: "a b c d e f g h", paceMs: 20 }] }] });
    const h = a.start({ cwd: "/tmp", mcpServers: [] }); let final: string | null = null;
    const c = (async () => { for await (const e of h.events) {
      if (e.type === "assistant_delta" && e.payload.delta === "b ") void h.interrupt();
      if (e.type === "assistant_text") final = e.payload.text;
      if (e.type === "status" && e.payload.status === "idle" && final !== null) break;
    } })();
    await h.send({ text: "go", attachments: [] }); await c;
    expect(final).toBe("a b ");
    await h.dispose();
  });

  it("scripts a plan and its revision on one id, so the dev prompter can reach the plan card", async () => {
    // The `plan` event is drawn by a card of its own, and the scripted adapter is what UI development
    // runs against — without this step that card is unreachable offline.
    const a = new FakeAdapter({ script: [{ on: "plan", emit: [
      { kind: "plan", planId: "p1", steps: [{ text: "A", status: "in_progress" }] },
      { kind: "plan", planId: "p1", text: "## A", steps: [{ text: "A", status: "completed" }] },
    ] }] });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const evs: { type: string; payload: unknown }[] = [];
    const c = (async () => { for await (const e of h.events) { evs.push(e); if (e.type === "status" && e.payload.status === "idle" && evs.some((x) => x.type === "plan")) break; } })();
    h.send({ text: "plan it", attachments: [] }); await c;
    const plans = evs.filter((e) => e.type === "plan").map((e) => e.payload);
    expect(plans).toEqual([
      { planId: "p1", steps: [{ text: "A", status: "in_progress" }] },
      { planId: "p1", text: "## A", steps: [{ text: "A", status: "completed" }] },
    ]);
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
  it("interrupt stops the running script without pushing idle itself; the turn ends naturally", async () => {
    const a = new FakeAdapter({ script: [{ on: "x", emit: [{ kind: "tool", name: "Bash", input: {}, needsPermission: true, result: "never" }, { kind: "text", text: "after" }] }] });
    const h = a.start({ cwd: "/tmp", mcpServers: [] }); const got: string[] = []; const st: string[] = [];
    const c = (async () => { for await (const e of h.events) { got.push(e.type); if (e.type === "status") st.push(e.payload.status); if (e.type === "permission_request") void h.interrupt(); if (e.type === "status" && e.payload.status === "idle" && got.includes("permission_response")) break; } })();
    await h.send({ text: "x", attachments: [] }); await c;
    expect(got).not.toContain("tool_result"); expect(got).not.toContain("assistant_text"); expect(got).toContain("usage");
    expect(st).toEqual(["idle", "running", "waiting_permission", "idle"]);
    await h.dispose();
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

describe("FakeAdapter edits that land", () => {
  /** Run one scripted turn and collect it, up to the settle. */
  const turn = async (a: FakeAdapter, cwd: string, text: string) => {
    const h = a.start({ cwd, mcpServers: [] });
    const evs: SessionEvent[] = [];
    const c = (async () => { for await (const e of h.events) { evs.push(e); if (e.type === "status" && e.payload.status === "idle" && evs.some((x) => x.type === "tool_result")) break; } })();
    await h.send({ text, attachments: [] }); await c; await h.dispose();
    return evs.flatMap((e) => (e.type === "tool_result" ? [e.payload] : []));
  };

  it("writes and edits for real in the working directory, so a checkout has something to measure", async () => {
    const cwd = tempDir("realm-fake-edit-");
    writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
    const a = new FakeAdapter({ script: [{ on: "go", emit: [
      { kind: "tool", name: "Edit", apply: true, input: { file_path: "a.ts", old_string: "a = 1", new_string: "a = 2" }, result: "ok" },
      { kind: "tool", name: "Write", apply: true, input: { file_path: "lib/b.ts", content: "export const b = 3;\n" }, result: "created" },
    ] }] });
    expect(await turn(a, cwd, "go")).toEqual([{ toolUseId: expect.any(String), content: "ok", isError: false }, { toolUseId: expect.any(String), content: "created", isError: false }]);
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(readFileSync(join(cwd, "lib/b.ts"), "utf8")).toBe("export const b = 3;\n");
  });

  it("settles an edit whose text is not there as a failed call, and never writes outside the directory", async () => {
    const cwd = tempDir("realm-fake-edit-");
    writeFileSync(join(cwd, "a.ts"), "x\n");
    const a = new FakeAdapter({ script: [{ on: "go", emit: [
      { kind: "tool", name: "Edit", apply: true, input: { file_path: "a.ts", old_string: "missing", new_string: "y" }, result: "ok" },
      { kind: "tool", name: "Write", apply: true, input: { file_path: "../escape.ts", content: "no" }, result: "ok" },
    ] }] });
    const results = await turn(a, cwd, "go");
    expect(results.map((r) => r.isError)).toEqual([true, true]);
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("x\n");
    expect(existsSync(join(cwd, "..", "escape.ts"))).toBe(false);
  });
});
