import { describe, expect, it } from "vitest";
import { ClaudeAdapter, claudeAllowedTools, claudeAskTools, claudeMcpServers, claudeSdkPermissionMode } from "./claude-adapter";
import type { SessionEvent } from "@realm/contracts";
import type { StartOptions } from "../types";
import { readFileSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join, dirname } from "node:path"; import { fileURLToPath } from "node:url";
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "turn.json"), "utf8")) as unknown[];

type FakeOpts = {
  permissionOnTool?: string;
  /** ask canUseTool this many times concurrently (default 1) */
  concurrentPermissions?: number;
  /** abort the canUseTool signal instead of waiting for a response */
  abortPermission?: boolean;
  /** throw from the generator after this many fixture messages */
  throwAfter?: number;
  /** write these lines to options.stderr before the first message */
  stderr?: string[];
  /** replace the fixture's result with an error result */
  errorResult?: boolean;
  /** never end the generator after the turn (wait for input close) */
  hang?: boolean;
  /** like the real SDK: reject iteration when options.abortController aborts */
  abortable?: boolean;
  /** record each user message pulled off the prompt stream (content-shape assertions) */
  capture?: unknown[];
  /** record the Options object the adapter handed `query` (start-time option assertions) */
  captureOptions?: Record<string, unknown>[];
};
function fakeQuery(opts: FakeOpts, calls: string[] = []) {
  return ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    const gen = (async function* () {
      opts.captureOptions?.push(options);
      for (const l of opts.stderr ?? []) (options.stderr as (d: string) => void)(l);
      const it = prompt[Symbol.asyncIterator](); const first = await it.next();
      if (first.done) return;
      opts.capture?.push(first.value);
      let n = 0; let asked = false;
      for (const m of fixture) {
        if (opts.throwAfter !== undefined && n++ >= opts.throwAfter) throw new Error("sdk exploded");
        if ((m as { type: string }).type === "assistant" && opts.permissionOnTool && options.canUseTool && !asked) {
          asked = true;
          const cut = options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<{ behavior: string }>;
          const ac = new AbortController();
          const asks = Array.from({ length: opts.concurrentPermissions ?? 1 }, (_, i) => cut(opts.permissionOnTool!, { file_path: `a${i}` }, { signal: ac.signal, title: `Read a${i}?` }));
          if (opts.abortPermission) setTimeout(() => ac.abort(), 5);
          const rs = await Promise.all(asks); const r = rs[0]!;
          if (r.behavior === "deny") { yield { type: "result", subtype: "success", session_id: "sess_1", uuid: "r", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "denied", stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [] }; break; }
        }
        if ((m as { type: string }).type === "result" && opts.errorResult) { yield { ...(m as object), subtype: "error_during_execution", is_error: true, errors: ["turn failed"] }; break; }
        yield m;
      }
      if (opts.abortable) {
        const signal = (options.abortController as AbortController).signal;
        await new Promise<void>((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("Claude Code process aborted by user"), { name: "AbortError" })), { once: true }));
      }
      if (opts.hang) { for await (const _ of { [Symbol.asyncIterator]: () => it }) { /* drain until input closes */ } }
    })();
    return Object.assign(gen, { interrupt: async () => { calls.push("interrupt"); }, setPermissionMode: async () => {}, setModel: async () => {} });
  };
}
const collectUntil = (events: AsyncIterable<SessionEvent>, stop: (e: SessionEvent, all: SessionEvent[]) => boolean, onEach?: (e: SessionEvent) => void) =>
  (async () => { const all: SessionEvent[] = []; for await (const e of events) { all.push(e); onEach?.(e); if (stop(e, all)) break; } return all; })();
const types = (evs: SessionEvent[]) => evs.map((e) => e.type);
const statuses = (evs: SessionEvent[]) => evs.flatMap((e) => (e.type === "status" ? [e.payload.status] : []));

describe("Ask — read-only, enforced by the adapter", () => {
  const gateway = { name: "realm", transport: "http", url: "http://localhost:1/mcp", headers: {} } as const;

  it("allows reading and searching, and nothing that changes anything", () => {
    const allowed = claudeAskTools([]);
    for (const t of ["Read", "Glob", "Grep", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "AskUserQuestion"]) {
      expect(allowed.has(t), t).toBe(true);
    }
    // Bash is the named mutant. Nothing can tell from a command string whether it mutates, and
    // `git log` and `git reset --hard` are the same shape — admitting it makes the mode advisory.
    for (const t of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Task", "Agent", "ExitPlanMode"]) {
      expect(allowed.has(t), t).toBe(false);
    }
  });

  it("admits the read-only browser tools by deriving them from the same list the adapter pre-allows", () => {
    const allowed = claudeAskTools([gateway]);
    // Not a second hand-written list: Ask and `allowedTools` cannot disagree about what is read-only.
    for (const t of claudeAllowedTools([gateway])) expect(allowed.has(t), t).toBe(true);
    expect(allowed.has("mcp__realm__realm-browser__browser_act")).toBe(false);
  });

  it("sends the SDK `default`, because that is the only mode under which its own gate runs", () => {
    // The mutant: passing "ask" through. The SDK's PermissionMode union has no such member; passing
    // acceptEdits or bypassPermissions instead would hand the gate its own bypass.
    expect(claudeSdkPermissionMode("ask")).toBe("default");
    expect(claudeSdkPermissionMode("plan")).toBe("plan");
    expect(claudeSdkPermissionMode("bypassPermissions")).toBe("bypassPermissions");
    expect(claudeSdkPermissionMode(undefined)).toBe("default");
  });

  it("refuses a mutating tool outright — no prompt the user could answer `allow` to", async () => {
    const captureOptions: Record<string, unknown>[] = [];
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Edit", captureOptions }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "ask" });
    const c = collectUntil(h.events, () => false);
    await h.send({ text: "hi", attachments: [] }); await h.dispose(); const got = await c;
    // Denied before it ran, and never put to the user: a prompt here would make Ask advisory.
    expect(types(got)).not.toContain("permission_request");
    expect(statuses(got)).not.toContain("waiting_permission");
    expect(captureOptions[0]!.permissionMode).toBe("default");
  });

  it("still routes a READ through the ordinary permission channel", async () => {
    // Ask narrows what may run; it does not take over deciding the calls that are allowed to.
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Read" }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "ask" });
    const c = collectUntil(h.events, (e, all) => e.type === "status" && e.payload.status === "idle" && types(all).includes("permission_response"),
      (e) => { if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "allow"); });
    await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
    expect(types(got)).toContain("permission_request");
  });

  it("holds on a session switched into Ask mid-flight, not only on one that started there", async () => {
    // The mutant: reading the mode off `options` instead of tracking it. `Options` is consulted once
    // at start, so a live switch would leave the gate open for the rest of the session.
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Edit" }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
    await h.setOptions({ permissionMode: "ask" });
    const c = collectUntil(h.events, () => false);
    await h.send({ text: "hi", attachments: [] }); await h.dispose(); const got = await c;
    expect(types(got)).not.toContain("permission_request");
  });
});

describe("ClaudeAdapter", () => {
  it("streams normalized events for a turn and marks idle at result", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({}) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e, all) => e.type === "status" && e.payload.status === "idle" && types(all).includes("usage"));
    await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
    expect(types(got)).toEqual(expect.arrayContaining(["init", "status", "assistant_delta", "assistant_text", "tool_call", "tool_result", "usage"]));
    expect(types(got)).not.toContain("user_message");
    expect(types(got)).not.toContain("error");
    expect(statuses(got)[0]).toBe("running");
    expect(statuses(got).at(-1)).toBe("idle");
  });
  it("routes canUseTool through permission_request/response with status transitions", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Read" }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e, all) => e.type === "status" && e.payload.status === "idle" && types(all).includes("permission_response"),
      (e) => { if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "deny"); });
    await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
    const t = types(got);
    expect(t.indexOf("permission_request")).toBeLessThan(t.indexOf("permission_response"));
    expect(statuses(got)).toEqual(["running", "waiting_permission", "running", "idle"]);
    const resp = got.find((e) => e.type === "permission_response");
    expect(resp?.type === "permission_response" && resp.payload.decision).toBe("deny");
  });
  it("concurrent canUseTool calls: one waiting_permission → running transition for the whole batch", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Read", concurrentPermissions: 2 }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e, all) => e.type === "status" && e.payload.status === "idle" && types(all).filter((t) => t === "permission_response").length === 2,
      (e) => { if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "allow"); });
    await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
    expect(types(got).filter((t) => t === "permission_request")).toHaveLength(2);
    expect(statuses(got)).toEqual(["running", "waiting_permission", "running", "idle"]);
  });
  it("an aborted canUseTool signal emits permission_response(deny) and restores status", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Read", abortPermission: true }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e, all) => e.type === "status" && e.payload.status === "idle" && types(all).includes("permission_response"));
    await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
    const resp = got.find((e) => e.type === "permission_response");
    expect(resp?.type === "permission_response" && resp.payload.decision).toBe("deny");
    expect(statuses(got)).toEqual(["running", "waiting_permission", "running", "idle"]);
  });
  it("generator throw -> error, status error, ended, queue closed; stderr tail attached", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ throwAfter: 2, stderr: ["warn: one\n", "warn: two\n"] }) as never });
    const logs: string[] = [];
    const h = a.start({ cwd: "/tmp", mcpServers: [], onLog: (l) => logs.push(l) });
    const c = collectUntil(h.events, () => false);
    await h.send({ text: "hi", attachments: [] }); const got = await c;
    const t = types(got);
    expect(t.slice(-3)).toEqual(["error", "status", "status"]);
    expect(statuses(got).slice(-2)).toEqual(["error", "ended"]);
    const errs = got.filter((e) => e.type === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.type === "error" && errs[0]!.payload.message).toContain("sdk exploded");
    expect(errs[0]!.type === "error" && errs[0]!.payload.message).toContain("warn: two");
    expect(logs).toEqual(["warn: one", "warn: two"]);
    await h.dispose();
  });
  it("normal turn with stderr noise emits no error events", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ stderr: ["noise\n"] }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, () => false);
    await h.send({ text: "hi", attachments: [] }); await h.dispose(); const got = await c;
    expect(types(got)).not.toContain("error");
  });
  it("result with is_error emits an error event and returns to idle", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ errorResult: true }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e, all) => e.type === "status" && e.payload.status === "idle" && types(all).includes("usage"));
    await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
    const err = got.find((e) => e.type === "error");
    expect(err?.type === "error" && err.payload.message).toBe("turn failed");
  });
  it("attachment-only: an image carries the message with NO empty text block (Plan 14 W5)", async () => {
    // The Messages API rejects `text: ""` — an image-only send must be image blocks alone.
    const png = join(tmpdir(), `realm-claude-attach-${Date.now()}.png`);
    writeFileSync(png, Buffer.from([1, 2, 3, 4]));
    const capture: unknown[] = [];
    const a = new ClaudeAdapter({ query: fakeQuery({ capture }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle");
    await h.send({ text: "", attachments: [{ path: png, mime: "image/png" }] });
    await c; await h.dispose();
    const content = (capture[0] as { message: { content: Array<Record<string, unknown>> } }).message.content;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "image" });
  });
  it("attachment-only where Claude ignores everything: the minimal honest stub, never empty content", async () => {
    // The named mutant: no text + non-image attachments (which this adapter skips) would otherwise be
    // a literally empty content array, which the API rejects. The prompter's send-gate refuses this
    // combination; the stub is the wire-level net for any other caller.
    const capture: unknown[] = [];
    const a = new ClaudeAdapter({ query: fakeQuery({ capture }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle");
    await h.send({ text: "", attachments: [{ path: "/tmp/notes.pdf", mime: "application/pdf" }] });
    await c; await h.dispose();
    const content = (capture[0] as { message: { content: Array<Record<string, unknown>> } }).message.content;
    expect(content).toEqual([{ type: "text", text: "(attached files)" }]);
  });
  it("send with an unreadable attachment emits error and does not start running", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ hang: true }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const seen: SessionEvent[] = []; const c = collectUntil(h.events, () => false, (e) => seen.push(e));
    await h.send({ text: "hi", attachments: [{ path: "/definitely/not/here.png", mime: "image/png" }] });
    expect(types(seen)).toEqual(["error"]);
    expect(seen[0]!.type === "error" && seen[0]!.payload.message).toMatch(/attachment/i);
    await h.dispose(); await c;
  });
  it("send after dispose emits a single error and nothing else", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ hang: true }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const seen: SessionEvent[] = []; const c = collectUntil(h.events, () => false, (e) => seen.push(e));
    const d = h.dispose();
    await h.send({ text: "late", attachments: [] });
    await d; await c;
    expect(types(seen).filter((t) => t !== "status")).toEqual(["error"]);
    expect(statuses(seen)).not.toContain("running");
  });
  it("dispose on a live handle whose SDK rejects with AbortError yields ended with no error", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ abortable: true }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, () => false);
    await h.send({ text: "hi", attachments: [] });
    await new Promise((r) => setTimeout(r, 10)); // let the turn finish; the fake is now parked on the abort signal
    await h.dispose(); const got = await c;
    expect(types(got)).not.toContain("error");
    expect(statuses(got)).not.toContain("error");
    expect(statuses(got).at(-1)).toBe("ended");
  });
  it("dispose denies pending permissions and resolves only after ended", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Read", hang: true }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const seen: SessionEvent[] = []; let endedBeforeDisposeResolved = false; let disposeDone = false;
    const c = collectUntil(h.events, () => false, (e) => { seen.push(e); if (e.type === "status" && e.payload.status === "ended" && !disposeDone) endedBeforeDisposeResolved = true; });
    await h.send({ text: "hi", attachments: [] });
    await new Promise<void>((res) => { const t = setInterval(() => { if (types(seen).includes("permission_request")) { clearInterval(t); res(); } }, 5); });
    await h.dispose(); disposeDone = true; await c;
    const resp = seen.find((e) => e.type === "permission_response");
    expect(resp?.type === "permission_response" && resp.payload.decision).toBe("deny");
    expect(endedBeforeDisposeResolved).toBe(true);
    expect(statuses(seen).at(-1)).toBe("ended");
  });
  it("interrupt calls query.interrupt, denies pending permissions, and does not push idle itself", async () => {
    const calls: string[] = [];
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Read", hang: true }, calls) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const seen: SessionEvent[] = []; const c = collectUntil(h.events, () => false, (e) => seen.push(e));
    await h.send({ text: "hi", attachments: [] });
    await new Promise<void>((res) => { const t = setInterval(() => { if (types(seen).includes("permission_request")) { clearInterval(t); res(); } }, 5); });
    const before = seen.length;
    await h.interrupt();
    expect(calls).toEqual(["interrupt"]);
    const after = seen.slice(before);
    expect(after.some((e) => e.type === "permission_response" && e.payload.decision === "deny")).toBe(true);
    // the fake yields a result after the deny -> idle comes from result, not from interrupt()
    await new Promise<void>((res) => { const t = setInterval(() => { if (types(seen).includes("usage")) { clearInterval(t); res(); } }, 5); });
    expect(statuses(seen).filter((s) => s === "idle")).toHaveLength(1);
    await h.dispose(); await c;
  });
});

/**
 * The two halves of Claude's skills channel, proven live in `apps/server/scripts/live-skills-check.ts`:
 * `plugins` is what adds Realm's library, and `settingSources: []` is what stops the user's own 29 skills
 * (and their `~/.claude/CLAUDE.md`) loading alongside it. Either one alone is a different product.
 */
describe("ClaudeAdapter skills", () => {
  /** Captures the options object the SDK was called with, without running a turn. */
  function capture(opts: Partial<StartOptions>) {
    let seen: Record<string, unknown> | null = null;
    const adapter = new ClaudeAdapter({
      query: ((args: { options: Record<string, unknown> }) => {
        seen = args.options;
        const gen = (async function* () { /* no messages: nothing here needs a turn */ })();
        return Object.assign(gen, { interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {} });
      }) as never,
    });
    const handle = adapter.start({ cwd: "/tmp", mcpServers: [], ...opts });
    return { handle, options: () => seen as unknown as Record<string, unknown> | null };
  }

  it("passes the staged plugin and isolates the session from the user's own settings", async () => {
    const { handle, options } = capture({ skills: { pluginPath: "/tmp/realm-plugin", root: "/tmp/realm-plugin/skills" } });
    await handle.send({ text: "hi", attachments: [] });
    const o = options()!;
    expect(o.plugins).toEqual([{ type: "local", path: "/tmp/realm-plugin", skipMcpDiscovery: true }]);
    // Dropping this is the silent mutation: the session still works, and quietly loads every skill the
    // user has installed on top of the library Realm's UI is listing.
    expect(o.settingSources).toEqual([]);
    await handle.dispose();
  });

  it("appends systemContext to the claude_code preset prompt — W3's memory channel, and the only route the user's CLAUDE.md has back into a settingSources: [] session", async () => {
    const { handle, options } = capture({
      systemContext: "REALM CONTEXT 4417",
      skills: { pluginPath: "/tmp/realm-plugin", root: "/tmp/realm-plugin/skills" },
    });
    await handle.send({ text: "hi", attachments: [] });
    // The preset base prompt must survive: replacing it instead of appending would cost far more than memory.
    expect(options()!.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "REALM CONTEXT 4417" });
    await handle.dispose();
  });

  it("leaves systemPrompt untouched when there is no context", async () => {
    const { handle, options } = capture({});
    await handle.send({ text: "hi", attachments: [] });
    expect(options()!.systemPrompt).toBeUndefined();
    await handle.dispose();
  });

  it("touches neither option when Realm is not managing this session's skills", async () => {
    const { handle, options } = capture({});
    await handle.send({ text: "hi", attachments: [] });
    const o = options()!;
    expect(o.plugins).toBeUndefined();
    // Undefined, NOT []: the SDK reads an omitted settingSources as "all sources, like the CLI", which is
    // what every Realm session did before skills existed and what a space with none must keep doing.
    expect("settingSources" in o).toBe(false);
    await handle.dispose();
  });
});

describe("@-mention resolution on the Claude wire (W4)", () => {
  /** Fake query that hands back the FIRST user message the adapter pushes — the wire, verbatim. */
  function captureFirstMessage() {
    let resolve!: (m: unknown) => void;
    const first = new Promise<unknown>((r) => { resolve = r; });
    const adapter = new ClaudeAdapter({
      query: (({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const gen = (async function* () { for await (const m of prompt) { resolve(m); return; } })();
        return Object.assign(gen, { interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {} });
      }) as never,
    });
    return { handle: adapter.start({ cwd: "/tmp", mcpServers: [] }), first };
  }
  const textOf = (m: unknown) =>
    ((m as { message: { content: Array<{ type: string; text?: string }> } }).message.content[0]!).text;

  it("prepends /realm:<frontmatter name> at position 0 — the only place the SDK dispatches a command", async () => {
    const { handle, first } = captureFirstMessage();
    // name ≠ id on purpose: the plugin registers the skill under its FRONTMATTER name (proven live in
    // scripts/live-mention-check.ts), so a prepend built from the directory id would invoke nothing.
    await handle.send({ text: "use mac to list reminders", attachments: [], skill: { id: "mac", name: "mac-skill", path: "/lib/skills/mac/SKILL.md" } });
    expect(textOf(await first)).toBe("/realm:mac-skill use mac to list reminders");
    await handle.dispose();
  });

  it("without a resolved skill the text goes through verbatim — no prepend, and never a literal @name (the server already stripped it)", async () => {
    const { handle, first } = captureFirstMessage();
    await handle.send({ text: "plain text, mac not mentioned", attachments: [] });
    expect(textOf(await first)).toBe("plain text, mac not mentioned");
    await handle.dispose();
  });
});

describe("claudeMcpServers", () => {
  const stdio = { name: "airtable", transport: "stdio" as const, command: "/usr/bin/node", args: ["/abs/s.mjs"], env: { K: "v" } };
  const http = { name: "vercel", transport: "http" as const, url: "https://mcp.vercel.com", headers: { Authorization: "Bearer t" } };
  const sse = { name: "legacy", transport: "sse" as const, url: "https://sse.example/mcp", headers: {} };

  it("is a RECORD keyed by name, not an array (sdk.d.ts:1734 — some docs say otherwise)", () => {
    const out = claudeMcpServers([stdio, http]);
    expect(Array.isArray(out)).toBe(false);
    expect(Object.keys(out)).toEqual(["airtable", "vercel"]);
  });

  it("tags each entry with its transport and carries only that transport's fields", () => {
    expect(claudeMcpServers([stdio])).toEqual({ airtable: { type: "stdio", command: "/usr/bin/node", args: ["/abs/s.mjs"], env: { K: "v" } } });
    expect(claudeMcpServers([http])).toEqual({ vercel: { type: "http", url: "https://mcp.vercel.com", headers: { Authorization: "Bearer t" } } });
    expect(claudeMcpServers([sse])).toEqual({ legacy: { type: "sse", url: "https://sse.example/mcp", headers: {} } });
  });

  it("keeps every entry — no per-agent transport filtering happens here any more", () => {
    expect(Object.keys(claudeMcpServers([stdio, http, sse]))).toHaveLength(3);
  });

  it("is empty — not absent — when there is nothing configured", () => {
    expect(claudeMcpServers([])).toEqual({});
  });
});

/**
 * W4's double-prompt fix: the SDK's `canUseTool` fires for every MCP tool, stacking Claude's own
 * prompt on top of Realm's broker — which deliberately lets read-only browser tools run free.
 * `allowedTools` pre-allows exactly the read-only set; mutating tools stay double-gated on purpose.
 */
describe("realm-browser allowedTools (Plan 11 W4)", () => {
  const gatewayEntry = { name: "realm", transport: "http" as const, url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t" } };

  it("expands to exactly the read-only tools under the gateway's server name — nothing more", () => {
    expect(claudeAllowedTools([gatewayEntry])).toEqual([
      "mcp__realm__realm-browser__browser_list",
      "mcp__realm__realm-browser__browser_snapshot",
      "mcp__realm__realm-browser__browser_read",
      "mcp__realm__realm-browser__browser_screenshot",
      // Listing enrolled sign-ins is read-only in the strong sense: `BrowserCredential` has no field
      // for a value, so a promptless call discloses nothing but the origin/username/label the USER
      // typed into Settings. The FILL is a different tool and is deliberately absent below.
      "mcp__realm__realm-browser__browser_credentials",
    ]);
  });

  it("NEVER contains a mutating tool name (the named mutant: a pre-allowed act)", () => {
    const allowed = claudeAllowedTools([gatewayEntry]);
    for (const mutating of ["browser_open", "browser_navigate", "browser_act", "browser_batch", "browser_fill_credential"]) {
      expect(allowed.some((t) => t.endsWith(`__${mutating}`))).toBe(false);
    }
  });

  it("rides the configured server NAME, so a renamed gateway entry cannot orphan the allow-list; no servers, no entries", () => {
    expect(claudeAllowedTools([{ ...gatewayEntry, name: "realm2" }])[0]).toBe("mcp__realm2__realm-browser__browser_list");
    expect(claudeAllowedTools([])).toEqual([]);
  });

  it("start() passes the expansion to the SDK as Options.allowedTools", async () => {
    let seen: Record<string, unknown> | null = null;
    const adapter = new ClaudeAdapter({
      query: ((args: { options: Record<string, unknown> }) => {
        seen = args.options;
        const gen = (async function* () { /* no turn needed */ })();
        return Object.assign(gen, { interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {} });
      }) as never,
    });
    const handle = adapter.start({ cwd: "/tmp", mcpServers: [gatewayEntry] });
    await handle.send({ text: "hi", attachments: [] });
    expect((seen as unknown as Record<string, unknown>).allowedTools).toEqual(claudeAllowedTools([gatewayEntry]));
    await handle.dispose();
  });
});
