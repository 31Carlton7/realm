import { ASK_PERMISSION_MODE, AskCardSchema, askCardFromElicitation, elicitationContent, loggableAnswers, normalizeAnswers, requiredAnswered, sessionEvent, type AskAnswers, type AskCard, type SessionEvent } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import { JsonRpcCallError, isRpcTimeout, type JsonRpcId } from "../jsonrpc/stdio";
import { CodexConnection, type ThreadListener } from "./connection";
import { createCodexMapper } from "./map-codex";
import { CODEX_FAST_TIER, parseCodexModelPage, probeCodex, type CodexModel } from "./probe";
import type { AgentAdapter, AgentHandle, McpServerConfig, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";
import { obj, str, type Bag } from "../bag";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Copies ClaudeAdapter: app quit awaits every dispose(), so no dispose may depend on a healthy child. */
const DISPOSE_TIMEOUT_MS = 3000;
/** thread/start loads config, resolves the model and checks auth — slower than initialize, never unbounded. */
const BOOT_TIMEOUT_MS = 30_000;
/** `skills/extraRoots/set` only rescans a couple of directories, and nothing about the session depends on
 *  its answer — so it gets a short leash rather than the boot budget. */
const EXTRA_ROOTS_TIMEOUT_MS = 10_000;
/** JSON-RPC "method not found": the signal that this codex build predates the method just asked for. */
const METHOD_NOT_FOUND = -32601;
/** `model/list` reads a local catalog; a slow answer means something is wrong, not that it needs longer. */
const MODEL_LIST_TIMEOUT_MS = 10_000;
/** Pagination guard for `model/list`: the live catalog is one page of 6; a cursor loop past this is a bug. */
const MODEL_LIST_MAX_PAGES = 5;

/**
 * Codex can inherit host-specific browser plugins from the user's global config. In Realm those
 * plugins target another app's browser bridge, while every Realm pane is exposed through the
 * gateway's `realm-browser` provider. The two surfaces look interchangeable to the model until the
 * foreign bridge fails during setup, so state the host boundary on every turn. `additionalContext`
 * also reaches resumed threads, unlike `developerInstructions`, which belongs to `thread/start`.
 */
export const REALM_APPLICATION_CONTEXT =
  "For browser tabs and panes inside Realm, use the realm-browser browser tools (begin with browser_list or browser_snapshot). " +
  "Do not use the bundled browser:control-in-app-browser skill or node_repl for Realm tabs; that browser bridge belongs to a different host application. " +
  "Use a Chrome-specific integration only when the user explicitly asks to control Chrome.";

const realmAdditionalContext = {
  realm_browser_host: { kind: "application", value: REALM_APPLICATION_CONTEXT },
} as const;

/**
 * W4 double-prompt verdict for Codex: NOTHING to wire, on purpose. Claude's SDK prompts per MCP tool
 * (fixed there via `allowedTools`); Codex's app-server protocol raises approvals ONLY for the two
 * methods below — captured live, and `mcpToolCall` items stream through `map-codex.ts` as tool calls
 * with no approval request at all. So a read-only realm-browser tool already runs promptless on
 * Codex, and a mutating one is gated by Realm's broker alone (single prompt — the desired end
 * state). The protocol offers no per-MCP-tool allow-list on `thread/start` to wire even if we
 * wanted one; if a future preview build starts raising MCP-tool approvals, it will surface here as
 * a new request method and this verdict gets revisited, not assumed away.
 */
const APPROVAL_METHODS: Record<string, { toolName: string; title: string }> = {
  "item/commandExecution/requestApproval": { toolName: "exec_command", title: "Run this command?" },
  "item/fileChange/requestApproval": { toolName: "apply_patch", title: "Apply these edits?" },
};

/** Who asks when Codex's own `request_user_input` tool reaches the card. */
const CODEX_ASKER = { kind: "agent", name: "Codex", agent: "codex" } as const;

/**
 * Codex's `item/tool/requestUserInput` as a card, or null when it holds nothing to answer.
 *
 * Shapes from `codex app-server generate-ts` (0.154.0): each question is `{id, header, question,
 * isOther, isSecret, options: {label, description}[] | null}`, and the reply is `{answers: {[id]:
 * {answers: string[]}}}`. An option's value IS its label, because a label is what Codex reads back;
 * `isOther` is the field for an answer of your own, and a question with no options is that field
 * alone. `isSecret` is masked on screen and kept out of the log like every other secret.
 */
export function codexUserInputCard(params: unknown): AskCard | null {
  const raw = obj(params).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions = raw.map((x) => {
    const q = obj(x);
    const options = (Array.isArray(q.options) ? q.options : []).map(obj).filter((o) => str(o.label))
      .map((o) => ({ value: str(o.label), label: str(o.label), ...(str(o.description) ? { description: str(o.description) } : {}) }));
    return {
      id: str(q.id), prompt: str(q.question) || str(q.header), ...(str(q.header) ? { header: str(q.header).slice(0, 80) } : {}),
      kind: options.length ? "choice" as const : "text" as const,
      ...(options.length ? { options, allowOther: q.isOther === true } : {}),
      ...(q.isSecret === true ? { secret: true } : {}),
    };
  });
  const card = AskCardSchema.safeParse({ asker: CODEX_ASKER, mode: "question", questions });
  return card.success ? card.data : null;
}

/** The answers as `ToolRequestUserInputResponse` carries them: every one a list. */
export function codexUserInputReply(answers: AskAnswers): { answers: Record<string, { answers: string[] }> } {
  return { answers: Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, { answers: Array.isArray(a) ? a : [a] }])) };
}

/**
 * How long Codex waits on one of Realm's tools before giving up on it. Its own default is a minute,
 * and a Realm tool can rightly take far longer: a question waits for the user up to the broker's
 * fifteen minutes, and `agent_wait` listens for sub-agents by default for as long. A minute more than
 * the longest of them, so Realm's own answer — even a timeout — is the one that lands.
 */
export const GATEWAY_TOOL_TIMEOUT_SEC = 16 * 60;

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

/**
 * Realm's permission modes onto Codex's two independent knobs. Both are `thread/start` params.
 *
 * Ask and Plan are BOTH read-only and they are not the same rung. Plan keeps `untrusted`, so a write
 * the sandbox refuses raises an approval the user can answer "yes" to — that escalation is what makes
 * a plan revisable in place. Ask disables approvals outright, so there is no answer that lets a write
 * through: Codex's own config validator describes exactly this pairing as "read-only permissions with
 * approvals disabled". The sandbox does the refusing in the kernel — a write under
 * `codex sandbox -c sandbox_mode='"read-only"'` fails with "Operation not permitted".
 */
export function codexPolicyFor(permissionMode: string | undefined): { approvalPolicy: string; sandbox: string } {
  if (permissionMode === "plan") return { approvalPolicy: "untrusted", sandbox: "read-only" };
  if (permissionMode === ASK_PERMISSION_MODE) return { approvalPolicy: "never", sandbox: "read-only" };
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
      : { url: s.url, ...(Object.keys(s.headers).length ? { http_headers: s.headers } : {}), tool_timeout_sec: GATEWAY_TOOL_TIMEOUT_SEC },
  ] as const);
  return { mcp_servers: Object.fromEntries(entries) };
}

/**
 * Codex cannot be sandboxed by Realm in this release, and this is the refusal that says so.
 *
 * **Why.** `CodexAdapter` refcounts ONE `codex app-server` process across every Realm session
 * (`acquire`/`release`, and the whole reason `processCount` is asserted never to exceed one). A
 * Seatbelt policy is applied by `sandbox-exec` at exec, to a process, for its lifetime — so one
 * shared process can hold exactly one policy. A Work space on `workspace-write` and a School space
 * on `read-only` cannot both be served by it, and the first session to start would silently decide
 * the confinement of every session that joined afterwards.
 *
 * **Why refuse rather than run unsandboxed.** Running anyway is the one outcome this feature exists
 * to prevent: a user who set a posture in Settings would be told they had a sandbox and not have
 * one. The way out is visible, stored, and the user's own — set that space's posture to `off`, at
 * which point they know Codex is unconfined because they said so.
 *
 * **The eventual fix**, stated so the next person does not re-derive it: key the shared connection
 * by a fingerprint of the resolved policy instead of having one, so `conn` becomes
 * `Map<policyFingerprint, Promise<CodexConnection>>` and sessions share a process only with sessions
 * whose confinement is identical. The refcount, `extraRoots` and `release` all become per-entry. The
 * cost is up to one `codex app-server` per distinct policy rather than one per machine, which is the
 * honest price and is why it is a change and not a patch.
 */
export const CODEX_SANDBOX_REFUSAL =
  "Codex sessions cannot run sandboxed yet. Realm shares one `codex app-server` process across every Codex session, and a macOS sandbox policy is fixed to a process when it starts — so one process cannot hold two spaces' policies. Set this space's sandbox to \"No sandbox\" in Settings to run Codex here, or use a different agent.";

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
  /** Same feature-detect discipline for `model/list`: a build without it degrades to the static picker
   *  fallback (`models: null`), never a failed probe. Sticky, because -32601 is a fact about the binary. */
  private modelListSupported = true;
  /** The version the latches above were learned against.
   *
   *  They are facts about a BINARY, and the binary changes under a long-running server: someone
   *  upgrades the CLI while Realm is open, the new build answers `model/list` perfectly well, and
   *  Realm goes on serving the static fallback until the app is restarted — with no way for the user
   *  to tell why "Check for new models" keeps finding nothing. Re-checking on a version change is
   *  what makes an upgrade take effect without a relaunch. */
  private latchedVersion: string | null = null;

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
    // The adapter's OWN args, so the probe runs the command the adapter would run. With no args —
    // production, where `bin` is the `codex` binary itself — this is `codex --version`, unchanged.
    // With them it is the same wrapper the sessions go through, which is the only honest thing to
    // ask for a version, and the only way the latch below can ever see one change.
    const p = await probeCodex(this.bin, [...(this.args ?? []), "--version"]);
    // A different binary is a different set of capabilities. Both latches are re-armed together —
    // they were learned from the same process and there is no reason one would outlive the other.
    if (p.available && p.version !== this.latchedVersion) {
      this.latchedVersion = p.version;
      this.modelListSupported = true;
      this.extraRootsSupported = true;
    }
    const models = p.available ? await this.listModels() : null;
    // The tier rides along with the row, so the prompter can offer Fast on a model before any session
    // has asked — the catalog is the CLI's own statement, and it is already in hand here.
    return { kind: this.kind, ...p, models: models === null ? null
      : models.map(({ id, label, fast, isDefault, efforts, defaultEffort }) => ({ id, label, fastMode: fast, ...(isDefault ? { isDefault } : {}),
        ...(efforts.length > 0 ? { efforts } : {}), ...(defaultEffort ? { defaultEffort } : {}) })) };
  }

  /**
   * The live model catalog over app-server `model/list` (response shape verified against codex-cli
   * 0.146.0: `{ data, nextCursor }` — see `parseCodexModelPage`). Rides the shared connection when a
   * session already holds one; otherwise spins up a probe-lifetime process the way the CLI probe spawns
   * its own children, and takes it down again. `null` on ANY failure — a -32601 build (sticky, like
   * `skills/extraRoots/set`), a dead spawn, a timeout — because the picker has a static fallback and a
   * failed enumeration must never fail the probe that carries availability.
   */
  private async listModels(): Promise<CodexModel[] | null> {
    if (!this.modelListSupported) return null;
    let owned: CodexConnection | null = null;
    try {
      // A rejected shared open is a boot problem for the session that caused it, not for this probe:
      // fall through to a transient process rather than inheriting the rejection.
      const shared = this.conn ? await this.conn.catch(() => null) : null;
      const conn = shared ?? (owned = await CodexConnection.open({
        bin: this.bin ?? process.env.REALM_CODEX_BIN ?? "codex",
        args: this.args,
        cwd: process.cwd(),
        initializeTimeoutMs: this.bootTimeoutMs,
      }));
      const models: CodexModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MODEL_LIST_MAX_PAGES; page += 1) {
        const res = await conn.request("model/list", cursor === null ? {} : { cursor }, MODEL_LIST_TIMEOUT_MS);
        const parsed = parseCodexModelPage(res);
        models.push(...parsed.models);
        cursor = parsed.nextCursor;
        if (cursor === null) break;
      }
      return models;
    } catch (e) {
      if (e instanceof JsonRpcCallError && e.code === METHOD_NOT_FOUND) this.modelListSupported = false;
      return null;
    } finally {
      if (owned) await owned.dispose().catch(() => {});
    }
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
  /** Visible for tests: false once a codex build has answered -32601 to `model/list`. */
  get modelListEnumerable(): boolean { return this.modelListSupported; }

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
    // Before anything is acquired, allocated or queued: a Codex session in a sandboxed space does
    // not start. `wrap` is only ever supplied for a non-`off` posture (SessionService omits it
    // otherwise), so its mere presence is the question being answered — this adapter has nowhere to
    // apply it, and an adapter that silently ignored a `wrap` would be running the thing the user
    // asked to be confined. See CODEX_SANDBOX_REFUSAL for why, and for the shape of the fix.
    //
    // A throw rather than an error event: `start` is called synchronously from
    // `SessionService.ensureLive`, and a throw is what makes the failure reach the caller that asked
    // for the session instead of arriving later as a dead handle nobody is watching yet.
    if (opts.wrap) throw new Error(CODEX_SANDBOX_REFUSAL);
    const events = new AsyncQueue<SessionEvent>();
    const mapper = createCodexMapper();
    /** Open requests by the id the transcript knows them by. An approval answers with a decision; a
     *  question answers with what the user gave, or with what "no answer" is on its protocol. */
    type Pending =
      | { kind: "approval"; id: JsonRpcId; decisions: unknown[] }
      | { kind: "question"; id: JsonRpcId; card: AskCard; accept: (given: AskAnswers) => unknown; decline: () => unknown; cancel: () => unknown };
    const pending = new Map<string, Pending>();
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

    /** `cancelled`: nobody answered — the turn was stopped or the session is going — which a question's
     *  protocol may say differently from a person's "no" (MCP's `cancel` against `decline`). */
    const respond = (requestId: string, decision: PermissionDecision, answers?: AskAnswers, cancelled = false) => {
      const p = pending.get(requestId);
      if (!p) return;
      pending.delete(requestId);
      if (p.kind === "question") {
        // Held to the card it was asked with; the log keeps a mark where a masked answer was.
        const given = decision !== "deny" && answers ? normalizeAnswers(p.card, answers) : undefined;
        const answered = given !== undefined && Object.keys(given).length > 0 && requiredAnswered(p.card, given);
        conn?.respond(p.id, answered ? p.accept(given) : cancelled ? p.cancel() : p.decline());
        events.push(sessionEvent("permission_response", { requestId, decision: answered ? decision : "deny", ...(answered ? { answers: loggableAnswers(p.card, given) } : {}) }));
      } else {
        conn?.respond(p.id, { decision: pickCodexDecision(decision, p.decisions) });
        events.push(sessionEvent("permission_response", { requestId, decision }));
      }
      // Several tools can be waiting at once (parallel tool calls): the status only comes back when the last
      // one is answered. An approval only exists inside a live turn, so that status is always `running`; the
      // turn's own `turn/completed` is what settles it back to idle.
      if (pending.size === 0) events.push(sessionEvent("status", { status: "running" }));
    };
    const denyAllPending = () => { for (const id of [...pending.keys()]) respond(id, "deny", undefined, true); };

    /** Put a question to the user, or — when it is one Realm will not draw — answer it at once and
     *  leave the declined card in the transcript, so the refusal is not silent. */
    const ask = (id: JsonRpcId, method: string, card: AskCard, title: string, replies: Pick<Extract<Pending, { kind: "question" }>, "accept" | "decline" | "cancel">) => {
      const requestId = String(id);
      if (card.refused) {
        conn?.respond(id, replies.decline());
        events.push(sessionEvent("permission_request", { requestId, toolName: method, input: {}, title, suggestions: [], ask: card }));
        events.push(sessionEvent("permission_response", { requestId, decision: "deny" }));
        return;
      }
      if (pending.size === 0) events.push(sessionEvent("status", { status: "waiting_permission" }));
      pending.set(requestId, { kind: "question", id, card, ...replies });
      events.push(sessionEvent("permission_request", { requestId, toolName: method, input: {}, title, suggestions: [], ask: card }));
    };

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

    /** Whether the next turn asks for Codex's Fast tier. Held here rather than only on the session
     *  row because it moves mid-session: `setOptions` flips it and the very next `turn/start` carries
     *  it, which is more than Codex offers for `model` or the approval policy. */
    let fastMode = opts.fastMode === true;
    /** Whether a turn of THIS thread has ever asked for the tier. `serviceTier` is sticky on the
     *  thread once set, so switching off has to say `null` — but only then: a session that never
     *  touched it must not reset a tier the user's own Codex config may have chosen. */
    let tierAsked = false;
    /** What the turn in flight was started under. A switch flipped mid-turn is about the NEXT
     *  `turn/start`, and the usage this turn reports has to say which request it answers — or a thread
     *  still on the old tier reads as a refusal of the new one. */
    let turnFast = fastMode;
    const serviceTierParam = (): { serviceTier?: string | null } => {
      if (fastMode) { tierAsked = true; return { serviceTier: CODEX_FAST_TIER }; }
      return tierAsked ? { serviceTier: null } : {};
    };

    /** The reasoning effort the next turn asks for: the session's level, or null for the model's own
     *  default. Per turn, like the tier — `turn/start`'s `effort` ("Override the reasoning effort for
     *  this turn and subsequent turns", `TurnStartParams` in `codex app-server generate-ts` 0.154.0);
     *  `thread/start` takes none, which is why this used to be dropped. */
    let effort = opts.effort ?? null;
    /** Whether a turn of THIS thread has sent a level. The override sticks to the thread, and a null
     *  `effort` is "no override" rather than "back to the default", so returning to the default names
     *  the model's own default — and only once something else was sent. */
    let effortAsked = false;
    /** What the thread's model accepts, off the catalog the probe reads: its levels and its default.
     *  Settled after `thread/start`; null where the catalog says nothing (a build without `model/list`,
     *  a model it does not carry). */
    let modelEfforts: Promise<{ levels: string[]; fallback: string | null } | null> = Promise.resolve(null);
    const effortParam = async (): Promise<{ effort?: string }> => {
      if (effort === null && !effortAsked) return {};
      const known = await modelEfforts;
      const level = effort ?? known?.fallback ?? null;
      // Only a level the catalog lists for this model. Another harness's id (Claude's `max`, kept on a
      // session that switched agents) or a level nothing confirmed is a turn Codex may refuse.
      if (level === null || !known?.levels.includes(level)) {
        if (level !== null) opts.onLog?.(`[codex] effort ${level} is not one this model lists; the turn runs at the thread's own`);
        return {};
      }
      effortAsked = effort !== null;
      return { effort: level };
    };

    /**
     * Ask the catalog whether the model this thread landed on lists the Fast tier, and say so once.
     *
     * The same shape as the Claude adapter's: the `init` event is restated whole with `supportsFastMode`
     * added, because the first init is pushed from the `thread/start` response and this answer needs a
     * `model/list` round trip that has not happened yet. Everything here fails quietly — a build
     * without `model/list`, a model the catalog does not carry — and "not stated" is what the prompter
     * reads as "offer no switch". A build that has no such tier at all says nothing, never "no".
     */
    const reportFastModeSupport = async (init: { providerSessionId: string; model: string; tools: string[]; cwd: string; instructionSources?: string[] },
      catalog: Promise<CodexModel[] | null>) => {
      try {
        const rows = await catalog;
        if (!rows || disposed) return;
        const hit = rows.find((r) => r.id === init.model);
        if (!hit) return;
        events.push(sessionEvent("init", { ...init, supportsFastMode: hit.fast }));
      } catch { /* the catalog declined; the capability stays unstated */ }
    };

    const listener: ThreadListener = {
      onNotification: (method, params) => {
        const p = obj(params);
        // A request Codex resolved without us — a non-blocking question that timed out on its own
        // (`autoResolutionMs`) — is withdrawn from the transcript, not left as a card nobody can answer.
        if (method === "serverRequest/resolved") {
          const requestId = String(p.requestId);
          if (pending.delete(requestId)) {
            events.push(sessionEvent("permission_response", { requestId, decision: "deny" }));
            if (pending.size === 0) events.push(sessionEvent("status", { status: "running" }));
          }
        }
        // thread/resume rejoins a turn that is already running, and its response carries no turn id — this
        // notification is the only place a rejoined session learns one.
        if (method === "turn/started") activeTurnId = str(obj(p.turn).id) || activeTurnId;
        if (method === "turn/completed") activeTurnId = null;
        for (const e of mapper.map(method, params)) {
          events.push(e.type === "usage" ? sessionEvent("usage", { ...e.payload, fastModeRequested: turnFast }) : e);
        }
      },
      onServerRequest: (id, method, params) => {
        // Codex's own question tool, asked of the user on Realm's card.
        if (method === "item/tool/requestUserInput") {
          const card = codexUserInputCard(params);
          if (!card) { conn?.respond(id, { answers: {} }); return; }
          ask(id, method, card, card.questions[0]!.prompt, {
            accept: (given) => codexUserInputReply(given), decline: () => ({ answers: {} }), cancel: () => ({ answers: {} }),
          });
          return;
        }
        // A server from the user's own Codex config asking through Codex (MCP elicitation, passed on).
        // The card names the server AND the agent it came through: it is the server asking, not Codex.
        if (method === "mcpServer/elicitation/request") {
          const p = obj(params);
          const asker = { kind: "server" as const, name: str(p.serverName) || "An MCP server", via: "Codex" };
          const mode = str(p.mode);
          // `openai/form` is a schema of OpenAI's own, which this card does not draw: declined, named.
          const card = askCardFromElicitation(mode === "form" || mode === "url"
            ? { mode, message: p.message, requestedSchema: p.requestedSchema, url: p.url }
            : { mode: "unsupported", message: p.message }, asker);
          const reply = (action: "accept" | "decline" | "cancel", content: unknown = null) => ({ action, content, _meta: null });
          ask(id, method, card, str(p.message) || `${asker.name} asks`, {
            accept: (given) => reply("accept", mode === "url" ? null : elicitationContent(card, given)),
            decline: () => reply("decline"), cancel: () => reply("cancel"),
          });
          return;
        }
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
        pending.set(requestId, { kind: "approval", id, decisions });
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
        // No `effort` here: Codex takes reasoning effort per turn, and `effortParam` sends it on `turn/start`.
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
        const start = (): Promise<unknown> => c.request("thread/start", {
          ...common,
          ...(opts.systemContext ? { developerInstructions: opts.systemContext } : {}),
          sessionStartSource: "startup",
        }, bootMs);
        /**
         * A resume Codex refuses is a fresh thread, not a dead session.
         *
         * `thread/resume` rejects when the thread is no longer in `~/.codex` — deleted by hand, aged
         * out, or written by a different Codex install. Realm keeps handing back the same
         * `providerSessionId` on every send, so before this one rejection made the session
         * permanently unstartable: every attempt took this same branch and failed the same way, with
         * nothing in the UI to say why.
         *
         * The fallback is `thread/start`, which is not merely the other call — it is the one that
         * carries `developerInstructions`, so the memory channel comes back with it. That asymmetry
         * is the reason the resume branch cannot simply pass the field and be done.
         *
         * The user is told. `declined` on the init event below becomes a `context_reset` seam in the
         * transcript, because the agent under that line genuinely cannot read what is above it.
         */
        let resumeOutcome: "continued" | "declined" | undefined;
        let raw: unknown;
        if (opts.resume) {
          try {
            raw = await c.request("thread/resume", { threadId: opts.resume, ...common }, bootMs);
            resumeOutcome = "continued";
          } catch (e) {
            // Only a REFUSAL falls back. A timeout means the app-server said nothing at all, and a
            // second bounded call would spend another whole boot budget waiting on the same silence —
            // so that failure surfaces as it always has, naming `thread/resume`.
            if (isRpcTimeout(e)) throw e;
            opts.onLog?.(`thread/resume ${opts.resume} refused (${bootFailureMessage(e)}); starting a new thread`);
            raw = await start();
            resumeOutcome = "declined";
          }
        } else {
          raw = await start();
        }
        const res = obj(raw);
        if (disposed) return;
        // On a declined resume the NEW thread's id is the only honest answer — falling back to
        // `opts.resume` would record an id Codex has just told us it does not have.
        const id = str(obj(res.thread).id) || (resumeOutcome === "declined" ? "" : str(opts.resume));
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
        const init = {
          providerSessionId: id, model: str(res.model) || str(opts.model), tools: [], cwd: str(res.cwd) || opts.cwd,
          ...(instructionSources ? { instructionSources } : {}),
          ...(opts.resume ? { resumeRequested: true } : {}),
          ...(resumeOutcome ? { resumeOutcome } : {}),
        };
        events.push(sessionEvent("init", init));
        events.push(sessionEvent("status", { status: "idle" }));
        c.attach(id, listener);
        // Not awaited: the answer arrives whenever the catalog does, and a first send must not wait on
        // it — except for a level, which the first `turn/start` checks against this same answer.
        const catalog = this.listModels().catch(() => null);
        void reportFastModeSupport(init, catalog);
        modelEfforts = catalog.then((rows) => {
          const m = rows?.find((r) => r.id === init.model);
          return m && m.efforts.length > 0 ? { levels: m.efforts, fallback: m.defaultEffort } : null;
        });
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
      const fileList = `Attached files:\n${files.map((a) => `- ${a.path}`).join("\n")}`;
      // Attachment-only messages (Plan 14 W5): with no text, the file list stands alone (no leading
      // blank lines), and an images-only send carries just the localImage items — the `UserInput`
      // union takes any mix, so an empty-string text item is never manufactured to fill space.
      const text = files.length ? (m.text ? `${m.text}\n\n${fileList}` : fileList) : m.text;
      return [
        ...(text ? [{ type: "text", text, text_elements: [] }] : []),
        // A resolved @-mention (W4) rides as Codex's NATIVE skill input item, beside the text — the
        // app-server `UserInput` union has a `skill` variant, which beats munging `$name` into the
        // text. `name` is the frontmatter name (what skills/list reports); `path` is the library
        // SKILL.md the staged extra root symlinks back to.
        ...(m.skill ? [{ type: "skill", name: m.skill.name, path: m.skill.path }] : []),
        ...images.map((a) => ({ type: "localImage", path: a.path })),
      ];
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
          turnFast = fastMode;
          const started = obj(await conn.request("turn/start", {
            threadId,
            input,
            additionalContext: realmAdditionalContext,
            // Fast mode is a per-turn parameter Codex writes back onto the thread (it echoes as
            // `thread/settings/updated.threadSettings.serviceTier`, which is what the mapper reports).
            // Verified live on 0.153.4: `"priority"` is the tier the catalog names Fast; `null` clears it.
            ...serviceTierParam(),
            // The session's reasoning effort, the same way: per turn, sticky on the thread.
            ...(await effortParam()),
          }));
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
        // Unlike the two below, these take effect on the next turn: the tier and the level ride on `turn/start`.
        if (o.fastMode !== undefined) fastMode = o.fastMode;
        if (o.effort !== undefined) effort = o.effort;
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
