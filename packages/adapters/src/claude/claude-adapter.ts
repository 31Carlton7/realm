import { readFile, stat } from "node:fs/promises";
import { query as sdkQuery, type Options, type PermissionResult, type PermissionUpdate, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";
import { ASK_PERMISSION_MODE, BROWSER_READ_ONLY_TOOLS, MAX_ATTACHMENT_BYTES, newId, sessionEvent, type SessionEvent } from "@realm/contracts";
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

/**
 * W4's double-prompt fix, read-only half ONLY. The SDK asks `canUseTool` for every MCP tool — which
 * Realm bridges to an ApprovalCard — so before this, a `browser_snapshot` that Realm's own broker
 * deliberately lets run free still raised a card from Claude's side. Pre-allowing the READ-ONLY
 * `realm-browser` tools via `Options.allowedTools` makes reads promptless end to end.
 *
 * Tool naming, verified against the gateway (`apps/server/src/mcp/gateway.ts`): every session's one
 * MCP server is the gateway entry named `realm`, whose provider tools are re-exported as
 * `realm-browser__browser_*`; the SDK prefixes MCP tools as `mcp__<serverName>__<toolName>` — so
 * `mcp__realm__realm-browser__browser_snapshot` etc. Derived from `opts.mcpServers` rather than a
 * literal "realm" so a renamed gateway entry cannot silently orphan the allow-list.
 *
 * MUTATING tools are deliberately NOT here and must never be: they keep BOTH prompts (Claude's and
 * Realm's ApprovalCard) — one prompt too many beats one too few. `BROWSER_READ_ONLY_TOOLS` is the
 * same shared list the server's broker gates by, and the test pins its exact expansion.
 */
export function claudeAllowedTools(servers: readonly McpServerConfig[]): string[] {
  return servers.flatMap((s) => BROWSER_READ_ONLY_TOOLS.map((t) => `mcp__${s.name}__realm-browser__${t}`));
}

/**
 * The BUILT-IN tools an Ask session may run — read and search, and nothing that changes anything.
 *
 * An allow-list, never a deny-list. Ask's whole value is that it is enforced, and a deny-list fails
 * open: the next tool the CLI ships, and every tool of every MCP server a space adds, would be
 * allowed by default until somebody remembered to name it.
 *
 * `Bash` is absent and that is the point. Nothing can decide from a command string whether it
 * mutates — `git log` and `git reset --hard` are the same shape, and a shell can write a file
 * through a hundred spellings. Guessing is exactly the lie this mode exists to avoid, and Cursor's
 * own `ask` mode draws the line in the same place: "no edits or command execution".
 *
 * `Task` is absent for the same fail-closed reason: whether the SDK routes a subagent's tool calls
 * back through this `canUseTool` is not something Realm can assert from the published types, and a
 * subagent that edits is an edit.
 *
 * `TodoWrite` and `AskUserQuestion` are in: one writes the agent's own checklist and the other asks
 * the user a question. Neither touches the repo.
 */
const CLAUDE_ASK_BUILTINS = ["Read", "Glob", "Grep", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "AskUserQuestion"] as const;

/**
 * Every tool name an Ask session may run, for a session with these MCP servers.
 *
 * The MCP half is `claudeAllowedTools` itself rather than a second list: those are the read-only
 * `realm-browser` tools, they are already pre-allowed for every session, and deriving them here
 * means Ask can never disagree with what the rest of the adapter calls read-only.
 */
export function claudeAskTools(servers: readonly McpServerConfig[]): Set<string> {
  return new Set<string>([...CLAUDE_ASK_BUILTINS, ...claudeAllowedTools(servers)]);
}

/**
 * Realm's mode onto the SDK's `PermissionMode`, whose union is
 * `default | acceptEdits | bypassPermissions | plan | dontAsk | auto` and has no "ask".
 *
 * Ask becomes `default` because that is the mode under which `canUseTool` is consulted for every
 * call, and `canUseTool` is where Ask is enforced. `acceptEdits` and `bypassPermissions` let calls
 * through without asking, so sending either would hand the mode's one gate its own bypass.
 */
export function claudeSdkPermissionMode(mode: string | null | undefined): string {
  return mode === ASK_PERMISSION_MODE || !mode ? "default" : mode;
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
    const pending = new Map<string, { resolve: (r: PermissionResult) => void; suggestions: PermissionUpdate[]; input: Record<string, unknown> }>();
    const abort = new AbortController();
    const mapper = createSdkMapper();
    const stderrTail: string[] = [];
    let q: Query | null = null;
    // Tracked rather than read off `options`, because Ask has to hold on a LIVE session: the mode can
    // change mid-turn and `Options` is only ever read at start.
    let permissionMode = opts.permissionMode ?? "default";
    const askTools = claudeAskTools(opts.mcpServers);
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

    // `answers` (AskUserQuestion) rides back as `updatedInput`: the SDK reads the user's choices off the
    // tool's own arguments, so answering a question IS allowing the call with the answers filled in.
    const resolvePermission = (requestId: string, d: PermissionDecision, answers?: Record<string, string>) => {
      const p = pending.get(requestId); if (!p) return;
      pending.delete(requestId);
      events.push(sessionEvent("permission_response", { requestId, decision: d, ...(answers ? { answers } : {}) }));
      if (d === "deny") p.resolve({ behavior: "deny", message: "User denied" });
      else if (d === "allow_always") p.resolve({ behavior: "allow", updatedPermissions: p.suggestions });
      else p.resolve({ behavior: "allow", ...(answers ? { updatedInput: { ...p.input, answers } } : {}) });
    };
    const denyAllPending = () => { for (const id of [...pending.keys()]) resolvePermission(id, "deny"); };

    // Several tools may ask at once (parallel tool calls): status flips to waiting_permission on the first open request
    // and back only when the last one is answered.
    const canUseTool: NonNullable<Options["canUseTool"]> = async (toolName, toolInput, o) => {
      // Ask, enforced: refused here, before the tool runs, and never put to the user — a prompt the
      // user could answer "allow" to would make the mode advisory. The message names what IS
      // available, so the model re-plans within the mode instead of retrying the same call.
      if (permissionMode === ASK_PERMISSION_MODE && !askTools.has(toolName)) {
        return { behavior: "deny", message: `This session is in Ask mode: read-only. ${toolName} cannot run. Reading, searching (Grep, Glob) and web lookups are available; to change files or run commands, the user has to leave Ask.` };
      }
      const requestId = newId();
      const suggestions = o.suggestions ?? [];
      if (pending.size === 0) events.push(sessionEvent("status", { status: "waiting_permission" }));
      events.push(sessionEvent("permission_request", { requestId, toolName, input: toolInput, title: o.title ?? `Allow ${toolName}?`, suggestions: suggestions as unknown[] }));
      const result = await new Promise<PermissionResult>((resolve) => {
        pending.set(requestId, { resolve, suggestions, input: toolInput as Record<string, unknown> });
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
      permissionMode: claudeSdkPermissionMode(opts.permissionMode) as Options["permissionMode"],
      canUseTool,
      includePartialMessages: true,
      abortController: abort,
      resume: opts.resume ?? undefined,
      systemPrompt: opts.systemContext ? { type: "preset", preset: "claude_code", append: opts.systemContext } : undefined,
      // A RECORD keyed by name, not an array: `sdk.d.ts` `mcpServers?: Record<string, McpServerConfig>`.
      // Some documentation shows an array; disk wins.
      mcpServers: claudeMcpServers(opts.mcpServers) as Options["mcpServers"],
      // Read-only realm-browser tools run without the SDK's own prompt (see claudeAllowedTools —
      // mutating tools stay double-gated on purpose).
      allowedTools: claudeAllowedTools(opts.mcpServers),
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
        // Attachment-only messages (Plan 14 W5): the Messages API rejects an empty text block, so one
        // is only included when there is text. Images can carry a message alone — but a send whose
        // attachments were ALL skipped above (Claude ignores non-images) would be literally empty
        // content, which the API also rejects; the minimal honest stub says what the user did. The
        // prompter's send-gate refuses that combination up front, so this is the wire-level net.
        const content: Array<Record<string, unknown>> = [...(text ? [{ type: "text", text }] : []), ...images];
        if (content.length === 0) content.push({ type: "text", text: "(attached files)" });
        input.push({ type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage);
      },
      respondPermission: resolvePermission,
      interrupt: async () => {
        denyAllPending();
        try { await q?.interrupt(); } catch { /* process may already be gone; result/ended will report */ }
      },
      setOptions: async (o) => {
        if (o.model) await q?.setModel(o.model);
        if (o.permissionMode) {
          // Realm's own record moves FIRST: it is what the gate above reads, and it must hold even
          // if the SDK call throws.
          permissionMode = o.permissionMode;
          await q?.setPermissionMode(claudeSdkPermissionMode(o.permissionMode) as never);
        }
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
