import {
  AGENT_META, TEAM_HANDOFF_TOOL, TEAM_MENTION_TOOL, TEMPLATE_HANDOFFS, backoffUntil, classifyFailure, isRunLive, isRunTerminal, usageDeltas, USAGE_REPORTING,
  type AgentKind, type Goal, type HandoffState, type MentionRef, type RoleGoal, type RoleRun, type Run, type Schedule, type Session, type SessionEvent,
  type SetRoleHandoffsInput, type TeamBackoff, type TeamHandoff, type TeamLimits, type TeamRole,
} from "@realm/contracts";
import type { AgentRunService } from "../../delegation/agent-run";
import type { RpcServer } from "../../rpc/server";
import type { RunService } from "../../runs/service";
import type { SessionService } from "../../sessions/service";
import { NotFoundError, RpcError } from "../../store/rows";
import type { TeamService } from "../service";
import type { RoleRow, TeamStore } from "../store";
import type { HandoffRow, HandoffStore } from "./store";

type SettingsLike = { get(key: string): unknown; set(key: string, value: unknown): void };

const BACKOFF_KEY = "team.backoff";

/** What `TeamService` reads from this one: the Phase 4 half of a role, a team and a week. */
export type TeamExtras = {
  roleExtras(r: RoleRow): { handsOffTo: string[]; wakeOnMention: boolean; goal: RoleGoal | null; live: "working" | "waiting" | null };
  spaceExtras(spaceId: string): { limits: TeamLimits; handoffs: TeamHandoff[] };
  /** Spend no run row holds: a role's (or a team's) mentions. */
  spentSince(where: { roleId?: string; spaceId?: string }, since: number): number;
  /** A role's mentions, as rows of its Recent runs. */
  mentionRuns(roleId: string): RoleRun[];
  /** The back-off in force for an engine, if any. */
  backoff(kind: string): TeamBackoff | null;
  /** Starters just made: draw the handoffs their templates name, among the team's roles. */
  seedEdges?(spaceId: string, templates: string[]): void;
};

export type HandoffInput = { to: string; note: string; record?: string | undefined; files?: string[] | undefined };

/**
 * Teams, Phase 4: handoffs, mentions, goals and the back-off — the ways one role wakes another, a
 * session wakes a role, a role keeps working toward something, and every team stands down at once.
 *
 * **No second runner.** A handoff wakes the receiving role through `TeamService.wake`, so it is a
 * durable run that waits for a slot like any other. A mention starts the role through the delegation
 * tools (`AgentRunService.startChild`), so it is a sub-agent of the session that named it, in the
 * lead's Agents tab, at min(lead's mode, role's mode). A goal is #118's goal loop on the run's own
 * session, and the run settles when the goal does — not after its first turn — so the role's caps and
 * the slots hold for the whole of it.
 *
 * **The back-off.** When any session's engine says its account hit a rate or plan limit, every team's
 * unattended runs on that engine wait until the reset it named (`admit` says no; clocks skip, saying
 * why), and a timer pumps the queue when the reset comes. Nothing unattended retries into a limit.
 */
export class HandoffService implements TeamExtras {
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;

  constructor(private readonly d: {
    store: HandoffStore;
    teamStore: Pick<TeamStore, "role" | "roleByName" | "roles" | "appendActivity" | "activityForRun" | "teamSpaceIds">;
    team: Pick<TeamService, "wake" | "pausedWhy" | "recordRel" | "repoPath" | "spaceFile" | "isTeam" | "teamMaxLive" | "slots" | "roleView">;
    runs: Pick<RunService, "listLive" | "listForRole" | "get" | "finish" | "stopAtLimit" | "pump">;
    goals: { get(sessionId: string): Goal | null; adopt(sessionId: string, objective: string, tokenBudget: number | null): Goal; set(sessionId: string, status: "blocked", note: string): Goal };
    agentRuns: Pick<AgentRunService, "startChild" | "record">;
    sessions: Pick<SessionService, "get" | "events">;
    rootForSpace: (spaceId: string) => string | null;
    settings: SettingsLike;
    rpc: Pick<RpcServer, "broadcast">;
    clock?: () => number;
  }) {}

  private now(): number { return this.d.clock ? this.d.clock() : Date.now(); }

  /** Boot: a back-off still in force wakes the queue when it ends. */
  start(): void { this.armBackoff(); }

  close(): void {
    this.closing = true;
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.backoffTimer = null;
  }

  /* ═══════════════════════════════ what the team reads ═══════════════════════════════ */

  roleExtras(r: RoleRow): ReturnType<TeamExtras["roleExtras"]> {
    const live = this.d.teamStore.roles(r.spaceId).map((x) => x.id);
    let state: "working" | "waiting" | null = null;
    for (const m of this.d.store.liveMentions()) {
      if (m.toRoleId !== r.id || !m.sessionId || this.mentionOutcome(m)) continue;
      const s = this.sessionStatus(m.sessionId);
      if (s === "waiting_permission") state = "waiting";
      else if (s === "running" && state === null) state = "working";
    }
    return {
      handsOffTo: this.d.store.edges(r.id).filter((id) => id !== r.id && live.includes(id)),
      wakeOnMention: this.d.store.wakeOnMention(r.id),
      goal: this.goalOf(r.id),
      live: state,
    };
  }

  spaceExtras(spaceId: string): ReturnType<TeamExtras["spaceExtras"]> {
    const live = this.d.runs.listLive().filter((r) => r.roleId);
    return {
      limits: {
        teamMaxLive: this.d.team.teamMaxLive(spaceId),
        realmMaxUnattended: this.d.team.slots(),
        teamRunning: live.filter((r) => r.spaceId === spaceId && r.state === "running").length,
        realmRunning: live.filter((r) => r.state === "running").length,
        teamQueued: live.filter((r) => r.spaceId === spaceId && r.state === "queued").length,
        backoff: this.backoffs(),
      },
      handoffs: this.d.store.inSpace(spaceId, 40).map((h) => this.view(h)),
    };
  }

  spentSince(where: { roleId?: string; spaceId?: string }, since: number): number {
    return this.d.store.mentionSpendSince(where, since);
  }

  mentionRuns(roleId: string): RoleRun[] {
    return this.d.store.mentionsOf(roleId, 20).map((m) => {
      const v = this.view(m);
      const asker = this.askerName(m);
      return {
        id: m.id, roleId, wokeOn: "mention", wokeNote: m.note, wokeBy: asker, sessionId: m.sessionId,
        state: v.state === "done" ? "succeeded" : v.state === "failed" ? "failed" : v.state === "stopped" ? "cancelled" : v.state === "needs-you" ? "blocked" : "running",
        createdAt: m.createdAt, startedAt: m.createdAt, settledAt: v.settledAt, costUsd: v.costUsd,
        summary: v.state === "working" || v.state === "needs-you" ? null : `Answered ${asker === "You" ? "your" : `${asker}'s`} mention`,
        error: v.state === "failed" ? "the sub-agent did not finish" : null, stoppedAtCap: null, reviewId: null, reviewState: null,
      } satisfies RoleRun;
    });
  }

  backoff(kind: string): TeamBackoff | null {
    const b = this.readBackoffs()[kind];
    return b && b.until > this.now() ? b : null;
  }

  private backoffs(): TeamBackoff[] {
    return Object.values(this.readBackoffs()).filter((b) => b.until > this.now()).sort((a, b) => a.until - b.until);
  }

  private readBackoffs(): Record<string, TeamBackoff> {
    const v = this.d.settings.get(BACKOFF_KEY);
    return v && typeof v === "object" ? (v as Record<string, TeamBackoff>) : {};
  }

  /** A handoff or mention as the pages show it: its state read off what it started. */
  view(h: HandoffRow): TeamHandoff {
    let state: HandoffState;
    let sessionId = h.sessionId;
    let costUsd = h.costUsd;
    let settledAt = h.settledAt;
    if (h.kind === "handoff") {
      const run = h.runId ? this.d.runs.get(h.runId)?.run ?? null : null;
      sessionId = run?.sessionId ?? null;
      costUsd = run?.costUsd ?? null;
      settledAt = run?.settledAt ?? null;
      state = !run ? "failed"
        : run.state === "queued" ? "queued"
        : run.state === "blocked" ? "needs-you"
        : run.state === "running" ? (run.sessionId && this.sessionStatus(run.sessionId) === "waiting_permission" ? "needs-you" : "working")
        : run.state === "succeeded" ? "done"
        : run.state === "cancelled" ? "stopped" : "failed";
    } else {
      const outcome = this.mentionOutcome(h);
      if (outcome && h.settledAt === null) {
        this.d.store.settleMention(h.id, outcome, h.sessionId ? this.sessionCost(h.sessionId) : null);
        const fresh = this.d.store.get(h.id)!;
        settledAt = fresh.settledAt; costUsd = fresh.costUsd;
      }
      state = outcome === "done" ? "done" : outcome === "stopped" || outcome === "interrupted" ? "stopped" : outcome ? "failed"
        : !h.sessionId ? "failed"
        : this.sessionStatus(h.sessionId) === "waiting_permission" ? "needs-you" : "working";
    }
    return {
      id: h.id, spaceId: h.spaceId, kind: h.kind, fromRoleId: h.fromRoleId, fromSessionId: h.fromSessionId, toRoleId: h.toRoleId,
      recordPath: h.recordPath, note: h.note, files: h.files, runId: h.runId, sessionId, state, costUsd, createdAt: h.createdAt, settledAt,
    };
  }

  private mentionOutcome(h: HandoffRow): string | null {
    if (h.outcome) return h.outcome;
    return h.sessionId ? this.d.agentRuns.record(h.sessionId)?.outcome ?? null : null;
  }

  /** Who asked, as a line names them: a role's name, "You", or the session's title. */
  private askerName(h: HandoffRow): string {
    if (h.fromRoleId) return this.d.teamStore.role(h.fromRoleId)?.name ?? "A former role";
    if (!h.fromSessionId) return "You";
    const run = this.d.runs.listLive().find((r) => r.sessionId === h.fromSessionId);
    if (run?.roleId) return this.d.teamStore.role(run.roleId)?.name ?? "A role";
    return "You";
  }

  /** A role's newest goal: its run, and where the goal loop on that run's session stands. */
  private goalOf(roleId: string): RoleGoal | null {
    const run = this.d.runs.listForRole(roleId, 20).find((r) => r.wokeOn === "goal");
    if (!run) return null;
    const objective = this.objectiveOf(run);
    if (objective === null) return null;
    const goal = run.sessionId ? this.d.goals.get(run.sessionId) : null;
    const status: RoleGoal["status"] = run.state === "queued" ? "queued" : goal?.status ?? (run.state === "succeeded" ? "complete" : isRunLive(run.state) ? "active" : "blocked");
    return {
      runId: run.id, sessionId: run.sessionId, objective, status, turns: goal?.turns ?? 0,
      note: goal?.note ?? (isRunTerminal(run.state) && run.state !== "succeeded" ? run.error : null), startedAt: run.createdAt,
    };
  }

  private objectiveOf(run: Run): string | null {
    const woke = this.d.teamStore.activityForRun(run.id).find((a) => a.verb === "woke");
    return typeof woke?.detail.note === "string" ? woke.detail.note : null;
  }

  /* ═══════════════════════════════ handoffs ═══════════════════════════════ */

  /**
   * `team_handoff`: a role's run passes work to another role. Only along an edge the person drew, only
   * from a role's own run, and never to a role whose week is spent. One live run per (role, record):
   * a second handoff about the same creator while the first is still being worked is told so, and
   * starts nothing.
   */
  handoff(ctx: { sessionId: string; spaceId: string }, input: HandoffInput): { handoff: TeamHandoff; started: boolean; toName: string } {
    const run = this.d.runs.listLive().find((r) => r.sessionId === ctx.sessionId && r.roleId) ?? null;
    const from = run?.roleId ? this.d.teamStore.role(run.roleId) : null;
    if (!run || !from) throw new RpcError("TEAM_HANDOFF_NOT_A_ROLE", `only a role's own run hands work off — to wake a role from this session, use ${TEAM_MENTION_TOOL}`);
    const to = this.d.teamStore.roleByName(ctx.spaceId, input.to.trim());
    if (!to) throw new RpcError("TEAM_HANDOFF_UNKNOWN", `this team has no role called ${input.to.trim()} — team_roles lists them`);
    const edges = this.d.store.edges(from.id);
    if (!edges.includes(to.id)) {
      const names = edges.map((id) => this.d.teamStore.role(id)).filter((r): r is RoleRow => !!r && !r.archived).map((r) => r.name);
      throw new RpcError("TEAM_HANDOFF_NO_EDGE", `${from.name} does not hand work to ${to.name}${names.length ? ` — it hands off to ${names.join(" and ")}` : " — it hands off to no one yet"}. A person adds one on ${from.name}'s page.`);
    }
    const paused = this.d.team.pausedWhy(to);
    if (paused) throw new RpcError("TEAM_HANDOFF_PAUSED", `${to.name} is paused: ${paused}. Say so in your report instead.`);
    const note = input.note.trim();
    if (!note) throw new RpcError("TEAM_HANDOFF_INVALID", "say what you are handing over in `note`");

    let recordPath: string | null = null;
    if (input.record) {
      const repo = this.d.team.repoPath(ctx.spaceId);
      if (!repo) throw new RpcError("TEAM_NO_REPO", "this team has no memory repo, so it has no records");
      recordPath = this.d.team.recordRel(input.record);
    }
    const root = this.d.rootForSpace(ctx.spaceId);
    const files = (input.files ?? []).map((f) => {
      if (!root) throw new RpcError("TEAM_NO_FOLDER", "this space has no folder for files to be passed from");
      return this.d.team.spaceFile(root, f);
    });

    const task = [
      `${from.name} handed you work${recordPath ? ` on ${recordPath}` : ""}:`,
      "",
      note,
      ...(files.length ? ["", "Files it passed, in this space's folder:", ...files.map((f) => `- ${f}`)] : []),
      "",
      recordPath ? `Read ${recordPath} with record_read first. Do your part, and deliver it as your brief says.` : "Do your part, and deliver it as your brief says.",
    ].join("\n");
    const woken = this.d.team.wake(to, "handoff", task, { note, by: from.name, dedupeKey: `handoff:${to.id}:${recordPath ?? "-"}` });
    const existing = this.d.store.forRun(woken.id);
    if (existing) return { handoff: this.view(existing), started: false, toName: to.name };
    const row = this.d.store.create({
      spaceId: ctx.spaceId, kind: "handoff", fromRoleId: from.id, fromSessionId: ctx.sessionId, toRoleId: to.id,
      recordPath, note, files, runId: woken.id, sessionId: null,
    });
    this.d.teamStore.appendActivity({ spaceId: ctx.spaceId, actor: `role:${from.id}`, verb: "handed_off", object: to.name,
      detail: { handoffId: row.id, toRoleId: to.id, note, record: recordPath, files: files.length }, runId: run.id, sessionId: ctx.sessionId });
    this.changed(ctx.spaceId);
    return { handoff: this.view(row), started: true, toName: to.name };
  }

  /** The lines a role's run is told about handing off, after the team's own rules. */
  preamble(run: Run): string | null {
    if (!run.roleId) return null;
    const names = this.d.store.edges(run.roleId).map((id) => this.d.teamStore.role(id)).filter((r): r is RoleRow => !!r && !r.archived).map((r) => r.name);
    if (names.length === 0) return null;
    return `- When part of the work is another role's, hand it over with \`${TEAM_HANDOFF_TOOL}\` (to: ${names.join(" or ")}) — a note saying what is done and what is left, the record, and the files. It wakes that role; do not wait for it.`;
  }

  /* ═══════════════════════════════ mentions ═══════════════════════════════ */

  /**
   * Wake a role as the session's sub-agent: `@Creator Manager` in a person's prompter, or a session's
   * `team_mention`. Started through the delegation tools, so the lead collects its report with
   * agent_wait and sees it in its Agents tab. A person's mention starts even when the role's week is
   * spent — a person asked — but an agent's does not.
   */
  async mention(ctx: { sessionId: string; spaceId: string }, roleId: string, task: string, from: "person" | "session"): Promise<{ ok: true; childId: string; handoff: TeamHandoff } | { ok: false; why: string }> {
    const role = this.d.teamStore.role(roleId);
    if (!role || role.archived || role.spaceId !== ctx.spaceId) return { ok: false, why: "that role is not on this space's team" };
    if (!this.d.store.wakeOnMention(role.id)) return { ok: false, why: `${role.name} is set not to wake on a mention — turn it on from its page` };
    if (from === "session") {
      const paused = this.d.team.pausedWhy(role);
      if (paused) return { ok: false, why: `${role.name} is paused: ${paused}` };
    }
    const caller = this.d.runs.listLive().find((r) => r.sessionId === ctx.sessionId && r.roleId);
    const asker = caller?.roleId ? this.d.teamStore.role(caller.roleId)?.name ?? "A role" : from === "person" ? "A person on your team" : "A session on your team";
    const goal = [
      `You are ${role.name}, a standing role on this space's team. ${asker} mentioned you and asked:`,
      "",
      task.trim(),
      "",
      "Your brief:",
      "",
      role.brief,
      "",
      `Answer what was asked. This is one sub-agent turn, not a run: it stops at ${Math.round(role.runCapMs / 60_000)} minutes.`,
    ].join("\n");
    const args = (model: string | null) => ({
      goal, title: role.name.slice(0, 40),
      constraints: {
        agentKind: role.agentKind, ...(model ? { model } : {}), permissionMode: role.permissionMode,
        ...(role.skills.length ? { skills: role.skills } : {}), timeoutMs: Math.max(5_000, Math.min(role.runCapMs, 3_600_000)),
      },
    });
    let started = await this.d.agentRuns.startChild(ctx, args(role.model));
    // A role's model is named the way a person would ("sonnet"); where this Realm cannot place the
    // name, the role still answers, on its harness's own default model.
    if (!started.ok && role.model) started = await this.d.agentRuns.startChild(ctx, args(null));
    if (!started.ok) return { ok: false, why: started.message.replace(/^refused:\s*/, "") };
    const row = this.d.store.create({
      spaceId: ctx.spaceId, kind: "mention", fromRoleId: caller?.roleId ?? null, fromSessionId: ctx.sessionId, toRoleId: role.id,
      recordPath: null, note: clip(task.trim(), 2_000), files: [], runId: null, sessionId: started.childId,
    });
    this.d.teamStore.appendActivity({ spaceId: ctx.spaceId, actor: `role:${role.id}`, verb: "mentioned", object: role.name,
      detail: { handoffId: row.id, by: caller?.roleId ? asker : from === "person" ? "You" : null, note: clip(task.trim(), 300), roleId: role.id }, sessionId: started.childId });
    this.changed(ctx.spaceId);
    return { ok: true, childId: started.childId, handoff: this.view(row) };
  }

  /**
   * The role chips of a message about to be sent: each mentioned role woken now, and its chip told
   * what happened — the sub-agent's handle, or why it did not start — for the lead's context block.
   * What a client wrote in either field is dropped first.
   */
  async wakeMentioned(sessionId: string, text: string, refs: readonly MentionRef[]): Promise<MentionRef[]> {
    let spaceId: string;
    try { spaceId = this.d.sessions.get(sessionId).spaceId; } catch { return [...refs]; }
    const out: MentionRef[] = [];
    for (const r of refs) {
      if (r.kind !== "role") { out.push(r); continue; }
      const clean = { kind: "role" as const, label: r.label, roleId: r.roleId };
      if (!text.includes(`@[${r.label}]`)) { out.push(clean); continue; }
      const done = await this.mention({ sessionId, spaceId }, r.roleId, text, "person");
      out.push(done.ok ? { ...clean, childId: done.childId } : { ...clean, refused: clip(done.why, 400) });
    }
    return out;
  }

  /* ═══════════════════════════════ goals ═══════════════════════════════ */

  /** Give a role a goal: one run, its session on #118's goal loop. One live goal per role. */
  setGoal(roleId: string, objective: string): Run {
    const role = this.d.teamStore.role(roleId);
    if (!role || role.archived) throw new NotFoundError("role", roleId);
    const text = objective.trim();
    if (!text) throw new RpcError("INVALID_ARGUMENT", "a goal needs an objective");
    const live = this.d.runs.listLive().find((r) => r.roleId === roleId && r.wokeOn === "goal");
    if (live) throw new RpcError("TEAM_GOAL_LIVE", `${role.name} is already working toward a goal — stop it, or let it finish, first`);
    const task = [
      `${role.name}, a person gave you a goal:`,
      "",
      text,
      "",
      "Work toward it across turns. Realm continues you after each turn until you close the goal with update_goal (complete, with the evidence; or blocked, with what is in the way). Deliver what you make with review_submit as you go.",
    ].join("\n");
    const run = this.d.team.wake(role, "goal", task, { note: text, dedupeKey: `goal:${roleId}` });
    this.d.teamStore.appendActivity({ spaceId: role.spaceId, actor: "user", verb: "goal_set", object: role.name, detail: { roleId, objective: text }, runId: run.id });
    this.changed(role.spaceId);
    return run;
  }

  /**
   * `RunService.onChanged`: a goal run that just got its session takes the goal, before its first turn
   * goes out — once: every later write of the run (its cost, say) comes through here too, and a goal
   * the agent has since closed must stay closed. One that ended stops its goal, so nothing continues
   * a run that is over.
   */
  runChanged(run: Run): void {
    if (this.closing || run.wokeOn !== "goal" || !run.sessionId) return;
    const goal = this.d.goals.get(run.sessionId);
    if (run.state === "running" && (!goal || goal.startedAt < (run.startedAt ?? run.createdAt))) {
      const objective = this.objectiveOf(run);
      if (objective) this.d.goals.adopt(run.sessionId, objective, null);
    } else if (isRunTerminal(run.state) && goal?.status === "active") {
      this.d.goals.set(run.sessionId, "blocked", run.error ?? "The role's run ended.");
    }
  }

  /** `RunService.holdSettle`: a goal run's turn settling is not the run settling while its goal goes on. */
  holdSettle(run: Run): boolean {
    return run.wokeOn === "goal" && !!run.sessionId && this.d.goals.get(run.sessionId)?.status === "active";
  }

  /**
   * The goal loop stopped a goal (complete, stalled, failing, capped, paused by the person). Its run
   * settles now when the session is resting — a goal the agent closed mid-turn settles at that turn's
   * end instead, and a spent token budget's handover turn settles the same way.
   */
  goalChanged(sessionId: string, goal: Goal | null): void {
    if (this.closing) return;
    const run = this.d.runs.listLive().find((r) => r.sessionId === sessionId && r.wokeOn === "goal" && r.state === "running");
    if (!run) return;
    if (goal?.status === "active" || goal?.status === "budget_limited") return;
    if (this.sessionStatus(sessionId) !== "idle") return;
    const role = run.roleId ? this.d.teamStore.role(run.roleId) : null;
    if (goal?.status === "complete") {
      this.d.runs.finish(run.id, goal.note ?? "Goal complete.");
      return;
    }
    const why = goal ? `${role?.name ?? "The role"} stopped working toward its goal: ${goal.note ?? goal.status}` : "the goal was dropped";
    if (role) this.d.teamStore.appendActivity({ spaceId: run.spaceId, actor: "realm", verb: "goal_stopped", object: role.name, detail: { roleId: role.id, why: goal?.note ?? null, status: goal?.status ?? null }, runId: run.id, sessionId });
    this.d.runs.stopAtLimit(run.id, why);
  }

  /* ═══════════════════════════════ the back-off ═══════════════════════════════ */

  /**
   * The session-event rail: an engine saying its account hit a limit backs every team off on that
   * engine; a mention's sub-agent reporting usage or settling repaints its role.
   */
  handleSessionEvent(session: Session, ev: SessionEvent): void {
    if (this.closing) return;
    if (ev.type === "rate_limit" && ev.payload.alert === "exceeded") {
      const at = backoffUntil({ windows: ev.payload.windows, alertWindow: ev.payload.alertWindow }, this.now());
      this.backOff(session.agentKind, at.until, `${AGENT_META[session.agentKind]?.label ?? session.agentKind} reported its plan limit`);
      return;
    }
    if (ev.type === "error" && (ev.payload.failure === "usage_limit" || classifyFailure(ev.payload.message) === "usage_limit")) {
      const at = backoffUntil({ message: ev.payload.message }, this.now());
      this.backOff(session.agentKind, at.until, `${AGENT_META[session.agentKind]?.label ?? session.agentKind} reported a usage limit${at.named ? "" : " without naming its reset, so Realm waits an hour"}`);
      return;
    }
    if (ev.type !== "usage" && ev.type !== "status") return;
    const m = this.d.store.forSession(session.id);
    if (!m || m.kind !== "mention" || m.settledAt !== null) return;
    if (ev.type === "usage") {
      const cost = this.sessionCost(session.id, { ts: ev.ts, ...ev.payload });
      if (cost !== null) this.d.store.setMentionCost(m.id, cost);
    }
    this.changed(m.spaceId);
  }

  backOff(kind: AgentKind | string, until: number, why: string): void {
    const all = this.readBackoffs();
    const prior = all[kind];
    if (prior && prior.until >= until) return;
    all[kind] = { agentKind: kind, until, why, since: prior && prior.until > this.now() ? prior.since : this.now() };
    this.d.settings.set(BACKOFF_KEY, all);
    for (const spaceId of this.d.teamStore.teamSpaceIds()) {
      this.d.teamStore.appendActivity({ spaceId, actor: "realm", verb: "backed_off", object: AGENT_META[kind as AgentKind]?.label ?? kind, detail: { agentKind: kind, until, why } });
      this.changed(spaceId);
    }
    this.armBackoff();
  }

  /** Lift a back-off by hand ("Try now"): the queue is pumped at once. */
  liftBackoff(kind: string): boolean {
    const all = this.readBackoffs();
    if (!all[kind]) return false;
    delete all[kind];
    this.d.settings.set(BACKOFF_KEY, all);
    for (const spaceId of this.d.teamStore.teamSpaceIds()) {
      this.d.teamStore.appendActivity({ spaceId, actor: "user", verb: "backed_off", object: AGENT_META[kind as AgentKind]?.label ?? kind, detail: { agentKind: kind, lifted: true } });
      this.changed(spaceId);
    }
    this.armBackoff();
    this.d.runs.pump();
    return true;
  }

  /** `ScheduleService.refuse`'s Phase 4 half: a role's clock on a backed-off engine is skipped, and says so. */
  refuseSchedule(schedule: Schedule): string | null {
    if (!schedule.roleId) return null;
    const role = this.d.teamStore.role(schedule.roleId);
    const b = role ? this.backoff(role.agentKind) : null;
    if (!role || !b) return null;
    const why = `${b.why}; team runs wait until ${clock(b.until)}`;
    this.d.teamStore.appendActivity({ spaceId: role.spaceId, actor: "realm", verb: "paused", object: role.name, detail: { roleId: role.id, why } });
    this.changed(role.spaceId);
    return why;
  }

  private armBackoff(): void {
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.backoffTimer = null;
    if (this.closing) return;
    const next = this.backoffs()[0];
    if (!next) return;
    const t = setTimeout(() => {
      this.backoffTimer = null;
      for (const spaceId of this.d.teamStore.teamSpaceIds()) this.changed(spaceId);
      this.d.runs.pump();
      this.armBackoff();
    }, Math.max(0, next.until - this.now()) + 250);
    t.unref?.();
    this.backoffTimer = t;
  }

  /* ═══════════════════════════════ settings on the pages ═══════════════════════════════ */

  /**
   * A team's starters hand off where their templates say (Content Producer → Creator Manager), but only
   * along edges that touch a role made just now: an edge the person took away from two roles that
   * were already there is not drawn again because a third one joined.
   */
  seedEdges(spaceId: string, templates: string[]): void {
    if (templates.length === 0) return;
    const roles = this.d.teamStore.roles(spaceId);
    const fresh = new Set(roles.filter((r) => r.template && templates.includes(r.template)).map((r) => r.id));
    for (const from of roles) {
      const wants = from.template ? TEMPLATE_HANDOFFS[from.template] ?? [] : [];
      const add = roles.filter((to) => to.id !== from.id && to.template && wants.includes(to.template) && (fresh.has(from.id) || fresh.has(to.id))).map((to) => to.id);
      if (add.length) this.d.store.setEdges(from.id, [...this.d.store.edges(from.id), ...add]);
    }
  }

  setRoleHandoffs(input: SetRoleHandoffsInput): TeamRole {
    const role = this.d.teamStore.role(input.id);
    if (!role) throw new NotFoundError("role", input.id);
    if (input.handsOffTo) {
      const team = new Set(this.d.teamStore.roles(role.spaceId).map((r) => r.id));
      const bad = input.handsOffTo.find((id) => !team.has(id) || id === role.id);
      if (bad) throw new RpcError("TEAM_HANDOFF_EDGE", bad === role.id ? `${role.name} cannot hand work to itself` : "a role it hands off to must be on the same team");
      this.d.store.setEdges(role.id, input.handsOffTo);
    }
    if (input.wakeOnMention !== undefined) this.d.store.setWakeOnMention(role.id, input.wakeOnMention);
    this.d.teamStore.appendActivity({ spaceId: role.spaceId, actor: "user", verb: "edited_role", object: role.name,
      detail: { roleId: role.id, changed: [...(input.handsOffTo ? ["handsOffTo"] : []), ...(input.wakeOnMention !== undefined ? ["wakeOnMention"] : [])] } });
    this.changed(role.spaceId);
    return this.d.team.roleView(this.d.teamStore.role(role.id)!);
  }

  setLimits(spaceId: string, o: { teamMaxLive?: number | undefined; realmMaxUnattended?: number | undefined }): void {
    if (o.teamMaxLive !== undefined) this.d.settings.set(`team.maxLive:${spaceId}`, o.teamMaxLive);
    if (o.realmMaxUnattended !== undefined) this.d.settings.set("team.slots", o.realmMaxUnattended);
    this.d.teamStore.appendActivity({ spaceId, actor: "user", verb: "edited_limits", object: null, detail: { ...o } });
    for (const id of this.d.teamStore.teamSpaceIds()) this.changed(id);
    this.d.runs.pump();
  }

  /* ═══════════════════════════════ internals ═══════════════════════════════ */

  /** A session's spend, from its own usage reports — the whole of a mention's sub-agent session. */
  private sessionCost(sessionId: string, latest?: { ts: number; costUsd?: number; inputTokens?: number; outputTokens?: number; numTurns?: number }): number | null {
    let kind: AgentKind;
    try { kind = this.d.sessions.get(sessionId).agentKind; } catch { return null; }
    const series = USAGE_REPORTING[kind]?.series ?? "none";
    if (series === "none") return null;
    const samples: { ts: number; costUsd: number; inputTokens: number; outputTokens: number; numTurns: number }[] = [];
    let after = 0;
    for (;;) {
      const batch = this.d.sessions.events(sessionId, after, 500);
      if (batch.length === 0) break;
      for (const e of batch) {
        after = e.seq;
        if (e.event.type === "usage") {
          const u = e.event.payload;
          samples.push({ ts: e.event.ts, costUsd: u.costUsd ?? 0, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, numTurns: u.numTurns ?? 0 });
        }
      }
    }
    if (latest) samples.push({ ts: latest.ts, costUsd: latest.costUsd ?? 0, inputTokens: latest.inputTokens ?? 0, outputTokens: latest.outputTokens ?? 0, numTurns: latest.numTurns ?? 0 });
    return Math.round(usageDeltas(samples, series).reduce((s, x) => s + x.costUsd, 0) * 10_000) / 10_000;
  }

  private sessionStatus(sessionId: string): string | null {
    try { return this.d.sessions.get(sessionId).status; } catch { return null; }
  }

  private changed(spaceId: string): void {
    this.d.rpc.broadcast("team.changed", { spaceId });
  }
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clock = (ts: number): string => new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
