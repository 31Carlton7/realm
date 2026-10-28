import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, claudeAllowedTools, claudeAskTools, claudeMcpServers, claudeSdkPermissionMode, effortByModel, fastModeByModel, streamWindowId } from "./claude-adapter";
import { HIDDEN_ANSWER, type SessionEvent } from "@realm/contracts";
import { GATEWAY_TOOL_TIMEOUT_MS, RestartRequiredError, type StartOptions } from "../types";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "turn.json"), "utf8")) as unknown[];

type FakeOpts = {
  permissionOnTool?: string;
  /** ask canUseTool this many times concurrently (default 1) */
  concurrentPermissions?: number;
  /** abort the canUseTool signal instead of waiting for a response */
  abortPermission?: boolean;
  /** the tool input canUseTool is asked about (default `{ file_path }`) */
  permissionInput?: unknown;
  /** record what each canUseTool call resolved with — what the agent itself was handed */
  permissionResults?: unknown[];
  /** a `rate_limit_info` to stream as a `rate_limit_event` just before the turn's result */
  rateLimit?: Record<string, unknown>;
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
  /** what `supportedModels()` answers; omitted means the control request is declined (a CLI may). */
  models?: { value: string; resolvedModel?: string; supportsFastMode?: boolean; supportsEffort?: boolean; supportedEffortLevels?: string[] }[];
  /** record every `applyFlagSettings` merge (the mid-session fast-mode path). */
  flagSettings?: Record<string, unknown>[];
  /** answer this many prompts with the fixture's turn instead of only the first (multi-turn assertions) */
  turns?: number;
  /** what `getContextUsage()` answers; omitted means the control request is declined (a CLI may). */
  contextUsage?: { totalTokens: number; maxTokens: number; rawMaxTokens: number };
  /** record the options `getContextUsage` was called with — `detail` is the expensive knob. */
  contextUsageCalls?: unknown[];
  /** record every mode `setPermissionMode` is asked for */
  modeSwitches?: string[];
  /** refuse `setPermissionMode` with this message, the way the CLI answers a mode it will not take */
  refuseModeWith?: string;
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
          const asks = Array.from({ length: opts.concurrentPermissions ?? 1 }, (_, i) => cut(opts.permissionOnTool!, opts.permissionInput ?? { file_path: `a${i}` }, { signal: ac.signal, title: `Read a${i}?` }));
          if (opts.abortPermission) setTimeout(() => ac.abort(), 5);
          const rs = await Promise.all(asks); const r = rs[0]!;
          opts.permissionResults?.push(...rs);
          if (r.behavior === "deny") { yield { type: "result", subtype: "success", session_id: "sess_1", uuid: "r", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "denied", stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [] }; break; }
        }
        if ((m as { type: string }).type === "result" && opts.rateLimit) yield { type: "rate_limit_event", rate_limit_info: opts.rateLimit, uuid: "rl", session_id: "sess_1" };
        if ((m as { type: string }).type === "result" && opts.errorResult) { yield { ...(m as object), subtype: "error_during_execution", is_error: true, errors: ["turn failed"] }; break; }
        yield m;
      }
      // Each later prompt gets the same turn again, minus the session's `init`, which a session sends once.
      for (let t = 1; t < (opts.turns ?? 1); t++) {
        const next = await it.next();
        if (next.done) return;
        opts.capture?.push(next.value);
        for (const m of fixture) if ((m as { type: string }).type !== "system") yield m;
      }
      if (opts.abortable) {
        const signal = (options.abortController as AbortController).signal;
        await new Promise<void>((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("Claude Code process aborted by user"), { name: "AbortError" })), { once: true }));
      }
      if (opts.hang) { for await (const _ of { [Symbol.asyncIterator]: () => it }) { /* drain until input closes */ } }
    })();
    return Object.assign(gen, {
      interrupt: async () => { calls.push("interrupt"); }, setModel: async () => {},
      setPermissionMode: async (mode: string) => {
        opts.modeSwitches?.push(mode);
        if (opts.refuseModeWith) throw new Error(opts.refuseModeWith);
      },
      supportedModels: async () => {
        if (!opts.models) throw new Error("control request declined");
        return opts.models;
      },
      applyFlagSettings: async (settings: Record<string, unknown>) => { opts.flagSettings?.push(settings); },
      getContextUsage: async (o?: unknown) => {
        opts.contextUsageCalls?.push(o);
        if (!opts.contextUsage) throw new Error("control request declined");
        return opts.contextUsage;
      },
    });
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

/**
 * Full access picked on a session that is already running. The CLI's own words when it refuses —
 * copied from 2.1.281, the build the SDK carries — are what these fakes answer with, because the
 * adapter tells the refusals apart by them.
 */
describe("Full access mid-session", () => {
  const NOT_LAUNCHED = "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions";
  const DISABLED = "Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration";
  const optionsFor = async (opts: Partial<StartOptions>) => {
    const captureOptions: Record<string, unknown>[] = [];
    const h = new ClaudeAdapter({ query: fakeQuery({ hang: true, captureOptions }) as never }).start({ cwd: "/tmp", mcpServers: [], ...opts });
    await h.send({ text: "hi", attachments: [] });
    await h.dispose();
    return captureOptions[0]!;
  };
  /** `getuid` is optional on `process` (Windows has none), so the spy goes through a type that has it. */
  const asRoot = async (body: () => Promise<void>) => {
    const uid = vi.spyOn(process as { getuid(): number }, "getuid").mockReturnValue(0);
    try { await body(); } finally { uid.mockRestore(); }
  };

  it("launches and resumes every session able to switch, and still in the mode it asked for", async () => {
    // The named mutant: dropping `allowDangerouslySkipPermissions`, after which the CLI takes Full
    // access only in a session that STARTED in it — the error the owner hit. The mode beside it is
    // unchanged, because the flag makes the switch possible and does nothing else.
    for (const [mode, sdk] of [["default", "default"], ["acceptEdits", "acceptEdits"], ["plan", "plan"], ["ask", "default"], [undefined, "default"]] as const) {
      for (const resume of [null, "sess-1"]) {
        expect(await optionsFor({ permissionMode: mode, resume }), `${mode} resume=${resume}`).toMatchObject({ allowDangerouslySkipPermissions: true, permissionMode: sdk });
      }
    }
  });

  it("leaves the flag off as root, where the CLI would refuse to start at all — unless the root is a sandbox's", async () => {
    await asRoot(async () => {
      expect((await optionsFor({ permissionMode: "default" })).allowDangerouslySkipPermissions).toBe(false);
      expect((await optionsFor({ permissionMode: "default", env: { IS_SANDBOX: "1" } })).allowDangerouslySkipPermissions).toBe(true);
    });
  });

  it("switches a running session, and Realm's own gate moves with it", async () => {
    const modeSwitches: string[] = [];
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Edit", modeSwitches }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "ask" });
    await h.setOptions({ permissionMode: "bypassPermissions" });
    expect(modeSwitches).toEqual(["bypassPermissions"]);
    // Out of Ask: an edit is a call the CLI decides again, not one Realm refuses before it runs.
    const c = collectUntil(h.events, (e, all) => e.type === "status" && e.payload.status === "idle" && types(all).includes("permission_response"),
      (e) => { if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "allow"); });
    await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
    expect(types(got)).toContain("permission_request");
  });

  it("asks for a fresh start when the CLI takes Full access only from launch", async () => {
    // The named mutant: no fallback, so the CLI's sentence reaches the person as the error.
    const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, refuseModeWith: NOT_LAUNCHED }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
    await expect(h.setOptions({ permissionMode: "bypassPermissions" })).rejects.toBeInstanceOf(RestartRequiredError);
    await h.dispose();
  });

  it("says in Realm's words when Claude Code refuses Full access outright, and keeps the mode the CLI still runs", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Edit", refuseModeWith: DISABLED }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "ask" });
    const refused = await h.setOptions({ permissionMode: "bypassPermissions" }).then(() => null, (e: Error) => e);
    expect(refused).not.toBeInstanceOf(RestartRequiredError);
    expect(refused?.message).toBe("Full access is turned off in Claude Code's settings (permissions.disableBypassPermissionsMode). The session keeps its current mode.");
    // The mutant: Realm's record left on Full access. The CLI never moved off `default`, so an edit
    // would raise a card where Ask refuses it before it runs.
    const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle",
      (e) => { if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "deny"); });
    await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
    expect(types(got)).not.toContain("permission_request");
  });

  it("as root, does not send for a restart that could only fail to boot", async () => {
    // Launched without the flag, the CLI answers NOT_LAUNCHED — but launching it in Full access as
    // root is the boot it refuses, so a restart would end the session rather than switch it.
    await asRoot(async () => {
      const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, refuseModeWith: NOT_LAUNCHED }) as never });
      const h = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
      const refused = await h.setOptions({ permissionMode: "bypassPermissions" }).then(() => null, (e: Error) => e);
      expect(refused).not.toBeInstanceOf(RestartRequiredError);
      expect(refused?.message).toBe("Claude Code doesn't allow Full access while Realm runs as root. The session keeps its current mode.");
      await h.dispose();
    });
  });

  it("passes any other mode's failure through untouched", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, refuseModeWith: "Query closed" }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
    await expect(h.setOptions({ permissionMode: "acceptEdits" })).rejects.toThrow(/^Query closed$/);
    await h.dispose();
  });

  it("holds Ask even when the CLI's own switch fails, rather than putting the old mode back", async () => {
    // Ask is enforced here and nowhere else, so a failed switch INTO it fails closed. The mutant:
    // restoring the record for every mode, which would reopen the gate the person just shut.
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Edit", refuseModeWith: "Query closed" }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
    await expect(h.setOptions({ permissionMode: "ask" })).rejects.toThrow(/^Query closed$/);
    const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle",
      (e) => { if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "deny"); });
    await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
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
  it("asks no card of its own for a gateway tool a team's policy decides, and still asks for anything else", async () => {
    const run = async (tool: string, decides: boolean) => {
      const handed: unknown[] = [];
      const asked: string[] = [];
      const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: tool, permissionInput: { x: 1 }, permissionResults: handed }) as never });
      const h = a.start({ cwd: "/tmp", mcpServers: [], gatewayDecides: async (t) => { asked.push(t); return decides; } });
      const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle",
        (e) => { if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "deny"); });
      await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
      return { handed, asked, cards: got.filter((e) => e.type === "permission_request").length };
    };
    // THE MUTANT: the card drawn anyway — the person would answer Claude's card and then the policy's.
    expect(await run("mcp__realm__stub__save_thing", true)).toEqual({ handed: [{ behavior: "allow", updatedInput: { x: 1 } }], asked: ["mcp__realm__stub__save_thing"], cards: 0 });
    expect((await run("mcp__realm__stub__save_thing", false)).cards).toBe(1);
    // A command never reaches the policy's question.
    expect(await run("Bash", true)).toMatchObject({ asked: [], cards: 1 });
  });
  it("a masked answer reaches the agent and never Realm's log", async () => {
    const handed: unknown[] = [];
    const input = { questions: [
      { question: "API key?", header: "Key", options: [], multiSelect: false, secret: true },
      { question: "Name?", header: "Name", options: [], multiSelect: false },
    ] };
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "AskUserQuestion", permissionInput: input, permissionResults: handed }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const answers = { "API key?": "sk-live-1234", "Name?": "Ada" };
    const c = collectUntil(h.events, (e, all) => e.type === "status" && e.payload.status === "idle" && types(all).includes("permission_response"),
      (e) => { if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "allow", answers); });
    await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
    const resp = got.find((e) => e.type === "permission_response");
    // The persisted, broadcast event keeps the ordinary answer and only a mark for the masked one…
    expect(resp?.type === "permission_response" && resp.payload.answers).toEqual({ "API key?": HIDDEN_ANSWER, "Name?": "Ada" });
    expect(JSON.stringify(got)).not.toContain("sk-live-1234");
    // …while the agent, who asked for it, is handed the real value.
    expect(handed[0]).toMatchObject({ behavior: "allow", updatedInput: { answers } });
  });
  it("marks AskUserQuestion as a question Claude asked, and hands several picks back comma-joined", async () => {
    const handed: unknown[] = [];
    const input = { questions: [
      { question: "Which?", header: "Pick", multiSelect: true, options: [{ label: "A" }, { label: "B" }], allowOther: false },
      { question: "Where?", header: "Region", multiSelect: false, options: [{ label: "us" }], allowOther: false },
    ] };
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "AskUserQuestion", permissionInput: input, permissionResults: handed }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e, all) => e.type === "status" && e.payload.status === "idle" && types(all).includes("permission_response"),
      (e) => { if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "allow", { "Which?": ["A", "B"], "Where?": "eu" }); });
    await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
    const req = got.find((e) => e.type === "permission_request");
    expect(req?.type === "permission_request" && req.payload.ask).toMatchObject({ asker: { kind: "agent", name: "Claude" }, mode: "question" });
    // "eu" was never offered and the question takes no answer of its own: it does not reach Claude.
    expect(handed[0]).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which?": "A, B" } } });
    expect((handed[0] as { updatedInput: { answers: Record<string, string> } }).updatedInput.answers).not.toHaveProperty("Where?");
  });
  it("never marks another tool a question, whatever its arguments look like", async () => {
    // THE MUTANT: build the card from the input's shape alone. A Bash call whose arguments carry a
    // `questions` array would then draw as a question, and answering it would allow the command.
    const input = { command: "rm -rf /", questions: [{ question: "Pick?", options: [{ label: "A" }] }] };
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Bash", permissionInput: input }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e, all) => e.type === "status" && e.payload.status === "idle" && types(all).includes("permission_response"),
      (e) => { if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "deny"); });
    await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
    const req = got.find((e) => e.type === "permission_request");
    expect(req?.type === "permission_request" && req.payload.ask).toBeUndefined();
  });
  it("puts the stream's limit reading in the panel's units: a fraction as percent, seconds as ms", async () => {
    // The CLI reads these straight off the API's headers: it draws `Math.floor(utilization * 100)` and
    // waits until `resetsAt * 1000`. Taken as-is, an 86% week read "at 1%" and reset in January 1970.
    const resetsAt = 1_791_480_000; // epoch SECONDS: Oct 8 2026, 9:38 AM Pacific
    const a = new ClaudeAdapter({ query: fakeQuery({ rateLimit: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.86, resetsAt } }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e, all) => e.type === "status" && e.payload.status === "idle" && types(all).includes("rate_limit"));
    await h.send({ text: "hi", attachments: [] }); const got = await c; await h.dispose();
    const ev = got.find((e) => e.type === "rate_limit");
    expect(ev?.type === "rate_limit" && ev.payload).toMatchObject({ alert: "approaching", alertWindow: "seven_day" });
    const w = ev?.type === "rate_limit" ? ev.payload.windows.find((x) => x.id === "seven_day") : undefined;
    expect(w?.utilization).toBeCloseTo(86, 6);
    expect(w?.resetsAt).toBe(resetsAt * 1000);
    expect(new Date(w!.resetsAt!).getUTCFullYear()).toBe(2026);
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
  it("draws no card for a call the SDK cancelled while a team's policy was still deciding it", async () => {
    // The signal fires at 5ms and the policy answers "ask the person" at 20ms. An abort event never
    // fires twice, so a card drawn after it has no listener left to clear it: it sits in Needs you
    // with nothing behind it, and the turn waits on it forever. That card is the named mutant.
    const handed: unknown[] = [];
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "mcp__realm__stub__save_thing", abortPermission: true, permissionResults: handed }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [], gatewayDecides: () => new Promise((r) => setTimeout(() => r(false), 20)) });
    const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle");
    await h.send({ text: "hi", attachments: [] });
    const got = await Promise.race([c, new Promise<null>((r) => setTimeout(() => r(null), 1000))]);
    await h.dispose();
    expect(got, "the turn never settled: a card was left waiting").not.toBeNull();
    expect(types(got!)).not.toContain("permission_request");
    expect(statuses(got!)).not.toContain("waiting_permission");
    expect(handed).toEqual([{ behavior: "deny", message: "aborted" }]);
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
    const png = join(tempDir("realm-claude-attach-"), "shot.png");
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
  it("names a non-image attachment's path in the text instead of dropping it", async () => {
    // These used to hit a bare `continue`: the file was attached, the prompter warned it would be
    // lost, and the agent was told nothing. It is handed the path now — `claude` runs on this machine
    // with Read and Bash already pointed at the filesystem, so the path is worth more than the bytes
    // would be. The mutant: restoring the `continue`, which silently empties this list.
    const capture: unknown[] = [];
    const a = new ClaudeAdapter({ query: fakeQuery({ capture }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle");
    await h.send({ text: "have a look", attachments: [{ path: "/tmp/notes.pdf", mime: "application/pdf" }] });
    await c; await h.dispose();
    const content = (capture[0] as { message: { content: Array<Record<string, unknown>> } }).message.content;
    expect(content).toEqual([{ type: "text", text: "have a look\n\nAttached files:\n- /tmp/notes.pdf" }]);
  });

  it("an attachment-only send of ordinary files carries the list alone, with no leading blank lines", async () => {
    const capture: unknown[] = [];
    const a = new ClaudeAdapter({ query: fakeQuery({ capture }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle");
    await h.send({ text: "", attachments: [{ path: "/tmp/a.pdf", mime: "application/pdf" }, { path: "/tmp/b.csv", mime: "text/csv" }] });
    await c; await h.dispose();
    const content = (capture[0] as { message: { content: Array<Record<string, unknown>> } }).message.content;
    expect(content).toEqual([{ type: "text", text: "Attached files:\n- /tmp/a.pdf\n- /tmp/b.csv" }]);
  });

  it("the empty-content stub still stands for a send the adapter can carry nothing of", async () => {
    // The named mutant: an empty content array, which the API rejects. With the file list folded into
    // the text this is now reachable only with neither words nor attachments — the prompter's
    // send-gate refuses that up front, so the stub is the wire-level net for any other caller.
    const capture: unknown[] = [];
    const a = new ClaudeAdapter({ query: fakeQuery({ capture }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle");
    await h.send({ text: "", attachments: [] });
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
  describe("context usage", () => {
    /** Wait for the restated `usage` event — the one carrying a measurement. */
    const measured = (seen: SessionEvent[]) =>
      new Promise<void>((res) => { const t = setInterval(() => { if (seen.some((e) => e.type === "usage" && e.payload.contextTokens !== undefined)) { clearInterval(t); res(); } }, 5); });

    it("measures occupancy with getContextUsage instead of adding up the result's usage", async () => {
      // The bug this replaces: `input + cache_read + cache_creation` off the result sums every
      // REQUEST of the turn, so a tool-heavy turn counted its cached prompt over and over and the
      // meter read 1.19M against a 1M window — pinned at 100%, unable to fall, on a session that had
      // never come close to full.
      const contextUsageCalls: unknown[] = [];
      const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, contextUsageCalls, contextUsage: { totalTokens: 42_000, maxTokens: 190_000, rawMaxTokens: 200_000 } }) as never });
      const h = a.start({ cwd: "/tmp", mcpServers: [] });
      const seen: SessionEvent[] = []; const c = collectUntil(h.events, () => false, (e) => seen.push(e));
      await h.send({ text: "hi", attachments: [] });
      await measured(seen);
      await h.dispose(); await c;
      const usages = seen.filter((e) => e.type === "usage");
      // The FIRST usage event states no context at all: the result cannot answer the question.
      expect(usages[0]!.type === "usage" && "contextTokens" in usages[0]!.payload).toBe(false);
      const last = usages.at(-1)!;
      expect(last.type === "usage" && last.payload.contextTokens).toBe(42_000);
      // `rawMaxTokens`, not `maxTokens`: the latter is the window less the compaction reserve, which
      // would report a session as full while it still had room to run.
      expect(last.type === "usage" && last.payload.contextWindow).toBe(200_000);
      // Restated WHOLE, like init's second event — the four numbers ride along rather than being
      // zeroed to satisfy the schema.
      expect(last.type === "usage" && last.payload.costUsd).toBe(usages[0]!.type === "usage" ? usages[0]!.payload.costUsd : null);
      expect(last.type === "usage" && last.payload.numTurns).toBe(usages[0]!.type === "usage" ? usages[0]!.payload.numTurns : null);
      // `summary` answers from the last response; `full` would make a token-count API call per
      // category on every single turn, which is a real cost for a 14px ring.
      expect(contextUsageCalls).toEqual([{ detail: "summary" }]);
    });

    it("leaves the last measurement standing when the CLI declines the question", async () => {
      // Absent, never zero: a 0% ring would be a claim about the window rather than an admission
      // that this build cannot answer.
      const a = new ClaudeAdapter({ query: fakeQuery({ hang: true }) as never });
      const h = a.start({ cwd: "/tmp", mcpServers: [] });
      const seen: SessionEvent[] = []; const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle");
      await h.send({ text: "hi", attachments: [] });
      await c; await h.dispose();
      for (const e of seen.filter((x) => x.type === "usage")) expect(e.type === "usage" && "contextTokens" in e.payload).toBe(false);
    });

    it("says nothing rather than dividing by a window of zero", async () => {
      // A build that answers the control request with nothing useful is the same as one that
      // declines it. `0` here would draw a ring against nothing.
      const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, contextUsage: { totalTokens: 42_000, maxTokens: 0, rawMaxTokens: 0 } }) as never });
      const h = a.start({ cwd: "/tmp", mcpServers: [] });
      const seen: SessionEvent[] = []; const c = collectUntil(h.events, () => false, (e) => seen.push(e));
      await h.send({ text: "hi", attachments: [] });
      await new Promise((r) => setTimeout(r, 50));
      await h.dispose(); await c;
      for (const e of seen.filter((x) => x.type === "usage")) expect(e.type === "usage" && "contextTokens" in e.payload).toBe(false);
    });
  });

  describe("fast mode", () => {
    // The fixture's init message names this model; the adapter joins it against `supportedModels()`.
    const MODEL = "claude-opus-5";

    it("asks the CLI whether THIS model can run it, and restates init with the answer", async () => {
      // Not a table here: a hardcoded list of fast-capable models goes stale, and a switch offered on
      // a model that cannot run it is a control whose only outcome is a `model_not_allowed`.
      const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, models: [{ value: MODEL, supportsFastMode: true }] }) as never });
      const h = a.start({ cwd: "/tmp", mcpServers: [] });
      const seen: SessionEvent[] = []; const c = collectUntil(h.events, () => false, (e) => seen.push(e));
      await h.send({ text: "hi", attachments: [] });
      await new Promise<void>((res) => { const t = setInterval(() => { if (seen.some((e) => e.type === "init" && e.payload.supportsFastMode !== undefined)) { clearInterval(t); res(); } }, 5); });
      await h.dispose(); await c;
      const inits = seen.filter((e) => e.type === "init");
      // The second init restates the WHOLE record, not a partial: an event whose `tools` was an empty
      // array to satisfy the schema would be a false statement in a persisted log.
      const last = inits.at(-1)!;
      expect(last.type === "init" && last.payload.supportsFastMode).toBe(true);
      expect(last.type === "init" && last.payload.tools).toEqual(inits[0]!.type === "init" ? inits[0]!.payload.tools : null);
      expect(last.type === "init" && last.payload.providerSessionId).toBe(inits[0]!.type === "init" ? inits[0]!.payload.providerSessionId : null);
    });

    const supportFrom = async (models: NonNullable<FakeOpts["models"]>) => {
      const a = new ClaudeAdapter({ query: fakeQuery({ models }) as never });
      const h = a.start({ cwd: "/tmp", mcpServers: [] });
      // Collected to the END, not to the first idle: the answer is a round trip behind the handshake,
      // and a restatement that landed after the loop stopped listening would read as "unstated".
      const seen: SessionEvent[] = [];
      const c = collectUntil(h.events, () => false, (e) => seen.push(e));
      await h.send({ text: "hi", attachments: [] });
      await new Promise<void>((res) => { const t = setInterval(() => { if (statuses(seen).includes("idle")) { clearInterval(t); res(); } }, 5); });
      await new Promise((r) => setTimeout(r, 20));
      await h.dispose(); await c;
      const stated = seen.filter((e) => e.type === "init" && e.payload.supportsFastMode !== undefined).at(-1);
      return stated?.type === "init" ? stated.payload.supportsFastMode : undefined;
    };

    it("finds the model where the CLI lists it only under a context-window variant", async () => {
      /* THE BUG: the CLI lists Opus 5.5 only as `opus[1m]` → `claude-opus-5-5[1m]`, and a session that
         picked plain `claude-opus-5-5` matched nothing — so its Speed control never appeared at all.
         Every Opus 5.5 session the user started by name had its answer silently dropped. */
      expect(await supportFrom([{ value: "opus[1m]", resolvedModel: `${MODEL}[1m]`, supportsFastMode: true }])).toBe(true);
    });

    it("lets an entry naming this very id outrank a variant of it", async () => {
      expect(await supportFrom([
        { value: "opus[1m]", resolvedModel: `${MODEL}[1m]`, supportsFastMode: true },
        { value: MODEL, supportsFastMode: false },
      ])).toBe(false);
    });

    it("does not mistake a different model that shares a prefix for a variant", async () => {
      // `claude-opus-5-5` is not a build of `claude-opus-5`; only a bracketed suffix is a variant.
      expect(await supportFrom([{ value: "opus[1m]", resolvedModel: `${MODEL}-5[1m]`, supportsFastMode: true }])).toBeUndefined();
    });

    it("restates the answer for EVERY model the CLI listed, so the next session on any of them knows", async () => {
      /* THE BUG the owner hit: a new session on a model no earlier session had run showed no fast-mode
         switch at all, because only the model each session asked for was ever remembered. The CLI
         answers for its whole list in the same round trip, and that list is what this files. */
      const a = new ClaudeAdapter({ query: fakeQuery({ models: [
        { value: "default", resolvedModel: "claude-fable-5-1", supportsFastMode: false },
        { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", supportsFastMode: true },
        { value: MODEL, supportsFastMode: true },
        { value: "haiku", resolvedModel: "claude-haiku-4-5" },
      ] }) as never });
      const h = a.start({ cwd: "/tmp", mcpServers: [] });
      const seen: SessionEvent[] = [];
      const c = collectUntil(h.events, () => false, (e) => seen.push(e));
      await h.send({ text: "hi", attachments: [] });
      await new Promise<void>((res) => { const t = setInterval(() => { if (seen.some((e) => e.type === "init" && e.payload.fastModeModels)) { clearInterval(t); res(); } }, 5); });
      await h.dispose(); await c;
      const last = seen.filter((e) => e.type === "init").at(-1)!;
      // The default row is the CLI's own default, filed under "" — what a session with no model asks
      // for — and the model it resolves to; a model that stated nothing is left out, not filed `false`.
      expect(last.type === "init" && last.payload.fastModeModels).toEqual({
        "": false, "claude-fable-5-1": false, "claude-opus-5-5": true, [MODEL]: true,
      });
      expect(last.type === "init" && last.payload.supportsFastMode).toBe(true);
    });

    it("lets a model's own entry outrank a variant of it, and the default's resolution, in that map", () => {
      // The single-model precedence above, applied across the list: listed in either order, the
      // entry naming the id is the answer for it.
      expect(fastModeByModel([
        { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", supportsFastMode: true },
        { value: "claude-opus-5-5", supportsFastMode: false },
      ])).toEqual({ "claude-opus-5-5": false });
      expect(fastModeByModel([
        { value: "claude-opus-5-5", supportsFastMode: false },
        { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", supportsFastMode: true },
      ])).toEqual({ "claude-opus-5-5": false });
      expect(fastModeByModel([
        { value: "default", resolvedModel: "claude-sonnet-5", supportsFastMode: true },
        { value: "sonnet", resolvedModel: "claude-sonnet-5", supportsFastMode: false },
      ])).toEqual({ "": true, "claude-sonnet-5": false });
    });

    it("says nothing at all when the CLI declines the question, or does not know the model", async () => {
      // Both are "not stated", and the prompter reads that as "offer no switch" — never as "no".
      for (const models of [undefined, [{ value: "some-other-model", supportsFastMode: true }]]) {
        const a = new ClaudeAdapter({ query: fakeQuery({ ...(models ? { models } : {}) }) as never });
        const h = a.start({ cwd: "/tmp", mcpServers: [] });
        const seen: SessionEvent[] = [];
        const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle", (e) => seen.push(e));
        await h.send({ text: "hi", attachments: [] });
        await c; await h.dispose();
        expect(seen.filter((e) => e.type === "init" && e.payload.supportsFastMode !== undefined)).toEqual([]);
      }
    });

    it("hands the request to `query` at start, so a session switched on before its first message runs fast on it", async () => {
      // The flag layer can only be written once a query exists, and by then the first prompt is on
      // its way — so the start option is what makes turn one honour the switch.
      const captureOptions: Record<string, unknown>[] = [];
      const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, captureOptions }) as never });
      const h = a.start({ cwd: "/tmp", mcpServers: [], fastMode: true });
      const c = collectUntil(h.events, () => false);
      await h.send({ text: "hi", attachments: [] });
      await h.dispose(); await c;
      /* In `settings`, the flag layer, because that is the one the CLI's opt-in gate reads: under the
         SDK it refuses fast mode as `sdk_opt_in_required` unless `flagSettings.fastMode` is true.
         THE BUG this pins: this test used to assert a top-level `fastMode`. The fake takes any key,
         so it agreed; the real SDK has no such option, dropped it without a word, and no session
         ever started fast. */
      expect(captureOptions[0]!.settings).toEqual({ fastMode: true });
      expect("fastMode" in captureOptions[0]!).toBe(false);
    });

    it("leaves the option off the start entirely when it was not asked for", async () => {
      // `fastMode: false` and an absent key mean the same thing to the SDK, but sending the key
      // writes the flag layer and would override a user's own Claude Code setting with a default.
      const captureOptions: Record<string, unknown>[] = [];
      const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, captureOptions }) as never });
      const h = a.start({ cwd: "/tmp", mcpServers: [] });
      const c = collectUntil(h.events, () => false);
      await h.send({ text: "hi", attachments: [] });
      await h.dispose(); await c;
      expect("fastMode" in captureOptions[0]!).toBe(false);
      expect("settings" in captureOptions[0]!).toBe(false);
    });

    it("moves it mid-session through the flag settings layer — there is no setFastMode", async () => {
      const flagSettings: Record<string, unknown>[] = [];
      const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, flagSettings }) as never });
      const h = a.start({ cwd: "/tmp", mcpServers: [] });
      const c = collectUntil(h.events, () => false);
      await h.send({ text: "hi", attachments: [] });
      await h.setOptions({ fastMode: true });
      await h.setOptions({ fastMode: false });
      // A setOptions that says nothing about speed must not touch the layer at all.
      await h.setOptions({ model: "claude-sonnet-5" });
      await h.dispose(); await c;
      expect(flagSettings).toEqual([{ fastMode: true }, { fastMode: false }]);
    });

    it("points Claude's auto-memory at Realm's folder in the same flag layer, beside fast mode", async () => {
      const captureOptions: Record<string, unknown>[] = [];
      const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, captureOptions }) as never });
      for (const fastMode of [true, false]) {
        const h = a.start({ cwd: "/tmp", mcpServers: [], fastMode, memoryDirectory: "/realm/memory/repos/profile-p/spaces/realm" });
        const c = collectUntil(h.events, () => false);
        await h.send({ text: "hi", attachments: [] });
        await h.dispose(); await c;
      }
      // THE MUTANT: two spreads of `settings` — the second replaces the first, and either fast mode
      // or the memory folder silently goes missing.
      expect(captureOptions.map((o) => o.settings)).toEqual([
        { fastMode: true, autoMemoryDirectory: "/realm/memory/repos/profile-p/spaces/realm" },
        { autoMemoryDirectory: "/realm/memory/repos/profile-p/spaces/realm" },
      ]);
    });

    describe("reasoning effort", () => {
      it("hands the SDK a level it has a word for, and never one from another harness", async () => {
        for (const [effort, sent] of [["max", "max"], ["minimal", undefined], [null, undefined]] as const) {
          const captureOptions: Record<string, unknown>[] = [];
          const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, captureOptions }) as never });
          const h = a.start({ cwd: "/tmp", mcpServers: [], effort });
          const c = collectUntil(h.events, () => false);
          await h.send({ text: "hi", attachments: [] });
          await h.dispose(); await c;
          // `minimal` is Codex's; kept across an agent switch, it is no `EffortLevel` the CLI takes.
          expect(captureOptions[0]!.effort, String(effort)).toBe(sent);
        }
      });

      it("moves the level mid-session through the flag layer, and a reset is the SDK's own null", async () => {
        /* `applyFlagSettings({effortLevel: null})` "goes to the model's default effort" — the SDK's
           words — which is exactly what the picker's reset means. A level from another harness is not
           sent at all, and an options call that says nothing about effort leaves the layer alone. */
        const flagSettings: Record<string, unknown>[] = [];
        const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, flagSettings }) as never });
        const h = a.start({ cwd: "/tmp", mcpServers: [] });
        const c = collectUntil(h.events, () => false);
        await h.send({ text: "hi", attachments: [] });
        await h.setOptions({ effort: "low" });
        await h.setOptions({ effort: null });
        await h.setOptions({ effort: "minimal" });
        await h.setOptions({ model: "claude-sonnet-5" });
        await h.dispose(); await c;
        expect(flagSettings).toEqual([{ effortLevel: "low" }, { effortLevel: null }]);
      });

      it("files each listed model's own levels, an explicit none included", () => {
        expect(effortByModel([
          { value: "default", resolvedModel: "claude-fable-5-1", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
          { value: "haiku", resolvedModel: "claude-haiku-4-5", supportsEffort: false },
          { value: "sonnet", resolvedModel: "claude-sonnet-5", supportedEffortLevels: ["low", "medium", "high", "minimal"] },
          { value: "opus" },
        ])).toEqual({
          "": ["low", "medium", "high", "xhigh", "max"], "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
          // `supportsEffort: false` is an answer — no levels — where silence (`opus`) is filed as nothing.
          "claude-haiku-4-5": [], "claude-sonnet-5": ["low", "medium", "high"],
        });
      });

      it("restates init with those levels, for the next session on any of them", async () => {
        const a = new ClaudeAdapter({ query: fakeQuery({ models: [
          { value: MODEL, supportsFastMode: true, supportsEffort: true, supportedEffortLevels: ["low", "high"] },
        ] }) as never });
        const h = a.start({ cwd: "/tmp", mcpServers: [] });
        const seen: SessionEvent[] = [];
        const c = collectUntil(h.events, () => false, (e) => seen.push(e));
        await h.send({ text: "hi", attachments: [] });
        await new Promise<void>((res) => { const t = setInterval(() => { if (seen.some((e) => e.type === "init" && e.payload.effortModels)) { clearInterval(t); res(); } }, 5); });
        await h.dispose(); await c;
        const last = seen.filter((e) => e.type === "init").at(-1)!;
        expect(last.type === "init" && last.payload.effortModels).toEqual({ [MODEL]: ["low", "high"] });
      });
    });

    const requested = (evs: SessionEvent[]) => evs.flatMap((e) => (e.type === "usage" ? [e.payload.fastModeRequested] : []));

    it("says on each turn's report whether that turn asked for it", async () => {
      // What the picker needs to tell "fast mode was refused" from "fast mode was not asked for".
      for (const fastMode of [true, false]) {
        const a = new ClaudeAdapter({ query: fakeQuery({}) as never });
        const h = a.start({ cwd: "/tmp", mcpServers: [], fastMode });
        const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle");
        await h.send({ text: "hi", attachments: [] });
        const got = await c; await h.dispose();
        expect(requested(got), String(fastMode)).toEqual([fastMode]);
      }
    });

    it("keeps a switch flipped mid-turn off the turn in flight, and puts it on the next", async () => {
      /* THE BUG this closes: the picker read the last turn's refusal as a verdict on the switch just
         flipped, and said fast mode could not run — about a turn that never asked for it. Turn one
         parks on a permission, the switch moves while it waits, and only turn two carries it. */
      const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Read", turns: 2, hang: true }) as never });
      const h = a.start({ cwd: "/tmp", mcpServers: [] });
      let parked!: (id: string) => void; const asked = new Promise<string>((r) => { parked = r; });
      let settled!: () => void; const turnOne = new Promise<void>((r) => { settled = r; });
      const c = collectUntil(h.events, (e, all) => e.type === "status" && e.payload.status === "idle" && requested(all).length === 2, (e) => {
        if (e.type === "permission_request") parked(e.payload.requestId);
        if (e.type === "status" && e.payload.status === "idle") settled();
      });
      await h.send({ text: "one", attachments: [] });
      const id = await asked;
      await h.setOptions({ fastMode: true });
      h.respondPermission(id, "allow");
      await turnOne;
      await h.send({ text: "two", attachments: [] });
      const got = await c; await h.dispose();
      expect(requested(got)).toEqual([false, true]);
    });
  });

  it("a turn the user stopped settles as STOPPED, not as an error", async () => {
    /* The SDK reports a cancelled turn as an error result carrying its own diagnostic
       (`[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null`). That is true of
       the API call and useless to the person who pressed the button — they know why it stopped. The
       named mutant: dropping the `interrupted` latch, which puts a red error block in the transcript
       every single time anyone stops a turn. */
    const a = new ClaudeAdapter({ query: fakeQuery({ errorResult: true, hang: true }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const seen: SessionEvent[] = [];
    const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle", (e) => seen.push(e));
    await h.send({ text: "hi", attachments: [] });
    await h.interrupt();
    await c;
    expect(types(seen)).not.toContain("error");
    const settle = seen.find((e) => e.type === "status" && e.payload.status === "idle");
    expect(settle?.type === "status" && settle.payload.interrupted).toBe(true);
    // The usage still lands: the tokens were spent, and a cancelled turn is not a free one.
    expect(types(seen)).toContain("usage");
    await h.dispose();
  });

  it("a turn that genuinely failed still reports its error", async () => {
    // The latch is armed by `interrupt` alone. Without that half, "quiet on cancel" would become
    // "quiet on failure", which is the worse bug of the two.
    const a = new ClaudeAdapter({ query: fakeQuery({ errorResult: true }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const seen: SessionEvent[] = [];
    const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle", (e) => seen.push(e));
    await h.send({ text: "hi", attachments: [] });
    await c; await h.dispose();
    expect(types(seen)).toContain("error");
    const settle = seen.find((e) => e.type === "status" && e.payload.status === "idle");
    expect(settle?.type === "status" && settle.payload.interrupted).toBeUndefined();
  });

  it("a Stop that lands after the turn ended does not mark the next turn as stopped", async () => {
    // Stop pressed as the turn finishes reaches an idle CLI: no result follows it, so a latch armed
    // then would ride into the next turn and settle that one as "you stopped this".
    const a = new ClaudeAdapter({ query: fakeQuery({ turns: 2, hang: true }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const seen: SessionEvent[] = [];
    const settles = () => seen.filter((e) => e.type === "status" && e.payload.status === "idle");
    const c = collectUntil(h.events, () => settles().length === 2, (e) => seen.push(e));
    await h.send({ text: "one", attachments: [] });
    await new Promise<void>((res) => { const t = setInterval(() => { if (settles().length === 1) { clearInterval(t); res(); } }, 5); });
    await h.interrupt();
    await h.send({ text: "two", attachments: [] });
    await c;
    const second = settles()[1];
    expect(second?.type === "status" && second.payload.interrupted).toBeUndefined();
    await h.dispose();
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
  // A skills start reads the settings file at $HOME (the auth carry-forward, settings-auth.ts), so
  // every test here points HOME at a scratch directory: the suite must never read the user's real
  // settings, let alone run their apiKeyHelper. The credential vars go too, so a key the carry
  // minted is observable on a machine that exports one of its own.
  beforeEach(() => {
    vi.stubEnv("HOME", tempDir("realm-claude-skills-home-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  /** What `$HOME/.claude/settings.json` holds for this test — the scratch home the stub above made. */
  function settingsFile(settings: Record<string, unknown>) {
    mkdirSync(join(process.env.HOME!, ".claude"), { recursive: true });
    writeFileSync(join(process.env.HOME!, ".claude", "settings.json"), JSON.stringify(settings));
  }

  /** Captures the options object the SDK was called with, without running a turn. `options` waits:
   *  a skills start reaches `query` only after the (async) settings-auth carry. */
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
    const options = async () => { while (!seen) await new Promise((r) => setTimeout(r, 1)); return seen as Record<string, unknown>; };
    return { handle, options };
  }

  it("passes the staged plugin and isolates the session from the user's own settings", async () => {
    const { handle, options } = capture({ skills: { pluginPath: "/tmp/realm-plugin", root: "/tmp/realm-plugin/skills" } });
    await handle.send({ text: "hi", attachments: [] });
    const o = await options();
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
    expect((await options()).systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "REALM CONTEXT 4417" });
    await handle.dispose();
  });

  it("leaves systemPrompt untouched when there is no context", async () => {
    const { handle, options } = capture({});
    await handle.send({ text: "hi", attachments: [] });
    expect((await options()).systemPrompt).toBeUndefined();
    await handle.dispose();
  });

  it("touches neither option when Realm is not managing this session's skills", async () => {
    const { handle, options } = capture({});
    await handle.send({ text: "hi", attachments: [] });
    const o = await options();
    expect(o.plugins).toBeUndefined();
    // Undefined, NOT []: the SDK reads an omitted settingSources as "all sources, like the CLI", which is
    // what every Realm session did before skills existed and what a space with none must keep doing.
    expect("settingSources" in o).toBe(false);
    await handle.dispose();
  });

  it("carries the settings file's auth into the child env — the login settingSources: [] would otherwise cost", async () => {
    /* THE BUG this pins: on a machine whose entire login is ~/.claude/settings.json (an env block
       pointing ANTHROPIC_BASE_URL at a gateway, plus an apiKeyHelper), `settingSources: []` cost the
       session that file too — every skills session booted `apiKeySource: none` and answered "Not
       logged in". Proven against the real SDK in scripts/live-claude-auth-check.ts; this holds the
       merge order. */
    settingsFile({
      env: { ANTHROPIC_BASE_URL: "https://settings.example", REALM_PROBE_FROM_SETTINGS: "yes" },
      apiKeyHelper: "printf sk-carried-1",
    });
    const { handle, options } = capture({
      skills: { pluginPath: "/tmp/realm-plugin", root: "/tmp/realm-plugin/skills" },
      env: { ANTHROPIC_BASE_URL: "https://realm.example" },
    });
    await handle.send({ text: "hi", attachments: [] });
    const env = (await options()).env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-carried-1");
    expect(env.REALM_PROBE_FROM_SETTINGS).toBe("yes");
    // Realm's own opts.env stays on top: nothing carried may override what the server set deliberately.
    expect(env.ANTHROPIC_BASE_URL).toBe("https://realm.example");
    await handle.dispose();
  });

  it("never spawns for a session disposed mid-carry", async () => {
    // dispose() stops waiting after its own timeout, but the carry can outlive it: without the
    // disposed check after the await, a session already reported "ended" still spawned a real CLI.
    settingsFile({ apiKeyHelper: "sleep 0.3; printf sk-late" });
    let seen = false;
    const adapter = new ClaudeAdapter({ query: (() => { seen = true; return (async function* () {})(); }) as never });
    const handle = adapter.start({ cwd: "/tmp", mcpServers: [], skills: { pluginPath: "/tmp/realm-plugin", root: "/tmp/realm-plugin/skills" } });
    await handle.send({ text: "hi", attachments: [] });
    await handle.dispose(); // returns once pump exits at the disposed check, well inside its own net
    await new Promise((r) => setTimeout(r, 400)); // past the helper's finish, where the spawn would happen
    expect(seen).toBe(false);
  });

  it("holds a mid-carry setOptions until the spawn it talks to exists", async () => {
    // The carry is the first await in `pump`, so for its duration there is no `q`: before the qUp
    // gate, this setModel landed on `q?.` as a no-op and the change silently vanished. The slow
    // helper IS the race window.
    settingsFile({ apiKeyHelper: "sleep 0.2; printf sk-slow" });
    let seen: Record<string, unknown> | null = null;
    const setModel = vi.fn();
    const adapter = new ClaudeAdapter({
      query: (({ options }: { options: Record<string, unknown> }) => {
        seen = options;
        const g = (async function* () {})() as AsyncGenerator<unknown> & { setModel: typeof setModel };
        g.setModel = setModel;
        return g;
      }) as never,
    });
    const handle = adapter.start({ cwd: "/tmp", mcpServers: [], skills: { pluginPath: "/tmp/realm-plugin", root: "/tmp/realm-plugin/skills" } });
    await handle.send({ text: "hi", attachments: [] });
    await handle.setOptions({ model: "claude-opus-5-5" }); // issued while the helper is still minting
    expect(setModel).toHaveBeenCalledWith("claude-opus-5-5");
    expect((seen as unknown as { env: Record<string, string> }).env.ANTHROPIC_API_KEY).toBe("sk-slow");
    await handle.dispose();
  });

  it("holds a mid-carry interrupt until the spawn it stops exists", async () => {
    // The same window as setOptions above: a Stop pressed while the helper is still minting found no
    // `q`, so `q?.interrupt()` did nothing and the first turn ran on as if Stop was never pressed.
    settingsFile({ apiKeyHelper: "sleep 0.2; printf sk-slow" });
    const interrupt = vi.fn();
    const adapter = new ClaudeAdapter({
      query: (() => {
        const g = (async function* () {})() as AsyncGenerator<unknown> & { interrupt: typeof interrupt };
        g.interrupt = interrupt;
        return g;
      }) as never,
    });
    const handle = adapter.start({ cwd: "/tmp", mcpServers: [], skills: { pluginPath: "/tmp/realm-plugin", root: "/tmp/realm-plugin/skills" } });
    await handle.send({ text: "hi", attachments: [] });
    await handle.interrupt(); // pressed while the helper is still minting
    expect(interrupt).toHaveBeenCalledTimes(1);
    await handle.dispose();
  });

  it("leaves a non-skills session's env byte-for-byte what it always was, settings file or not", async () => {
    // The CLI reads the file itself here, so carrying it too would apply every entry twice — and run
    // a token-minting helper on sessions that never lost their login.
    settingsFile({ env: { REALM_PROBE_FROM_SETTINGS: "yes" }, apiKeyHelper: "printf sk-never-minted" });
    const { handle, options } = capture({ env: { REALM_PROBE_OWN: "v" } });
    await handle.send({ text: "hi", attachments: [] });
    expect((await options()).env).toEqual({ ...process.env, REALM_PROBE_OWN: "v" });
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

});

describe("claudeMcpServers", () => {
  const stdio = { name: "airtable", transport: "stdio" as const, command: "/usr/bin/node", args: ["/abs/s.mjs"], env: { K: "v" } };
  const http = { name: "vercel", transport: "http" as const, url: "https://mcp.vercel.com", headers: { Authorization: "Bearer t" } };
  const sse = { name: "legacy", transport: "sse" as const, url: "https://sse.example/mcp", headers: {} };

  it("tags each entry with its transport and carries only that transport's fields", () => {
    expect(claudeMcpServers([stdio])).toEqual({ airtable: { type: "stdio", command: "/usr/bin/node", args: ["/abs/s.mjs"], env: { K: "v" } } });
    expect(claudeMcpServers([http])).toEqual({ vercel: { type: "http", url: "https://mcp.vercel.com", headers: { Authorization: "Bearer t" }, timeout: GATEWAY_TOOL_TIMEOUT_MS } });
    expect(claudeMcpServers([sse])).toEqual({ legacy: { type: "sse", url: "https://sse.example/mcp", headers: {}, timeout: GATEWAY_TOOL_TIMEOUT_MS } });
  });

  it("lets a gateway call run past Claude's five-minute silence limit, to the hour agent_wait may take", () => {
    // THE MUTANT: drop `timeout`. Claude then aborts an agent_wait that has sent nothing for 300 s,
    // and the lead is handed Claude's error instead of its sub-agents' reports.
    const entry = claudeMcpServers([{ name: "realm", transport: "http", url: "http://127.0.0.1:1/mcp", headers: {} }]).realm as { timeout?: number };
    expect(entry.timeout).toBe(GATEWAY_TOOL_TIMEOUT_MS);
    expect(GATEWAY_TOOL_TIMEOUT_MS).toBeGreaterThan(60 * 60_000);
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
describe("read-only gateway allowedTools (Plan 11 W4)", () => {
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
      // The rest of REALM_READ_ONLY_TOOLS, the list the gateway marks read-only for Codex: reads
      // Realm itself never prompts for, so Claude's prompt would be the only card in front of them.
      "mcp__realm__realm-workspace__workspace_state",
      "mcp__realm__realm-workspace__sessions_list",
      "mcp__realm__realm-workspace__session_read",
      "mcp__realm__realm-workspace__space_list",
      "mcp__realm__realm-workspace__settings_get",
      "mcp__realm__realm-workspace__realm_capabilities",
      // Sizes and names of what is using the Mac's memory, and advice; it changes nothing. A prompt
      // in front of it would only teach an agent to skip the check before a build.
      "mcp__realm__realm-workspace__machine_status",
      "mcp__realm__realm-agent__agent_peers",
      "mcp__realm__realm-agent__agent_status",
      "mcp__realm__realm-schedule__schedule_list",
      "mcp__realm__realm-docs__docs_search",
      "mcp__realm__realm-docs__docs_read",
      "mcp__realm__realm-docs__docs_state",
      "mcp__realm__realm-team__record_list",
      "mcp__realm__realm-team__record_types",
      "mcp__realm__realm-team__review_status",
      "mcp__realm__realm-team__policy_read",
      "mcp__realm__realm-memory__memory_index",
      "mcp__realm__realm-memory__memory_read",
      "mcp__realm__realm-memory__memory_search",
      "mcp__realm__realm-goal__goal_status",
      "mcp__realm__realm-vault__vault_list",
    ]);
  });

  it("NEVER contains a mutating tool name (the named mutant: a pre-allowed act)", () => {
    const allowed = claudeAllowedTools([gatewayEntry]);
    // `pane_show` changes what is on the user's screen: it keeps Claude's prompt where the mode has one.
    for (const mutating of ["browser_open", "browser_navigate", "browser_act", "browser_batch", "browser_fill_credential",
      "pane_show", "session_open", "space_switch", "settings_set",
      "agent_run", "agent_start", "agent_ask", "schedule_create", "docs_open", "update_goal",
      "record_update", "record_read", "review_submit", "review_close", "memory_save", "memory_write_file", "vault_http"]) {
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

/**
 * The truncating resume (`Options.resumeSessionAt` + `Options.resumeDropsTurn`) — what a checkpoint
 * restore arms. Everything here is asserted on the Options object the adapter hands `query`, because
 * that is the whole of Realm's part: the truncation itself happens inside the CLI, on the print/headless
 * lane this adapter is on, and no test in this suite can reach it.
 */
describe("truncating resume", () => {
  const start = (opts: Partial<StartOptions & { resumeAt?: string | null; resumeDropsTurn?: string | null }>, captureOptions: Record<string, unknown>[]) => {
    const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, captureOptions }) as never });
    return a.start({ cwd: "/tmp", mcpServers: [], ...opts });
  };
  const optionsFor = async (opts: Partial<StartOptions & { resumeAt?: string | null; resumeDropsTurn?: string | null }>) => {
    const captureOptions: Record<string, unknown>[] = [];
    const h = start(opts, captureOptions);
    await h.send({ text: "hi", attachments: [] });
    await h.dispose();
    return captureOptions[0]!;
  };

  it("sends the fork point and the dropped turn alongside the resume", async () => {
    const o = await optionsFor({ resume: "sess-1", resumeAt: "u-end", resumeDropsTurn: "u-prompt" });
    expect(o).toMatchObject({ resume: "sess-1", resumeSessionAt: "u-end", resumeDropsTurn: "u-prompt" });
  });

  it("sends NEITHER when the dropped turn is unknown — an unguarded truncation is not on offer", async () => {
    /* The named mutant: passing `resumeSessionAt` on its own. The SDK's documented behaviour without
       `resumeDropsTurn` is an UNVALIDATED truncation, which silently discards whatever else landed past
       the fork point — a queued user message, a task notification. The guard is the feature; its absence
       is not a degraded version of it. */
    const o = await optionsFor({ resume: "sess-1", resumeAt: "u-end" });
    expect(o.resume).toBe("sess-1");
    expect("resumeSessionAt" in o).toBe(false);
    expect("resumeDropsTurn" in o).toBe(false);
  });

  it("sends neither when there is no session to resume", async () => {
    // `resumeSessionAt` names a position in the chain `resume` loads. With no `resume` there is no
    // chain, and the pair would be an instruction about nothing.
    const o = await optionsFor({ resume: null, resumeAt: "u-end", resumeDropsTurn: "u-prompt" });
    expect("resumeSessionAt" in o).toBe(false);
    expect("resumeDropsTurn" in o).toBe(false);
  });

  it("leaves an ordinary resume exactly as it was", async () => {
    const o = await optionsFor({ resume: "sess-1" });
    expect(o.resume).toBe("sess-1");
    expect("resumeSessionAt" in o).toBe(false);
    expect("resumeDropsTurn" in o).toBe(false);
  });

  it("reports the settled turn's chain cursor off the handle", async () => {
    // The server reads this on the settle to write a checkpoint's cursor. The fixture's turn ends on an
    // assistant entry (`a2`) after a tool_result carrier (`r1`), and carries no prompt replay — which is
    // exactly what a cursor with no `dropsTurn` looks like, and why such a cursor is stored as none.
    const captureOptions: Record<string, unknown>[] = [];
    const a = new ClaudeAdapter({ query: fakeQuery({ captureOptions }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const c = collectUntil(h.events, (e) => e.type === "status" && e.payload.status === "idle");
    await h.send({ text: "hi", attachments: [] });
    await c;
    expect(h.chainCursor()).toEqual({ promptUuid: null, endUuid: "a2" });
    await h.dispose();
  });
});

/**
 * Realm's execution sandbox on the Claude side. The SDK owns the argv, so the only place to stand is
 * its own `spawnClaudeCodeProcess` seam — and the tests that matter are about when Realm stands on
 * it and when it deliberately does not.
 */
describe("the sandbox wrap", () => {
  const options = async (start: Partial<StartOptions>) => {
    const captureOptions: Record<string, unknown>[] = [];
    const a = new ClaudeAdapter({ query: fakeQuery({ hang: true, captureOptions }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [], ...start });
    const c = collectUntil(h.events, () => false);
    await h.send({ text: "hi", attachments: [] });
    await h.dispose(); await c;
    return captureOptions[0]!;
  };

  it("leaves the SDK's own spawn alone for a session with no sandbox", async () => {
    // The un-opted-in path, which is what this release ships. The SDK's `spawnLocalProcess` does
    // more than `spawn` — windowsHide, a stderr tail, an exit it holds until stderr closes — and a
    // user who never asked for a sandbox must keep all of it.
    //
    // MUTANT: install the seam unconditionally and this key appears for everybody.
    expect(await options({})).not.toHaveProperty("spawnClaudeCodeProcess");
  });

  it("hands the wrap the SDK's own argv and spawns what it answers with", async () => {
    const seen: { command: string; args: string[] }[] = [];
    const o = await options({
      wrap: (command, args) => { seen.push({ command, args }); return { command, args: ["WRAPPED"] }; },
    });
    const spawn = o.spawnClaudeCodeProcess as (so: { command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal }) => { stdout: NodeJS.ReadableStream; kill(s: NodeJS.Signals): boolean };
    const child = spawn({ command: "/bin/echo", args: ["ORIGINAL"], cwd: process.cwd(), env: process.env, signal: new AbortController().signal });
    // MUTANT: pass `so.command`/`so.args` straight to spawn and this prints ORIGINAL — an agent the
    // user asked to confine, running unconfined.
    const printed = await new Promise<string>((res) => { let out = ""; child.stdout.on("data", (d) => { out += String(d); }); child.stdout.on("end", () => res(out)); });
    expect(printed.trim()).toBe("WRAPPED");
    expect(seen).toEqual([{ command: "/bin/echo", args: ["ORIGINAL"] }]);
  });

  it("lets a wrap's throw out of the spawn rather than starting the CLI unconfined", async () => {
    const o = await options({ wrap: () => { throw new Error("sandbox-exec is missing"); } });
    const spawn = o.spawnClaudeCodeProcess as (so: { command: string; args: string[]; env: NodeJS.ProcessEnv; signal: AbortSignal }) => unknown;
    expect(() => spawn({ command: "/bin/echo", args: [], env: process.env, signal: new AbortController().signal }))
      .toThrow(/sandbox-exec is missing/);
  });
});

describe("streamWindowId", () => {
  const w = (id: string) => ({ id, label: id, utilization: 10, resetsAt: null });
  it("files the stream's overage-included window under the model bucket the control request named", () => {
    // Taken literally the event opened a second row, "Weekly (with extra usage)", beside "Fable
    // weekly" — one window drawn twice with two different numbers.
    expect(streamWindowId("seven_day_overage_included", [w("five_hour"), w("model:Fable")])).toBe("model:Fable");
  });
  it("keeps every other id, and the type itself when no model bucket is known", () => {
    expect(streamWindowId("five_hour", [w("model:Fable")])).toBe("five_hour");
    expect(streamWindowId("seven_day_overage_included", [w("five_hour")])).toBe("seven_day_overage_included");
    expect(streamWindowId(null, [])).toBeNull();
  });
});
