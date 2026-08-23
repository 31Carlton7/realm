import { sessionEvent, type SessionEvent } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import { JsonRpcCallError, type JsonRpcId } from "../jsonrpc/stdio";
import { CodexConnection, type ThreadListener } from "./connection";
import { createCodexMapper } from "./map-codex";
import { probeCodex } from "./probe";
import type { AgentAdapter, AgentHandle, McpStdioConfig, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";

type Bag = Record<string, unknown>;
const obj = (v: unknown): Bag => (v && typeof v === "object" ? (v as Bag) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const APPROVAL_METHODS: Record<string, { toolName: string; title: string }> = {
  "item/commandExecution/requestApproval": { toolName: "exec_command", title: "Run this command?" },
  "item/fileChange/requestApproval": { toolName: "apply_patch", title: "Apply these edits?" },
};

/**
 * Codex decisions Realm will send, most preferred first.
 *
 * The live capture offered `["accept", {acceptWithExecpolicyAmendment:…}, "cancel"]` — with **no `"decline"`**,
 * even though the generated bindings list it. Sending a decision the server did not offer fails the request and
 * wedges the turn, so the wire list wins and these are only a preference order over it.
 */
const DECISION_PREFERENCES: Record<PermissionDecision, readonly string[]> = {
  allow: ["accept"],
  allow_always: ["acceptForSession", "accept"],
  deny: ["decline", "cancel"],
};

/**
 * Picks the first offered decision from the preference list for `decision`.
 *
 * `availableDecisions` comes straight off the wire and may contain objects (`{acceptWithExecpolicyAmendment}`) —
 * only string variants are candidates. When nothing matches (or the server sent no list at all) the *last*
 * preference is used, which is the most conservative one: a deny can never degrade into an accept.
 */
export function pickCodexDecision(decision: PermissionDecision, availableDecisions: readonly unknown[]): string {
  const prefs = DECISION_PREFERENCES[decision];
  const offered = new Set(availableDecisions.filter((d): d is string => typeof d === "string"));
  return prefs.find((p) => offered.has(p)) ?? prefs[prefs.length - 1]!;
}

/** Realm's permission modes onto Codex's two independent knobs. Both are `thread/start` params. */
export function codexPolicyFor(permissionMode: string | undefined): { approvalPolicy: string; sandbox: string } {
  if (permissionMode === "plan") return { approvalPolicy: "untrusted", sandbox: "read-only" };
  if (permissionMode === "bypassPermissions") return { approvalPolicy: "never", sandbox: "danger-full-access" };
  return { approvalPolicy: "on-request", sandbox: "workspace-write" };
}

function mcpConfig(servers: McpStdioConfig[]): Bag | undefined {
  if (servers.length === 0) return undefined;
  const entries = servers.map((s) => [s.name, { command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) }] as const);
  return { mcp_servers: Object.fromEntries(entries) };
}

/** `thread/start` rejects a stale login here, long after `initialize` and `codex login status` both said fine. */
function bootFailureMessage(e: unknown): string {
  if (e instanceof JsonRpcCallError && obj(e.data).action === "relogin") {
    return `${e.message} — your Codex login has expired or was revoked. Run \`codex login\` in a terminal, then send the message again.`;
  }
  return message(e);
}

/**
 * Codex adapter over one shared `codex app-server` process.
 *
 * The protocol multiplexes any number of threads on a single process (protocol reference §8 gotcha 4), so the
 * adapter refcounts one `CodexConnection` across all its sessions instead of spawning one per session; the last
 * `dispose()` takes the process down.
 */
export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  private readonly bin?: string;
  private readonly args?: string[];
  private conn: Promise<CodexConnection> | null = null;
  private refs = 0;

  constructor(deps: { bin?: string; args?: string[] } = {}) {
    this.bin = deps.bin;
    this.args = deps.args;
  }

  /** Visible for tests: 0 or 1 — the whole point of the refcount is that it never exceeds one. */
  get processCount(): number { return this.conn === null ? 0 : 1; }
  /** Visible for tests: sessions currently holding the process. A leak here strands the child forever. */
  get sessionCount(): number { return this.refs; }

  async probe(): Promise<ProbeResult> {
    const p = await probeCodex(this.bin);
    return { kind: this.kind, ...p };
  }

  /**
   * `cwd`/`env`/`onLog` only shape the process the *first* session spawns; every later session rides the same
   * one and carries its own `cwd` on `thread/start`, which is the value that actually matters.
   */
  private async acquire(opts: StartOptions): Promise<CodexConnection> {
    this.refs += 1;
    const pending = this.conn ?? (this.conn = CodexConnection.open({
      bin: this.bin ?? process.env.REALM_CODEX_BIN ?? "codex",
      args: this.args,
      cwd: opts.cwd,
      env: opts.env,
      onLog: opts.onLog,
    }));
    try {
      return await pending;
    } catch (e) {
      // A failed open must not pin the refcount (nothing will ever call release for it) nor cache the rejected
      // promise, or every later session in this process inherits the same failure.
      this.refs -= 1;
      if (this.conn === pending) this.conn = null;
      throw e;
    }
  }

  private async release(): Promise<void> {
    this.refs -= 1;
    if (this.refs > 0) return;
    const pending = this.conn;
    this.conn = null;
    if (!pending) return;
    try { await (await pending).dispose(); } catch { /* open() already tore down its own child */ }
  }

  start(opts: StartOptions): AgentHandle {
    const events = new AsyncQueue<SessionEvent>();
    const mapper = createCodexMapper();
    const pending = new Map<string, { id: JsonRpcId; decisions: unknown[] }>();
    let conn: CodexConnection | null = null;
    let threadId: string | null = null;
    let activeTurnId: string | null = null;
    let running = false;
    let acquired = false;
    let disposed = false;

    const fail = (text: string) => {
      events.push(sessionEvent("error", { message: text }));
      events.push(sessionEvent("status", { status: "error" }));
    };

    const respond = (requestId: string, decision: PermissionDecision) => {
      const p = pending.get(requestId);
      if (!p) return;
      pending.delete(requestId);
      conn?.respond(p.id, { decision: pickCodexDecision(decision, p.decisions) });
      events.push(sessionEvent("permission_response", { requestId, decision }));
      // Several tools can be waiting at once (parallel tool calls): the status only comes back when the last
      // one is answered.
      if (pending.size === 0) events.push(sessionEvent("status", { status: running ? "running" : "idle" }));
    };
    const denyAllPending = () => { for (const id of [...pending.keys()]) respond(id, "deny"); };

    /** Detaches, closes the transcript and hands the process back. Idempotent; the only path that ends a session. */
    const shutdown = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      denyAllPending();
      if (conn && threadId) conn.detach(threadId);
      for (const e of mapper.closeOpenTools("session closed")) events.push(e);
      events.push(sessionEvent("status", { status: "ended" }));
      events.close();
      if (acquired) { acquired = false; await this.release(); }
    };

    const listener: ThreadListener = {
      onNotification: (method, params) => {
        const p = obj(params);
        if (method === "turn/started") { activeTurnId = str(obj(p.turn).id) || activeTurnId; running = true; }
        if (method === "turn/completed") { activeTurnId = null; running = false; }
        for (const e of mapper.map(method, params)) events.push(e);
      },
      onServerRequest: (id, method, params) => {
        const approval = APPROVAL_METHODS[method];
        if (!approval) {
          // Every server request must be answered or the turn stalls forever (protocol reference §9).
          opts.onLog?.(`[codex] refusing unsupported server request ${method}`);
          conn?.respondError(id, -32601, `realm does not support ${method}`);
          return;
        }
        const p = obj(params);
        const requestId = String(id);
        const input = approval.toolName === "exec_command"
          ? { command: str(p.command), cwd: str(p.cwd) }
          : { itemId: str(p.itemId), grantRoot: p.grantRoot ?? null };
        const decisions = Array.isArray(p.availableDecisions) ? p.availableDecisions : [];
        if (pending.size === 0) events.push(sessionEvent("status", { status: "waiting_permission" }));
        pending.set(requestId, { id, decisions });
        events.push(sessionEvent("permission_request", { requestId, toolName: approval.toolName, input, title: str(p.reason) || approval.title, suggestions: decisions }));
      },
      onGone: (reason, wasDisposed) => {
        // `wasDisposed` means Realm shut the process down (app quit, last session closed). Only an actual crash
        // is an error; reporting the quiet path would spray "codex app-server exited" over every open session.
        if (!wasDisposed) {
          for (const e of mapper.closeOpenTools(reason)) events.push(e);
          const tail = conn?.stderrTail ?? [];
          fail(tail.length ? `${reason}\n--- stderr (last ${tail.length} lines) ---\n${tail.join("\n")}` : reason);
        }
        void shutdown();
      },
    };

    const boot = (async () => {
      try {
        const c = await this.acquire(opts);
        acquired = true;
        if (disposed) return; // disposed while the process was still coming up; shutdown() releases the ref
        conn = c;
        const { approvalPolicy, sandbox } = codexPolicyFor(opts.permissionMode);
        const config = mcpConfig(opts.mcpServers);
        const common = {
          cwd: opts.cwd,
          approvalPolicy,
          sandbox, // a SandboxMode STRING here; the structured object is turn/start's `sandboxPolicy` (§8 gotcha 5)
          ...(opts.model ? { model: opts.model } : {}),
          ...(config ? { config } : {}),
        };
        const res = obj(opts.resume
          ? await c.request("thread/resume", { threadId: opts.resume, ...common })
          : await c.request("thread/start", { ...common, sessionStartSource: "startup" }));
        if (disposed) return;
        const id = str(obj(res.thread).id) || str(opts.resume);
        if (!id) throw new Error("codex did not return a thread id");
        threadId = id;
        c.attach(id, listener);
        events.push(sessionEvent("init", { providerSessionId: id, model: str(res.model) || str(opts.model), tools: [], cwd: str(res.cwd) || opts.cwd }));
        events.push(sessionEvent("status", { status: "idle" }));
      } catch (e) {
        if (disposed) return;
        fail(bootFailureMessage(e));
        // SessionService drops the handle when the stream ends and never calls dispose(), so the boot failure
        // has to hand the process back itself.
        await shutdown();
      }
    })();

    const inputFor = (m: UserMessage): Bag[] => {
      const images = m.attachments.filter((a) => a.mime.startsWith("image/"));
      const files = m.attachments.filter((a) => !a.mime.startsWith("image/"));
      // Codex reads local images off disk, so no base64. Anything else is named in the text and left for the
      // agent to open with its own tools.
      const text = files.length ? `${m.text}\n\nAttached files:\n${files.map((a) => `- ${a.path}`).join("\n")}` : m.text;
      return [{ type: "text", text, text_elements: [] }, ...images.map((a) => ({ type: "localImage", path: a.path }))];
    };

    return {
      events,
      send: async (m: UserMessage) => {
        await boot; // boot reports its own failures; it never rejects
        if (disposed || !conn || !threadId) { events.push(sessionEvent("error", { message: "session ended" })); return; }
        const input = inputFor(m);
        running = true;
        events.push(sessionEvent("status", { status: "running" }));
        try {
          if (activeTurnId) {
            try {
              const steered = obj(await conn.request("turn/steer", { threadId, expectedTurnId: activeTurnId, input }));
              activeTurnId = str(steered.turnId) || activeTurnId;
              return;
            } catch (e) {
              // The turn ended between the check and the call; `expectedTurnId` is a precondition, so this is
              // a race, not a failure. Retried once as a fresh turn — never in a loop.
              if (!(e instanceof JsonRpcCallError) || !/no active turn/i.test(e.message)) throw e;
              activeTurnId = null;
            }
          }
          const started = obj(await conn.request("turn/start", { threadId, input }));
          activeTurnId = str(obj(started.turn).id) || null;
        } catch (e) {
          running = false;
          events.push(sessionEvent("error", { message: message(e) }));
          events.push(sessionEvent("status", { status: "idle" }));
        }
      },
      respondPermission: respond,
      interrupt: async () => {
        denyAllPending();
        if (!conn || !threadId || !activeTurnId) return;
        try { await conn.request("turn/interrupt", { threadId, turnId: activeTurnId }); }
        catch (e) { opts.onLog?.(`[codex] interrupt failed: ${message(e)}`); }
      },
      /**
       * Known limitation: `model` and `approvalPolicy` are `thread/start` parameters and cannot be applied to a
       * running Codex thread — there is no protocol call for it. So this only reports the change. SessionService
       * has already persisted it to the session row, which is what the next `start()` reads, so the change takes
       * effect the next time this session starts a thread.
       */
      setOptions: async (o) => {
        const parts = [o.model === undefined ? null : `model=${o.model}`, o.permissionMode === undefined ? null : `permissionMode=${o.permissionMode}`].filter(Boolean);
        if (parts.length === 0) return;
        opts.onLog?.(`[codex] ${parts.join(" ")} recorded; codex fixes these at thread start, so it applies the next time this session starts`);
      },
      dispose: async () => {
        await boot; // never leave a half-attached thread behind a dispose that raced the boot
        await shutdown();
      },
    };
  }
}
