import { realpathSync } from "node:fs";
import { AGENT_MEMORY_CHANNEL, AGENT_META, AGENT_SKILL_SUPPORT, AGENT_SUPPORTS_PERMISSION_MODES, DEFAULT_PERMISSION_MODE_KEY, MID_TURN_MODE_KEY, PERMISSION_MODES, PERSISTED_EVENT_TYPES, SkillIdSchema, elementContext, newId, sessionRefContext, resolveMidTurnMode, scanMentions, sessionEvent, steerInterrupts, stripMentionAts, type AgentKind, type ElementChip, type Environment, type SessionRef, type QueuedPrompt, type Session, type SessionEvent, type SessionEventPayload, type StoredSessionEvent } from "@realm/contracts";
import { CODEX_SANDBOX_REFUSAL, type AdapterRegistry, type AgentHandle, type PermissionDecision, type ProbeResult, type SkillMention, type UserMessage } from "@realm/adapters";
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
import { shouldSurfaceWrite } from "@realm/contracts";
import type { FailoverHooks } from "./failover";
import { portEnv, type PortAllocator } from "../workspace/ports";
import type { WorktreeService } from "../workspace/worktrees";
import type { CheckpointService } from "../checkpoints/service";
import { decodeArmedRewind, isRewindRefusal, type ArmedRewind } from "../checkpoints/rewind";
import { ProbeCache } from "./probe-cache";
import type { SkillsService } from "../skills/service";
import type { McpGateway } from "../mcp/gateway";
import { capabilitiesContext } from "../mcp/capabilities";
import type { MemoryService } from "../memory/service";
import type { ExecutionSandboxService } from "../sandbox/service";
import { sandboxWrapFor, type SpawnWrap } from "../sandbox/spawn-wrap";
import type { MemorySources } from "@realm/contracts";

/**
 * One message as the prompter hands it over. `elements` are the browser-pane elements the user picked
 * as chips: they never enter the transcript (which keeps what the user typed, chips and all) and are
 * appended, fenced, to the text the ADAPTER sees — the same split mentions already follow.
 */
export type SendMessage = { text: string; attachments: { path: string; mime: string }[]; mentions?: string[]; elements?: ElementChip[]; sessionRefs?: SessionRef[];
  /** Written by the session's own goal rather than typed. Rides to the transcript event and nowhere
   *  else: what the AGENT is handed is the same prompt either way. */
  goal?: "continuation" | "budget" };

/* The placeholder a session wears until its first message names it. Not "<Agent> session": the
 * agent is already shown on the row, and repeating it there says nothing about WHICH session this
 * is — which is the only question a title in a list of ten of them answers. */
const DEFAULT_TITLE = "New session";
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
  dispatchedBy?: import("@realm/contracts").DispatchedBy | null;
  /** No item row, and so no place in any list — see `sessions.create`'s schema. */
  unlisted?: boolean };

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
export class SessionService {
  private live = new Map<string, Live>();
  /**
   * Messages waiting for the current turn to end, oldest first, per session.
   *
   * In memory rather than in SQLite, deliberately. A queue exists only because a turn is in flight,
   * and after a restart none is — `markStaleOnBoot` has already put every row back to `idle`. A
   * persisted queue would therefore drain the moment the app came up, sending messages the user
   * queued yesterday and has stopped expecting. It survives what it needs to survive: a pane closed
   * and reopened, a window reloaded, a client disconnecting, all of which leave the server up.
   *
   * **The daemon settles this rather than reopening it.** Every case the queue needs to survive is
   * one where the server stays up, and a server that now outlives the app stays up through strictly
   * more of them — closing the window no longer ends the process at all. The only thing left that
   * clears this map is a real server restart, and after one there is no in-flight turn by
   * construction, so there is nothing a persisted queue could correctly drain into. If unsent text
   * is ever wanted across a restart it is drafts AND the queue together, restored as drafts — text
   * the user can look at and send — never as a queue that sends itself. Unsent text is already not
   * durable anywhere: `drafts` is renderer memory.
   */
  private queued = new Map<string, { prompt: QueuedPrompt; msg: SendMessage }[]>();
  /**
   * The truncating resume the CURRENT handle was booted with, per session — the in-memory half of a
   * restore's armed fork.
   *
   * The durable half is the session row (`rewind_fork_json`), which is what survives the restart
   * between a restore and the next send. This map is narrower and shorter-lived: it exists so the pump
   * can recognise the CLI's refusal as belonging to a fork THIS process asked for, and so it can name
   * the checkpoint whose cursor must then be forgotten. Empty for every session that has not just been
   * restored, which is nearly all of them.
   */
  private forkInFlight = new Map<string, ArmedRewind>();
  /**
   * The message a forked start carried, held only until that start proves itself.
   *
   * A fork refusal kills the turn before the agent sees a word of it, so without this the user's
   * message would be silently eaten by a recovery they never asked for. Set only when a fork is
   * actually in flight and dropped on the first sign the boot worked, so an ordinary session never
   * holds a copy of what it just sent.
   */
  private rewindTurns = new Map<string, SendMessage>();
  private closing = false;
  /** Set while the daemon is going quiet for a handoff. See `ensureLive` for the rule that matters. */
  private draining = false;
  constructor(private d: { db: Db; rpc: RpcServer; sessions: SessionsStore; events: SessionEventsStore; items: ItemsStore; spaces: SpacesStore; projects: ProjectsStore; environments: EnvironmentsStore; settings: SettingsStore; worktrees: WorktreeService; ports: PortAllocator; terminals: TerminalService; adapters: AdapterRegistry; skills: SkillsService; gateway: McpGateway; memory: MemoryService; checkpoints?: CheckpointService;
    /** Failover (fallbacks + forks). Optional so a server built without it behaves exactly as
     *  before: no retries, no handoffs, an error is an error. */
    failover?: FailoverHooks;
    /** The Seatbelt policy an agent CLI is spawned under. Optional so a harness built without it
     *  spawns exactly what Realm spawned before this feature existed. */
    sandbox?: ExecutionSandboxService;
    /** The documents service, for surfacing a file the agent wrote. Optional like every other
     *  nicety here: a server built without it simply shows nothing. */
    documents?: { openPath(p: { spaceId: string; environmentId?: string; path: string }): Promise<unknown> };
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
    /** Writes the model's account of a session when a turn settles (`SessionSummaryService`). Wired
     *  and gated for exactly the same reasons as `titleGenerator` above: it is a billed call, so only
     *  the real server process passes one, and it is `void`ed off the settle rather than awaited. */
    /** The settle's model-written fields — the summary and the prompter's hint, from one call. */
    summaries?: { onSettled(sessionId: string): Promise<void> };
    /** Where a `rate_limit` reading goes. Per agent KIND, not per session — see PlanLimitsService. */
    planLimits?: { apply(kind: AgentKind, reading: SessionEventPayload<"rate_limit">): void };
    /** Goal mode (`GoalService`), which is the one thing here that can start a turn nobody asked
     *  for. Optional and absent in most tests, exactly like the two above: a suite that never
     *  mentions goals must not have a session continue itself behind its back. */
    goals?: {
      onUsage(sessionId: string, reading: SessionEventPayload<"usage">): void;
      onError(sessionId: string): void;
      onSettled(sessionId: string, opts: { interrupted: boolean }): Promise<unknown>;
    };
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
  /** `null` = every profile. See `SessionsStore.listAll` for why the scoping is a join and not a filter. */
  listAll(profileId: string | null = null): Session[] { return this.d.sessions.listAll(profileId); }
  /** How far the user has read this session. See `sessions.markSeen` in the contract. */
  markSeen(id: string, seq: number): void { this.d.sessions.markSeen(id, seq); }
  /** Going quiet for a handoff: finish what is running, start nothing new. */
  setDraining(draining: boolean): void { this.draining = draining; }
  get(id: string): Session { const s = this.d.sessions.get(id); if (!s) throw new NotFoundError("session", id); return s; }
  events(id: string, afterSeq: number, limit: number): StoredSessionEvent[] { this.get(id); return this.d.events.listAfter(id, afterSeq, limit); }

  /* Two signatures for one function, because `unlisted` is the only thing that makes `itemId` null
     and every other caller may go on relying on it. An overload says that in the type instead of
     asking four call sites to assert it. */
  create(input: CreateSessionInput & { unlisted?: false }): { session: Session; itemId: string };
  create(input: CreateSessionInput): { session: Session; itemId: string | null };
  create(input: CreateSessionInput): { session: Session; itemId: string | null } {
    const space = this.d.spaces.get(input.spaceId); if (!space) throw new NotFoundError("space", input.spaceId);
    if (!this.d.adapters[input.agentKind]) throw new RpcError("AGENT_UNAVAILABLE", `${input.agentKind} is not registered`);
    const project = input.projectId ? this.d.projects.get(input.projectId) : null;
    if (input.projectId && !project) throw new NotFoundError("project", input.projectId);
    const env = this.resolveEnvironment(input.spaceId, input.environmentId ?? null, project?.rootPath ?? null);
    const title = input.title?.trim() || DEFAULT_TITLE;
    // A named mode travels verbatim; null (the instant-create paths) is the user's configured default.
    const permissionMode = input.permissionMode ?? resolveDefaultPermissionMode(input.agentKind, this.d.settings.get(DEFAULT_PERMISSION_MODE_KEY));
    const session = this.d.sessions.create({ spaceId: input.spaceId, projectId: project?.id ?? null, agentKind: input.agentKind, model: input.model, effort: input.effort, permissionMode, environmentId: env.id, title, dispatchedBy: input.dispatchedBy ?? null });
    /* An UNLISTED session gets no item, and so appears in no list anywhere — see `sessions.create`'s
       schema for what that is for. No broadcast either: nothing about this space's items changed,
       and telling every client otherwise would have them all re-fetch to find that out. */
    if (input.unlisted) return { session, itemId: null };
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

  /**
   * Emits `user_message` (persisted + broadcast) and hands the message to the adapter, starting it if
   * needed — unless a turn is already running, in which case what happens is the user's setting.
   *
   * `delivery` is the prompter's override of that setting for ONE message: `"steer"` is the chip's
   * send-now, `"queue"` is a queue asked for explicitly. `"auto"` — every internal caller, since the
   * delegation and run services send into children they have just created — reads the setting.
   */
  async send(id: string, msg: SendMessage, delivery: "auto" | "queue" | "steer" = "auto"): Promise<void> {
    // `waiting_permission` counts: the turn has not ended, it is blocked on a card the user has not
    // answered. The prompter draws both states the same way for the same reason, and a message typed
    // against an open permission card is the one most likely to be a correction.
    const status = this.d.sessions.get(id)?.status;
    const turnInFlight = status === "running" || status === "waiting_permission";
    if (turnInFlight) {
      const mode = delivery === "auto" ? resolveMidTurnMode(this.d.settings.get(MID_TURN_MODE_KEY)) : delivery;
      if (mode === "queue") { this.enqueue(id, msg); return; }
      await this.steer(id, msg);
      return;
    }
    await this.deliver(id, msg);
  }

  /**
   * Put a message at the back of the queue and tell the prompter.
   *
   * The `SendMessage` is kept whole beside the wire shape rather than rebuilt from it at drain time:
   * `mentions` and `elements` are part of what the user composed, and a queue that dropped them
   * would turn an `@skill` typed during a turn into plain text for no reason the user could see.
   */
  private enqueue(id: string, msg: SendMessage): void {
    const prompt: QueuedPrompt = { id: newId(), text: msg.text, attachments: msg.attachments, ts: Date.now() };
    this.queued.set(id, [...(this.queued.get(id) ?? []), { prompt, msg }]);
    this.broadcastQueue(id);
  }

  /**
   * Send into a running turn.
   *
   * The interrupt is the HANDLE's, for the reason `deliverInterjection` documents: this class's
   * `interrupt` also fires `parentInterrupted`, which would cancel a delegated run this session is
   * blocked on — and the user asked to redirect the agent, not to kill its child.
   *
   * `deliver` rather than a bare `handle.send` afterwards, because this message IS the user's and
   * earns everything a typed message earns — its `user_message` line, a title for an untitled
   * session. The one thing it does not earn is `deliver`'s checkpoint, which is why the capture is
   * skipped: the agent may be mid-write, and `send`'s own comment names that race ("a capture racing
   * the agent's first write would record a tree that never existed").
   */
  private async steer(id: string, msg: SendMessage): Promise<void> {
    if (steerInterrupts(this.get(id).agentKind)) await this.live.get(id)?.handle.interrupt();
    await this.deliver(id, msg, { checkpoint: false });
  }

  /**
   * Send the oldest queued message, if there is one. Called on the settle — the transition INTO idle
   * — which is the moment the turn that was blocking it ended.
   *
   * One message per settle, not the whole queue: each queued message is its own turn, and draining
   * three of them into one `handle.send` would merge three things the user asked separately. The next
   * settle takes the next one, which is also what keeps the queue draining if the user queues more
   * while a drained message is running.
   */
  private async drainQueue(id: string): Promise<void> {
    const [next, ...rest] = this.queued.get(id) ?? [];
    if (!next) return;
    if (rest.length === 0) this.queued.delete(id); else this.queued.set(id, rest);
    this.broadcastQueue(id);
    await this.deliver(id, next.msg);
  }

  /** What this session still has waiting to go out. Read by goal mode, which stands down when the
   *  user has typed something: their message is the next turn, and the goal picks up behind it. */
  queuedFor(id: string): { prompt: QueuedPrompt; msg: SendMessage }[] { return this.queued.get(id) ?? []; }

  /** Drop a queued message before its turn comes. An id the queue no longer holds is a no-op: the
   *  drain got there first, which is a race the prompter cannot win and should not have to. */
  dequeue(id: string, queuedId: string): void {
    this.get(id);
    const waiting = this.queued.get(id);
    if (!waiting) return;
    const left = waiting.filter((w) => w.prompt.id !== queuedId);
    if (left.length === waiting.length) return;
    if (left.length === 0) this.queued.delete(id); else this.queued.set(id, left);
    this.broadcastQueue(id);
  }

  /**
   * Send one queued message NOW, ahead of the turn it was waiting for — the chip's send-now.
   *
   * By id and through the server rather than by the prompter re-sending the text, because the queue
   * holds the whole `SendMessage` and the wire shape does not: an `@skill` typed during a turn would
   * come back as plain text if the prompter rebuilt the message from what it was shown.
   *
   * Routed through `send` rather than straight into `steer`, so a queue released after the turn has
   * already ended is an ordinary send instead of an interrupt of nothing.
   */
  async releaseQueued(id: string, queuedId: string): Promise<void> {
    this.get(id);
    const waiting = this.queued.get(id) ?? [];
    const held = waiting.find((w) => w.prompt.id === queuedId);
    if (!held) return; // the drain got there first
    const left = waiting.filter((w) => w !== held);
    if (left.length === 0) this.queued.delete(id); else this.queued.set(id, left);
    this.broadcastQueue(id);
    await this.send(id, held.msg, "steer");
  }

  queuedPrompts(id: string): QueuedPrompt[] {
    this.get(id);
    return (this.queued.get(id) ?? []).map((w) => w.prompt);
  }

  private broadcastQueue(id: string): void {
    this.d.rpc.broadcast("session.queue", { sessionId: id, queued: (this.queued.get(id) ?? []).map((w) => w.prompt) });
  }

  /** Everything a typed message earns on its way to the adapter. Reached only from `send` and from
   *  the two paths that have already chosen — a caller that came here has passed the queue gate. */
  private async deliver(id: string, msg: SendMessage, opts: { checkpoint?: boolean } = {}): Promise<void> {
    // Claim the environment's port block before the adapter can be spawned — `ensureLive` reads it
    // back off the row, so this is the only place the (async) allocation has to happen.
    await this.ensurePorts(id);
    // The turn's checkpoint (W4), captured BEFORE the message reaches the adapter and awaited rather
    // than fired off: a capture racing the agent's first write would record a tree that never existed.
    // It reports its own failures and returns null — a checkpoint is a safety net, and a safety net
    // that can refuse a message is a worse failure than not having one.
    if (opts.checkpoint !== false) await this.checkpointTurn(id, msg.text);
    const handle = this.ensureLive(id);
    // A start that carried a restore's fork can be refused at fork time, before the model sees a word
    // of this message — so the message is held until that boot proves itself, and re-sent plainly if it
    // does not. Only on this path: `deliverInterjection` and `resendTurn` do their own bookkeeping, and
    // a peer's question re-sent behind the user's back is not a recovery anyone asked for.
    if (this.forkInFlight.has(id)) this.rewindTurns.set(id, msg);
    // Recorded BEFORE the message goes out, because the failure this enables recovery from can
    // arrive on the very first event back. A new turn also clears the previous one's retry budget
    // and chain position — those are per-turn, not per-session.
    this.d.failover?.turnStarted(id, msg);
    this.maybeTitleFrom(id, msg.text);
    // The transcript records what the USER wrote — `@mac` and all. Only the wire below is rewritten.
    this.onEvent(id, sessionEvent("user_message", { text: msg.text, attachments: msg.attachments, ...(msg.goal ? { goal: msg.goal } : {}) }));
    await handle.send(this.resolveMentions(id, msg));
  }

  /**
   * Deliver a turn's message AGAIN, after a failover retry or a handoff (`FailoverService`).
   *
   * Deliberately not `send`, for three reasons that each matter:
   *  - no second `user_message`, because the user typed it once and a transcript that shows it twice
   *    is a transcript lying about what was asked;
   *  - no second checkpoint, because the tree has not moved since the first one and a checkpoint per
   *    retry would bury the real ones;
   *  - no `maybeTitleFrom`, which would re-title a session on text it already considered.
   *
   * `ensureLive` is what makes a handoff work at all: the row's `agentKind` has already been
   * rewritten by the time this runs, so this starts the NEW adapter.
   */
  async resendTurn(id: string, msg: SendMessage): Promise<void> {
    if (this.closing) return;
    if (!this.d.sessions.get(id)) return; // deleted while a backoff was pending
    await this.ensurePorts(id);
    const handle = this.ensureLive(id);
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
    // Both blocks ride the same way and in this order: what the user picked ON a page, then who
    // else they pointed at. Appended to the user's own text rather than sent as a system note,
    // because all three agent wires take one markdown string and nothing else.
    const context = elementContext(msg.elements ?? []) + sessionRefContext(msg.sessionRefs ?? []);
    const base = { text: msg.text + context, attachments: msg.attachments };
    if (declared.length === 0) return base;
    const tokens = scanMentions(msg.text, declared);
    if (tokens.length === 0) return base;
    const text = stripMentionAts(msg.text, tokens) + context;
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
    // A scheduled retry dies with the turn it belonged to. Resuming work somebody just cancelled is
    // the rudest thing failover could do, and the one that would make people turn it off.
    this.d.failover?.cancel(id);
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
  /**
   * Record what the reader thought of one answer. Goes down the same `onEvent` path as everything
   * else on the transcript, so it persists and broadcasts by the rules already in force and lands
   * in the panes showing this session without a second channel.
   *
   * `get` first, so a verdict on a session that no longer exists is a NOT_FOUND rather than an
   * orphan row the foreign key would have refused anyway.
   */
  recordFeedback(id: string, messageId: string, rating: "up" | "down" | null): void {
    this.get(id);
    this.onEvent(id, sessionEvent("feedback", { messageId, rating }));
  }
  async setOptions(id: string, o: { model?: string; effort?: string; permissionMode?: string; fastMode?: boolean }): Promise<Session> {
    const s = this.d.sessions.update({ id, ...o });
    // The row moves whether or not a process is live. A session that has not started yet keeps the
    // request in the column and hands it over at `start` (ensureLive reads the row), which is what
    // makes the switch mean the same thing before the first message as after it.
    await this.live.get(id)?.handle.setOptions({ model: o.model, permissionMode: o.permissionMode, fastMode: o.fastMode });
    return s;
  }

  /**
   * Re-point a session that has not started yet at another agent. Authoritative guard: one persisted
   * event is enough to lock the kind forever — a transcript, a providerSessionId and a resume are all
   * tied to the agent that produced them, so there is no coherent "switch" after the first message.
   * The client hides the affordance too, but this is the check that matters.
   *
   * `model` is cleared because model ids are per-kind (a `claude-opus-5` on a Codex session is a lie);
   * the new kind falls back to its adapter default until the user picks from its own model list. The
   * title is left alone — it used to be re-derived here, back when an untouched default read
   * "Claude session" and so would have named the wrong agent after the switch. DEFAULT_TITLE names
   * no agent, so there is nothing left to keep in step.
   */
  setAgent(id: string, agentKind: AgentKind): Session {
    const s = this.get(id);
    if (s.agentKind === agentKind) return s;
    if (!this.d.adapters[agentKind]) throw new RpcError("AGENT_UNAVAILABLE", `${agentKind} is not registered`);
    if (this.d.events.hasAny(id)) throw new RpcError("SESSION_STARTED", "this session has already run; its agent can no longer be changed");
    return this.d.sessions.update({ id, agentKind, model: null });
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
    // And its carried handoff context, plus any retry still on a timer.
    this.d.failover?.release(id);
    // Nothing left to send into. No broadcast: the session's own row is going away with it.
    this.queued.delete(id);
    // …and the rewind bookkeeping. The row carrying the durable half goes below; these two are what a
    // still-draining pump could otherwise read after the session it describes has stopped existing.
    this.forkInFlight.delete(id);
    this.rewindTurns.delete(id);
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
  /**
   * What the daemon would tell a person: how many sessions are mid-turn, and how many are stopped
   * waiting for an answer.
   *
   * Statuses rather than handles, deliberately. `liveCount` below is larger — a session keeps its
   * adapter handle after a turn ends, until the adapter itself exits — and "3 working" has to mean
   * three turns in flight, not three warm subprocesses.
   */
  statusCounts(): { working: number; needsYou: number } {
    let working = 0, needsYou = 0;
    for (const s of this.d.sessions.listAll()) {
      if (s.status === "running") working++;
      else if (s.status === "waiting_permission") needsYou++;
    }
    return { working, needsYou };
  }
  /**
   * How many sessions hold a live adapter handle right now.
   *
   * Counts handles, not rows — an idle session that has never been started holds none. But note what
   * it is NOT: a measure of activity. A handle lives until the adapter's own event stream ends, so a
   * session whose turn finished five minutes ago still has one. `statusCounts()` above is the number
   * that means "working", and it is the one the tray, the quit dialog and the drain all read.
   */
  liveCount(): number {
    return this.live.size;
  }
  /** Stop every live adapter handle, leaving the service up: the tray's *Stop all agents*. Rows and
   *  items stay exactly as they are, so each session resumes on its next send. */
  async stopAll(): Promise<number> {
    const ids = [...this.live.keys()];
    for (const id of ids) await this.stop(id);
    return ids.length;
  }
  /** Shutdown: dispose live handles; rows/items stay so sessions resume next boot. */
  async closeAll(): Promise<void> {
    this.closing = true;
    this.d.failover?.close();
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

  /**
   * Open a document the agent created, if it created one.
   *
   * Fire-and-forget and failure-tolerant by design: this is a nicety on the transcript's own event
   * rail, and a document that cannot be opened (deleted between the call and the result, outside the
   * workspace, a path the agent invented) must never disturb the turn that produced it.
   */
  private surfaceWrittenDocument(id: string, toolName: string, input: Record<string, unknown>): void {
    if (!this.d.documents) return;
    const path = shouldSurfaceWrite(toolName, input);
    if (path === null) return;
    const s = this.d.sessions.get(id); if (!s) return;
    void this.d.documents.openPath({ spaceId: s.spaceId, environmentId: s.environmentId, path })
      .catch(() => {});
  }

  /** Tear the live adapter down without touching the row — failover's handoff needs exactly this, and
   *  needs it BEFORE the row's `agentKind` moves: a handle outliving its own kind would keep pumping
   *  the old agent's events into a session that now claims to be another one. */
  async stopAgent(id: string): Promise<void> { await this.stop(id); }

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

  /**
   * Put an event Realm itself produced onto the session's rail.
   *
   * The summary service's only way in, and it goes through the SAME persist-then-broadcast the
   * agent's own events take — so a generated summary is stored, replayed on load and fanned out to
   * every open pane without a channel of its own. Silently drops when the session has been deleted
   * underneath a call that was already in flight, which is the ordinary end of a long one.
   */
  publishServerEvent(id: string, ev: SessionEvent): void {
    const row = this.d.sessions.get(id);
    if (!row) return;
    const stored = this.persist(id, ev);
    // The same hook the agent's own events go through. A generated event that skipped it would be on
    // the rail for the panes and invisible to everything that LISTENS to the rail — which is how the
    // summary would have reached the transcript and never reached the notification about it.
    this.d.notifications?.handleSessionEvent(row, ev);
    this.d.rpc.broadcast("session.event", { ...stored, ephemeral: false });
  }

  /** The first message names an untitled session (and its sidebar item) — and, when that session
   *  runs in a worktree Realm opened before it had a name, its BRANCH too (W3). */
  private maybeTitleFrom(id: string, text: string): void {
    const s = this.d.sessions.get(id); if (!s || s.title !== DEFAULT_TITLE) return;
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

  /** The Seatbelt wrapper this session's agent CLI is spawned through, or `undefined` when its space
   *  has no sandbox (see `sandboxWrapFor`).
   *
   *  `extraWritableRoots: [s.cwd]` because the session's own checkout must be writable even when it is
   *  not one of the space's registered environments — a session pointed at a folder Realm has not
   *  catalogued would otherwise be confined out of the very directory it was opened on. */
  private wrapFor(s: Session): SpawnWrap | undefined {
    return sandboxWrapFor(this.d.sandbox, { spaceId: s.spaceId, extraWritableRoots: [s.cwd] });
  }

  private ensureLive(id: string): AgentHandle {
    const existing = this.live.get(id); if (existing) return existing.handle;
    // The load-bearing refusal of a drain (Plan 26 Phase 8). A handle that is ALREADY running is
    // fine: the child has exec'd, and the inode survives `install-local.mjs` deleting the bundle
    // under it. Starting a cold one is not — it would exec a path that no longer exists.
    if (this.draining) throw new RpcError("DAEMON_DRAINING", "Realm is finishing an update — this session will start again in a moment");
    const s = this.get(id);
    const adapter = this.d.adapters[s.agentKind];
    if (!adapter) throw new RpcError("AGENT_UNAVAILABLE", `${s.agentKind} is not registered`);
    // The space's Seatbelt policy, resolved before anything else is allocated so a refusal costs
    // nothing to unwind. `undefined` for a space on `off`, which is what this release ships: no
    // wrapper is installed at all, and every adapter below spawns exactly the argv it always did.
    // See `TerminalService.wrapFor` for the same reasoning at the other spawn site.
    const wrap = this.wrapFor(s);
    // Codex, and only Codex, refuses rather than running unconfined. `CodexAdapter.start` throws on
    // a `wrap` it cannot honour, and this is the same refusal one step earlier — before a gateway
    // token has been minted for a session that will not exist, and as an `RpcError` whose code the
    // renderer can branch on. Both exist on purpose: this one is the refusal a user meets, and the
    // adapter's is the one that holds for any OTHER caller that ever starts a Codex session.
    if (wrap && s.agentKind === "codex") throw new RpcError("SANDBOX_AGENT_UNSUPPORTED", CODEX_SANDBOX_REFUSAL);
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
    // A session that was handed over mid-turn carries the previous agent's conversation as written
    // text. LAST, so it is the most recent thing the incoming agent reads — and re-injected on every
    // start rather than sent once, because the adapter it is briefing can be restarted at any time.
    const handoffContext = this.d.failover?.extraSystemContext(id);
    // What Realm's own tools are for, named while the agent is still planning rather than left to be
    // discovered in a tool list it may never read (capabilities.ts). FIRST in the join: it is the most
    // general thing in the prompt, and the user's memory documents must be able to overrule it.
    //
    // Skipped for a session that already carries `agentContext` — a delegated child, a reviewer, an
    // unattended worker. Each of those was spawned with a brief written for one job, and generic advice
    // about spawning MORE agents beside a brief that just told it how deep it may go is noise at best.
    // Also skipped where the agent has no context channel at all, the same honesty `systemContextFor`
    // applies: Cursor's ACP session/new takes no per-session context, so this would be told to nobody.
    const capabilities = agentContext || AGENT_MEMORY_CHANNEL[s.agentKind] === "none"
      ? undefined
      : capabilitiesContext(this.d.gateway.realmProvidersFor(id, s.spaceId));
    const joined = [capabilities, baseContext, agentContext, handoffContext].filter((p): p is string => Boolean(p)).join("\n\n");
    const systemContext = joined.length > 0 ? joined : undefined;
    // The fork a checkpoint restore armed, if one is still waiting. Read off the ROW and not from
    // memory: a restore is refused while any handle in the checkout is live, so the arm is by
    // construction consumed by a later start — often a later PROCESS — and an in-memory one would be
    // dropped by the first restart between the two.
    //
    // Dropped rather than carried when the session holds no provider session id: there is no
    // conversation to truncate, and `resumeSessionAt` without `resume` means nothing.
    const fork = s.providerSessionId ? decodeArmedRewind(this.d.sessions.rewindFork(id)) : null;
    // The two extra options travel structurally — only `ClaudeAdapter` reads them, and only Claude has
    // anywhere to put them (see ClaudeResumeFork). Built as a variable rather than inline so the extra
    // pair is declared where it is passed instead of being an unchecked cast at the call.
    const startOptions: import("@realm/adapters").StartOptions & { resumeAt?: string | null; resumeDropsTurn?: string | null } = {
      cwd: s.cwd, model: s.model, effort: s.effort, permissionMode: s.permissionMode, fastMode: s.fastMode, mcpServers, resume: s.providerSessionId,
      skills,
      systemContext,
      // The port block, plus `REALM_SANDBOX*` — a statement of the posture this process was started
      // under, for a log line or a bug report to read. Nothing reads them back.
      env: { ...(env ? portEnv(env) : {}), ...this.d.sandbox?.env(s.spaceId) },
      ...(wrap ? { wrap } : {}),
      ...(fork ? { resumeAt: fork.at, resumeDropsTurn: fork.dropsTurn } : {}),
      onLog: (line) => console.error(`[session ${id.slice(-6)}] ${line}`),
    };
    let handle: AgentHandle;
    try {
      handle = adapter.start(startOptions);
    } catch (e) {
      // `gateway.register` above already minted a token for this session before `adapter.start` had any
      // chance to fail — a throw here must not leave that token valid with no live session behind it
      // (it would otherwise sit there until the NEXT `ensureLive` call re-registers and revokes it,
      // which may be a while for a session nobody retries right away).
      this.d.gateway.release(id);
      throw e;
    }
    if (fork) {
      // Disarmed the moment the process carrying it exists, and not before. The boot is where the
      // truncation happens, so there is nothing left for a later start to do — while leaving the row
      // armed would re-fork a chain that has since moved on. A `start` that THREW keeps the arm, which
      // is why this sits after the try: nothing was asked of the provider in that case.
      this.d.sessions.setRewindFork(id, null);
      this.forkInFlight.set(id, fork);
    }
    const pump = (async () => {
      try { for await (const ev of handle.events) this.onEvent(id, ev); }
      catch (e) { console.error(`[sessions] pump failed for ${id}: ${e instanceof Error ? e.message : String(e)}`); }
      finally { if (this.live.get(id)?.handle === handle) { this.live.delete(id); this.d.gateway.release(id); } }
    })();
    this.live.set(id, { handle, pump, skillsInjected: skills !== undefined });
    return handle;
  }

  /**
   * The conversation half of a checkpoint restore, called by `CheckpointService` once the WORKSPACE is
   * already back (`CheckpointDeps.rewindSession`).
   *
   * Two writes, and they are one fact: Realm's transcript loses everything after the checkpoint, and
   * the session's next adapter start is armed to resume the provider conversation at the same point.
   * Neither happens without the other — a transcript truncated alone hides turns the model would still
   * be carrying, which is the lie `AGENT_CONVERSATION_REWIND` exists to refuse.
   *
   * Refuses while the session holds a live handle, and that refusal is not redundant with
   * `CheckpointService`'s environment-busy check: that one guards the checkout, this one guards the
   * arm. The fork is honoured at BOOT, so a live handle would mean a truncated transcript above a
   * conversation nothing is ever going to truncate.
   */
  rewindConversation(input: { sessionId: string; throughSeq: number; fork: string }): boolean {
    if (!this.d.sessions.get(input.sessionId)) return false;
    if (this.live.has(input.sessionId)) return false;
    this.d.events.truncate(input.sessionId, input.throughSeq);
    this.d.sessions.setRewindFork(input.sessionId, input.fork);
    return true;
  }

  /**
   * A turn settled: hand the checkpoint service the provider's chain position, and retire the fork that
   * survived to get here.
   *
   * The cursor is read off the HANDLE, because it is the only thing that ever saw the chain — Realm's
   * own transcript records what was said, not the uuids the provider filed it under. Adapters that have
   * no chain to report simply have no `chainCursor`, and this then records nothing rather than a
   * fabricated position: the structural check is the honest form of "this agent cannot be rewound", the
   * same fact `AGENT_CONVERSATION_REWIND` states statically.
   *
   * Reaching this at all means a forked boot produced a complete turn, so the fork is retired here:
   * the refusal arrives instead of a settle, never after one.
   */
  private noteTurnCursor(id: string, before: Session): void {
    this.forkInFlight.delete(id);
    this.rewindTurns.delete(id);
    if (!this.d.checkpoints) return;
    const handle = this.live.get(id)?.handle as (AgentHandle & { chainCursor?: () => { promptUuid: string | null; endUuid: string | null } }) | undefined;
    const chain = handle?.chainCursor?.();
    if (!chain) return;
    this.d.checkpoints.noteTurnCursor(id, { providerSessionId: before.providerSessionId, ...chain });
  }

  /**
   * The provider refused the fork — the one documented failure of a truncating resume.
   *
   * The refusal is deterministic: the CLI validated that everything past the fork point belonged to the
   * declared turn, found something that did not, and will find it again every time. So this recovers
   * and never retries:
   *
   *  1. the checkpoint's cursor is forgotten, so `rewindsConversation` stops promising a rewind that
   *     this checkpoint can no longer deliver and nothing can arm the same request twice;
   *  2. the refusal is written onto the session verbatim — the CLI's own diagnostic names what it found
   *     in the discarded range, and Realm has nothing better to say than that;
   *  3. the handle booted with the refused fork is torn down and the turn re-sent plainly, because the
   *     refusal happened at fork time and the user's message never reached the model at all.
   *
   * `false` when this was not a fork refusal, which is how the caller knows to let the error travel its
   * ordinary road (failover included).
   */
  private handleRewindRefusal(id: string, message: string): boolean {
    const fork = this.forkInFlight.get(id);
    if (!fork || !isRewindRefusal(message)) return false;
    this.forkInFlight.delete(id);
    const held = this.rewindTurns.get(id);
    this.rewindTurns.delete(id);
    this.d.checkpoints?.forgetProviderCursor(fork.checkpointId);
    this.d.sessions.recordRewindRefusal(id, message);
    console.error(`[sessions] rewind refused for ${id}; resuming plainly: ${message}`);
    // Off the pump: `stop` waits on the very loop this is being called from, so awaiting it here would
    // be waiting on ourselves. The dispose is not optional — the CLI refused at boot, so the process
    // this handle wraps has no usable conversation to send into.
    void (async () => {
      await this.stop(id).catch(() => {});
      if (held && !this.closing) await this.resendTurn(id, held).catch(() => {});
    })();
    return true;
  }

  /**
   * Say so when the agent under the transcript cannot read it.
   *
   * A resume that silently starts a fresh thread under an old conversation is the one lie this whole
   * area exists to remove: everything above stays on screen, looking for all the world like context
   * the agent has, and the agent has none of it.
   *
   * The predicate is narrow on purpose. The row must ALREADY have held a provider session id — that
   * is what makes "we asked to continue" true — and the adapter must have reported that the ask did
   * not succeed. A first boot has nothing to continue; an adapter that reports nothing is not made to
   * confess something Realm cannot see.
   *
   * Failover needs no special case: it clears the token BEFORE the restart, so there is no id to have
   * been refused and `handoff` is the only seam that speaks there.
   */
  private noteContextReset(before: Session, init: SessionEventPayload<"init">): void {
    if (before.providerSessionId === null) return;
    if (init.resumeOutcome !== "declined" && init.resumeOutcome !== "unsupported") return;
    const label = AGENT_META[before.agentKind]?.label ?? before.agentKind;
    // Persisted and broadcast directly rather than through `onEvent`, which is mid-flight above us.
    // It lands BEFORE the `init` that prompted it, which is the order a reader wants: the seam, then
    // the session that starts after it.
    const stored = this.persist(before.id, sessionEvent("context_reset", {
      agent: before.agentKind,
      reason: init.resumeOutcome,
      // One sentence, built here so every surface tells it identically — the transcript, and anything
      // that later reads the event log. It says what is still true before it says what is not.
      note: `This agent could not continue the earlier conversation. Everything above is still here; ${label} starts from your next message.`,
    }));
    this.d.rpc.broadcast("session.event", { ...stored, ephemeral: false });
  }

  private onEvent(id: string, ev: SessionEvent): void {
    if (this.closing) return; // shutdown: the row keeps its last real status; markStaleOnBoot resets it
    const before = this.d.sessions.get(id);
    if (!before) return; // deleted underneath a still-draining pump
    // BEFORE the status update below, so the hook sees the row's PREVIOUS status — a settle is a
    // transition, and only this side of the update still knows both ends of it.
    this.d.notifications?.handleSessionEvent(before, ev);
    if (ev.type === "init") {
      this.noteContextReset(before, ev.payload);
      this.d.sessions.update({ id, providerSessionId: ev.payload.providerSessionId });
    }
    // A refused truncating resume is claimed here FIRST, and deliberately kept away from failover: the
    // refusal is deterministic, so every retry mechanism in the building would re-send a request that
    // can only fail again. It is still persisted below — the CLI's diagnostic is the evidence, and
    // hiding it would leave the plain resume that follows with nothing to explain it.
    const rewindRefused = ev.type === "error" && this.handleRewindRefusal(id, ev.payload.message);
    // Failover reads the error BEFORE it is persisted below, but does not suppress it: the failure
    // genuinely happened, and a transcript that hid it would leave the following `retrying` or
    // `handoff` line with nothing to explain. `before` is the row as it was when the turn failed —
    // the handoff rewrites `agentKind`, so reading it afterwards would name the wrong agent.
    if (ev.type === "error" && !rewindRefused) this.d.failover?.onError(before, ev.payload.message);
    // …and goal mode hears about it too: three errored turns in a row is what stops a goal from
    // continuing into a wall it cannot see (a missing CLI errors and settles in milliseconds).
    // Same exemption: the turn is being re-sent plainly, so it has not failed yet.
    if (ev.type === "error" && !rewindRefused) this.d.goals?.onError(id);
    /* A document the agent just WROTE gets shown.
     *
     * This is the gap behind "I asked for a doc and the docs pane never opened": Realm knew about
     * the file the moment the tool call landed and did nothing with it, so a document you asked for
     * arrived as a line of grey text naming a path. `documents.openPath` is the same call the docs
     * agent tool makes, and it broadcasts `documents.openRequested`, which the renderer already
     * knows how to land quietly beside the session.
     *
     * Narrow on purpose (`shouldSurfaceWrite`): a CREATED file, of a kind the pane can render. An
     * edit across twenty files must not open twenty tabs, and a `.ts` does not belong behind a
     * rich-text editor. */
    if (ev.type === "tool_call") this.surfaceWrittenDocument(id, ev.payload.name, ev.payload.input);
    // Not persisted and not this session's: the reading describes the ACCOUNT behind every session on
    // this agent, so it is folded into per-kind state and never into the transcript.
    if (ev.type === "rate_limit") this.d.planLimits?.apply(before.agentKind, ev.payload);
    // A goal's budget is spent by tokens rather than by turns, and this event is where a turn's cost
    // is reported. Counted even on a turn that errored: the tokens were still spent.
    if (ev.type === "usage") this.d.goals?.onUsage(id, ev.payload);
    if (ev.type === "status") {
      this.d.sessions.update({ id, status: ev.payload.status });
      this.d.rpc.broadcast("session.status", { sessionId: id, status: ev.payload.status });
      // A SETTLE, not any status: the transition out of a live state is the moment the transcript
      // stops moving, and it is the only one worth summarizing. Fired after the events of the turn
      // are persisted below on their own passes — the summary reads the log, so it must not run
      // until the log is the log. `void`, because a turn is never held up for a nicety.
      if (ev.payload.status === "idle" && before.status !== "idle") {
        // Where the provider's chain now stands, taken on the settle and nowhere else: this is the one
        // moment the answer is complete (the turn's `result` has been mapped) and not yet overwritten
        // (the next turn has not begun). Synchronous and first, ahead of every `void` below — one of
        // those starts the next turn, and a cursor read after that would describe the wrong one.
        this.noteTurnCursor(id, before);
        void this.d.summaries?.onSettled(id);
        /* The turn that was blocking the queue just ended — unless the USER ended it, in which case
         * the queue stays parked. Stop has to mean stop: a queued message that started a fresh turn
         * a moment after the button was pressed would read as the button not working. The messages
         * are not thrown away either, which would lose text the user wrote — they keep their chips,
         * and the send-now on each is how the user releases one deliberately.
         *
         * `void` for the same reason the summary is: this runs inside the adapter pump, and awaiting
         * a send here would hold the pump open across the next turn's first events. */
        if (!ev.payload.interrupted) void this.drainQueue(id).catch(() => {});
        /* …and then the goal, if this session is pursuing one. AFTER the drain and never instead of
           it: a message the user typed during the turn is the next turn, and the goal picks up
           behind it (`GoalService.onSettled` sees the queue and stands down). `void` for the
           reason above — this runs inside the adapter pump, and a continuation's own first events
           must not be waited for from inside it. */
        void this.d.goals?.onSettled(id, { interrupted: ev.payload.interrupted === true }).catch(() => {});
      }
    }
    if (PERSISTED_EVENT_TYPES.includes(ev.type)) {
      const stored = this.persist(id, ev);
      this.d.rpc.broadcast("session.event", { ...stored, ephemeral: false });
    } else {
      this.d.rpc.broadcast("session.event", { seq: -1, sessionId: id, event: ev, ephemeral: true });
    }
  }
}
