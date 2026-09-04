import { realpathSync } from "node:fs";
import { AGENT_META, AGENT_SKILL_SUPPORT, AGENT_SUPPORTS_PERMISSION_MODES, DEFAULT_PERMISSION_MODE_KEY, PERMISSION_MODES, PERSISTED_EVENT_TYPES, SkillIdSchema, elementContext, scanMentions, sessionEvent, stripMentionAts, type AgentKind, type ElementChip, type Environment, type Session, type SessionEvent, type StoredSessionEvent } from "@realm/contracts";
import type { AdapterRegistry, AgentHandle, PermissionDecision, ProbeResult, SkillMention, UserMessage } from "@realm/adapters";
import type { Db } from "../db/database";
import type { RpcServer } from "../rpc/server";
import type { ItemsStore } from "../store/items";
import type { ProjectsStore } from "../store/projects";
import type { SessionsStore, SessionEventsStore, SessionUpdate } from "../store/sessions";
import type { EnvironmentsStore } from "../store/environments";
import type { SpacesStore } from "../store/spaces";
import type { SettingsStore } from "../store/settings";
import type { TerminalService } from "../terminals/service";
import { NotFoundError, RpcError } from "../store/rows";
import { portEnv, type PortAllocator } from "../workspace/ports";
import type { WorktreeService } from "../workspace/worktrees";
import type { CheckpointService } from "../checkpoints/service";
import { ProbeCache } from "./probe-cache";
import type { SkillsService } from "../skills/service";
import type { McpGateway } from "../mcp/gateway";
import type { MemoryService } from "../memory/service";
import type { MemorySources } from "@realm/contracts";

const defaultTitle = (kind: AgentKind) => `${AGENT_META[kind].label} session`;
export const TITLE_MAX = 40;
/** First line of the message, whitespace-collapsed, clipped to TITLE_MAX. */
export function titleFromMessage(text: string): string {
  const line = text.trim().split("\n").find((l) => l.trim()) ?? "";
  const one = line.replace(/\s+/g, " ").trim();
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1).trimEnd()}…` : one;
}

export type CreateSessionInput = { spaceId: string; agentKind: AgentKind; projectId: string | null; environmentId?: string | null; model: string | null; effort: string | null; permissionMode: string | null; title?: string;
  /** Plan 13 W1: the dispatch origin recorded on the row when a delegation tool (or W2's dispatch
   *  gesture) creates the session. Absent/null for every user-created session — never defaulted. */
  dispatchedBy?: import("@realm/contracts").DispatchedBy | null };

/**
 * The permission mode a session starts in when its creator named none (Plan 12 W6) — every
 * instant-create path, which is every path there is since W3 retired the session sheet.
 *
 * `raw` is whatever sits under `DEFAULT_PERMISSION_MODE_KEY` and is treated as untrusted twice over:
 * it must be a real `PERMISSION_MODES` id (which excludes `"plan"` — a mode axis, not a permission),
 * and the agent must be one whose permission model Realm can actually set. An unsupported agent
 * (`AGENT_SUPPORTS_PERMISSION_MODES` false) starts on `"default"` no matter what is stored: its
 * adapter never reads the field, and a session row claiming `bypassPermissions` about an agent Realm
 * has no lever on would be a lie the composer's chip then repeats.
 */
export function resolveDefaultPermissionMode(kind: AgentKind, raw: unknown): string {
  if (!AGENT_SUPPORTS_PERMISSION_MODES[kind]) return "default";
  return PERMISSION_MODES.some((m) => m.id === raw) ? (raw as string) : "default";
}
/** `skillsInjected` remembers whether THIS handle was started with Realm's library — the fact mention
 *  resolution gates on, because a `/realm:<name>` prepend into a session that never loaded the plugin
 *  is a command that does not exist there. */
type Live = { handle: AgentHandle; pump: Promise<void>; skillsInjected: boolean };

/**
 * Owns the session trio: DB row + sidebar item + live adapter handle. Adapter handles are started lazily on the
 * first `send` (and restarted with `resume` after they end), so a persisted session survives server restarts.
 * Every adapter event (except deltas) is persisted with a global, monotonically increasing seq (unique across sessions;
 * clients page per session with `afterSeq`) and broadcast as `session.event`.
 */
/**
 * One message as the prompter hands it over. `elements` are the browser-pane elements the user picked
 * as chips: they never enter the transcript (which keeps what the user typed, chips and all) and are
 * appended, fenced, to the text the ADAPTER sees — the same split mentions already follow.
 */
export type SendMessage = { text: string; attachments: { path: string; mime: string }[]; mentions?: string[]; elements?: ElementChip[] };

export class SessionService {
  private live = new Map<string, Live>();
  private closing = false;
  constructor(private d: { db: Db; rpc: RpcServer; sessions: SessionsStore; events: SessionEventsStore; items: ItemsStore; spaces: SpacesStore; projects: ProjectsStore; environments: EnvironmentsStore; settings: SettingsStore; worktrees: WorktreeService; ports: PortAllocator; terminals: TerminalService; adapters: AdapterRegistry; skills: SkillsService; gateway: McpGateway; memory: MemoryService; checkpoints?: CheckpointService;
    /** Plan 11 W3: routes broker-owned permission requestIds (`bperm_…`) and cleans a deleted
     *  session's pending prompts + allow-always grants. Optional — a harness without browser tools
     *  behaves exactly as before. */
    browserPermissions?: { owns(requestId: string): boolean; resolve(requestId: string, decision: PermissionDecision): void; release(sessionId: string): void };
    /** Plan 11 W5 (+ Plan 13 W1): delegation hooks — in production one closure fanning out to BOTH
     *  delegation registries (browser-agent children and agent_run children). `parentInterrupted`
     *  cancels a session's in-flight delegated run when THAT session is interrupted; `release`
     *  forgets a deleted session's child record/run; `extraSystemContext` is the policy preamble a
     *  delegated child starts with; `skillsFilter` (optional, Plan 13 W1) narrows which of the
     *  space's enabled skills an agent_run child is staged — null/undefined for every other session.
     *  Optional — a harness without delegation behaves exactly as before. */
    browserAgents?: { parentInterrupted(sessionId: string): void; release(sessionId: string): void; extraSystemContext(sessionId: string): string | undefined; skillsFilter?(sessionId: string): string[] | null };
    /** Plan 12 W5: the notifications feed's session hooks. `handleSessionEvent` gets the session row as
     *  it stood BEFORE the event (so a status event carries its previous status implicitly); it is
     *  called from `onEvent` — the pump and `emitExternal` alike — and from `markStaleOnBoot`'s
     *  synthetic denies, so the feed reconciles on every path an answer can travel. `probeResults`
     *  feeds CLI availability regressions. Optional — a harness without it behaves exactly as before. */
    notifications?: { handleSessionEvent(session: Session, ev: SessionEvent): void; probeResults(results: ProbeResult[]): void };
    /** Upgrades the heuristic first-line title (`maybeTitleFrom`) to a short model-written summary.
     *  Optional and OFF by default: it is a real, billed LLM call on every session's first message,
     *  so only `main.ts`'s real server process wires it — every test and live-check script goes
     *  through `createApp` without it and gets the heuristic title only, never a live network call. */
    titleGenerator?: (text: string) => Promise<string>;
  }) {}

  /** Cached probe (TTL + in-flight dedup): each `probeAll` spawns a child process per registered agent,
   *  and the renderer asks on every prompter mount. `force` bypasses it — see ProbeCache. */
  private probeCache = new ProbeCache(() => this.probeAll());

  probe(opts: { force?: boolean } = {}): Promise<ProbeResult[]> { return this.probeCache.get(opts); }

  /** One adapter's probe throwing must not hide the others; it reports as unavailable with the reason. */
  async probeAll(): Promise<ProbeResult[]> {
    const adapters = Object.values(this.d.adapters);
    const results = await Promise.allSettled(adapters.map((a) => a.probe()));
    const probes = results.map((r, i): ProbeResult => r.status === "fulfilled" ? r.value
      : { kind: adapters[i]!.kind, available: false, version: null, loggedIn: null, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    // Every probe that actually ran reports here — the feed's agent_probe rows come from the same
    // results the install card renders, never from a second probe of their own.
    this.d.notifications?.probeResults(probes);
    return probes;
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
    // A named mode travels verbatim; null (the instant-create paths) is the user's configured default.
    const permissionMode = input.permissionMode ?? resolveDefaultPermissionMode(input.agentKind, this.d.settings.get(DEFAULT_PERMISSION_MODE_KEY));
    const session = this.d.sessions.create({ spaceId: input.spaceId, projectId: project?.id ?? null, agentKind: input.agentKind, model: input.model, effort: input.effort, permissionMode, environmentId: env.id, title, dispatchedBy: input.dispatchedBy ?? null });
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
  async send(id: string, msg: SendMessage): Promise<void> {
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
    // The transcript records what the USER wrote — `@mac` and all. Only the wire below is rewritten.
    this.onEvent(id, sessionEvent("user_message", { text: msg.text, attachments: msg.attachments }));
    await handle.send(this.resolveMentions(id, msg));
  }

  /**
   * `@`-mention resolution (Plan 8 W4). The one rule: a literal `@name` must never reach an agent —
   * `@` means nothing defined on any of the three wires. So every token the prompter declared as a
   * mention loses its `@` here (the id stays in place, keeping the sentence readable), whether or not
   * it still resolves — a skill disabled or deleted between typing and sending degrades to plain text.
   *
   * The FIRST declared mention that still holds up becomes the message's resolved skill; the rest stay
   * as de-@'d text (`turn/start` takes one skill item sanely, and `/realm:a /realm:b` is one command
   * plus literal text — a second resolution would silently not happen, which is the failure this plan
   * bans). "Holds up" means all of: it actually appears as a token in the text (the declared list is a
   * claim, not an instruction), the skill is currently enabled and valid in the session's space, the
   * agent has an injection route at all, and THIS live session was started with the library — a
   * `/realm:` prepend into a session that never loaded the plugin invokes nothing.
   */
  private resolveMentions(id: string, msg: SendMessage): UserMessage {
    const declared = [...new Set(msg.mentions ?? [])].filter((m) => SkillIdSchema.safeParse(m).success);
    const base = { text: msg.text + elementContext(msg.elements ?? []), attachments: msg.attachments };
    if (declared.length === 0) return base;
    const tokens = scanMentions(msg.text, declared);
    if (tokens.length === 0) return base;
    const text = stripMentionAts(msg.text, tokens) + elementContext(msg.elements ?? []);
    const s = this.get(id);
    let skill: SkillMention | undefined;
    if (AGENT_SKILL_SUPPORT[s.agentKind] === "injected" && this.live.get(id)?.skillsInjected) {
      const library = this.d.skills.list(s.spaceId).skills;
      for (const t of tokens) {
        const k = library.find((x) => x.id === t.id && x.enabled && x.valid);
        // The path goes out CANONICALIZED: Codex matches a skill input item against the skills it
        // discovered by resolved path, and silently ignores one it cannot place (proven live — a
        // `/var/...` path for a skill it knew as `/private/var/...` invoked nothing). realpath of the
        // library file is exactly what the staged symlink resolves to, so the two always agree.
        if (k) { skill = { id: k.id, name: k.name, path: this.canonical(k.path) }; break; }
      }
    }
    return { text, attachments: msg.attachments, ...(skill ? { skill } : {}) };
  }

  /** Best-effort realpath. A file that cannot be resolved (racing deletion) keeps its library path —
   *  a mention is a nicety, and a nicety never fails the message carrying it. */
  private canonical(path: string): string {
    try { return realpathSync(path); } catch { return path; }
  }

  /**
   * Deliver a message into a session FROM ANOTHER SESSION (Plan 20), interrupting its turn first when
   * its agent kind has no mid-turn injection route (`AGENT_MIDTURN_DELIVERY`).
   *
   * Deliberately NOT `send`, because `send` does three things that are each wrong here:
   *
   *  - `checkpointTurn` would capture a git checkpoint MID-EDIT — the peer may be halfway through
   *    writing files. That is precisely the race `send`'s own comment awaits to avoid ("a capture
   *    racing the agent's first write would record a tree that never existed"), and it would put one
   *    checkpoint per question into the environment's list.
   *  - `maybeTitleFrom` would rename an untitled peer after the QUESTION rather than its own work.
   *  - the `user_message` would go out unlabelled, so the peer's pane would show another agent's
   *    words as something the user typed.
   *
   * The `interrupt` below is the HANDLE's, not this class's: `SessionService.interrupt` also fires
   * `parentInterrupted`, which would cancel the target's OWN delegated run and kill its child. Callers
   * refuse a target that has a run in flight, so this is belt and braces — but the two must not be
   * the same call.
   *
   * Returns whether an interrupt actually happened, so the caller can say so truthfully rather than
   * assuming: a session that was not live had no turn to stop.
   */
  async deliverInterjection(id: string, msg: { text: string; from: { sessionId: string; title: string } },
    opts: { interruptFirst: boolean }): Promise<{ interrupted: boolean }> {
    // Read BEFORE ensureLive: a session whose row says `running` but whose handle died has nothing to
    // interrupt, and interrupting a handle we just started would abort a turn that never began.
    const wasLive = this.live.has(id);
    await this.ensurePorts(id);
    const handle = this.ensureLive(id);
    const interrupted = wasLive && opts.interruptFirst;
    if (interrupted) await handle.interrupt();
    this.onEvent(id, sessionEvent("user_message", { text: msg.text, attachments: [], from: msg.from }));
    await handle.send({ text: msg.text, attachments: [] });
    return { interrupted };
  }

  async interrupt(id: string): Promise<void> {
    this.get(id);
    // Interrupting a session also cancels its delegated browser-agent run (W5): the child is
    // interrupted and the blocked `browser_agent_run` call resolves as cancelled. BEFORE the handle
    // interrupt, and unconditional — the run wait lives in the gateway, not the adapter, so it must
    // be cancelled even when the parent's adapter process is already gone.
    this.d.browserAgents?.parentInterrupted(id);
    await this.live.get(id)?.handle.interrupt();
  }
  respondPermission(id: string, requestId: string, decision: PermissionDecision, answers?: Record<string, string>): void {
    this.get(id);
    // Browser-tool permission requests (Plan 11 W3) are raised by the SERVER, not the adapter — the
    // broker owns their requestIds and routes the answer back to the blocked tool call. Deliberately
    // BEFORE the live-handle check: the prompt blocks an MCP call inside the gateway, which stays
    // answerable even if the adapter process died while the card sat unanswered.
    if (this.d.browserPermissions?.owns(requestId)) { this.d.browserPermissions.resolve(requestId, decision); return; }
    const l = this.live.get(id);
    if (!l) throw new RpcError("SESSION_NOT_LIVE", "the agent is not running; the request is stale (send a message to resume)");
    l.handle.respondPermission(requestId, decision, answers);
  }

  /**
   * Persist + broadcast one event on a session's transcript from OUTSIDE its adapter pump — the
   * browser permission broker's `permission_request`/`permission_response`/`status` events (Plan 11
   * W3). Same `onEvent` path the pump uses, so persistence rules, status rows and broadcasts cannot
   * diverge between the two producers.
   */
  emitExternal(id: string, ev: SessionEvent): void {
    this.onEvent(id, ev);
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
   * Re-point a session that has not started yet at another environment (Plan 12 W1 — the under-strip's
   * workspace selector). Same authority and same guard as `setAgent`, for the same reason: one persisted
   * event ties the transcript to the checkout it ran in — its cwds, its turn checkpoints, its terminal —
   * and "moving" it afterwards would leave every one of those pointing at the wrong tree. The store's
   * `setEnvironment` owns the wrong-space refusal, mirroring `create`; `cwd` needs no touch at all,
   * because it is read off the environment row on every read.
   */
  setEnvironment(id: string, environmentId: string): Session {
    const s = this.get(id);
    if (s.environmentId === environmentId) return s;
    if (this.d.events.hasAny(id)) throw new RpcError("SESSION_STARTED", "this session has already run; it can no longer move to another checkout");
    return this.d.sessions.setEnvironment(id, environmentId);
  }

  /**
   * Move a session into another space (the sidebar's "Move to space…"). Unlike `setAgent`/`setEnvironment`
   * there is no started-guard, because the thing those guards protect is preserved here rather than
   * broken: a transcript is tied to the CHECKOUT it ran in, so a session that has run takes that
   * checkout with it (`carryEnvironment`) and its cwd never changes. Only the space does.
   *
   * The two cases differ in exactly one way, and the difference is the point:
   *  - **Never run** — nothing ties it to a checkout, so it lands on the destination's PRIMARY
   *    environment, wired identically to a session created fresh there (the same fallback a plain
   *    `create` with no environment named gets).
   *  - **Has run** — the destination adopts a row for the SAME path, so cwd, turn checkpoints, and
   *    the terminal panel all still name the tree the transcript describes.
   *
   * `projectId` is always cleared either way: projects are space-scoped rows, and the old one names
   * nothing in the destination.
   */
  moveToSpace(id: string, spaceId: string): Session {
    const s = this.get(id);
    if (s.spaceId === spaceId) return s;
    if (!this.d.spaces.get(spaceId)) throw new NotFoundError("space", spaceId);
    const env = this.d.events.hasAny(id)
      ? this.carryEnvironment(spaceId, s.environmentId)
      : this.d.environments.ensurePrimary(spaceId);
    // The session's terminal panel, if it was ever opened (openTerminal has no started-guard, so an
    // unstarted session can have a live pty too). Its pty was spawned AT a cwd, so it survives the
    // move exactly when that cwd does — otherwise it is torn down rather than left pointing at a tree
    // the session no longer runs in.
    const term = s.terminalItemId ? this.d.items.get(s.terminalItemId) : null;
    const keepTerminal = term !== null && env.path === s.cwd;
    if (term && !keepTerminal) this.closeTerminalItem(term.refId);
    this.d.db.exec("BEGIN");
    let updated: Session;
    try {
      updated = this.d.sessions.moveToSpace(id, spaceId, env.id, null);
      const item = this.d.items.findByRefId(id);
      if (item) this.d.items.moveToSpace(item.id, spaceId);
      // The hidden terminal item and its row follow the session, or the destination would own a
      // session whose terminal the ORIGIN space's deletion would kill.
      if (term && keepTerminal) { this.d.items.moveToSpace(term.id, spaceId); this.d.terminals.moveToSpace(term.refId, spaceId); }
      this.d.db.exec("COMMIT");
    } catch (e) { this.d.db.exec("ROLLBACK"); throw e; }
    // The origin space drops the item and the destination picks it up, the same two-broadcast shape
    // `delete`/`create` each use for their own single side of this.
    this.d.rpc.broadcast("items.changed", { spaceId: s.spaceId });
    this.d.rpc.broadcast("items.changed", { spaceId });
    return updated;
  }

  /**
   * The destination space's environment row for a checkout a moving session has already run in.
   * Environments are space-scoped (`environments_space_path` is UNIQUE per space, not globally), so
   * "the same checkout in another space" means a second row at the same path — which is legal, and is
   * what keeps the session's cwd stable across the move.
   *
   * The origin's row is deliberately left standing, per the store's stated lifecycle policy: nothing
   * removes an environment implicitly, and other sessions may still point at it. One consequence worth
   * naming: the port block does NOT travel (`environments_port_block` is UNIQUE, and the origin row
   * keeps its own), so the adopted row allocates a fresh block on the session's next send.
   */
  private carryEnvironment(spaceId: string, environmentId: string): Environment {
    const src = this.d.environments.get(environmentId);
    if (!src) return this.d.environments.ensurePrimary(spaceId); // row vanished underneath us; wire it like a fresh session
    const existing = this.d.environments.findByPath(spaceId, src.path);
    if (existing) return existing;
    // `primary` is a per-space singleton (`environments_one_primary`) that NAMES the space's own
    // folder, so a carried-over primary can only land as a plain `checkout` in the destination.
    return this.d.environments.create({
      spaceId, path: src.path, kind: src.kind === "primary" ? "checkout" : src.kind, branch: src.branch,
    });
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
    // `stop()` already released it via the pump's `finally` if the session was live — this is a
    // deliberately redundant, idempotent call for the case it was not (never started, or already
    // stopped): a deleted session's token must never remain valid.
    this.d.gateway.release(id);
    // Same idempotence: a deleted session's pending browser prompts resolve deny, its grants die.
    this.d.browserPermissions?.release(id);
    // And its browser-agent state (W5): as a parent, its run is cancelled; as a child, its persisted
    // record and act budget are forgotten — the restriction dies with the session.
    this.d.browserAgents?.release(id);
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
    for (const id of [...this.live.keys()]) { await this.stop(id); this.d.gateway.release(id); this.d.browserPermissions?.release(id); }
  }
  /**
   * Boot: no adapter survives a restart. Live statuses become idle; `ended` (an adapter that exited — after `error` on a
   * crash) is resumable when we hold a providerSessionId, otherwise it stays terminal. Permissions the user never
   * answered are closed with synthetic persisted denies so clients don't render stale cards.
   */
  markStaleOnBoot(): void {
    for (const s of this.d.sessions.listAll()) {
      // Read BEFORE the synthetic denies below append rows of their own — they carry `Date.now()`,
      // and dating the run's terminator at one of them would put the crash at boot time.
      const lastRealTs = this.d.events.lastTs(s.id);
      for (const requestId of this.d.events.findDanglingPermissions(s.id)) {
        const deny = sessionEvent("permission_response", { requestId, decision: "deny" });
        this.persist(s.id, deny);
        // A synthetic deny is still an answer: the feed's permission row must stop reading "pending"
        // the same way it would for a real one.
        this.d.notifications?.handleSessionEvent(s, deny);
      }
      // The row is reset below, but the EVENT LOG is what the transcript replays, and a session that
      // died mid-turn left `running` as its last word there. Nothing would ever close that run, so the
      // next turn's settle would report a span reaching back across the crash. The synthetic idle is
      // dated at the last event the log actually has, which is the last moment there is evidence the
      // agent was working — not now, which would count the hours the app was shut down.
      if (s.status === "running" || s.status === "waiting_permission") {
        this.persist(s.id, sessionEvent("status", { status: "idle" }, lastRealTs ?? Date.now()));
      }
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
    // Same fire-and-forget shape: the sidebar already has the raw-first-line title above, this just
    // swaps in a nicer one a little later, if a title generator is configured at all.
    if (this.d.titleGenerator) void this.upgradeTitle(id, title, text);
  }

  /** Replaces the heuristic title with a short model-written summary, once the model answers —
   *  but only if nothing has moved the title on since (a second message renamed it, or the user
   *  renamed it by hand): this must never clobber a title that is no longer the one it was asked
   *  to improve on. Checked on BOTH rows: a manual rename (`items.update`, `RenameInput.tsx`) only
   *  ever touches the item's title, never the session's, so the session-row check alone would miss it. */
  private async upgradeTitle(id: string, heuristicTitle: string, text: string): Promise<void> {
    try {
      const title = await this.d.titleGenerator!(text);
      const s = this.d.sessions.get(id); if (!s || s.title !== heuristicTitle) return;
      const item = this.d.items.findByRefId(id);
      if (item && item.title !== heuristicTitle) return;
      this.d.sessions.update({ id, title });
      if (item) { this.d.items.update({ id: item.id, title }); this.d.rpc.broadcast("items.changed", { spaceId: item.spaceId }); }
    } catch { /* a nicer title is a nicety; it never fails a turn */ }
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

  /**
   * What durable context this session's agent loads (memory.sources). The Codex report comes from THIS
   * session's own persisted `init` event and nowhere else — the store query is keyed by the session id,
   * which is what keeps one session's `instructionSources` from ever dressing up another's pane.
   */
  memorySources(id: string): MemorySources {
    const s = this.get(id);
    const skillsInjected = this.d.skills.wouldInject(s.spaceId, s.agentKind);
    let reported: string[] | null = null;
    if (s.agentKind === "codex") {
      const ev = this.d.events.lastOfType(id, "init");
      reported = ev?.type === "init" ? ev.payload.instructionSources ?? null : null;
    }
    return this.d.memory.sourcesFor({ kind: s.agentKind, spaceId: s.spaceId, cwd: s.cwd, skillsInjected, reported });
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
    // the session from the user's own settings. An agent_run child with a `skills` constraint (Plan 13
    // W1) stages the narrowed subset under its own session-keyed stage instead of the space's shared
    // one, so other live sessions' symlinked trees are never rebuilt out from under them.
    const only = this.d.browserAgents?.skillsFilter?.(id) ?? null;
    const skills = (only
      ? this.d.skills.injectionFor(s.spaceId, s.agentKind, { only, stageId: id })
      : this.d.skills.injectionFor(s.spaceId, s.agentKind)) ?? undefined;
    // The ONLY MCP config any agent ever receives (W3): one `realm` gateway entry, minted fresh per
    // session start by `gateway.register`. Third-party server endpoints, API keys and OAuth tokens never
    // leave realm-server — an agent reaches them only by proxy, through the Bearer token below, which
    // `onLog` (like every other log line here) never sees.
    const mcpServers = [this.d.gateway.register(id, s.spaceId)];
    // The session's durable context (W3): THIS space's Realm memory document, plus — when the skills
    // injection above is active on a Claude session — the CLAUDE.md content that `settingSources: []`
    // would otherwise silently drop. `skills !== undefined` is the same fact the adapter keys the
    // isolation on, so the re-injection can never disagree with it.
    const baseContext = this.d.memory.systemContextFor({ spaceId: s.spaceId, kind: s.agentKind, cwd: s.cwd, skillsInjected: skills !== undefined });
    // A delegated browser-agent child (W5) additionally carries its browsing-policy preamble —
    // appended AFTER the space's memory so the policy is the last (most binding) thing the agent
    // reads. Undefined for every ordinary session, leaving `systemContext` byte-identical to before.
    const agentContext = this.d.browserAgents?.extraSystemContext(id);
    const joined = [baseContext, agentContext].filter((p): p is string => Boolean(p)).join("\n\n");
    const systemContext = joined.length > 0 ? joined : undefined;
    let handle: AgentHandle;
    try {
      handle = adapter.start({ cwd: s.cwd, model: s.model, effort: s.effort, permissionMode: s.permissionMode, mcpServers, resume: s.providerSessionId,
        skills,
        systemContext,
        env: env ? portEnv(env) : {},
        onLog: (line) => console.error(`[session ${id.slice(-6)}] ${line}`) });
    } catch (e) {
      // `gateway.register` above already minted a token for this session before `adapter.start` had any
      // chance to fail — a throw here must not leave that token valid with no live session behind it
      // (it would otherwise sit there until the NEXT `ensureLive` call re-registers and revokes it,
      // which may be a while for a session nobody retries right away).
      this.d.gateway.release(id);
      throw e;
    }
    const pump = (async () => {
      try { for await (const ev of handle.events) this.onEvent(id, ev); }
      catch (e) { console.error(`[sessions] pump failed for ${id}: ${e instanceof Error ? e.message : String(e)}`); }
      finally { if (this.live.get(id)?.handle === handle) { this.live.delete(id); this.d.gateway.release(id); } }
    })();
    this.live.set(id, { handle, pump, skillsInjected: skills !== undefined });
    return handle;
  }

  private onEvent(id: string, ev: SessionEvent): void {
    if (this.closing) return; // shutdown: the row keeps its last real status; markStaleOnBoot resets it
    const before = this.d.sessions.get(id);
    if (!before) return; // deleted underneath a still-draining pump
    // BEFORE the status update below, so the hook sees the row's PREVIOUS status — a settle is a
    // transition, and only this side of the update still knows both ends of it.
    this.d.notifications?.handleSessionEvent(before, ev);
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
