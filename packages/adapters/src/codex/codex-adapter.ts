import { sessionEvent, type SessionEvent } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import { JsonRpcCallError, type JsonRpcId } from "../jsonrpc/stdio";
import { CodexConnection, type ThreadListener } from "./connection";
import { createCodexMapper } from "./map-codex";
import { probeCodex } from "./probe";
import type { AgentAdapter, AgentHandle, McpServerConfig, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";

type Bag = Record<string, unknown>;
const obj = (v: unknown): Bag => (v && typeof v === "object" ? (v as Bag) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Copies ClaudeAdapter: app quit awaits every dispose(), so no dispose may depend on a healthy child. */
const DISPOSE_TIMEOUT_MS = 3000;
/** thread/start loads config, resolves the model and checks auth — slower than initialize, never unbounded. */
const BOOT_TIMEOUT_MS = 30_000;
/** `skills/extraRoots/set` only rescans a couple of directories, and nothing about the session depends on
 *  its answer — so it gets a short leash rather than the boot budget. */
const EXTRA_ROOTS_TIMEOUT_MS = 10_000;
/** JSON-RPC "method not found": the signal that this codex build predates `skills/extraRoots/set`. */
const METHOD_NOT_FOUND = -32601;

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

/**
 * `thread/start` `config.mcp_servers` — a `[mcp_servers.NAME]` table per server, for this thread only.
 *
 * Codex's `RawMcpServerConfig` is one struct covering both shapes: `command`/`args`/`env` for a stdio
 * server, `url`/`http_headers` for a streamable-HTTP one. There is no SSE variant, but that no longer
 * matters here: since Plan 9 W3 `servers` is always exactly the gateway's own `http` entry (or empty) —
 * Codex takes `http` fine, and no third-party server's real transport ever reaches this function.
 *
 * `undefined` when nothing survives, so `config` is omitted entirely rather than sent as an empty map:
 * `thread/start` does not validate `config` keys (research §1.2), so an empty one is accepted in
 * silence and there is no reason to send it.
 */
export function codexMcpConfig(servers: readonly McpServerConfig[]): Bag | undefined {
  if (servers.length === 0) return undefined;
  const entries = servers.map((s) => [
    s.name,
    s.transport === "stdio"
      ? { command: s.command, ...(s.args.length ? { args: s.args } : {}), ...(Object.keys(s.env).length ? { env: s.env } : {}) }
      : { url: s.url, ...(Object.keys(s.headers).length ? { http_headers: s.headers } : {}) },
  ] as const);
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
  /** Overridable for tests. Bounds every boot call: initialize, thread/start and thread/resume. */
  private readonly bootTimeoutMs?: number;
  private conn: Promise<CodexConnection> | null = null;
  private refs = 0;
  /**
   * Skills roots contributed by live sessions, refcounted by root.
   *
   * `skills/extraRoots/set` takes `{ extraRoots }` and **no `threadId`** — it is per-connection, and
   * CodexAdapter deliberately shares one `codex app-server` across every Realm session. So the roots of
   * every live session are unioned and the whole set is re-sent on each change; a Work space and a School
   * space with different skills enabled will each see both sets in Codex. That is the documented trade
   * (research §2) — the alternative is a process per space, which loses the refcount this class exists for.
   */
  private readonly extraRoots = new Map<string, number>();
  /**
   * Feature detection, sticky per adapter. This machine runs a codex preview ahead of the public release;
   * an older binary answers `skills/extraRoots/set` with -32601 and must degrade to "Codex sees no Realm
   * skills", never throw and never fail a session.
   */
  private extraRootsSupported = true;

  constructor(deps: { bin?: string; args?: string[]; bootTimeoutMs?: number } = {}) {
    this.bin = deps.bin;
    this.args = deps.args;
    this.bootTimeoutMs = deps.bootTimeoutMs;
  }

  /** Visible for tests: 0 or 1 — the whole point of the refcount is that it never exceeds one. */
  get processCount(): number { return this.conn === null ? 0 : 1; }
  /** Visible for tests: sessions currently holding the process. A leak here strands the child forever. */
  get sessionCount(): number { return this.refs; }
  /**
   * Visible for tests: the shared process itself, once a session has acquired it. Lets tests assert what the
   * refcount alone cannot — that the child is really dead, that a disposed session really detached, and how a
   * still-attached session reacts when the process is deliberately torn down under it.
   */
  get connection(): Promise<CodexConnection> | null { return this.conn; }

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
      initializeTimeoutMs: this.bootTimeoutMs,
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

  /** Visible for tests: the roots currently unioned onto the shared connection. */
  get extraRootCount(): number { return this.extraRoots.size; }
  /** Visible for tests: false once a codex build has answered -32601 to `skills/extraRoots/set`. */
  get skillsSupported(): boolean { return this.extraRootsSupported; }

  /**
   * Re-sends the union to the shared connection. Never throws and never rejects: a skills root that does
   * not land is a session with fewer skills, not a session that failed to start — and this is awaited on
   * the boot path, where a throw would be reported to the user as a dead agent.
   */
  private async syncExtraRoots(conn: CodexConnection, onLog?: (line: string) => void): Promise<void> {
    if (!this.extraRootsSupported) return;
    try {
      await conn.request("skills/extraRoots/set", { extraRoots: [...this.extraRoots.keys()] }, EXTRA_ROOTS_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof JsonRpcCallError && e.code === METHOD_NOT_FOUND) {
        this.extraRootsSupported = false;
        onLog?.("[codex] this codex build has no skills/extraRoots/set; Realm skills will not be visible to Codex");
        return;
      }
      onLog?.(`[codex] skills/extraRoots/set failed: ${message(e)}`);
    }
  }

  private async addExtraRoot(conn: CodexConnection, root: string, onLog?: (line: string) => void): Promise<void> {
    this.extraRoots.set(root, (this.extraRoots.get(root) ?? 0) + 1);
    await this.syncExtraRoots(conn, onLog);
  }

  private async dropExtraRoot(conn: CodexConnection, root: string, onLog?: (line: string) => void): Promise<void> {
    const next = (this.extraRoots.get(root) ?? 0) - 1;
    if (next > 0) this.extraRoots.set(root, next);
    else this.extraRoots.delete(root);
    await this.syncExtraRoots(conn, onLog);
  }

  private async release(): Promise<void> {
    this.refs -= 1;
    if (this.refs > 0) return;
    const pending = this.conn;
    this.conn = null;
    // The roots live on the connection, not on the adapter: a later session gets a fresh process that has
    // never been told anything, so a leftover entry here would make syncExtraRoots think it already had.
    this.extraRoots.clear();
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
    let acquired = false;
    let released = false;
    let disposed = false;
    /** Set only once this session's root is counted into the union, so shutdown drops exactly what boot added. */
    let ownedRoot: string | null = null;

    const fail = (text: string) => {
      events.push(sessionEvent("error", { message: text }));
      events.push(sessionEvent("status", { status: "error" }));
    };

    /**
     * Hands the shared process back exactly once.
     *
     * `acquire()` takes the ref synchronously inside `start()`, but this closure only learns it succeeded when
     * the open resolves — and dispose() no longer waits for that. So whichever of shutdown() and boot gets here
     * once `acquired` is set is the one that releases; the other is a no-op.
     */
    const releaseOnce = async (): Promise<void> => {
      if (!acquired || released) return;
      released = true;
      await this.release();
    };

    const respond = (requestId: string, decision: PermissionDecision) => {
      const p = pending.get(requestId);
      if (!p) return;
      pending.delete(requestId);
      conn?.respond(p.id, { decision: pickCodexDecision(decision, p.decisions) });
      events.push(sessionEvent("permission_response", { requestId, decision }));
      // Several tools can be waiting at once (parallel tool calls): the status only comes back when the last
      // one is answered. An approval only exists inside a live turn, so that status is always `running`; the
      // turn's own `turn/completed` is what settles it back to idle.
      if (pending.size === 0) events.push(sessionEvent("status", { status: "running" }));
    };
    const denyAllPending = () => { for (const id of [...pending.keys()]) respond(id, "deny"); };

    /** Detaches, closes the transcript and hands the process back. Idempotent; the only path that ends a session. */
    const shutdown = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      denyAllPending();
      if (conn && threadId) conn.detach(threadId);
      // Before releasing: the process may be about to go, but while other sessions still hold it their
      // union must stop including a root this session is no longer entitled to.
      if (conn && ownedRoot) { const r = ownedRoot; ownedRoot = null; await this.dropExtraRoot(conn, r, opts.onLog); }
      for (const e of mapper.closeOpenTools("session closed")) events.push(e);
      events.push(sessionEvent("status", { status: "ended" }));
      events.close();
      await releaseOnce();
    };

    const listener: ThreadListener = {
      onNotification: (method, params) => {
        const p = obj(params);
        // thread/resume rejoins a turn that is already running, and its response carries no turn id — this
        // notification is the only place a rejoined session learns one.
        if (method === "turn/started") activeTurnId = str(obj(p.turn).id) || activeTurnId;
        if (method === "turn/completed") activeTurnId = null;
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
        // Disposed while the process was still coming up. shutdown() has already run and found nothing to hand
        // back (it no longer waits for a boot that may never settle), so the ref is returned here instead.
        if (disposed) { await releaseOnce(); return; }
        conn = c;
        const { approvalPolicy, sandbox } = codexPolicyFor(opts.permissionMode);
        const config = codexMcpConfig(opts.mcpServers);
        // `opts.effort` is deliberately dropped: Codex takes reasoning effort per turn, not per thread, and
        // Realm has no per-turn effort control yet. Claude passes it through; this asymmetry is intentional.
        const common = {
          cwd: opts.cwd,
          approvalPolicy,
          sandbox, // a SandboxMode STRING here; the structured object is turn/start's `sandboxPolicy` (§8 gotcha 5)
          ...(opts.model ? { model: opts.model } : {}),
          ...(config ? { config } : {}),
        };
        // Bounded: neither call has a protocol-level deadline, and a child that spawns and then answers
        // nothing would otherwise leave `boot` — and every send()/setOptions()/dispose() behind it — pending
        // for the life of the process.
        const bootMs = this.bootTimeoutMs ?? BOOT_TIMEOUT_MS;
        // `developerInstructions` is W3's memory channel: the same text the Claude adapter appends to its
        // system prompt, as a thread/start parameter. thread/start ONLY — a resumed thread keeps the
        // instructions it was started with, and what a fresh value on thread/resume would mean is not
        // something the protocol says (the field is listed unverified there; proven for thread/start in
        // scripts/live-memory-check.ts).
        const res = obj(opts.resume
          ? await c.request("thread/resume", { threadId: opts.resume, ...common }, bootMs)
          : await c.request("thread/start", {
            ...common,
            ...(opts.systemContext ? { developerInstructions: opts.systemContext } : {}),
            sessionStartSource: "startup",
          }, bootMs));
        if (disposed) return;
        const id = str(obj(res.thread).id) || str(opts.resume);
        if (!id) throw new Error("codex did not return a thread id");
        threadId = id;
        // Codex names the exact instruction files it loaded (AGENTS.md hierarchy) in the start response —
        // ground truth the memory pane shows instead of a guess. Absent (older build / resume without the
        // field) stays absent rather than becoming [], so "reported nothing" and "reported zero files"
        // remain distinguishable downstream.
        const instructionSources = Array.isArray(res.instructionSources)
          ? res.instructionSources.filter((s): s is string => typeof s === "string")
          : undefined;
        // Both before attach(): attach flushes the thread's buffer synchronously, and notifications that beat
        // the thread/start response would otherwise be mapped into the stream ahead of init. Nothing is lost by
        // waiting — the connection buffers by threadId until someone attaches.
        events.push(sessionEvent("init", {
          providerSessionId: id, model: str(res.model) || str(opts.model), tools: [], cwd: str(res.cwd) || opts.cwd,
          ...(instructionSources ? { instructionSources } : {}),
        }));
        events.push(sessionEvent("status", { status: "idle" }));
        c.attach(id, listener);
        // After the thread exists, per the protocol's own ordering, and awaited inside boot so that the
        // first send() — which awaits boot — cannot start a turn before Codex knows about the skills.
        if (opts.skills) { ownedRoot = opts.skills.root; await this.addExtraRoot(c, opts.skills.root, opts.onLog); }
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
        // Waiting for boot keeps a dispose that raced it from leaving a half-attached thread behind — but the
        // wait is bounded, because SessionService.closeAll() -> App.close() -> app quit is what is behind it.
        // An unbounded wait here is how the desktop main process ends up SIGTERMing a server that still owns
        // live agent children.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([boot, new Promise<void>((res) => { timer = setTimeout(res, DISPOSE_TIMEOUT_MS); })]);
        clearTimeout(timer);
        await shutdown();
      },
    };
  }
}
