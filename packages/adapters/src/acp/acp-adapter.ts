import { basename, dirname, join, resolve, sep } from "node:path";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { sessionEvent, type AgentKind, type SessionEvent } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import { JsonRpcCallError, StdioJsonRpc, withTimeout, type JsonRpcId } from "../jsonrpc/stdio";
import { createAcpMapper } from "./map-acp";
import { probeAcp } from "./probe";
import { selectMcpServers } from "../mcp-transport";
import type { AgentAdapter, AgentHandle, McpServerConfig, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";

type Bag = Record<string, unknown>;
const obj = (v: unknown): Bag => (v && typeof v === "object" ? (v as Bag) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One registered ACP agent. The class is generic; a spec is what makes it Cursor or Gemini. */
export type AcpAgentSpec = {
  kind: AgentKind;
  bin: string;
  args: string[];
  /** Human name for error copy — "Cursor", "Gemini". */
  label: string;
  /** What the user should run out of band to log in — Realm never calls `authenticate` itself (§2.2). */
  loginHint: string;
  env?: Record<string, string>;
  /** Overridable for tests. Bounds every boot call: initialize, session/new and session/load. */
  bootTimeoutMs?: number;
};

/** Copies ClaudeAdapter: app quit awaits every dispose(), so no dispose may depend on a healthy child. */
const DISPOSE_TIMEOUT_MS = 3000;
/** `initialize` is a local handshake. */
const INITIALIZE_TIMEOUT_MS = 10_000;
/** `session/new`/`session/load` can go to the network — Cursor signs in and spins up session services here. */
const SESSION_TIMEOUT_MS = 30_000;

/** `RequestError.authRequired`. Gemini uses it on `session/new`; Cursor returns a generic -32603 instead (§7). */
const AUTH_REQUIRED = -32000;

/**
 * `PermissionOption.kind`s Realm will accept for a decision, most preferred first.
 *
 * `optionId`s are agent-defined strings (§4), so the only stable thing to match on is `kind`.
 */
const OPTION_PREFERENCES: Record<PermissionDecision, readonly string[]> = {
  allow: ["allow_once", "allow_always"],
  allow_always: ["allow_always", "allow_once"],
  deny: ["reject_once", "reject_always"],
};

/**
 * Picks the `optionId` to echo back for `decision`, or `null` when the agent offered nothing that means it.
 *
 * `null` is answered with `{outcome:{outcome:"cancelled"}}` by the caller. There is deliberately no fallback to
 * `options[0]`: on an allow-only list that would turn a user's *deny* into running the tool call.
 */
export function pickAcpOption(decision: PermissionDecision, options: readonly unknown[]): string | null {
  const offered = options.map(obj).filter((o) => typeof o.optionId === "string");
  for (const kind of OPTION_PREFERENCES[decision]) {
    const hit = offered.find((o) => o.kind === kind);
    if (hit) return str(hit.optionId);
  }
  return null;
}

/**
 * `StartOptions.skills` is deliberately unread here, and there is no TODO attached to it.
 *
 * ACP `session/new` is `{cwd, mcpServers}` and nothing else, `cursor-agent acp` accepts no flags of its
 * own, and no `CURSOR_SKILLS*` env var exists. Cursor's one filesystem route — picking up other agents'
 * skill directories — is gated behind a server-side predicate Realm can neither read nor set, and it
 * returned different answers on different runs of the same binary (research §1.1.3). A skills path built
 * on that would work for some users and silently not for others, which is worse than not having one.
 * `AGENT_SKILL_SUPPORT` says `unsupported` for both ACP kinds so the UI can say so out loud.
 */

/**
 * `McpServer[]` for `session/new` / `session/load` (§2.3).
 *
 * Two shapes, and the difference between them is not cosmetic:
 *
 *   - stdio — `{name, command, args, env}` with **`env` an ARRAY of `{name,value}` pairs, not a record**,
 *     and both `args` and `env` required. Cursor validates with zod *before* its own more lenient
 *     normalizer runs, so a record here is rejected `invalid_union` and `session/new` fails outright.
 *   - http / sse — `{type, name, url, headers}`, with `headers` the same array-of-pairs shape.
 *
 * The stdio variant carries no `type` discriminant; the remote ones do. Sending `type: "stdio"` is not
 * part of 0.4.5's union.
 */
export function acpMcpServers(
  kind: AgentKind,
  servers: readonly McpServerConfig[],
  /** `initialize`'s `agentCapabilities.mcpCapabilities`, verbatim. Both installed agents advertise
   *  `{http:true,sse:true}`, but the field is optional in 0.4.5 and an agent that omits it is telling
   *  Realm it takes stdio only — believing the static table over the handshake is how a session ends up
   *  rejected at `session/new` for a server the agent never claimed to support. */
  advertised: { http?: unknown; sse?: unknown } = { http: true, sse: true },
  onLog?: (line: string) => void,
): Bag[] {
  const pairs = (m: Record<string, string>): Bag[] => Object.entries(m).map(([name, value]) => ({ name, value }));
  const usable = selectMcpServers(kind, servers, onLog).filter((s) => {
    if (s.transport === "stdio" || advertised[s.transport] === true) return true;
    onLog?.(`[mcp] skipping "${s.name}": this build did not advertise mcpCapabilities.${s.transport}`);
    return false;
  });
  return usable.map((s) =>
    s.transport === "stdio"
      ? { name: s.name, command: s.command, args: s.args, env: pairs(s.env) }
      : { type: s.transport, name: s.name, url: s.url, headers: pairs(s.headers) });
}

/** User-visible copy for the stop reasons that are outcomes rather than plain completions (§3). */
const STOP_REASON_ERRORS: Record<string, string> = {
  refusal: "the agent refused to continue this turn",
  max_tokens: "the turn stopped early: the agent hit its maximum token count",
  max_turn_requests: "the turn stopped early: the agent hit its maximum number of model requests",
};

/** `null` for `end_turn` and `cancelled` — both are normal endings, not failures. */
export function stopReasonError(stopReason: string): string | null {
  return STOP_REASON_ERRORS[stopReason] ?? null;
}

/** `fs/read_text_file`'s optional window: `line` is 1-based, `limit` is a line count (§5). */
export function sliceLines(content: string, line: unknown, limit: unknown): string {
  const from = num(line);
  const count = num(limit);
  if (from === null && count === null) return content;
  const lines = content.split("\n");
  const start = from === null ? 0 : Math.max(0, from - 1);
  return lines.slice(start, count === null ? undefined : start + count).join("\n");
}

/** Cap on `fs/read_text_file`: the content crosses a JSON-RPC frame and lands in the model's context. */
export const MAX_FS_READ_BYTES = 10 * 1024 * 1024;

/**
 * `realpath` for a path whose tail may not exist yet: resolves the deepest ancestor that does, then re-attaches
 * the missing segments. A plain `realpath` throws ENOENT for a not-yet-created write target.
 */
async function realpathOfDeepestExisting(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try { return join(await realpath(cur), ...tail); }
    catch { /* does not exist yet — keep walking up */ }
    const parent = dirname(cur);
    if (parent === cur) return p; // ran out of ancestors; nothing left to resolve
    tail.unshift(basename(cur));
    cur = parent;
  }
}

/**
 * Resolves `target` for the session rooted at `root`, and refuses anything that escapes it.
 *
 * §5 is right that declaring `fs:false` would not remove the capability — the agent just does its own disk I/O.
 * But that cuts the other way for containment: confining *our* handlers costs a well-behaved agent nothing (it
 * falls back to that same I/O) and stops Realm from being the instrument of an unconstrained read of
 * `~/.ssh/id_rsa` or write to `~/.zshrc`, neither of which ever reaches a permission card.
 *
 * Both sides are resolved through `realpath` before they are compared, so a symlink inside the session
 * directory cannot point out of it — and neither side may be compared literally, because on macOS the session
 * cwd itself routinely arrives as a symlinked `/var/...` path for a real `/private/var/...` one.
 *
 * The caller reports a missing file: this returns a resolved path, not the promise that anything is there.
 */
export async function containedPath(root: string, target: string): Promise<string> {
  const rootReal = await realpath(root);
  // An absolute target is kept as-is; a relative one starts at the session directory.
  const real = await realpathOfDeepestExisting(resolve(rootReal, target));
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error(`${target} is outside this session's working directory`);
  }
  return real;
}

/**
 * Copy for a `session/new`/`session/load` rejection.
 *
 * Cursor returns a generic `-32603 Internal error` for *any* startup failure and hides the real reason in
 * `data` (§7), so the data is echoed verbatim and the login hint is appended whatever the code — the user
 * cannot be told apart "not logged in" from "bad cwd" by the code alone.
 */
export function acpBootFailureMessage(e: unknown, spec: Pick<AcpAgentSpec, "label" | "loginHint">, authMethods: readonly unknown[]): string {
  if (!(e instanceof JsonRpcCallError)) return message(e); // spawn failure, transport death: not a login problem
  const data = obj(e.data);
  const detail = [str(data.message), str(data.details)].filter(Boolean).join(" — ");
  const names = authMethods.map((m) => str(obj(m).name) || str(obj(m).id)).filter(Boolean);
  const head = e.code === AUTH_REQUIRED
    ? `${spec.label} needs you to sign in: ${e.message}`
    : `${spec.label} could not start a session: ${e.message}`;
  return [head, detail, names.length ? `Sign-in methods it offers: ${names.join(", ")}.` : "", spec.loginHint].filter(Boolean).join(" ");
}

/**
 * One generic ACP adapter, instantiated once per registered agent kind.
 *
 * Unlike Codex's multiplexed app-server, an ACP session belongs to its connection, so this spawns **one child
 * per session** and `dispose()` takes that child down.
 */
export class AcpAdapter implements AgentAdapter {
  readonly kind: AgentKind;

  constructor(private readonly spec: AcpAgentSpec) {
    this.kind = spec.kind;
  }

  async probe(): Promise<ProbeResult> {
    return { kind: this.kind, ...(await probeAcp(this.spec.bin)) };
  }

  start(opts: StartOptions): AgentHandle {
    const spec = this.spec;
    const events = new AsyncQueue<SessionEvent>();
    const mapper = createAcpMapper();
    const pending = new Map<string, { id: JsonRpcId; options: unknown[] }>();
    let rpc: StdioJsonRpc | null = null;
    let sessionId: string | null = null;
    let imagesAllowed = false;
    let authMethods: unknown[] = [];
    /** True only for the duration of `session/load`, whose replay Realm has already persisted. */
    let replaying = false;
    let disposed = false;

    const log = (line: string) => opts.onLog?.(`[${spec.kind}] ${line}`);
    const fail = (text: string) => {
      events.push(sessionEvent("error", { message: text }));
      events.push(sessionEvent("status", { status: "error" }));
    };

    const answer = (requestId: string, outcome: Bag): void => {
      const p = pending.get(requestId);
      if (!p) return;
      pending.delete(requestId);
      rpc?.respond(p.id, { outcome });
    };

    const respond = (requestId: string, decision: PermissionDecision) => {
      const p = pending.get(requestId);
      if (!p) return;
      const optionId = pickAcpOption(decision, p.options);
      // No option carries this decision. `cancelled` is the only other legal answer (§4) and is the safe one:
      // it never runs the tool call.
      if (optionId === null) log(`no option matched decision ${decision}; answering cancelled`);
      answer(requestId, optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId });
      events.push(sessionEvent("permission_response", { requestId, decision }));
      // Several tools can be waiting at once; the turn is only unblocked when the last one is answered. The
      // prompt's own resolution is what settles the status back to idle.
      if (pending.size === 0) events.push(sessionEvent("status", { status: "running" }));
    };

    /**
     * §6: every in-flight permission MUST be answered `cancelled` when the turn is cancelled. The transcript
     * still records a decision so the card stops waiting; `deny` is what actually happened to the tool call.
     */
    const cancelAllPending = () => {
      for (const requestId of [...pending.keys()]) {
        answer(requestId, { outcome: "cancelled" });
        events.push(sessionEvent("permission_response", { requestId, decision: "deny" }));
      }
    };

    /** Ends the session and the child. Idempotent; the only path that closes the stream. */
    const shutdown = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      cancelAllPending();
      // The child goes first, and the stream stays open across its death: whatever the agent flushes on its
      // way out still reaches the transcript, and `ended` stays the last event anyone sees.
      await rpc?.dispose();
      for (const e of mapper.flush()) events.push(e);
      for (const e of mapper.closeOpenCalls("session closed")) events.push(e);
      events.push(sessionEvent("status", { status: "ended" }));
      events.close();
    };

    const serveFs = async (id: JsonRpcId, method: string, p: Bag): Promise<void> => {
      const target = str(p.path);
      try {
        if (method === "fs/read_text_file") {
          const path = await containedPath(opts.cwd, target);
          const { size } = await stat(path);
          if (size > MAX_FS_READ_BYTES) throw new Error(`${target} is ${size} bytes, too large to read (limit ${MAX_FS_READ_BYTES})`);
          const content = await readFile(path, "utf8");
          rpc?.respond(id, { content: sliceLines(content, p.line, p.limit) });
        } else {
          const path = await containedPath(opts.cwd, target);
          await writeFile(path, str(p.content), "utf8");
          rpc?.respond(id, {});
        }
      } catch (e) {
        log(`${method} ${target}: ${message(e)}`);
        rpc?.respondError(id, -32603, message(e));
      }
    };

    const requestPermission = (id: JsonRpcId, p: Bag): void => {
      // Nobody is left to answer either of these, so both get `cancelled` — the only other legal answer (§4) —
      // and stay out of the transcript: a replayed request belongs to a turn that finished long ago, and one
      // that arrives while the child is being torn down would leave a card waiting after the session ended.
      if (replaying || disposed) {
        log(`cancelling a permission request raised during ${replaying ? "session/load replay" : "shutdown"}`);
        rpc?.respond(id, { outcome: { outcome: "cancelled" } });
        return;
      }
      const patch = obj(p.toolCall);
      const toolCallId = str(patch.toolCallId);
      // `toolCall` is a ToolCallUpdate: only `toolCallId` is guaranteed (§4), so the card is rendered from the
      // merged call the mapper recorded, with whatever the patch does carry laid over it.
      const merged = mapper.callOf(toolCallId);
      const toolName = str(patch.title) || merged?.title || toolCallId;
      const input = { ...(merged?.input ?? {}), ...obj(patch.rawInput) };
      const options = Array.isArray(p.options) ? p.options : [];
      const requestId = String(id);
      if (pending.size === 0) events.push(sessionEvent("status", { status: "waiting_permission" }));
      pending.set(requestId, { id, options });
      events.push(sessionEvent("permission_request", { requestId, toolName, input, title: toolName, suggestions: options }));
    };

    const boot = (async () => {
      try {
        const transport = new StdioJsonRpc({
          command: spec.bin,
          args: spec.args,
          cwd: opts.cwd,
          env: { ...spec.env, ...opts.env },
          onNotification: ({ method, params }) => {
            if (method !== "session/update" || replaying) return;
            for (const e of mapper.map(obj(params).update)) events.push(e);
          },
          onServerRequest: ({ id, method, params }) => {
            const p = obj(params);
            if (method === "session/request_permission") { requestPermission(id, p); return; }
            if (method === "fs/read_text_file" || method === "fs/write_text_file") { void serveFs(id, method, p); return; }
            // Agents probe for capabilities we never declared (terminal/*), and an unanswered request stalls
            // the turn permanently (§5).
            log(`refusing unsupported client method ${method}`);
            rpc?.respondError(id, -32601, `realm does not support ${method}`);
          },
          onStderr: (line) => log(line),
          onExit: ({ reason, disposed: wasDisposed }) => {
            // `wasDisposed` means Realm took the child down; only an actual crash is an error to report.
            if (!wasDisposed) {
              for (const e of mapper.closeOpenCalls(reason)) events.push(e);
              const tail = rpc?.stderrTail ?? [];
              fail(tail.length ? `${reason}\n--- stderr (last ${tail.length} lines) ---\n${tail.join("\n")}` : reason);
            }
            void shutdown();
          },
        });
        rpc = transport;

        // Bounded: ACP gives none of these calls a deadline, and a child that spawns and then answers nothing
        // would otherwise leave `boot` — and every send()/setOptions()/dispose() behind it — pending for the
        // life of the process.
        const ask = (method: string, params: Bag, fallbackMs: number): Promise<unknown> => {
          const ms = spec.bootTimeoutMs ?? fallbackMs;
          return withTimeout(transport.request(method, params), ms, `${spec.label} did not answer ${method} within ${ms}ms`);
        };

        const init = obj(await ask("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        }, INITIALIZE_TIMEOUT_MS));
        const caps = obj(init.agentCapabilities);
        imagesAllowed = obj(caps.promptCapabilities).image === true;
        authMethods = Array.isArray(init.authMethods) ? init.authMethods : [];
        if (disposed) return;

        const mcpServers = acpMcpServers(spec.kind, opts.mcpServers, obj(caps.mcpCapabilities), log);
        let id: string | null = null;
        let session: Bag = {};
        if (opts.resume && caps.loadSession === true) {
          replaying = true;
          try {
            // The whole prior conversation arrives as session/update notifications before this resolves (§2.3).
            // Realm has already persisted every one of them, so they are dropped rather than appended.
            session = obj(await ask("session/load", { sessionId: opts.resume, cwd: opts.cwd, mcpServers }, SESSION_TIMEOUT_MS));
            id = opts.resume;
          } catch (e) {
            log(`session/load failed (${message(e)}); starting a new session instead`);
          } finally {
            replaying = false;
          }
        }
        if (id === null) {
          session = obj(await ask("session/new", { cwd: opts.cwd, mcpServers }, SESSION_TIMEOUT_MS));
          id = str(session.sessionId);
          if (!id) throw new Error(`${spec.label} did not return a session id`);
        }
        if (disposed) return;
        sessionId = id;
        events.push(sessionEvent("init", {
          providerSessionId: id,
          model: str(obj(session.models).currentModelId) || str(opts.model),
          tools: [],
          cwd: opts.cwd,
        }));
        events.push(sessionEvent("status", { status: "idle" }));
      } catch (e) {
        if (disposed) return;
        fail(acpBootFailureMessage(e, spec, authMethods));
        // SessionService drops the handle when the stream ends and never calls dispose(), so a boot failure
        // has to take its own child down.
        await shutdown();
      }
    })();

    /** `prompt: ContentBlock[]` (§3). Images inline only where the agent accepts them; everything else links. */
    const promptFor = async (m: UserMessage): Promise<Bag[]> => {
      const blocks: Bag[] = [{ type: "text", text: m.text }];
      for (const a of m.attachments) {
        // Cursor reports embeddedContext:false, so a `resource` block is never an option — a link it is.
        const link = { type: "resource_link", uri: `file://${a.path}`, name: basename(a.path), mimeType: a.mime };
        if (!imagesAllowed || !a.mime.startsWith("image/")) { blocks.push(link); continue; }
        try { blocks.push({ type: "image", data: (await readFile(a.path)).toString("base64"), mimeType: a.mime }); }
        catch (e) { log(`could not read ${a.path} (${message(e)}); sending it as a link`); blocks.push(link); }
      }
      return blocks;
    };

    return {
      events,
      send: async (m: UserMessage) => {
        await boot; // boot reports its own failures; it never rejects
        if (disposed || !rpc || !sessionId) { events.push(sessionEvent("error", { message: "session ended" })); return; }
        const prompt = await promptFor(m);
        events.push(sessionEvent("status", { status: "running" }));
        // NOT awaited: session/prompt stays pending for the entire turn, and SessionService.send() — and the
        // WebSocket call behind it — awaits this function. The turn is settled in the background instead.
        void rpc.request("session/prompt", { sessionId, prompt }).then(
          (res) => {
            if (disposed) return;
            for (const e of mapper.flush()) events.push(e);
            const failure = stopReasonError(str(obj(res).stopReason));
            if (failure) events.push(sessionEvent("error", { message: failure }));
            events.push(sessionEvent("status", { status: "idle" }));
          },
          (e) => {
            if (disposed) return; // the exit handler already reported why the turn died
            for (const e of mapper.flush()) events.push(e);
            events.push(sessionEvent("error", { message: message(e) }));
            events.push(sessionEvent("status", { status: "idle" }));
          },
        );
      },
      respondPermission: respond,
      interrupt: async () => {
        cancelAllPending();
        if (!rpc || !sessionId) return;
        // A notification, not a request (§6). The connection stays up: the agent flushes its remaining updates
        // and still resolves the prompt with stopReason "cancelled", which is what returns the session to idle.
        rpc.notify("session/cancel", { sessionId });
      },
      setOptions: async (o) => {
        await boot;
        if (!rpc || !sessionId) return;
        const attempt = async (method: string, params: Bag) => {
          // Both calls are optional in ACP 0.4.5 (set_model is flagged unstable), so a rejection is a log line.
          try { await rpc!.request(method, params); }
          catch (e) { log(`${method} failed: ${message(e)}`); }
        };
        if (o.permissionMode !== undefined) await attempt("session/set_mode", { sessionId, modeId: o.permissionMode });
        if (o.model !== undefined) await attempt("session/set_model", { sessionId, modelId: o.model });
      },
      dispose: async () => {
        // Waiting for boot keeps a dispose that raced it from tearing down a half-open connection — but the
        // wait is bounded, because SessionService.closeAll() -> App.close() -> app quit is what is behind it.
        // An unbounded wait here is how the desktop main process ends up SIGTERMing a server that still owns
        // live agent children. shutdown() closes the transport either way: `rpc` is assigned before the
        // handshake, so the child dies even when the timeout is what got us here.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([boot, new Promise<void>((res) => { timer = setTimeout(res, DISPOSE_TIMEOUT_MS); })]);
        clearTimeout(timer);
        await shutdown();
      },
    };
  }
}
