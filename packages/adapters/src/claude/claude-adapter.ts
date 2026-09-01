import { readFile, stat } from "node:fs/promises";
import { query as sdkQuery, type Options, type PermissionResult, type PermissionUpdate, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";
import { MAX_ATTACHMENT_BYTES, newId, sessionEvent, type SessionEvent } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import { createSdkMapper } from "./map-sdk-message";
import { probeClaude } from "./probe";
import type { AgentAdapter, AgentHandle, McpServerConfig, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";

type QueryFn = typeof sdkQuery;

/**
 * `Options.mcpServers` for the SDK: a record keyed by name (`sdk.d.ts:1734`), whose members are the
 * three process transports — `{type:'stdio',command,args,env}` and `{type:'http'|'sse',url,headers}`.
 *
 * No filtering happens here: since Plan 9 W3 `servers` is always exactly the gateway's own `http` entry
 * (or empty), and Claude takes every transport anyway. Translation only.
 */
export function claudeMcpServers(servers: readonly McpServerConfig[]): Record<string, unknown> {
  return Object.fromEntries(servers.map((s) => [
    s.name,
    s.transport === "stdio"
      ? { type: "stdio" as const, command: s.command, args: s.args, env: s.env }
      : { type: s.transport, url: s.url, headers: s.headers },
  ]));
}

const STDERR_TAIL_LINES = 50;
const DISPOSE_TIMEOUT_MS = 3000;

/** Claude adapter on the Agent SDK in streaming-input mode. `canUseTool` is bridged to permission_request/response events. */
export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  private queryFn: QueryFn;
  constructor(deps: { query?: QueryFn } = {}) { this.queryFn = deps.query ?? sdkQuery; }

  async probe(): Promise<ProbeResult> { const p = await probeClaude(); return { kind: this.kind, ...p }; }

  start(opts: StartOptions): AgentHandle {
    const events = new AsyncQueue<SessionEvent>();
    const input = new AsyncQueue<SDKUserMessage>();
    const pending = new Map<string, { resolve: (r: PermissionResult) => void; suggestions: PermissionUpdate[] }>();
    const abort = new AbortController();
    const mapper = createSdkMapper();
    const stderrTail: string[] = [];
    let q: Query | null = null;
    let running = false;
    let sawResult = false;
    let disposed = false;

    const onStderr = (data: string) => {
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        opts.onLog?.(line);
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    };
    const withStderr = (message: string) => (stderrTail.length ? `${message}\n--- stderr (last ${stderrTail.length} lines) ---\n${stderrTail.join("\n")}` : message);

    const resolvePermission = (requestId: string, d: PermissionDecision) => {
      const p = pending.get(requestId); if (!p) return;
      pending.delete(requestId);
      events.push(sessionEvent("permission_response", { requestId, decision: d }));
      if (d === "deny") p.resolve({ behavior: "deny", message: "User denied" });
      else if (d === "allow_always") p.resolve({ behavior: "allow", updatedPermissions: p.suggestions });
      else p.resolve({ behavior: "allow" });
    };
    const denyAllPending = () => { for (const id of [...pending.keys()]) resolvePermission(id, "deny"); };

    // Several tools may ask at once (parallel tool calls): status flips to waiting_permission on the first open request
    // and back only when the last one is answered.
    const canUseTool: NonNullable<Options["canUseTool"]> = async (toolName, toolInput, o) => {
      const requestId = newId();
      const suggestions = o.suggestions ?? [];
      if (pending.size === 0) events.push(sessionEvent("status", { status: "waiting_permission" }));
      events.push(sessionEvent("permission_request", { requestId, toolName, input: toolInput, title: o.title ?? `Allow ${toolName}?`, suggestions: suggestions as unknown[] }));
      const result = await new Promise<PermissionResult>((resolve) => {
        pending.set(requestId, { resolve, suggestions });
        o.signal.addEventListener("abort", () => {
          if (!pending.delete(requestId)) return;
          events.push(sessionEvent("permission_response", { requestId, decision: "deny" }));
          resolve({ behavior: "deny", message: "aborted" });
        }, { once: true });
      });
      if (pending.size === 0) events.push(sessionEvent("status", { status: running ? "running" : "idle" }));
      return result;
    };

    const options: Options = {
      cwd: opts.cwd,
      model: opts.model ?? undefined,
      effort: (opts.effort ?? undefined) as Options["effort"],
      permissionMode: (opts.permissionMode ?? "default") as Options["permissionMode"],
      canUseTool,
      includePartialMessages: true,
      abortController: abort,
      resume: opts.resume ?? undefined,
      systemPrompt: opts.systemContext ? { type: "preset", preset: "claude_code", append: opts.systemContext } : undefined,
      // A RECORD keyed by name, not an array: `sdk.d.ts` `mcpServers?: Record<string, McpServerConfig>`.
      // Some documentation shows an array; disk wins.
      mcpServers: claudeMcpServers(opts.mcpServers) as Options["mcpServers"],
      // Realm's skills library as a local plugin, and `settingSources: []` so it is the ONLY library
      // this session has. The two go together and neither works alone for what Realm wants:
      //
      //   - without `plugins`, there is no way to add a skills directory at all;
      //   - without `settingSources: []`, the user's own `~/.claude/skills` (29 of them here) load
      //     alongside Realm's, so the library the UI lists is not the library the agent has.
      //
      // Proven live in scripts/live-skills-check.ts: this shape surfaces `realm:<id>` and leaks nothing;
      // dropping `settingSources` takes the command count from 53 to 147.
      //
      // The cost is real and deliberate: `settingSources: []` also drops the user's `~/.claude/CLAUDE.md`
      // and the repo's `.claude/` settings. That is why the option is only present when the space
      // actually has enabled skills — a space that manages none is left exactly as it was.
      ...(opts.skills ? { settingSources: [], plugins: [{ type: "local" as const, path: opts.skills.pluginPath, skipMcpDiscovery: true }] } : {}),
      env: { ...process.env, ...opts.env },
      stderr: onStderr,
      pathToClaudeCodeExecutable: process.env.REALM_CLAUDE_BIN,
    };

    const pump = async () => {
      let failure: string | null = null;
      try {
        q = this.queryFn({ prompt: input, options });
        for await (const msg of q) {
          if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
            for (const e of mapper.map(msg)) events.push(e);
            if (!running) events.push(sessionEvent("status", { status: "idle" })); // init arrives after the first send in streaming mode
            continue;
          }
          if (msg.type === "result") {
            for (const e of mapper.map(msg)) events.push(e);
            running = false; sawResult = true;
            events.push(sessionEvent("status", { status: "idle" }));
            continue;
          }
          for (const e of mapper.map(msg)) events.push(e);
        }
        // Generator ended on its own: abnormal unless we asked for it or it ended cleanly between turns.
        if (!disposed && (running || !sawResult)) failure = "agent process ended unexpectedly";
      } catch (e) {
        // The SDK rejects iteration with "Claude Code process aborted by user" when our abortController fires in dispose(); not an error.
        if (!disposed && !abort.signal.aborted) failure = (e as Error).message ?? String(e);
      } finally {
        denyAllPending();
        if (failure !== null) {
          events.push(sessionEvent("error", { message: withStderr(failure) }));
          events.push(sessionEvent("status", { status: "error" }));
        }
        running = false;
        events.push(sessionEvent("status", { status: "ended" }));
        events.close();
      }
    };
    const pumpDone = pump();

    const readAttachments = async (m: UserMessage): Promise<Array<Record<string, unknown>>> => {
      const blocks: Array<Record<string, unknown>> = [];
      for (const a of m.attachments) {
        if (!a.mime.startsWith("image/")) continue;
        const { size } = await stat(a.path);
        if (size > MAX_ATTACHMENT_BYTES) throw new Error(`attachment too large (${size} bytes > ${MAX_ATTACHMENT_BYTES}): ${a.path}`);
        const data = (await readFile(a.path)).toString("base64");
        blocks.push({ type: "image", source: { type: "base64", media_type: a.mime, data } });
      }
      return blocks;
    };

    return {
      events,
      send: async (m: UserMessage) => {
        if (disposed || input.isClosed) { events.push(sessionEvent("error", { message: "session ended" })); return; }
        let images: Array<Record<string, unknown>>;
        try { images = await readAttachments(m); }
        catch (e) { events.push(sessionEvent("error", { message: `attachment error: ${(e as Error).message ?? String(e)}` })); return; }
        if (disposed || input.isClosed) { events.push(sessionEvent("error", { message: "session ended" })); return; }
        running = true;
        events.push(sessionEvent("status", { status: "running" }));
        // A resolved @-mention (W4) becomes `/realm:<name>` at POSITION 0 — the only place the SDK
        // dispatches a slash command; mid-text it is literal characters. The rest of the message rides
        // as the command's argument. `name` is the frontmatter name, which is how the plugin registers
        // the skill (a prepend built from the directory id would target nothing when the two differ).
        const text = m.skill ? `/realm:${m.skill.name} ${m.text}` : m.text;
        const content: Array<Record<string, unknown>> = [{ type: "text", text }, ...images];
        input.push({ type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage);
      },
      respondPermission: resolvePermission,
      interrupt: async () => {
        denyAllPending();
        try { await q?.interrupt(); } catch { /* process may already be gone; result/ended will report */ }
      },
      setOptions: async (o) => {
        if (o.model) await q?.setModel(o.model);
        if (o.permissionMode) await q?.setPermissionMode(o.permissionMode as never);
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        denyAllPending();
        input.close();
        abort.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([pumpDone.then(() => false), new Promise<boolean>((res) => { timer = setTimeout(() => res(true), DISPOSE_TIMEOUT_MS); })]);
        clearTimeout(timer);
        if (timedOut && !events.isClosed) { events.push(sessionEvent("status", { status: "ended" })); events.close(); }
      },
    };
  }
}
