import { AGENT_META, PERSISTED_EVENT_TYPES, sessionEvent, type AgentKind, type Session, type SessionEvent, type StoredSessionEvent } from "@realm/contracts";
import type { AdapterRegistry, AgentHandle, PermissionDecision, ProbeResult, UserMessage } from "@realm/adapters";
import type { Db } from "../db/database";
import type { RpcServer } from "../rpc/server";
import type { ItemsStore } from "../store/items";
import type { ProjectsStore } from "../store/projects";
import type { SessionsStore, SessionEventsStore, SessionUpdate } from "../store/sessions";
import type { EnvironmentsStore } from "../store/environments";
import type { SpacesStore } from "../store/spaces";
import type { TerminalService } from "../terminals/service";
import { NotFoundError, RpcError } from "../store/rows";
import { portEnv, type PortAllocator } from "../workspace/ports";
import type { WorktreeService } from "../workspace/worktrees";
import type { CheckpointService } from "../checkpoints/service";
import { ProbeCache } from "./probe-cache";
import type { SkillsService } from "../skills/service";
import type { McpService } from "../mcp/service";

const defaultTitle = (kind: AgentKind) => `${AGENT_META[kind].label} session`;
export const TITLE_MAX = 40;
/** First line of the message, whitespace-collapsed, clipped to TITLE_MAX. */
export function titleFromMessage(text: string): string {
  const line = text.trim().split("\n").find((l) => l.trim()) ?? "";
  const one = line.replace(/\s+/g, " ").trim();
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1).trimEnd()}…` : one;
}

export type CreateSessionInput = { spaceId: string; agentKind: AgentKind; projectId: string | null; environmentId?: string | null; model: string | null; effort: string | null; permissionMode: string; title?: string };
type Live = { handle: AgentHandle; pump: Promise<void> };

/**
 * Owns the session trio: DB row + sidebar item + live adapter handle. Adapter handles are started lazily on the
 * first `send` (and restarted with `resume` after they end), so a persisted session survives server restarts.
 * Every adapter event (except deltas) is persisted with a global, monotonically increasing seq (unique across sessions;
 * clients page per session with `afterSeq`) and broadcast as `session.event`.
 */
export class SessionService {
  private live = new Map<string, Live>();
  private closing = false;
  constructor(private d: { db: Db; rpc: RpcServer; sessions: SessionsStore; events: SessionEventsStore; items: ItemsStore; spaces: SpacesStore; projects: ProjectsStore; environments: EnvironmentsStore; worktrees: WorktreeService; ports: PortAllocator; terminals: TerminalService; adapters: AdapterRegistry; skills: SkillsService; mcp: McpService; checkpoints?: CheckpointService }) {}

  /** Cached probe (TTL + in-flight dedup): each `probeAll` spawns a child process per registered agent,
   *  and the renderer asks on every prompter mount. `force` bypasses it — see ProbeCache. */
  private probeCache = new ProbeCache(() => this.probeAll());

  probe(opts: { force?: boolean } = {}): Promise<ProbeResult[]> { return this.probeCache.get(opts); }

  /** One adapter's probe throwing must not hide the others; it reports as unavailable with the reason. */
  async probeAll(): Promise<ProbeResult[]> {
    const adapters = Object.values(this.d.adapters);
    const results = await Promise.allSettled(adapters.map((a) => a.probe()));
    return results.map((r, i) => r.status === "fulfilled" ? r.value
      : { kind: adapters[i]!.kind, available: false, version: null, loggedIn: null, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  }

  isLive(id: string): boolean { return this.live.has(id); }
  list(spaceId: string): Session[] { return this.d.sessions.list(spaceId); }
  listAll(): Session[] { return this.d.sessions.listAll(); }
  get(id: string): Session { const s = this.d.sessions.get(id); if (!s) throw new NotFoundError("session", id); return s; }
  events(id: string, afterSeq: number, limit: number): StoredSessionEvent[] { this.get(id); return this.d.events.listAfter(id, afterSeq, limit); }

  create(input: CreateSessionInput): { session: Session; itemId: string } {
    const space = this.d.spaces.get(input.spaceId); if (!space) throw new NotFoundError("space", input.spaceId);
    if (!this.d.adapters[input.agentKind]) throw new RpcError("AGENT_UNAVAILABLE", `${input.agentKind} is not registered`);
    const project = input.projectId ? this.d.projects.get(input.projectId) : null;
    if (input.projectId && !project) throw new NotFoundError("project", input.projectId);
    const env = this.resolveEnvironment(input.spaceId, input.environmentId ?? null, project?.rootPath ?? null);
    const title = input.title?.trim() || defaultTitle(input.agentKind);
    const session = this.d.sessions.create({ spaceId: input.spaceId, projectId: project?.id ?? null, agentKind: input.agentKind, model: input.model, effort: input.effort, permissionMode: input.permissionMode, environmentId: env.id, title });
    const item = this.d.items.create({ spaceId: input.spaceId, kind: "session", title, refId: session.id });
    this.d.rpc.broadcast("items.changed", { spaceId: input.spaceId });
    return { session, itemId: item.id };
  }

  /**
   * Where a new session runs, in priority order: an environment the caller named (the seam W2 uses to
   * start a session in a worktree), the project's own checkout, or the space's primary. The get-or-create
   * is what makes several sessions in one place share one environment rather than accumulate rows.
   * Whether a named environment belongs to this space is `SessionsStore.create`'s check, not a second
   * copy here.
   */
  private resolveEnvironment(spaceId: string, environmentId: string | null, projectRoot: string | null) {
    if (environmentId) {
      const env = this.d.environments.get(environmentId);
      if (!env) throw new NotFoundError("environment", environmentId);
      return env;
    }
    if (projectRoot) return this.d.environments.ensureAt(spaceId, projectRoot, "checkout");
    return this.d.environments.ensurePrimary(spaceId);
  }

  /** Emits `user_message` (persisted + broadcast) and hands the message to the adapter, starting it if needed. */
  async send(id: string, msg: UserMessage): Promise<void> {
    // Claim the environment's port block before the adapter can be spawned — `ensureLive` reads it
    // back off the row, so this is the only place the (async) allocation has to happen.
    await this.ensurePorts(id);
    // The turn's checkpoint (W4), captured BEFORE the message reaches the adapter and awaited rather
    // than fired off: a capture racing the agent's first write would record a tree that never existed.
    // It reports its own failures and returns null — a checkpoint is a safety net, and a safety net
    // that can refuse a message is a worse failure than not having one.
    await this.checkpointTurn(id, msg.text);
    const handle = this.ensureLive(id);
    this.maybeTitleFrom(id, msg.text);
    this.onEvent(id, sessionEvent("user_message", msg));
    await handle.send(msg);
  }
  async interrupt(id: string): Promise<void> { this.get(id); await this.live.get(id)?.handle.interrupt(); }
  respondPermission(id: string, requestId: string, decision: PermissionDecision): void {
    this.get(id);
    const l = this.live.get(id);
    if (!l) throw new RpcError("SESSION_NOT_LIVE", "the agent is not running; the request is stale (send a message to resume)");
    l.handle.respondPermission(requestId, decision);
  }
  async setOptions(id: string, o: { model?: string; effort?: string; permissionMode?: string }): Promise<Session> {
    const s = this.d.sessions.update({ id, ...o });
    await this.live.get(id)?.handle.setOptions({ model: o.model, permissionMode: o.permissionMode });
    return s;
  }

  /**
   * Re-point a session that has not started yet at another agent. Authoritative guard: one persisted
   * event is enough to lock the kind forever — a transcript, a providerSessionId and a resume are all
   * tied to the agent that produced them, so there is no coherent "switch" after the first message.
   * The client hides the affordance too, but this is the check that matters.
   *
   * `model` is cleared because model ids are per-kind (a `claude-opus-5` on a Codex session is a lie);
   * the new kind falls back to its adapter default until the user picks from its own model list. An
   * untouched default title follows the new kind so the sidebar never names the wrong agent.
   */
  setAgent(id: string, agentKind: AgentKind): Session {
    const s = this.get(id);
    if (s.agentKind === agentKind) return s;
    if (!this.d.adapters[agentKind]) throw new RpcError("AGENT_UNAVAILABLE", `${agentKind} is not registered`);
    if (this.d.events.hasAny(id)) throw new RpcError("SESSION_STARTED", "this session has already run; its agent can no longer be changed");
    const title = s.title === defaultTitle(s.agentKind) ? defaultTitle(agentKind) : s.title;
    const updated = this.d.sessions.update({ id, agentKind, model: null, title });
    const item = this.d.items.findByRefId(id);
    if (item && item.title !== title) { this.d.items.update({ id: item.id, title }); this.d.rpc.broadcast("items.changed", { spaceId: item.spaceId }); }
    return updated;
  }

  /**
   * The session's terminal side panel (W4), created on FIRST call and never before — a session whose
   * panel is never opened must never spawn a pty. Idempotent afterwards: the same trio comes back.
   * A recorded terminal whose pty is gone (it exited, or its cwd vanished at boot) is torn down and
   * replaced, so opening the panel always lands you in a live shell at the session's cwd.
   */
  async openTerminal(id: string): Promise<{ terminalId: string; itemId: string }> {
    await this.ensurePorts(id);
    const s = this.get(id);
    const item = s.terminalItemId ? this.d.items.get(s.terminalItemId) : null;
    if (item) {
      if (this.d.terminals.has(item.refId)) return { terminalId: item.refId, itemId: item.id };
      this.closeTerminalItem(item.refId); // stale: drops the row + item, which nulls the column (ON DELETE SET NULL)
    }
    const opened = this.d.terminals.open({ spaceId: s.spaceId, cwd: s.cwd, cols: 80, rows: 24 });
    this.d.sessions.setTerminalItem(id, opened.itemId);
    return opened;
  }

  /** Kill the session's terminal (pty + row + hidden item), if it has one. Tolerates a half-gone trio. */
  private closeTerminalItem(terminalId: string): void {
    try { this.d.terminals.close(terminalId); }
    catch (e) { if (!(e instanceof NotFoundError)) throw e; }
  }

  /** Dispose the live handle (if any) AND the session's terminal, then remove the item and the row (events cascade). */
  async delete(id: string): Promise<void> {
    const s = this.get(id);
    await this.stop(id);
    // The terminal belongs to the session: deleting the session must not leave its pty running.
    const term = s.terminalItemId ? this.d.items.get(s.terminalItemId) : null;
    if (term) this.closeTerminalItem(term.refId);
    const item = this.d.items.findByRefId(id);
    if (item) this.d.items.delete(item.id);
    this.d.sessions.delete(id);
    this.d.rpc.broadcast("items.changed", { spaceId: s.spaceId });
  }
  /** Delete every session in the space (used before space deletion). */
  async deleteAllInSpace(spaceId: string): Promise<void> {
    for (const s of this.d.sessions.list(spaceId)) await this.delete(s.id);
  }
  /** Shutdown: dispose live handles; rows/items stay so sessions resume next boot. */
  async closeAll(): Promise<void> {
    this.closing = true;
    for (const id of [...this.live.keys()]) await this.stop(id);
  }
  /**
   * Boot: no adapter survives a restart. Live statuses become idle; `ended` (an adapter that exited — after `error` on a
   * crash) is resumable when we hold a providerSessionId, otherwise it stays terminal. Permissions the user never
   * answered are closed with synthetic persisted denies so clients don't render stale cards.
   */
  markStaleOnBoot(): void {
    for (const s of this.d.sessions.listAll()) {
      for (const requestId of this.d.events.findDanglingPermissions(s.id)) this.persist(s.id, sessionEvent("permission_response", { requestId, decision: "deny" }));
      const resumable = s.status === "running" || s.status === "waiting_permission" || (s.status === "ended" && s.providerSessionId !== null);
      if (resumable) this.d.sessions.update({ id: s.id, status: "idle" });
    }
  }

  private async stop(id: string): Promise<void> {
    const l = this.live.get(id); if (!l) return;
    await l.handle.dispose();
    await l.pump; // pump ends when the adapter closes its event stream (right after `ended`)
    this.live.delete(id);
  }

  /** Append + bump last_event_seq atomically. */
  private persist(id: string, ev: SessionEvent): StoredSessionEvent {
    this.d.db.exec("BEGIN");
    try {
      const stored = this.d.events.append(id, ev);
      this.d.sessions.setLastEventSeq(id, stored.seq);
      this.d.db.exec("COMMIT");
      return stored;
    } catch (e) { this.d.db.exec("ROLLBACK"); throw e; }
  }

  /** The first message names an untitled session (and its sidebar item) — and, when that session
   *  runs in a worktree Realm opened before it had a name, its BRANCH too (W3). */
  private maybeTitleFrom(id: string, text: string): void {
    const s = this.d.sessions.get(id); if (!s || s.title !== defaultTitle(s.agentKind)) return;
    if (this.d.events.hasType(id, "user_message")) return;
    const title = titleFromMessage(text); if (!title) return;
    this.d.sessions.update({ id, title });
    const item = this.d.items.findByRefId(id);
    if (item) { this.d.items.update({ id: item.id, title }); this.d.rpc.broadcast("items.changed", { spaceId: item.spaceId }); }
    // Fire-and-forget: git work must never delay (or fail) the message that carried the title.
    // `renameBranch` swallows its own failures and returns null when any of its conditions says no.
    void this.renameWorktreeBranch(s.environmentId, title);
  }

  /** `realm/session` → `realm/fix-the-login-flow`, when the environment is a worktree whose branch
   *  is still the unnamed one and no remote carries it yet. Silent on every other path. */
  private async renameWorktreeBranch(environmentId: string, title: string): Promise<void> {
    try {
      const env = this.d.environments.get(environmentId);
      if (!env || env.kind !== "worktree" || !env.branch) return;
      const renamed = await this.d.worktrees.renameBranch({ path: env.path, branch: env.branch, title });
      if (!renamed) return;
      this.d.environments.setBranch(env.id, renamed);
      this.d.rpc.broadcast("environments.changed", { spaceId: env.spaceId });
    } catch { /* a branch name is a nicety; it never fails a turn */ }
  }

  /** Take the turn's checkpoint and tell clients a new one exists. Optional dependency: a server built
   *  without it (older tests, a stripped harness) simply does not checkpoint. */
  private async checkpointTurn(id: string, text: string): Promise<void> {
    const service = this.d.checkpoints; if (!service) return;
    const taken = await service.captureTurn(id, text, (line) => console.error(line));
    if (taken) this.d.rpc.broadcast("checkpoints.changed", { environmentId: taken.environmentId });
  }

  /** Whether any session in this environment holds a live adapter handle — what stops a restore
   *  rewriting a working tree under a running tool call. */
  isEnvironmentBusy(environmentId: string): boolean {
    for (const id of this.live.keys()) {
      if (this.d.sessions.get(id)?.environmentId === environmentId) return true;
    }
    return false;
  }

  /** Allocate the session's environment a port block if it has none yet (W2). Async, and therefore
   *  hoisted out of the sync `ensureLive`/`openTerminal` bodies into their callers. */
  private async ensurePorts(id: string): Promise<void> {
    const s = this.d.sessions.get(id); if (!s) return;
    await this.d.ports.ensureBlock(s.environmentId);
  }

  private ensureLive(id: string): AgentHandle {
    const existing = this.live.get(id); if (existing) return existing.handle;
    const s = this.get(id);
    const adapter = this.d.adapters[s.agentKind];
    if (!adapter) throw new RpcError("AGENT_UNAVAILABLE", `${s.agentKind} is not registered`);
    // The environment's port block, read back off the row that ensurePorts just settled: an agent
    // told to `pnpm dev` in a worktree starts on that worktree's ports, not on the space's.
    const env = this.d.environments.get(s.environmentId);
    // Realm's skills library, staged for this space and handed over per-invocation (W1). Null for an
    // agent that has no route for it and for a space with nothing enabled — and null must stay null
    // rather than becoming an empty root, because on Claude the option's presence is also what isolates
    // the session from the user's own settings.
    const skills = this.d.skills.injectionFor(s.spaceId, s.agentKind) ?? undefined;
    // This space's enabled MCP servers, resolved at start and handed over per-session (W2). Nothing is
    // written to `~/.claude.json`, `~/.codex/config.toml` or `~/.cursor/mcp.json` to get them there.
    //
    // This is the ONLY place API keys leave the database, and they go straight into `adapter.start` —
    // never onto an event, a broadcast or a log line. `onLog` below prints the SESSION id and the
    // provider's own output; it never sees this array.
    const mcpServers = this.d.mcp.configFor(s.spaceId);
    const handle = adapter.start({ cwd: s.cwd, model: s.model, effort: s.effort, permissionMode: s.permissionMode, mcpServers, resume: s.providerSessionId,
      skills,
      env: env ? portEnv(env) : {},
      onLog: (line) => console.error(`[session ${id.slice(-6)}] ${line}`) });
    const pump = (async () => {
      try { for await (const ev of handle.events) this.onEvent(id, ev); }
      catch (e) { console.error(`[sessions] pump failed for ${id}: ${e instanceof Error ? e.message : String(e)}`); }
      finally { if (this.live.get(id)?.handle === handle) this.live.delete(id); }
    })();
    this.live.set(id, { handle, pump });
    return handle;
  }

  private onEvent(id: string, ev: SessionEvent): void {
    if (this.closing) return; // shutdown: the row keeps its last real status; markStaleOnBoot resets it
    if (!this.d.sessions.get(id)) return; // deleted underneath a still-draining pump
    if (ev.type === "init") this.d.sessions.update({ id, providerSessionId: ev.payload.providerSessionId });
    if (ev.type === "status") {
      this.d.sessions.update({ id, status: ev.payload.status });
      this.d.rpc.broadcast("session.status", { sessionId: id, status: ev.payload.status });
    }
    if (PERSISTED_EVENT_TYPES.includes(ev.type)) {
      const stored = this.persist(id, ev);
      this.d.rpc.broadcast("session.event", { ...stored, ephemeral: false });
    } else {
      this.d.rpc.broadcast("session.event", { seq: -1, sessionId: id, event: ev, ephemeral: true });
    }
  }
}
