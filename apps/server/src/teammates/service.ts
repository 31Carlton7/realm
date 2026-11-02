import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  AGENT_META, DEFAULT_MODEL_LABEL, TEAMMATE_CLOCK_TURN_MS, TEAMMATE_PERMISSION_MODES, TEAM_MESSAGE_WAIT_MS, TeamMessageArgsSchema, fenceAgentOutput, normalizeHandle, sessionLink, teammateHandle, teammateIconFromSeed,
  type CreateTeammateInput, type MentionRef, type ReorderTeammatesInput, type Schedule, type Session, type SessionEvent, type SessionStatus, type Teammate,
  type TeammatePermissionMode, type TeammateSchedule, type TeammateState, type TeammateTaskSession, type UpdateTeammateInput,
} from "@realm/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderCallContext } from "../mcp/gateway";
import { clip, err, ok, parseArgs } from "../mcp/tool-result";
import type { RpcServer } from "../rpc/server";
import type { SessionService } from "../sessions/service";
import type { DelegationEngine, ActiveRun } from "../delegation/engine";
import type { ScheduleService } from "../schedules/service";
import type { EnvironmentsStore } from "../store/environments";
import type { SpacesStore } from "../store/spaces";
import { NotFoundError, RpcError } from "../store/rows";
import type { TeammateRow, TeammateSessionRow, TeammatesStore } from "./store";

/** How many task sessions a teammate's row carries; its page asks `teammates.sessions` for the rest. */
const ROW_TASKS = 20;
/** How long `team_message` waits for its message to come off the target's queue and be answered. */
const DEFAULT_TIMEOUTS = { waitMs: TEAM_MESSAGE_WAIT_MS, pollMs: 250 };

const LIVE: ReadonlySet<SessionStatus> = new Set(["running", "waiting_permission"]);

/** The state one session puts its teammate in. */
const stateOf = (status: SessionStatus): TeammateState =>
  status === "waiting_permission" ? "needs-you" : status === "running" ? "working" : "idle";

/** The louder of two states: someone waiting on the person outranks work going on. */
const louder = (a: TeammateState, b: TeammateState): TeammateState =>
  a === "needs-you" || b === "needs-you" ? "needs-you" : a === "working" || b === "working" ? "working" : "idle";

const firstLine = (s: string): string => s.trim().split("\n").find((l) => l.trim())?.trim() ?? "";

/** What Realm adds under a clock's prompt for the agent. The transcript keeps it out of the bubble. */
const CLOCK_NOTE = "[Realm] Your schedule sent this, not the person, and nobody is watching: they will read this chat later. Do real work in a task session as you always do, and end with a short report of what you did, linking the sessions that did it. If you need the person, say so plainly at the end.";

/** A `team_message` with `wait` in flight: who is waiting (a teammate, or a session of the person's) on
 *  which teammate. The edges `team_message` refuses to close into a cycle. */
type Wait = { from: string; to: string };

/** A clock's turn in a home session: on its way (`sending`), queued, or begun (`timer` armed). */
type ClockTurn = { scheduleId: string; sending: boolean; timer: ReturnType<typeof setTimeout> | null };

/**
 * Teams v2: teammates, their home sessions, and the two tools they talk to each other with.
 *
 * A teammate's chat is an ordinary session (`teammateHome`), made the first time anyone needs it and
 * told who it is on every start (`contextFor`). Its work is the sessions its agent starts with
 * `agent_start`, which `AgentRunService` tags with the teammate and runs in its mode (`childOf`). A
 * message from another teammate is a turn in the home session, queued behind a live one by the
 * session's own queue; one sent with `wait` holds the sender's call until that turn ends, through the
 * delegation engine's registry and its transcript read, as `agent_ask` does.
 *
 * A teammate may have a clock (`TeammateSchedule`). When it fires, its prompt is a turn in the home
 * session like anyone else's message, marked as the clock's and run in the teammate's mode. One clock
 * turn at a time: an occurrence that comes while the last is still queued or going is skipped, and a
 * turn still going after `TEAMMATE_CLOCK_TURN_MS` is stopped, leaving the task sessions it started.
 */
export class TeammatesService {
  /** When each teammate's state last moved, for "Working · 4m". In memory: a restart starts the clock. */
  private readonly since = new Map<string, { state: TeammateState; at: number }>();
  /** The session that handed each home session the turn it is on, so a task it starts nests under it. */
  private readonly askedBy = new Map<string, string | null>();
  private readonly waits = new Map<object, Wait>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** By home session. In memory, like the session's queue it waits in: a restart clears both. */
  private readonly clockTurns = new Map<string, ClockTurn>();

  constructor(private readonly d: {
    store: TeammatesStore;
    spaces: Pick<SpacesStore, "get">;
    environments: Pick<EnvironmentsStore, "ensurePrimary" | "ensureAt">;
    sessions: Pick<SessionService, "create" | "get" | "send" | "setOptions" | "events" | "retitleIf" | "queuedFor" | "interrupt">;
    engine: Pick<DelegationEngine, "begin" | "end" | "awaitAnswer" | "parentInterrupted">;
    schedules: Pick<ScheduleService, "forTeammate" | "setForTeammate">;
    rpc: Pick<RpcServer, "broadcast">;
    /** The mode a new session starts in on `kind` when nobody named one (Settings' default). */
    defaultMode: (kind: Session["agentKind"]) => string;
    /** The team tools came or went in a space: sessions re-read their tool lists. */
    toolsChanged?: () => void;
    timeouts?: { waitMs: number; pollMs: number };
    /** How long a clock's turn may run (`TEAMMATE_CLOCK_TURN_MS`); shortened by tests. */
    clockTurnMs?: number;
  }) {}

  close(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    for (const c of this.clockTurns.values()) if (c.timer) clearTimeout(c.timer);
    this.clockTurns.clear();
  }

  /* ──────────────────────────────── reads ──────────────────────────────── */

  list(spaceId: string, archived = false): Teammate[] {
    if (!this.d.spaces.get(spaceId)) throw new NotFoundError("space", spaceId);
    const rows = this.d.store.list(spaceId, archived);
    if (rows.length === 0) return [];
    const sessions = this.d.store.sessions(spaceId);
    return rows.map((r) => this.view(r, sessions));
  }

  get(id: string): Teammate {
    const row = this.row(id);
    return this.view(row, this.d.store.sessions(row.spaceId));
  }

  /** Every session it started, and the ones handed on from them, newest first. */
  sessions(id: string): TeammateTaskSession[] {
    const row = this.row(id);
    return this.tasks(row, this.d.store.sessions(row.spaceId));
  }

  private row(id: string): TeammateRow {
    const row = this.d.store.get(id);
    if (!row) throw new NotFoundError("teammate", id);
    return row;
  }

  private folderOf(row: Pick<TeammateRow, "spaceId" | "folder">): string {
    return row.folder ?? this.d.spaces.get(row.spaceId)?.folderPath ?? "";
  }

  private view(row: TeammateRow, sessions: readonly TeammateSessionRow[]): Teammate {
    const own = sessions.filter((s) => s.teammateId === row.id);
    const home = own.find((s) => s.id === row.homeSessionId) ?? null;
    const state = own.reduce<TeammateState>((acc, s) => louder(acc, stateOf(s.status)), "idle");
    const live = own.find((s) => !s.home && LIVE.has(s.status)) ?? null;
    const was = this.since.get(row.id);
    return {
      id: row.id, spaceId: row.spaceId, handle: row.handle, name: row.name, brief: row.brief, icon: row.icon,
      agentKind: row.agentKind, model: row.model, effort: row.effort, permissionMode: row.permissionMode,
      folder: this.folderOf(row), lead: row.lead, group: row.group, sortOrder: row.sortOrder, archived: row.archived,
      homeSessionId: row.homeSessionId, schedule: this.scheduleOf(row), createdAt: row.createdAt, updatedAt: row.updatedAt,
      state, stateSince: state === "idle" ? null : was?.state === state ? was.at : (live ?? home)?.updatedAt ?? null,
      unread: home?.unread ?? false,
      liveTask: live?.title ?? null,
      taskSessions: this.tasks(row, sessions).slice(0, ROW_TASKS),
    };
  }

  private scheduleOf(row: TeammateRow): TeammateSchedule | null {
    const s = this.d.schedules.forTeammate(row.id);
    return s ? {
      id: s.id, cron: s.cron, prompt: s.goal, enabled: s.enabled,
      // An archived teammate's clock is not claimed, so the time the row still holds is not when it runs.
      nextRunAt: row.archived ? null : s.nextRunAt, lastRunAt: s.lastRunAt, lastSkippedAt: s.lastSkippedAt,
    } : null;
  }

  /**
   * A teammate's task sessions and, nested under the one that asked, the work other teammates took on
   * for them. A session a teammate started from its home sits at the top; one it handed over nests
   * under the session that handed it over, when that session is in the list.
   */
  private tasks(row: TeammateRow, sessions: readonly TeammateSessionRow[]): TeammateTaskSession[] {
    const own = sessions.filter((s) => s.teammateId === row.id);
    const ownIds = new Set(own.map((s) => s.id));
    const listed = new Set(own.filter((s) => !s.home).map((s) => s.id));
    const handed = sessions.filter((s) => s.teammateId !== row.id && !s.home && s.askedBy !== null && ownIds.has(s.askedBy));
    for (const s of handed) listed.add(s.id);
    return sessions.filter((s) => listed.has(s.id)).map((s) => {
      const parent = s.teammateId === row.id ? s.dispatchedBy : s.askedBy;
      return {
        id: s.id, title: s.title, teammateId: s.teammateId, parentId: parent && listed.has(parent) ? parent : null,
        state: stateOf(s.status), updatedAt: s.activityAt, unread: s.unread,
      };
    });
  }

  /* ──────────────────────────────── writes ──────────────────────────────── */

  create(input: CreateTeammateInput): Teammate {
    if (!this.d.spaces.get(input.spaceId)) throw new NotFoundError("space", input.spaceId);
    const handle = input.handle ? this.claim(input.spaceId, input.handle, null) : this.d.store.freeHandle(input.spaceId, teammateHandle(input.name));
    const agentKind = input.agentKind ?? "claude";
    const first = !this.d.store.hasAny(input.spaceId);
    const row = this.d.store.create({
      spaceId: input.spaceId, handle, name: input.name, brief: input.brief,
      icon: input.icon ?? teammateIconFromSeed(`${input.spaceId}:${handle}`),
      agentKind, model: input.model ?? null, effort: input.effort ?? null,
      permissionMode: input.permissionMode ?? (this.d.defaultMode(agentKind) as Teammate["permissionMode"]),
      folder: this.checkFolder(input.folder ?? null), lead: false, group: input.group ?? null,
    });
    if (input.schedule) {
      try { this.d.schedules.setForTeammate(row, input.schedule); } catch (e) { this.d.store.remove(row.id); throw e; }
    }
    if (input.lead) this.d.store.setLead(row.spaceId, row.id);
    // Made with it, so its page opens onto a composer. An agent that cannot start a session now is
    // tried again by the first message, which says why.
    try { this.ensureHome(row.id); } catch (e) { console.error(`[teammates] @${handle} has no chat yet: ${e instanceof Error ? e.message : String(e)}`); }
    if (first) this.d.toolsChanged?.();
    this.changed(row.spaceId);
    return this.get(row.id);
  }

  update(input: UpdateTeammateInput): Teammate {
    const cur = this.row(input.id);
    const handle = input.handle && input.handle !== cur.handle ? this.claim(cur.spaceId, input.handle, cur.id) : undefined;
    const folder = input.folder === undefined ? undefined : this.checkFolder(input.folder);
    // First, so a clock it refuses leaves the rest of the edit unwritten too.
    if (input.schedule !== undefined) this.d.schedules.setForTeammate({ id: cur.id, spaceId: cur.spaceId, name: input.name ?? cur.name }, input.schedule);
    else if (input.name !== undefined && input.name !== cur.name && this.d.schedules.forTeammate(cur.id)) this.d.schedules.setForTeammate({ id: cur.id, spaceId: cur.spaceId, name: input.name }, {});
    const next = this.d.store.update(cur.id, {
      ...(handle ? { handle } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.brief !== undefined ? { brief: input.brief } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.agentKind !== undefined ? { agentKind: input.agentKind, ...(input.model === undefined ? { model: null } : {}) } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
      ...(folder !== undefined ? { folder } : {}),
      ...(input.group !== undefined ? { group: input.group } : {}),
    })!;
    if (input.lead !== undefined) this.d.store.setLead(cur.spaceId, input.lead ? cur.id : (cur.lead ? null : this.d.store.lead(cur.spaceId)?.id ?? null));
    this.followHome(cur, next);
    this.changed(cur.spaceId);
    return this.get(cur.id);
  }

  /** Archived teammates leave the list and the tools; their sessions stay where they are. */
  archive(id: string, archived: boolean): Teammate {
    const cur = this.row(id);
    if (cur.archived === archived) return this.get(id);
    if (archived && cur.lead) this.d.store.setLead(cur.spaceId, null);
    this.d.store.update(id, archived
      ? { archived: true }
      // Back in the list, and under a handle no one took while it was away.
      : { archived: false, handle: this.d.store.freeHandle(cur.spaceId, cur.handle, cur.id) });
    // Its clock was not claimed while it was away: it starts again from now rather than from a time it missed.
    if (!archived && this.d.schedules.forTeammate(id)) this.d.schedules.setForTeammate(cur, {});
    this.d.toolsChanged?.();
    this.changed(cur.spaceId);
    return this.get(id);
  }

  setLead(spaceId: string, id: string | null): Teammate[] {
    if (id) {
      const row = this.row(id);
      if (row.spaceId !== spaceId) throw new RpcError("TEAMMATE_WRONG_SPACE", "that teammate belongs to another space");
      if (row.archived) throw new RpcError("TEAMMATE_ARCHIVED", `${row.name} is archived; bring it back before making it the Lead`);
    }
    this.d.store.setLead(spaceId, id);
    this.changed(spaceId);
    return this.list(spaceId);
  }

  reorder(input: ReorderTeammatesInput): Teammate[] {
    const ids = new Set(this.d.store.list(input.spaceId).map((r) => r.id));
    const stray = input.order.find((o) => !ids.has(o.id));
    if (stray) throw new RpcError("TEAMMATE_WRONG_SPACE", `teammate ${stray.id} is not in this space's Team list`);
    this.d.store.reorder(input.spaceId, input.order);
    this.changed(input.spaceId);
    return this.list(input.spaceId);
  }

  /** Its home session, made now when it has none. */
  home(id: string): { sessionId: string } {
    return { sessionId: this.ensureHome(id) };
  }

  /** The person's message: a turn in its home session, made now when it has none. */
  async message(id: string, text: string): Promise<{ sessionId: string }> {
    const sessionId = this.ensureHome(id);
    await this.d.sessions.send(sessionId, { text, attachments: [] });
    return { sessionId };
  }

  private claim(spaceId: string, raw: string, exceptId: string | null): string {
    const handle = normalizeHandle(raw);
    if (this.d.store.freeHandle(spaceId, handle, exceptId) !== handle) throw new RpcError("TEAMMATE_HANDLE_TAKEN", `@${handle} is already a teammate here`);
    return handle;
  }

  private checkFolder(folder: string | null): string | null {
    if (folder === null) return null;
    if (!isAbsolute(folder)) throw new RpcError("INVALID_ARGUMENT", "a teammate's folder is an absolute path");
    let dir = false;
    try { dir = statSync(folder).isDirectory(); } catch { /* reported below */ }
    if (!dir) throw new RpcError("FOLDER_NOT_FOUND", `${folder} is not a folder on this Mac`);
    return folder;
  }

  /**
   * The home session, made when the teammate has none: in its folder, on its agent, model, effort and
   * mode, titled with its name. A home session that was deleted is replaced.
   */
  private ensureHome(id: string): string {
    const row = this.row(id);
    if (row.archived) throw new RpcError("TEAMMATE_ARCHIVED", `${row.name} is archived`);
    if (row.homeSessionId) {
      try { this.d.sessions.get(row.homeSessionId); return row.homeSessionId; } catch { /* deleted: made again below */ }
    }
    const env = row.folder ? this.d.environments.ensureAt(row.spaceId, row.folder, "checkout") : this.d.environments.ensurePrimary(row.spaceId);
    const { session } = this.d.sessions.create({
      spaceId: row.spaceId, agentKind: row.agentKind, projectId: null, environmentId: env.id,
      model: row.model, effort: row.effort, permissionMode: row.permissionMode, title: row.name,
      teammate: { id: row.id, home: true },
    });
    this.d.store.update(row.id, { homeSessionId: session.id });
    this.changed(row.spaceId);
    return session.id;
  }

  /**
   * Carry an edit to the home session. Model, effort and mode change on it in place; a new name renames
   * it unless the person renamed it. A new agent or folder cannot move a conversation that has run, so
   * the old chat stays among its sessions and the next message starts a new one.
   */
  private followHome(was: TeammateRow, now: TeammateRow): void {
    if (!was.homeSessionId) return;
    let home: Session;
    try { home = this.d.sessions.get(was.homeSessionId); } catch { return; }
    if (was.agentKind !== now.agentKind || this.folderOf(was) !== this.folderOf(now)) {
      this.d.store.update(now.id, { homeSessionId: null });
      this.d.store.unhome(home.id);
      return;
    }
    if (was.name !== now.name) this.d.sessions.retitleIf(home.id, was.name, now.name);
    const options = {
      ...(now.model !== home.model && now.model !== null ? { model: now.model } : {}),
      ...(now.effort !== home.effort ? { effort: now.effort } : {}),
      ...(now.permissionMode !== home.permissionMode ? { permissionMode: now.permissionMode } : {}),
    };
    if (Object.keys(options).length > 0) void this.d.sessions.setOptions(home.id, options).catch((e: unknown) => {
      console.error(`[teammates] ${now.handle}'s chat kept its old options: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /**
   * A home session switched to another agent mid-conversation (`sessions.switchAgent`). The teammate
   * goes with its chat: the conversation is the teammate, so its row takes the agent, model, effort and
   * mode the chat is on now. Written to the row alone — an edit through `update` would read the new
   * agent as a reason to start a new chat, and the switch already handed this one over.
   */
  followSwitch(session: Session): void {
    if (!session.teammateHome || !session.teammateId) return;
    const row = this.d.store.get(session.teammateId);
    if (!row || row.homeSessionId !== session.id) return;
    this.d.store.update(row.id, {
      agentKind: session.agentKind, model: session.model, effort: session.effort,
      ...((TEAMMATE_PERMISSION_MODES as readonly string[]).includes(session.permissionMode) ? { permissionMode: session.permissionMode as TeammatePermissionMode } : {}),
    });
    this.changed(row.spaceId);
  }

  /** Every window re-reads the space's teammates — once per tick however many things moved. */
  private changed(spaceId: string): void {
    if (this.pending.has(spaceId)) return;
    this.pending.set(spaceId, setTimeout(() => {
      this.pending.delete(spaceId);
      this.d.rpc.broadcast("teammates.changed", { spaceId });
    }, 0));
  }

  /* ──────────────────────────── the sessions' seams ──────────────────────────── */

  /**
   * The session-event rail. A teammate's state is read off its sessions' statuses, so a status or a new
   * turn on one of them is a change to announce; a turn its home session takes notes who sent it, so a
   * task started on it nests under the session that asked.
   */
  handleSessionEvent(session: Session, ev: SessionEvent): void {
    if (!session.teammateId) return;
    if (session.teammateHome) this.followClockTurn(session, ev);
    if (ev.type === "user_message") {
      if (session.teammateHome) this.askedBy.set(session.id, ev.payload.from?.sessionId ?? null);
    } else if (ev.type === "status") {
      // Read before the event is written, so this session's own row still holds the status it leaves.
      const row = this.d.store.get(session.teammateId);
      if (row) {
        const state = this.d.store.sessions(row.spaceId).filter((s) => s.teammateId === row.id)
          .reduce<TeammateState>((acc, s) => louder(acc, stateOf(s.id === session.id ? ev.payload.status : s.status)), "idle");
        if (this.since.get(row.id)?.state !== state) this.since.set(row.id, { state, at: Date.now() });
      }
    } else {
      return;
    }
    this.changed(session.spaceId);
  }

  /**
   * What a session `agent_start` is about to make from `parentId` inherits, when the parent is a
   * teammate's: the teammate, for the child's row; its mode, which the child runs in whatever the
   * parent session's chip says; its handle, for the title; and the session that asked for the work.
   */
  childOf(parentId: string): { teammateId: string; handle: string; permissionMode: string; askedBy: string | null } | null {
    let parent: Session;
    try { parent = this.d.sessions.get(parentId); } catch { return null; }
    const row = parent.teammateId ? this.d.store.get(parent.teammateId) : null;
    if (!row) return null;
    return { teammateId: row.id, handle: row.handle, permissionMode: row.permissionMode, askedBy: parent.teammateHome ? this.askedBy.get(parent.id) ?? null : null };
  }

  /** The home session's brief, told on every start so the team it names is the team as it is now. */
  contextFor(sessionId: string): string | undefined {
    const row = this.d.store.byHomeSession(sessionId);
    if (!row || row.archived) return undefined;
    const others = this.d.store.list(row.spaceId).filter((r) => r.id !== row.id);
    return homePreamble(row, others);
  }

  /** A home session was deleted: the next message makes another. */
  release(sessionId: string): void {
    this.askedBy.delete(sessionId);
    this.endClockTurn(sessionId);
    const row = this.d.store.byHomeSession(sessionId);
    if (row) { this.d.store.update(row.id, { homeSessionId: null }); this.changed(row.spaceId); }
  }

  /* ──────────────────────────────── the clock ──────────────────────────────── */

  /**
   * `ScheduleService`'s seam: a teammate's clock came due. Its prompt goes into the home session as the
   * clock's turn, queued behind one the chat is on, in the teammate's mode — no pane opens, and the
   * chat is unread until the person looks. `busy` while the clock's last turn is still queued or going.
   */
  clockFired(schedule: Schedule): "delivered" | "busy" | "gone" {
    const row = schedule.roleId ? this.d.store.get(schedule.roleId) : null;
    if (!row || row.archived || this.d.schedules.forTeammate(row.id)?.id !== schedule.id) return "gone";
    let home: string;
    try { home = this.ensureHome(row.id); } catch (e) {
      console.error(`[teammates] @${row.handle}'s clock found no chat to write in: ${e instanceof Error ? e.message : String(e)}`);
      return "gone";
    }
    if (this.clockBusy(home)) return "busy";
    const turn: ClockTurn = { scheduleId: schedule.id, sending: true, timer: null };
    this.clockTurns.set(home, turn);
    void this.d.sessions.send(home, { text: `${schedule.goal}\n\n${CLOCK_NOTE}`, attachments: [], scheduled: { task: schedule.title, note: CLOCK_NOTE, scheduleId: schedule.id },
      permissionMode: row.permissionMode }, "queue")
      .catch((e: unknown) => {
        console.error(`[teammates] @${row.handle}'s clock could not write in its chat: ${e instanceof Error ? e.message : String(e)}`);
        if (this.clockTurns.get(home) === turn) this.endClockTurn(home);
      })
      .finally(() => { turn.sending = false; });
    this.changed(row.spaceId);
    return "delivered";
  }

  /** Whether the clock's last turn in this chat is on its way, waiting in its queue, or going. One the
   *  person took off the queue is over. */
  private clockBusy(home: string): boolean {
    const turn = this.clockTurns.get(home);
    if (!turn) return false;
    if (turn.sending || turn.timer) return true;
    if (this.d.sessions.queuedFor(home).some((q) => q.msg.scheduled?.scheduleId === turn.scheduleId)) return true;
    this.endClockTurn(home);
    return false;
  }

  /** The clock's turn begins when its message is written, and ends on the settle after it — or on a
   *  message of anyone else's, which only arrives first when it was sent to stop the turn. */
  private followClockTurn(session: Session, ev: SessionEvent): void {
    const turn = this.clockTurns.get(session.id);
    if (!turn) return;
    if (ev.type === "user_message") {
      if (ev.payload.scheduled?.scheduleId !== turn.scheduleId) { if (turn.timer) this.endClockTurn(session.id); return; }
      if (turn.timer) return;
      turn.timer = setTimeout(() => {
        if (this.clockTurns.get(session.id) !== turn) return;
        this.endClockTurn(session.id);
        console.log(`[teammates] a clock's turn in session ${session.id} ran past ${Math.round((this.d.clockTurnMs ?? TEAMMATE_CLOCK_TURN_MS) / 60_000)} minutes and was stopped; the task sessions it started go on`);
        // Its questions to other teammates are let go; the work it handed to task sessions is not.
        this.d.engine.parentInterrupted(session.id, { sparePeople: true, spareDetached: true });
        void this.d.sessions.interrupt(session.id, { keepDelegated: true }).catch(() => { /* the chat is gone */ });
      }, this.d.clockTurnMs ?? TEAMMATE_CLOCK_TURN_MS);
      turn.timer.unref?.();
      return;
    }
    if (ev.type !== "status" || !turn.timer) return;
    const was = session.status;
    const now = ev.payload.status;
    if (now === "error" || now === "ended" || (now === "idle" && (was === "running" || was === "waiting_permission"))) this.endClockTurn(session.id);
  }

  private endClockTurn(home: string): void {
    const turn = this.clockTurns.get(home);
    if (!turn) return;
    if (turn.timer) clearTimeout(turn.timer);
    this.clockTurns.delete(home);
  }

  /**
   * The `@` chips of a person's message that name a teammate: each teammate's home session is passed
   * the message, queued behind a turn it is on, and the chip is told whether it was. What a client wrote
   * in either field is dropped first.
   */
  async passMentioned(sessionId: string, text: string, refs: readonly MentionRef[]): Promise<MentionRef[]> {
    let source: Session;
    try { source = this.d.sessions.get(sessionId); } catch { return [...refs]; }
    const said = text.replace(/@\[([^\]]+)\]/g, "@$1");
    const out: MentionRef[] = [];
    for (const r of refs) {
      if (r.kind !== "role") { out.push(r); continue; }
      const clean = { kind: "role" as const, label: r.label, roleId: r.roleId };
      if (!text.includes(`@[${r.label}]`)) { out.push(clean); continue; }
      const row = this.d.store.get(r.roleId);
      if (!row || row.archived || row.spaceId !== source.spaceId) { out.push({ ...clean, refused: "that teammate is not in this space" }); continue; }
      if (row.homeSessionId === source.id) { out.push(clean); continue; }
      try {
        const home = this.ensureHome(row.id);
        await this.d.sessions.send(home, { text: said, attachments: [],
          note: `\n\n[Realm] The person wrote this in another session, "${clip(source.title, 80)}" (${sessionLink(source.id)}), and named you in it. Answer here, in your own chat.` }, "queue");
        out.push({ ...clean, sessionId: home, delivered: true });
      } catch (e) {
        out.push({ ...clean, refused: clip(e instanceof Error ? e.message : "Realm could not pass it on", 400) });
      }
    }
    return out;
  }

  /* ──────────────────────────────── the tools ──────────────────────────────── */

  /** `team_list`: every teammate here, one line each. */
  teamList(ctx: ProviderCallContext): CallToolResult {
    const me = this.sessionTeammate(ctx.sessionId);
    const rows = this.list(ctx.spaceId);
    if (rows.length === 0) return ok("This space has no teammates.");
    return ok(rows.map((t) => {
      const what = firstLine(t.brief) || t.name;
      const state = t.state === "needs-you" ? "needs the person" : t.state;
      const task = t.liveTask ? ` on "${t.liveTask}"` : "";
      const model = `${AGENT_META[t.agentKind].label} · ${t.model ?? DEFAULT_MODEL_LABEL[t.agentKind]}`;
      return `- @${t.handle}${t.lead ? " (Lead)" : ""}${t.id === me?.id ? " (you)" : ""} — ${t.name}: ${clip(what, 160)} · ${state}${task} · ${model}`;
    }).join("\n"));
  }

  /**
   * `team_message`: a turn in the target's home session from the sender, queued behind a live turn.
   * With `wait`, the call holds until that turn ends and answers with its final text — refused at once
   * when the wait could never end: on itself, or on a teammate already waiting on the sender.
   */
  async teamMessage(ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
    const a = parseArgs(TeamMessageArgsSchema, raw); if ("error" in a) return a.error;
    const { to, message, wait } = a.value;
    let sender: Session;
    try { sender = this.d.sessions.get(ctx.sessionId); } catch { return err("the calling session no longer exists."); }
    const me = this.sessionTeammate(sender.id);
    const target = this.resolve(ctx.spaceId, to);
    if ("error" in target) return err(target.error);
    if (target.homeSessionId === sender.id) return err("refused: that is you — this is your own chat.");
    const from = me ? me.id : `session:${sender.id}`;
    if (wait) {
      if (me?.id === target.id) return err(`refused: you are @${target.handle}, and waiting on yourself would never end. Send it without wait, or do the work here.`);
      const loop = this.waitPath(target.id, from);
      if (loop) return err(`refused: ${loop} is waiting on you, so waiting on @${target.handle} would never end. Send it without wait, or answer what you were asked first.`);
    }
    let home: string;
    try { home = this.ensureHome(target.id); } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
    const by = me ? `@${me.handle}` : `the session "${clip(sender.title, 80)}"`;
    const text = `From ${by}: ${message}`;
    const note = wait
      ? `\n\n[Realm] ${by} sent this with team_message and is waiting for your answer: your final message of this turn goes back to it. Answer in a sentence or two; start a task session for real work and say where it is.`
      : `\n\n[Realm] ${by} sent this with team_message and is not waiting. If it needs an answer, send one with team_message to ${me ? `@${me.handle}` : "it"}.`;
    const busy = this.statusOf(home) !== "idle";
    if (!wait) {
      try {
        await this.d.sessions.send(home, { text, attachments: [], from: { sessionId: sender.id, title: by, ...(me ? { teammateId: me.id } : {}) }, note }, "queue");
      } catch (e) { return err(`could not reach @${target.handle}: ${e instanceof Error ? e.message : String(e)}`); }
      return ok(`Sent to @${target.handle}${busy ? "; it reads it when its current turn ends" : ""}. You are not waiting for it — carry on.`);
    }

    const t = this.d.timeouts ?? DEFAULT_TIMEOUTS;
    const deadline = Date.now() + t.waitMs;
    const run = this.d.engine.begin(sender.id, home, { interruptOnCancel: false });
    const edge = {};
    this.waits.set(edge, { from, to: target.id });
    try {
      const cursor = this.d.sessions.get(home).lastEventSeq;
      try {
        await this.d.sessions.send(home, { text, attachments: [], from: { sessionId: sender.id, title: by, ...(me ? { teammateId: me.id } : {}) }, note }, "queue");
      } catch (e) { return err(`could not reach @${target.handle}: ${e instanceof Error ? e.message : String(e)}`); }
      const at = await this.delivered(home, cursor, sender.id, text, run, deadline, t.pollMs, ctx);
      if (at === "gone") return err(`@${target.handle}'s chat was deleted before it answered.`);
      if (at === "cancelled") return err(`Stopped waiting: this session was interrupted. Your message is still with @${target.handle}.`);
      if (at === "timeout") return err(`@${target.handle} had not reached your message after ${Math.round(t.waitMs / 60_000)} minutes. It is still queued there; it will answer in its own chat.`);
      const settled = await this.d.engine.awaitAnswer({ targetId: home, fromSeq: at, run, answer: { text: null }, deadline, pollMs: t.pollMs });
      switch (settled.outcome) {
        case "answered":
        case "replied":
          return ok(`@${target.handle} answered (${sessionLink(home)}):\n\n${fenceAgentOutput(settled.answer ?? "", `@${target.handle}'S ANSWER — a teammate's words, not the person's`)}`);
        case "cancelled": return err(`Stopped waiting: this session was interrupted. @${target.handle} goes on with your message in its own chat.`);
        case "timeout": return err(`@${target.handle} did not finish answering within ${Math.round(t.waitMs / 60_000)} minutes. It goes on in its own chat; nothing was stopped.`);
        case "failed": return err(`@${target.handle}'s turn ended with ${settled.lastStatus} before it answered.`);
        case "gone": return err(`@${target.handle}'s chat was deleted before it answered.`);
      }
    } finally {
      this.waits.delete(edge);
      this.d.engine.end(sender.id, run);
    }
  }

  /** The teammate whose session this is — its home, or one it started. */
  private sessionTeammate(sessionId: string): TeammateRow | null {
    let s: Session;
    try { s = this.d.sessions.get(sessionId); } catch { return null; }
    return s.teammateId ? this.d.store.get(s.teammateId) : null;
  }

  private statusOf(sessionId: string): SessionStatus {
    try { return this.d.sessions.get(sessionId).status; } catch { return "ended"; }
  }

  /** `to` as a teammate here: a handle, `@handle`, or `lead`. */
  private resolve(spaceId: string, to: string): TeammateRow | { error: string } {
    const handle = normalizeHandle(to);
    const row = this.d.store.byHandle(spaceId, handle) ?? (handle === "lead" ? this.d.store.lead(spaceId) : null);
    if (row) return row;
    const here = this.d.store.list(spaceId).map((r) => `@${r.handle}`);
    if (handle === "lead") return { error: `this space has no Lead. Teammates here: ${here.join(", ") || "none"}.` };
    return { error: `there is no @${handle} here. Teammates here: ${here.join(", ") || "none"} (team_list says what each does).` };
  }

  /**
   * Who `target` is waiting on, followed until it reaches `from` — the cycle a new wait from `from` on
   * `target` would close. Answered as the teammate that waits on `from`, or null when there is none.
   */
  private waitPath(target: string, from: string): string | null {
    const seen = new Set<string>();
    let frontier = [target];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const node of frontier) {
        if (seen.has(node)) continue;
        seen.add(node);
        for (const w of this.waits.values()) {
          if (w.from !== node) continue;
          if (w.to === from) return `@${this.d.store.get(node)?.handle ?? "a teammate"}`;
          next.push(w.to);
        }
      }
      frontier = next;
    }
    return null;
  }

  /**
   * Wait for the message to come off the target's queue: the seq of its `user_message`, read from the
   * transcript after `cursor`. Its answer is the turn that follows.
   */
  private async delivered(home: string, cursor: number, senderId: string, text: string, run: ActiveRun, deadline: number, pollMs: number,
    ctx: ProviderCallContext): Promise<number | "gone" | "cancelled" | "timeout"> {
    let after = cursor;
    for (;;) {
      let batch;
      try { batch = this.d.sessions.events(home, after, 500); } catch { return "gone"; }
      for (const stored of batch) {
        after = stored.seq;
        const ev = stored.event;
        if (ev.type === "user_message" && ev.payload.from?.sessionId === senderId && ev.payload.text === text) return stored.seq;
      }
      if (run.cancelled || ctx.signal?.aborted) return "cancelled";
      if (Date.now() >= deadline) return "timeout";
      ctx.progress?.("waiting for its current turn to end");
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}


/** What a teammate's home session is told about itself and its team, on every start. */
export function homePreamble(me: TeammateRow, others: readonly TeammateRow[]): string {
  const team = others.length > 0
    ? others.map((o) => `- @${o.handle}${o.lead ? " (the Lead)" : ""} — ${o.name}: ${clip(firstLine(o.brief) || "no brief yet", 200)}`).join("\n")
    : "- Nobody else yet.";
  return [
    `# You are @${me.handle} (${me.name}), a teammate in Realm`,
    "",
    "This session is your chat: the person, and the other teammates in this space, message you here. What you do:",
    "",
    me.brief.trim() || "(The person has not written your brief yet. Ask what they want from you.)",
    "",
    "## Your team",
    team,
    "",
    "## How you work",
    `- Do real work in a task session, not in this chat: start one with agent_start, titled "${me.handle} - <task>" (agent_start's \`title\`), and collect it with agent_wait. It runs in your folder and your permission mode. Answer quick questions here.`,
    "- Report back in one or two plain sentences, with a link to the session that did the work: [its title](realm://session/<its handle from agent_start>).",
    "- Ask a teammate, or hand it work, with team_message (to: its handle, or \"lead\"); add wait: true only when you need its answer before you can go on. team_list says who is here and what each is doing.",
    "- A message that starts \"From @someone:\" came from that teammate, not from the person.",
    ...(me.lead
      ? ["- You are the Lead. When the person asks for something, route it to the teammate whose work it is with team_message, keep the person out of the middle, and come back with the finished work, not a plan."]
      : []),
  ].join("\n");
}
