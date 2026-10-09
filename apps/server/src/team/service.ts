import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CreateRoleSchema, CustomRoleSchema, ROLE_TEMPLATES, teamShares, type CustomRoleInput, TEAM_DEFAULTS, UpdateRoleSchema, USAGE_REPORTING, amrRepoSourceLink, creatorRecordTemplate,
  ACT_PACING, actKindFor, isRunLive, isRunTerminal, parseMemoryEntry, parseRecord, recordAccounts, recordField, recordSlug, sessionEvent, usageDeltas, weekStart,
  type ActTicket, type AgentKind, type CreateRoleInput, type ParsedRecord, type LedgerLine, type ReviewCheck, type ReviewKind, type ReviewTarget, type RoleRun,
  type Run, type Schedule, type Session, type SessionEvent, type TeamActivity, type TeamRecord, type TeamRecordSummary,
  type TeamReviewDetail, type TeamReviewItem, type TeamReviewSummary, type TeamRole, type TeamSpace, type UpdateRoleInput, type WokeOn,
} from "@realm/contracts";
import type { RunService } from "../runs/service";
import { workerPreamble } from "../runs/service";
import type { ScheduleService } from "../schedules/service";
import type { SessionService } from "../sessions/service";
import type { MemoryRepoService } from "../memory/repo";
import type { RpcServer } from "../rpc/server";
import { NotFoundError, RpcError } from "../store/rows";
import { bytesHash, itemHash } from "./item-hash";
import { applyRecordEdit, type RecordEdit } from "./records";
import type { ItemInsert, ReviewRow, RoleRow, TeamStore } from "./store";

type SettingsLike = { get(key: string): unknown; set(key: string, value: unknown): void };

const teamBudgetKey = (spaceId: string) => `team.weekBudget:${spaceId}`;
const teamMaxLiveKey = (spaceId: string) => `team.maxLive:${spaceId}`;
const SLOTS_KEY = "team.slots";
const IMAGE = /\.(png|jpe?g|gif|webp|heic|avif)$/i;
const REVIEW_DEDUPE = /^review:([0-9A-HJKMNP-TV-Z]{26}):\d+$/;

export type SubmitInput = {
  kind: ReviewKind;
  title: string;
  record?: string | undefined;
  items: { files: string[]; body?: string | undefined; target?: ReviewTarget | undefined }[];
};

export type RecordUpdateInput =
  | { path: string; op: "create"; name: string }
  | { path: string; op: "add"; section?: string | undefined; entry: string }
  | { path: string; op: "replace"; match: string; entry: string }
  | { path: string; op: "remove"; match: string };

/**
 * Teams: roles, Review, records and the activity log, over machinery Realm already has.
 *
 * **A role's run is a `runs` row.** Its clock is an ordinary schedule tagged with the role; Run now,
 * a message and "Request changes" are `RunService.create` with the role's id. This service decides
 * WHETHER a role's run may start (`admit`: one per role, two per team, three unattended Realm-wide),
 * what it is told (`rolePreamble`), and when it must stop (`$` and minutes caps, from the session's
 * own usage reports and a timer armed when it starts). It never dispatches a session itself.
 *
 * **Review is the only way out.** A role delivers with `review_submit`; files must be inside the
 * space folder, and each item carries the hash of exactly the bytes it showed. Approve records that
 * hash; a file changed afterwards drops the review back to waiting, because a yes to one picture is
 * not a yes to another. Phase 1 posts nothing: approved means "ready for you to post by hand".
 *
 * **Records are files.** One Markdown file per person in the space's memory repo, committed through
 * `MemoryRepoService` — its lock, its clean-repo rule and its secret refusal — with the role (or the
 * person) as the commit's author.
 *
 * **Everything is an activity line.** `team_activity` is append-only, and every wake, submission,
 * decision, record change and cap stop writes one.
 */
export class TeamService {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private hashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();
  private closing = false;

  constructor(private readonly d: {
    store: TeamStore;
    runs: Pick<RunService, "create" | "get" | "listForRole" | "spentSince" | "listLive" | "recordCost" | "stopAtLimit" | "pump">;
    schedules: Pick<ScheduleService, "createForRole" | "forRole" | "update" | "remove">;
    sessions: Pick<SessionService, "get" | "events" | "publishServerEvent">;
    repos: Pick<MemoryRepoService, "config" | "create" | "defaultPath" | "read" | "writeFile" | "lastChange">;
    /** The space's folder — where a review's files must live. */
    rootForSpace: (spaceId: string) => string | null;
    spaceExists: (spaceId: string) => boolean;
    /** The skills a space has on — a starter role takes its template's skills only where they exist. */
    enabledSkills?: (spaceId: string) => string[];
    settings: SettingsLike;
    rpc: Pick<RpcServer, "broadcast">;
    /** The agent a role runs on when none is named: claude in production, the fake in tests. */
    defaultKind?: AgentKind;
    /** Approve → act (team/acts): an approval issues tickets, and a review that moves on takes back
     *  whatever has not gone out. Absent, approving marks the batch and nothing more. */
    acts?: {
      issue(reviewId: string): ActTicket[];
      cancelForReview(reviewId: string, why: string): void;
      tickets(reviewId: string): ActTicket[];
      counts(reviewId: string): { total: number; done: number };
      held(spaceId: string): boolean;
      today(kind: "post" | "dm" | "email", channel: string, account: string): { count: number; cap: number };
    };
    /** More standing context for a role's run — the vault's names it may use (team/vault). */
    preambleExtra?: (roleId: string) => string[];
    clock?: () => number;
    today?: () => string;
  }) {}

  private now(): number { return this.d.clock ? this.d.clock() : Date.now(); }
  private today(): string { return this.d.today ? this.d.today() : new Date(this.now()).toISOString().slice(0, 10); }

  /** Boot: arm the minutes cap of every role run already going (a restart re-queues them anyway). */
  start(): void {
    for (const run of this.d.runs.listLive()) if (run.roleId && run.state === "running") this.arm(run);
  }

  close(): void {
    this.closing = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /* ═══════════════════════════════ the team ═══════════════════════════════ */

  isTeam(spaceId: string): boolean { return this.d.store.roles(spaceId, true).length > 0; }

  /** Every space that is a team, as the sidebar needs it. */
  overview(): TeamSpace[] {
    return this.d.store.teamSpaceIds().filter((id) => this.d.spaceExists(id)).map((id) => this.space(id));
  }

  space(spaceId: string): TeamSpace {
    const roles = this.d.store.roles(spaceId).map((r) => this.roleView(r));
    this.refreshApprovedHashes(spaceId);
    const reviews = this.d.store.reviews(spaceId).filter((r) => r.state !== "dismissed").map((r) => this.summary(r));
    const repo = this.repoPath(spaceId);
    const owner = { scope: "space", id: spaceId } as const;
    return {
      spaceId,
      enabled: this.isTeam(spaceId),
      roles,
      reviews,
      weekSpendUsd: round(this.d.runs.spentSince({ spaceId }, weekStart(this.now()))),
      weekBudgetUsd: this.teamBudget(spaceId),
      hasRepo: repo !== null,
      repoPath: repo,
      repoMoved: repo !== null && resolve(repo) !== resolve(this.d.repos.defaultPath(owner)),
      sharesUsd: teamShares(roles),
      formerRoles: this.d.store.roles(spaceId, true).filter((r) => r.archived).map((r) => ({ id: r.id, name: r.name, realmite: r.realmite })),
      recordCount: repo ? this.recordFiles(repo).length : 0,
      runSessionIds: this.runSessionIds(spaceId),
      actsHeld: this.d.acts?.held(spaceId) ?? false,
    };
  }

  /** The sessions role runs made, so the sidebar can leave them to the role's page. */
  private runSessionIds(spaceId: string): string[] {
    const out = new Set<string>();
    for (const r of this.d.store.roles(spaceId, true)) {
      for (const run of this.d.runs.listForRole(r.id, 200)) if (run.sessionId) out.add(run.sessionId);
    }
    return [...out];
  }

  teamBudget(spaceId: string): number {
    const v = this.d.settings.get(teamBudgetKey(spaceId));
    return typeof v === "number" && v > 0 ? v : TEAM_DEFAULTS.teamWeekBudgetUsd;
  }

  /**
   * Make a space a team, or add to one: its own memory repo (where records live) if it has none, in
   * the folder the person chose if they chose one; the starter roles asked for — each only if no role
   * of that name exists, so a second click adds nothing — and the roles the person wrote. Everything
   * is checked before anything is made: the names, and that the shares fit the team's week (raised
   * first, when the picker asked to raise it).
   */
  async makeTeam(spaceId: string, templates: string[], o: { roles?: CustomRoleInput[]; repoPath?: string; weekBudgetUsd?: number } = {}): Promise<TeamSpace> {
    if (!this.d.spaceExists(spaceId)) throw new NotFoundError("space", spaceId);
    const picked = templates.map((id) => {
      const t = ROLE_TEMPLATES.find((x) => x.id === id);
      if (!t) throw new RpcError("TEAM_TEMPLATE", `no starter role "${id}" — there are ${ROLE_TEMPLATES.map((x) => x.id).join(", ")}`);
      return t;
    }).filter((t) => !this.d.store.roleByName(spaceId, t.name));
    const custom = (o.roles ?? []).map((r) => CustomRoleSchema.parse(r));
    const names = [...picked.map((t) => t.name), ...custom.map((r) => r.name)].map((n) => n.toLowerCase());
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    if (twice) throw new RpcError("TEAM_ROLE_NAME", `two of the roles are called ${[...picked, ...custom].find((r) => r.name.toLowerCase() === twice)!.name} — give one another name`);
    for (const r of custom) if (this.d.store.roleByName(spaceId, r.name)) throw new RpcError("TEAM_ROLE_NAME", `this team already has a role called ${r.name}`);
    const cap = o.weekBudgetUsd ?? this.teamBudget(spaceId);
    this.checkShares(spaceId, cap, { add: [...picked.map((t) => t.weekBudgetUsd), ...custom.map((r) => r.weekBudgetUsd ?? null)] });
    if (!this.repoPath(spaceId)) await this.d.repos.create({ scope: "space", id: spaceId }, o.repoPath);
    if (o.weekBudgetUsd !== undefined) this.d.settings.set(teamBudgetKey(spaceId), o.weekBudgetUsd);
    const fresh = !this.isTeam(spaceId);
    for (const t of picked) {
      this.createRole({
        spaceId, name: t.name, brief: t.brief, realmite: { seed: t.realmiteSeed }, template: t.id, model: t.model, cron: t.cron, skills: this.present(spaceId, t.skills), weekBudgetUsd: t.weekBudgetUsd,
      }, { quiet: true });
    }
    for (const r of custom) this.createRole({ ...r, spaceId }, { quiet: true });
    if (fresh) this.log(spaceId, "user", "made_team", null, { roles: [...picked.map((t) => t.id), ...custom.map((r) => r.name)] });
    this.changed(spaceId);
    return this.space(spaceId);
  }

  /** Set the team's week. Never under what its roles' shares already come to. */
  setTeamBudget(spaceId: string, weekBudgetUsd: number): TeamSpace {
    if (!this.d.spaceExists(spaceId)) throw new NotFoundError("space", spaceId);
    const shares = teamShares(this.d.store.roles(spaceId));
    if (weekBudgetUsd < shares) throw new RpcError("TEAM_BUDGET_OVER", `the roles' shares already come to ${usd(shares)} a week — lower a role's budget first, or keep the team's week at ${usd(shares)} or more`);
    this.d.settings.set(teamBudgetKey(spaceId), weekBudgetUsd);
    this.log(spaceId, "user", "edited_team", null, { weekBudgetUsd });
    this.changed(spaceId);
    return this.space(spaceId);
  }

  /**
   * The rule that keeps a team's week honest: its roles' shares add up to no more than the team's
   * cap. Only a change that RAISES the sum is held to it, so a team already over (made before the rule)
   * can still lower a share or remove a role.
   */
  private checkShares(spaceId: string, cap: number, change: { replace?: { id: string; weekBudgetUsd: number | null }; add?: (number | null)[] }): void {
    const roles = this.d.store.roles(spaceId);
    const before = teamShares(roles);
    const after = teamShares(roles, change);
    if (after > before && after > cap + 1e-9) {
      throw new RpcError("TEAM_BUDGET_OVER", `the roles' shares would come to ${usd(after)} of the team's ${usd(cap)} a week — lower a share, or raise the team's week to ${usd(after)}`);
    }
  }

  /** A template's skills as this space names them (a library skill may carry a prefix), leaving out
   *  any it does not have: a run whose skills cannot resolve would refuse to start at all. */
  private present(spaceId: string, wanted: string[]): string[] {
    const have = this.d.enabledSkills?.(spaceId) ?? [];
    return wanted.flatMap((w) => have.filter((h) => h === w || h.endsWith(`-${w}`) || h.endsWith(`:${w}`)).slice(0, 1));
  }

  /* ═══════════════════════════════ roles ═══════════════════════════════ */

  roleView(r: RoleRow): TeamRole {
    const schedule = this.d.schedules.forRole(r.id);
    const runs = this.d.runs.listForRole(r.id, 20);
    const live = runs.filter((x) => isRunLive(x.state));
    const running = live.find((x) => x.state === "running");
    const blocked = live.find((x) => x.state === "blocked");
    const waitingOnPerson = running?.sessionId ? this.sessionStatus(running.sessionId) === "waiting_permission" : false;
    const latest = runs[0] ?? null;
    const pausedWhy = this.pausedWhy(r);
    const state: TeamRole["state"] = blocked || waitingOnPerson ? "waiting" : running ? "working" : live.length > 0 ? "queued" : pausedWhy ? "paused" : "idle";
    const unread = latest && isRunTerminal(latest.state) && latest.sessionId ? this.sessionUnread(latest.sessionId) : false;
    return {
      id: r.id, spaceId: r.spaceId, name: r.name, brief: r.brief, realmite: r.realmite, template: r.template,
      agentKind: r.agentKind, model: r.model, effort: r.effort, permissionMode: r.permissionMode, skills: r.skills,
      scheduleId: schedule?.id ?? null, cron: schedule?.cron ?? null, scheduleEnabled: schedule?.enabled ?? false, nextRunAt: schedule?.nextRunAt ?? null,
      wakeOnReview: r.wakeOnReview, weekBudgetUsd: r.weekBudgetUsd, runCapUsd: r.runCapUsd, runCapMs: r.runCapMs, maxConcurrent: r.maxConcurrent,
      archived: r.archived, createdAt: r.createdAt, updatedAt: r.updatedAt,
      state, stateSince: (blocked ?? running ?? live[0])?.startedAt ?? (blocked ?? running ?? live[0])?.createdAt ?? null,
      pausedWhy: state === "paused" ? pausedWhy : null,
      weekSpendUsd: round(this.d.runs.spentSince({ roleId: r.id }, weekStart(this.now()))),
      lastRunAt: latest?.createdAt ?? null,
      latestSessionId: latest?.sessionId ?? null,
      unread,
    };
  }

  role(id: string): TeamRole {
    const r = this.d.store.role(id);
    if (!r) throw new NotFoundError("role", id);
    return this.roleView(r);
  }

  createRole(input: CreateRoleInput, o: { quiet?: boolean } = {}): TeamRole {
    const p = CreateRoleSchema.parse(input);
    if (!this.d.spaceExists(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    if (this.d.store.roleByName(p.spaceId, p.name)) throw new RpcError("TEAM_ROLE_NAME", `this team already has a role called ${p.name}`);
    this.checkShares(p.spaceId, this.teamBudget(p.spaceId), { add: [p.weekBudgetUsd ?? null] });
    const row = this.d.store.createRole({
      spaceId: p.spaceId, name: p.name, brief: p.brief, realmite: p.realmite, template: p.template ?? null,
      agentKind: p.agentKind ?? this.d.defaultKind ?? "claude", model: p.model ?? null, effort: p.effort ?? null,
      permissionMode: p.permissionMode ?? "default", skills: p.skills ?? [], wakeOnReview: p.wakeOnReview ?? true,
      weekBudgetUsd: p.weekBudgetUsd ?? null, runCapUsd: p.runCapUsd ?? TEAM_DEFAULTS.runCapUsd, runCapMs: p.runCapMs ?? TEAM_DEFAULTS.runCapMs,
      maxConcurrent: 1,
    });
    if (p.cron) this.d.schedules.createForRole(this.scheduleInput(row, p.cron), row.id);
    this.log(row.spaceId, "user", "made_role", row.name, { roleId: row.id });
    if (!o.quiet) this.changed(row.spaceId);
    return this.roleView(row);
  }

  updateRole(input: UpdateRoleInput): TeamRole {
    const p = UpdateRoleSchema.parse(input);
    const before = this.d.store.role(p.id);
    if (!before) throw new NotFoundError("role", p.id);
    if (p.name && p.name.toLowerCase() !== before.name.toLowerCase() && this.d.store.roleByName(before.spaceId, p.name))
      throw new RpcError("TEAM_ROLE_NAME", `this team already has a role called ${p.name}`);
    if (p.weekBudgetUsd !== undefined && !before.archived) this.checkShares(before.spaceId, this.teamBudget(before.spaceId), { replace: { id: p.id, weekBudgetUsd: p.weekBudgetUsd } });
    const row = this.d.store.updateRole(p.id, {
      ...(p.name !== undefined ? { name: p.name } : {}), ...(p.brief !== undefined ? { brief: p.brief } : {}),
      ...(p.realmite !== undefined ? { realmite: p.realmite } : {}), ...(p.agentKind !== undefined ? { agentKind: p.agentKind } : {}),
      ...(p.model !== undefined ? { model: p.model } : {}), ...(p.effort !== undefined ? { effort: p.effort } : {}),
      ...(p.permissionMode !== undefined ? { permissionMode: p.permissionMode } : {}), ...(p.skills !== undefined ? { skills: p.skills } : {}),
      ...(p.wakeOnReview !== undefined ? { wakeOnReview: p.wakeOnReview } : {}), ...(p.weekBudgetUsd !== undefined ? { weekBudgetUsd: p.weekBudgetUsd } : {}),
      ...(p.runCapUsd !== undefined ? { runCapUsd: p.runCapUsd } : {}), ...(p.runCapMs !== undefined ? { runCapMs: p.runCapMs } : {}),
    })!;
    // The clock: made, moved, paused or removed with the role — and its runs' wording follows the brief.
    const schedule = this.d.schedules.forRole(row.id);
    if (p.cron === null && schedule) this.d.schedules.remove(schedule.id);
    else if (p.cron && !schedule) this.d.schedules.createForRole(this.scheduleInput(row, p.cron), row.id);
    else if (schedule) {
      const s = this.scheduleInput(row, p.cron ?? schedule.cron);
      this.d.schedules.update({ id: schedule.id, title: s.title, goal: s.goal, cron: s.cron, constraints: s.constraints,
        ...(p.scheduleEnabled !== undefined ? { enabled: p.scheduleEnabled } : {}) });
    }
    const changedKeys = Object.keys(p).filter((k) => k !== "id");
    this.log(row.spaceId, "user", "edited_role", row.name, { roleId: row.id, changed: changedKeys });
    this.changed(row.spaceId);
    this.d.runs.pump();
    return this.roleView(row);
  }

  archiveRole(id: string): void {
    const row = this.d.store.role(id);
    if (!row) throw new NotFoundError("role", id);
    const schedule = this.d.schedules.forRole(id);
    if (schedule) this.d.schedules.remove(schedule.id);
    this.d.store.updateRole(id, { archived: true });
    this.log(row.spaceId, "user", "archived_role", row.name, { roleId: id });
    this.changed(row.spaceId);
  }

  /** A role's runs as its page lists them. */
  roleRuns(roleId: string, limit = 30): RoleRun[] {
    return this.d.runs.listForRole(roleId, limit).map((run) => {
      const review = this.d.store.reviewForRun(run.id);
      const lines = this.d.store.activityForRun(run.id);
      const capped = lines.find((l) => l.verb === "stopped_at_cap");
      const woke = lines.find((l) => l.verb === "woke");
      return {
        id: run.id, roleId, state: run.state, wokeOn: (run.wokeOn as WokeOn | null) ?? null,
        wokeNote: typeof woke?.detail.note === "string" ? woke.detail.note : null,
        sessionId: run.sessionId, createdAt: run.createdAt, startedAt: run.startedAt, settledAt: run.settledAt,
        costUsd: run.costUsd, summary: firstLine(run.result), error: run.error,
        stoppedAtCap: capped ? (capped.detail.cap === "time" ? "time" : "usd") : null,
        reviewId: review?.id ?? null, reviewState: review?.state ?? null,
      };
    });
  }

  /** Run now, or a person's message: a run woken by hand. */
  runRole(id: string, message: string | null): Run {
    const role = this.d.store.role(id);
    if (!role || role.archived) throw new NotFoundError("role", id);
    const task = message?.trim()
      ? `${role.name}, a person on your team asked:\n\n${message.trim()}`
      : `${role.name}: a person started this run by hand. Do what your brief says is due now.`;
    return this.wake(role, "manual", task, { note: message?.trim() || null });
  }

  /* ── the run seams ── */

  /** Whether a queued role run may start now. Running runs only: a blocked one holds no execution. */
  admit(run: Run): boolean {
    if (!run.roleId) return true;
    const role = this.d.store.role(run.roleId);
    const running = this.d.runs.listLive().filter((r) => r.state === "running" && r.id !== run.id);
    if (running.filter((r) => r.roleId === run.roleId).length >= (role?.maxConcurrent ?? 1)) return false;
    if (running.filter((r) => r.roleId && r.spaceId === run.spaceId).length >= this.teamMaxLive(run.spaceId)) return false;
    if (running.length >= this.slots()) return false;
    return true;
  }

  private teamMaxLive(spaceId: string): number {
    const v = this.d.settings.get(teamMaxLiveKey(spaceId));
    return typeof v === "number" && v >= 1 ? v : TEAM_DEFAULTS.teamMaxLive;
  }

  private slots(): number {
    const v = this.d.settings.get(SLOTS_KEY);
    return typeof v === "number" && v >= 1 ? v : TEAM_DEFAULTS.realmMaxUnattended;
  }

  /** Why a role's clock may not fire: its week's budget, or its team's, is spent. Null when it may. */
  pausedWhy(role: RoleRow): string | null {
    const since = weekStart(this.now());
    if (role.weekBudgetUsd !== null && this.d.runs.spentSince({ roleId: role.id }, since) >= role.weekBudgetUsd)
      return `${role.name} has spent its ${usd(role.weekBudgetUsd)} for this week`;
    const team = this.teamBudget(role.spaceId);
    if (this.d.runs.spentSince({ spaceId: role.spaceId }, since) >= team) return `the team has spent its ${usd(team)} for this week`;
    return null;
  }

  /** `ScheduleService`'s seam: a role's clock is skipped while its budget is spent, and that is said. */
  refuseSchedule(schedule: Schedule): string | null {
    if (!schedule.roleId) return null;
    const role = this.d.store.role(schedule.roleId);
    if (!role || role.archived) return "the role is archived";
    const why = this.pausedWhy(role);
    if (why) {
      this.log(role.spaceId, "realm", "paused", role.name, { roleId: role.id, why });
      this.changed(role.spaceId);
    }
    return why;
  }

  /** The standing context a role's run wears: the unattended rules, then the team's. */
  rolePreamble(run: Run): string | null {
    const role = run.roleId ? this.d.store.role(run.roleId) : null;
    if (!role) return null;
    return [
      workerPreamble(`You are ${role.name}, a standing role on this space's team.\n\n${role.brief}`),
      "",
      "Team rules (Realm):",
      "- Deliver with `review_submit` (the realm-team tools). Never send, post, sign or pay: a person approves everything in Review, then presses each post or send themselves, one at a time, at Realm's paced slots. No tool lets you post, send or DM, and none ever will.",
      "- Records are Markdown files under `creators/` in the team's memory. Read them with `record_list` and `record_read`; change them with `record_update`. An account names where its sign-in is kept, never a password or key.",
      "- Save what you make inside this space's folder; Review only takes files from there.",
      `- This run stops at ${usd(role.runCapUsd)} or ${Math.round(role.runCapMs / 60_000)} minutes, whichever comes first.`,
      ...(this.d.preambleExtra?.(role.id) ?? []),
    ].join("\n");
  }

  /**
   * The session-event hook (the same rail `RunService` rides). A role run's usage report updates its
   * dollars and stops it at its cap; any status change repaints the role's row.
   */
  handleSessionEvent(session: Session, ev: SessionEvent): void {
    if (this.closing) return;
    if (ev.type !== "usage" && ev.type !== "status") return;
    const run = this.d.runs.listLive().find((r) => r.sessionId === session.id && r.roleId);
    if (!run) return;
    if (ev.type === "status") { this.changed(run.spaceId); return; }
    // The hook runs BEFORE the event is written, so the report in hand is added to the stored ones.
    const cost = this.costOf(run, session.agentKind, { ts: ev.ts, ...ev.payload });
    if (cost === null) return;
    this.d.runs.recordCost(run.id, cost);
    const role = this.d.store.role(run.roleId!);
    if (role && cost >= role.runCapUsd && run.state === "running") this.stop(run, role, "usd");
  }

  /** `RunService.onChanged`: arm a starting run's minutes cap, disarm a finished one, and tell the
   *  clients the role moved. A settle frees a slot, so the queue is tried again. */
  runChanged(run: Run): void {
    if (!run.roleId || this.closing) return;
    if (run.state === "running") this.arm(run);
    // A clock's wake is the scheduler's doing, not wake()'s, so its line is written when it starts.
    if (run.state === "running" && run.wokeOn === "schedule" && !this.d.store.activityForRun(run.id).some((l) => l.verb === "woke")) {
      this.log(run.spaceId, `role:${run.roleId}`, "woke", this.d.store.role(run.roleId)?.name ?? null, { roleId: run.roleId, wokeOn: "schedule" }, run);
    }
    if (isRunTerminal(run.state)) {
      const t = this.timers.get(run.id);
      if (t) { clearTimeout(t); this.timers.delete(run.id); }
    }
    this.changed(run.spaceId);
  }

  /** A run settled: a line for the log, and the next queued run's turn. */
  runSettled(run: Run): void {
    if (!run.roleId || this.closing) return;
    const role = this.d.store.role(run.roleId);
    const capped = this.d.store.activityForRun(run.id).some((l) => l.verb === "stopped_at_cap");
    if (!capped) {
      this.log(run.spaceId, `role:${run.roleId}`, run.state === "succeeded" ? "finished" : "failed", role?.name ?? null,
        { roleId: run.roleId, state: run.state, costUsd: run.costUsd, summary: firstLine(run.result ?? run.error) }, run);
    }
    this.d.runs.pump();
  }

  private arm(run: Run): void {
    if (this.timers.has(run.id)) return;
    const role = run.roleId ? this.d.store.role(run.roleId) : null;
    if (!role) return;
    const started = run.startedAt ?? this.now();
    const wait = Math.max(0, started + role.runCapMs - this.now());
    const t = setTimeout(() => {
      this.timers.delete(run.id);
      const live = this.d.runs.get(run.id)?.run;
      if (live && live.state === "running") this.stop(live, role, "time");
    }, wait);
    t.unref?.();
    this.timers.set(run.id, t);
  }

  private stop(run: Run, role: RoleRow, cap: "usd" | "time"): void {
    const why = cap === "usd"
      ? `${role.name} stopped at its ${usd(role.runCapUsd)} run limit`
      : `${role.name} stopped at its ${Math.round(role.runCapMs / 60_000)}-minute run limit`;
    this.log(run.spaceId, "realm", "stopped_at_cap", role.name, { roleId: role.id, cap, costUsd: run.costUsd }, run);
    this.d.runs.stopAtLimit(run.id, why);
  }

  /** A run's spend: the usage its session reported since the run started. Null for an engine that
   *  reports none — a meter that cannot be filled is not drawn as an empty one. */
  private costOf(run: Run, kind: AgentKind, latest: { ts: number; costUsd?: number; inputTokens?: number; outputTokens?: number; numTurns?: number }): number | null {
    const series = USAGE_REPORTING[kind]?.series ?? "none";
    if (series === "none" || !run.sessionId) return null;
    const samples: { ts: number; costUsd: number; inputTokens: number; outputTokens: number; numTurns: number }[] = [];
    let after = 0;
    for (;;) {
      const batch = this.d.sessions.events(run.sessionId, after, 500);
      if (batch.length === 0) break;
      for (const e of batch) {
        after = e.seq;
        if (e.event.type === "usage") {
          const u = e.event.payload;
          samples.push({ ts: e.event.ts, costUsd: u.costUsd ?? 0, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, numTurns: u.numTurns ?? 0 });
        }
      }
    }
    samples.push({ ts: latest.ts, costUsd: latest.costUsd ?? 0, inputTokens: latest.inputTokens ?? 0, outputTokens: latest.outputTokens ?? 0, numTurns: latest.numTurns ?? 0 });
    const since = run.startedAt ?? run.createdAt;
    return round(usageDeltas(samples, series).filter((x) => x.ts >= since).reduce((s, x) => s + x.costUsd, 0));
  }

  /** Every wake ends here: one run, with the role's narrowing, and a line in the log. */
  private wake(role: RoleRow, wokeOn: WokeOn, task: string, o: { note?: string | null; sessionId?: string | null; dedupeKey?: string | null } = {}): Run {
    const { run, created } = this.d.runs.create({
      spaceId: role.spaceId, title: role.name, goal: `${task}\n\nYour brief:\n\n${role.brief}`,
      constraints: this.constraints(role), dedupeKey: o.dedupeKey ?? null, maxAttempts: 1, deadlineAt: null,
      sessionId: o.sessionId ?? null, roleId: role.id, wokeOn,
    });
    if (created) {
      this.log(role.spaceId, `role:${role.id}`, "woke", role.name, { roleId: role.id, wokeOn, note: o.note ?? null }, run);
      if (run.state === "queued" && !this.admit(run)) this.log(role.spaceId, "realm", "queued", role.name, { roleId: role.id }, run);
    }
    this.changed(role.spaceId);
    return run;
  }

  private constraints(role: RoleRow) {
    return {
      agentKind: role.agentKind,
      ...(role.model ? { model: role.model } : {}),
      ...(role.effort ? { effort: role.effort } : {}),
      permissionMode: role.permissionMode,
      ...(role.skills.length > 0 ? { skills: role.skills } : {}),
    };
  }

  private scheduleInput(role: RoleRow, cron: string) {
    return {
      spaceId: role.spaceId, title: role.name, cron, enabled: true,
      goal: `${role.name}'s scheduled run. Do what your brief says is due now.\n\nYour brief:\n\n${role.brief}`,
      constraints: this.constraints(role), newSessionPerRun: true, archiveSucceeded: false,
    };
  }

  /* ═══════════════════════════════ review ═══════════════════════════════ */

  /**
   * A role (or any session in a team space) sends work to Review. Every file must be inside the space
   * folder, and an item aimed at an account needs a record whose Accounts line for it says `consent:`.
   * A run woken by "Request changes" revises the review it was woken for, in place.
   */
  submit(ctx: { sessionId: string; spaceId: string }, input: SubmitInput): TeamReviewSummary {
    if (!this.isTeam(ctx.spaceId)) throw new RpcError("TEAM_NOT_A_TEAM", "this space has no team — Review takes work from a team's roles");
    const root = this.d.rootForSpace(ctx.spaceId);
    if (!root) throw new RpcError("TEAM_NO_FOLDER", "this space has no folder for Review's files to live in");
    const title = input.title.trim();
    if (!title) throw new RpcError("TEAM_REVIEW_INVALID", "give the batch a title");
    if (input.items.length === 0) throw new RpcError("TEAM_REVIEW_INVALID", "a review needs at least one item");
    let recordPath: string | null = null;
    let record: ReturnType<typeof parseRecord> = null;
    if (input.record) {
      const repo = this.repoPath(ctx.spaceId);
      if (!repo) throw new RpcError("TEAM_NO_REPO", "this team has no memory repo, so it has no records");
      recordPath = this.recordRel(input.record);
      if (!existsSync(join(repo, recordPath))) throw new RpcError("TEAM_RECORD_NOT_FOUND", `${recordPath} is not a record — record_list lists them`);
      record = parseRecord(readFileSync(join(repo, recordPath), "utf8"));
    }
    const items: ItemInsert[] = input.items.map((it, i) => {
      if (it.files.length === 0 && !it.body?.trim()) throw new RpcError("TEAM_REVIEW_INVALID", `item ${i + 1} has neither files nor text`);
      const files = it.files.map((f) => this.spaceFile(root, f));
      const target = it.target && (it.target.channel || it.target.account) ? it.target : null;
      if (target?.account) this.requireConsent(target, record, recordPath, i);
      return { files, body: it.body?.trim() || null, target, contentHash: this.hashItem(root, files, it.body?.trim() || null) };
    });

    const run = this.d.runs.listLive().find((r) => r.sessionId === ctx.sessionId) ?? null;
    const roleId = run?.roleId ?? null;
    const revising = run?.dedupeKey ? REVIEW_DEDUPE.exec(run.dedupeKey)?.[1] ?? null : null;
    const prior = revising ? this.d.store.review(revising) : null;
    const row = prior && prior.spaceId === ctx.spaceId
      ? this.d.store.revise(prior.id, { runId: run?.id ?? null, sessionId: ctx.sessionId, title }, items)
      : this.d.store.createReview({ spaceId: ctx.spaceId, roleId, runId: run?.id ?? null, sessionId: ctx.sessionId, recordPath, kind: input.kind, title }, items);
    this.log(ctx.spaceId, roleId ? `role:${roleId}` : "realm", prior ? "revised" : "submitted", title,
      { reviewId: row.id, kind: input.kind, items: items.length, version: row.version }, run ?? { sessionId: ctx.sessionId });

    // The files are the session's work, so they belong in Documents and the Library like any other.
    const abs = [...new Set(items.flatMap((it) => it.files))].map((f) => join(root, f)).filter((p) => existsSync(p));
    if (abs.length > 0) {
      try {
        this.d.sessions.publishServerEvent(ctx.sessionId, sessionEvent("files_made", {
          settledAt: this.now(), files: abs.map((p) => ({ path: p, size: statSync(p).size })), totalFiles: abs.length,
        }));
      } catch { /* the session may be gone; the review stands on its own */ }
    }
    this.changed(ctx.spaceId);
    return this.summary(row);
  }

  private requireConsent(target: ReviewTarget, record: ReturnType<typeof parseRecord>, recordPath: string | null, i: number): void {
    if (!record || !recordPath)
      throw new RpcError("TEAM_NO_CONSENT", `item ${i + 1} is for ${target.account}, but names no record — pass \`record\` with the creator's record, whose Accounts line for ${target.account} says consent:`);
    const handle = target.account!.toLowerCase();
    const acct = recordAccounts(record).find((a) => a.handle?.toLowerCase() === handle
      && (!target.channel || a.channel.toLowerCase().includes(target.channel.toLowerCase()) || target.channel.toLowerCase().includes(a.channel.toLowerCase())));
    if (!acct) throw new RpcError("TEAM_NO_CONSENT", `${recordPath} has no Accounts line for ${target.account}${target.channel ? ` on ${target.channel}` : ""}`);
    if (!acct.parts.consent) throw new RpcError("TEAM_NO_CONSENT", `${recordPath} names ${target.account} without consent: — an account is managed only with the creator's written yes; add "· consent: <where it was given>" to its line first`);
  }

  reviewStatus(spaceId: string, id: string | null, sessionId: string): TeamReviewSummary[] {
    if (id) {
      const r = this.d.store.review(id);
      if (!r || r.spaceId !== spaceId) throw new NotFoundError("review", id);
      return [this.summary(r)];
    }
    return this.d.store.reviews(spaceId, 50).filter((r) => r.sessionId === sessionId).map((r) => this.summary(r));
  }

  summary(r: ReviewRow): TeamReviewSummary {
    const items = this.d.store.items(r.id, r.version);
    const role = r.roleId ? this.d.store.role(r.roleId) : null;
    const first = items[0]?.files.find((f) => IMAGE.test(f)) ?? null;
    return {
      id: r.id, spaceId: r.spaceId, roleId: r.roleId, roleName: role?.name ?? null, runId: r.runId, sessionId: r.sessionId,
      recordPath: r.recordPath, kind: r.kind, title: r.title, state: r.state, note: r.note, version: r.version,
      itemCount: items.length, thumb: first,
      channels: [...new Set(items.map((i) => i.target?.channel).filter((c): c is string => !!c))],
      account: items[0]?.target?.account ?? null,
      changedSinceApproval: items.some((i) => i.approvedHash !== null && i.approvedHash !== i.contentHash),
      ...(() => { const c = this.d.acts?.counts(r.id) ?? { total: 0, done: 0 }; return { actsTotal: c.total, actsDone: c.done }; })(),
      createdAt: r.createdAt, decidedAt: r.decidedAt, updatedAt: r.updatedAt,
    };
  }

  review(id: string): TeamReviewDetail {
    const r = this.d.store.review(id);
    if (!r) throw new NotFoundError("review", id);
    const root = this.d.rootForSpace(r.spaceId);
    if (root) this.rehash(r, root);
    const fresh = this.d.store.review(id)!;
    const all = this.d.store.items(id);
    const items = all.filter((i) => i.version === fresh.version);
    const previous = all.filter((i) => i.version < fresh.version);
    const run = fresh.runId ? this.d.runs.get(fresh.runId)?.run ?? null : null;
    const role = fresh.roleId ? this.d.store.role(fresh.roleId) : null;
    const repo = this.repoPath(fresh.spaceId);
    const record = fresh.recordPath && repo && existsSync(join(repo, fresh.recordPath)) ? parseRecord(readFileSync(join(repo, fresh.recordPath), "utf8")) : null;
    return {
      ...this.summary(fresh),
      items, previous,
      costUsd: run?.costUsd ?? null,
      durationMs: run?.startedAt ? (run.settledAt ?? this.now()) - run.startedAt : null,
      runCapUsd: role?.runCapUsd ?? null,
      model: run?.constraints?.model ?? role?.model ?? null,
      recordName: record?.title ?? null,
      checks: this.checks(items, record, fresh.kind),
      ledger: this.ledger(fresh, run),
      root,
      tickets: this.d.acts?.tickets(id) ?? [],
    };
  }

  /** What Realm itself can say about a batch before anyone posts it — facts it checked, not claims. */
  private checks(items: TeamReviewItem[], record: ReturnType<typeof parseRecord>, kind: ReviewKind): ReviewCheck[] {
    const out: ReviewCheck[] = [];
    const target = items.find((i) => i.target?.account)?.target ?? null;
    if (target?.account) {
      // The account on the channel it goes to: @versed.nathan on Instagram is not the TikTok one.
      const ch = target.channel?.toLowerCase() ?? "";
      const acct = record ? recordAccounts(record).find((a) => a.handle?.toLowerCase() === target.account!.toLowerCase()
        && (!ch || a.channel.toLowerCase().includes(ch) || ch.includes(a.channel.toLowerCase()))) ?? null : null;
      const verb = kind === "message" ? "Sends" : "Posts";
      out.push(acct?.parts.consent
        ? { ok: true, title: `${verb} as ${target.account}${acct.channel ? ` on ${acct.channel}` : ""}`, detail: `${record!.title}'s account, managed with their consent (${acct.parts.consent})` }
        : { ok: false, title: `${target.account} has no consent on record`, detail: "Add consent: to the account's line in the record before it is posted" });
    }
    const captions = items.map((i) => i.body ?? "").filter(Boolean);
    // Paid-partnership disclosure is a post's: a DM or an email carries no platform label.
    if (kind === "slideshows" && captions.length > 0 && items.some((i) => i.target?.account)) {
      const disclosed = captions.every((c) => /#ad\b|#sponsored\b|#paidpartnership\b|paid partnership/i.test(c));
      out.push(disclosed
        ? { ok: true, title: "Disclosed as paid partnership", detail: "Every caption says so" }
        : { ok: false, title: "No paid-partnership disclosure in the caption", detail: "Turn on the platform's paid-partnership label when you post, or add #ad" });
    }
    // Today's pacing for the account, as Realm will keep it — or, for work aimed nowhere, the plain
    // fact that a yes marks it and a person sends it. A message is sent, not posted.
    const act = target?.account ? actKindFor(kind, target.channel) : null;
    if (act && target?.account && target.channel && this.d.acts) {
      const today = this.d.acts.today(act, target.channel, target.account);
      const noun = act === "post" ? "posts" : act === "dm" ? "DMs" : "emails";
      out.push({ ok: today.count < today.cap, title: `${today.count} of ${today.cap} ${noun} today for this account`,
        detail: act === "post" ? "Realm spaces posts at least 2 hours apart" : `Realm spaces ${noun} at least ${Math.round(ACT_PACING[act].gapMs / 60_000)} minutes apart` });
    } else {
      out.push(kind === "message"
        ? { ok: null, title: "Realm does not send this", detail: "It names no account and no one to send it to. Approving marks it ready; send it yourself." }
        : { ok: null, title: "Realm does not post this", detail: "It names no account. Approving marks it ready; post it by hand from the space folder." });
    }
    return out;
  }

  /** "How it was made": the run's own log, in a few lines, with the dollars at the end. */
  private ledger(r: ReviewRow, run: Run | null): LedgerLine[] {
    const lines: LedgerLine[] = [];
    if (!run) return lines;
    for (const a of this.d.store.activityForRun(run.id)) {
      if (a.verb === "woke") {
        const why = a.detail.wokeOn === "schedule" ? "Woke on its schedule" : a.detail.wokeOn === "review" ? "Woke when you asked for changes" : "Started by you";
        lines.push({ ts: a.ts, glyph: "alarm", text: why, detail: typeof a.detail.note === "string" ? `“${clip(a.detail.note, 80)}”` : null });
      } else if (a.verb === "read_record") {
        lines.push({ ts: a.ts, glyph: "note", text: `Read ${a.object ?? "a record"}`, detail: typeof a.detail.path === "string" ? a.detail.path : null });
      } else if (a.verb === "updated_record") {
        lines.push({ ts: a.ts, glyph: "note", text: `Updated ${a.object ?? "a record"}`, detail: typeof a.detail.line === "string" ? clip(a.detail.line, 90) : null });
      } else if (a.verb === "submitted" || a.verb === "revised") {
        const items = typeof a.detail.items === "number" ? a.detail.items : null;
        const version = typeof a.detail.version === "number" ? a.detail.version : r.version;
        const files = [...new Set(this.d.store.items(r.id, version).flatMap((i) => i.files))];
        if (files.length > 0) {
          const pictures = files.filter((f) => IMAGE.test(f)).length;
          const dirs = [...new Set(files.map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".")))];
          lines.push({ ts: a.ts, glyph: "image", text: `Laid out ${files.length} ${pictures === files.length ? "slides" : "files"}`,
            detail: dirs.length === 1 ? `saved to ${dirs[0]}` : `in ${dirs.length} folders`, });
        }
        const role = r.roleId ? this.d.store.role(r.roleId) : null;
        const cost = run.costUsd !== null ? `${usd(run.costUsd)}${role ? ` of its ${usd(role.runCapUsd)} run cap` : ""}` : null;
        lines.push({
          ts: a.ts, glyph: "inbox",
          text: a.verb === "revised" && a.detail.version !== undefined ? `Sent version ${String(a.detail.version)} to Review`
            : `Sent ${items ?? ""} ${items === 1 ? "item" : "items"} to Review`.replace(/\s+/g, " "),
          detail: [role?.name, run.constraints?.model, cost].filter(Boolean).join(", ") || null,
        });
      }
    }
    return lines;
  }

  approve(id: string): TeamReviewSummary {
    const r = this.mustReview(id);
    if (r.state !== "waiting" && r.state !== "changes") throw new RpcError("TEAM_REVIEW_STATE", `this review is ${r.state}, not waiting`);
    const root = this.d.rootForSpace(r.spaceId);
    if (root) this.rehash(r, root);
    this.d.store.approveItems(id, r.version);
    const next = this.d.store.setReviewState(id, "approved", { decided: true, note: null })!;
    const hashes = this.d.store.items(id, r.version).map((i) => i.contentHash);
    this.log(r.spaceId, "user", "approved", r.title, { reviewId: id, version: r.version, hashes });
    // A yes issues tickets, one per outward act; it sends nothing. Each still waits for its own press.
    this.d.acts?.issue(id);
    this.changed(r.spaceId);
    return this.summary(next);
  }

  /**
   * Ask for changes. The note goes back to the run that made the batch — the same conversation, one
   * more turn, as a new run woken on the review — when the role wakes on reviews; its revision then
   * replaces this review's items in place.
   */
  requestChanges(id: string, note: string): TeamReviewSummary {
    const text = note.trim();
    if (!text) throw new RpcError("TEAM_REVIEW_INVALID", "say what should change");
    const r = this.mustReview(id);
    if (r.state === "done" || r.state === "dismissed") throw new RpcError("TEAM_REVIEW_STATE", `this review is ${r.state}`);
    const next = this.d.store.setReviewState(id, "changes", { note: text, decided: true })!;
    this.log(r.spaceId, "user", "asked_changes", r.title, { reviewId: id, note: text });
    this.d.acts?.cancelForReview(id, "you asked for changes");
    const role = r.roleId ? this.d.store.role(r.roleId) : null;
    if (role && !role.archived && role.wakeOnReview) {
      const prior = r.runId ? this.d.runs.get(r.runId)?.run ?? null : null;
      this.wake(role, "review", [
        `A person asked for changes to "${r.title}", which you sent to Review:`,
        "",
        text,
        "",
        "Make the changes, then send the new version with `review_submit` — it replaces the old one in place.",
      ].join("\n"), {
        note: text,
        sessionId: prior?.sessionId ?? r.sessionId,
        dedupeKey: `review:${id}:${r.version}`,
      });
    }
    this.changed(r.spaceId);
    return this.summary(next);
  }

  /** Posted by hand, sent, or read: the review is finished. */
  markDone(id: string): TeamReviewSummary {
    const r = this.mustReview(id);
    const next = this.d.store.setReviewState(id, "done", { decided: true })!;
    this.log(r.spaceId, "user", "marked_done", r.title, { reviewId: id });
    this.d.acts?.cancelForReview(id, "you marked it done by hand");
    this.changed(r.spaceId);
    return this.summary(next);
  }

  dismiss(id: string): TeamReviewSummary {
    const r = this.mustReview(id);
    const next = this.d.store.setReviewState(id, "dismissed", { decided: true })!;
    this.log(r.spaceId, "user", "dismissed", r.title, { reviewId: id });
    this.d.acts?.cancelForReview(id, "you dismissed it");
    this.changed(r.spaceId);
    return this.summary(next);
  }

  private mustReview(id: string): ReviewRow {
    const r = this.d.store.review(id);
    if (!r) throw new NotFoundError("review", id);
    return r;
  }

  /** Re-read an approved review's files; one that changed is a yes to bytes nobody saw, so the review
   *  goes back to waiting, and says why. */
  private refreshApprovedHashes(spaceId: string): void {
    const root = this.d.rootForSpace(spaceId);
    if (!root) return;
    for (const r of this.d.store.reviews(spaceId)) if (r.state === "approved") this.rehash(r, root);
  }

  private rehash(r: ReviewRow, root: string): void {
    let drifted = false;
    for (const item of this.d.store.items(r.id, r.version)) {
      const hash = this.hashItem(root, item.files, item.body);
      if (hash !== item.contentHash) this.d.store.setItemHash(item.id, hash);
      if (item.approvedHash !== null && hash !== item.approvedHash) drifted = true;
    }
    if (drifted && r.state === "approved") {
      this.d.store.setReviewState(r.id, "waiting", { note: "A file changed after you approved it, so it needs your yes again." });
      this.log(r.spaceId, "realm", "refused", r.title, { reviewId: r.id, why: "changed_after_approval" });
      this.d.acts?.cancelForReview(r.id, "a file changed after you approved it");
    }
  }

  /** sha256 over each file's bytes, in order, and the text: what the person saw. A file that is gone
   *  hashes as gone, so deleting one also changes the item. Cached by size and mtime. */
  hashItem(root: string, files: string[], body: string | null): string {
    return itemHash(files, (f) => this.fileHash(join(root, f)), body);
  }

  private fileHash(abs: string): string {
    let st;
    try { st = statSync(abs); } catch { return "missing"; }
    const hit = this.hashCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.hash;
    const hash = bytesHash(readFileSync(abs));
    this.hashCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, hash });
    return hash;
  }

  /** A file a role named, as a path relative to the space folder — refused unless it is a file that
   *  exists inside that folder, a symlink out of it included. */
  private spaceFile(root: string, given: string): string {
    const abs = isAbsolute(given) ? resolve(given) : resolve(root, given);
    const realRoot = existsSync(root) ? realpathSync(root) : root;
    let real: string;
    try { real = realpathSync(abs); } catch { throw new RpcError("TEAM_FILE_NOT_FOUND", `${given} does not exist — save the file in this space's folder first`); }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new RpcError("TEAM_FILE_OUTSIDE", `${given} is outside this space's folder; Review only takes files from ${root}`);
    if (!statSync(real).isFile()) throw new RpcError("TEAM_FILE_NOT_FOUND", `${given} is not a file`);
    return relative(realRoot, real).split(sep).join("/");
  }

  /* ═══════════════════════════════ records ═══════════════════════════════ */

  /** A record, parsed, by its path in the space's memory — null when it is missing or free-form. */
  recordFor(spaceId: string, recordPath: string): ParsedRecord | null {
    const repo = this.repoPath(spaceId);
    if (!repo) return null;
    const abs = join(repo, this.recordRel(recordPath));
    return existsSync(abs) ? parseRecord(readFileSync(abs, "utf8")) : null;
  }

  repoPath(spaceId: string): string | null {
    const cfg = this.d.repos.config({ scope: "space", id: spaceId });
    return cfg && existsSync(join(cfg.path, ".git")) ? cfg.path : null;
  }

  private recordFiles(repo: string): string[] {
    const dir = join(repo, "creators");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_") && !f.startsWith(".")).sort().map((f) => `creators/${f}`);
  }

  /** A record's path, normalised: `nathan-beyenhof`, `creators/nathan-beyenhof` and the `.md` all
   *  name `creators/nathan-beyenhof.md`. Never outside `creators/`. */
  recordRel(given: string): string {
    let p = given.trim().replace(/^\[\[|\]\]$/g, "").replace(/^\/+/, "");
    if (!p.startsWith("creators/")) p = `creators/${p}`;
    if (!p.endsWith(".md")) p = `${p}.md`;
    if (p.split("/").some((part) => part === ".." || part === "") || p.split("/").length !== 2)
      throw new RpcError("TEAM_RECORD_PATH", `${given} is not a record path — records are creators/<name>.md`);
    return p;
  }

  records(spaceId: string): TeamRecordSummary[] {
    const repo = this.repoPath(spaceId);
    if (!repo) return [];
    return this.recordFiles(repo).map((path) => {
      const abs = join(repo, path);
      const text = readFileSync(abs, "utf8");
      const parsed = parseRecord(text);
      return {
        path, kind: "creators",
        name: parsed?.title ?? path.slice("creators/".length, -3),
        status: parsed ? recordField(parsed, "status") : null,
        updatedAt: Math.round(statSync(abs).mtimeMs),
      };
    });
  }

  async record(spaceId: string, path: string): Promise<TeamRecord> {
    const repo = this.repoPath(spaceId);
    if (!repo) throw new RpcError("TEAM_NO_REPO", "this team has no memory repo, so it has no records");
    const rel = this.recordRel(path);
    const abs = join(repo, rel);
    if (!existsSync(abs)) throw new RpcError("TEAM_RECORD_NOT_FOUND", `${rel} is not a record`);
    const markdown = readFileSync(abs, "utf8");
    const parsed = parseRecord(markdown);
    const last = await this.d.repos.lastChange(repo, rel);
    return {
      path: rel, kind: "creators", name: parsed?.title ?? rel.slice("creators/".length, -3),
      status: parsed ? recordField(parsed, "status") : null,
      updatedAt: last?.at ?? Math.round(statSync(abs).mtimeMs),
      markdown, absPath: abs, lastAuthor: last?.author ?? null,
    };
  }

  /** The person's own edit of a record — the whole file, committed under their name. */
  async writeRecord(spaceId: string, path: string, markdown: string): Promise<TeamRecord> {
    const rel = this.recordRel(path);
    await this.d.repos.writeFile({ scope: "space", id: spaceId }, rel, markdown);
    this.log(spaceId, "user", "updated_record", parseRecord(markdown)?.title ?? rel, { path: rel });
    this.changed(spaceId);
    return this.record(spaceId, rel);
  }

  /** A new record from the template, by the person. */
  async createRecord(spaceId: string, name: string): Promise<TeamRecord> {
    const repo = this.repoPath(spaceId);
    if (!repo) throw new RpcError("TEAM_NO_REPO", "this team has no memory repo yet");
    const rel = this.recordRel(recordSlug(name));
    if (existsSync(join(repo, rel))) throw new RpcError("TEAM_RECORD_EXISTS", `${rel} already exists`);
    return this.writeRecord(spaceId, rel, creatorRecordTemplate(name.trim()));
  }

  /** `record_read`, for a role: the file, and a line in the run's log. */
  readForAgent(ctx: { sessionId: string; spaceId: string }, path: string): string {
    const repo = this.repoPath(ctx.spaceId);
    if (!repo) throw new RpcError("TEAM_NO_REPO", "this team has no memory repo, so it has no records yet");
    const rel = this.recordRel(path);
    const text = this.d.repos.read(repo, rel);
    const run = this.runFor(ctx.sessionId);
    this.log(ctx.spaceId, run?.roleId ? `role:${run.roleId}` : "realm", "read_record", parseRecord(text)?.title ?? rel, { path: rel }, run ?? ctx);
    return text;
  }

  /** `record_update`, for a role: one line changed (or a new record made), stamped with the session,
   *  committed under the role's name. Refuses a secret's shape, as every memory write does. */
  async updateForAgent(ctx: { sessionId: string; spaceId: string }, input: RecordUpdateInput): Promise<{ path: string; line: string | null; changed: boolean }> {
    const repo = this.repoPath(ctx.spaceId);
    if (!repo) throw new RpcError("TEAM_NO_REPO", "this team has no memory repo, so it has no records yet");
    const run = this.runFor(ctx.sessionId);
    const role = run?.roleId ? this.d.store.role(run.roleId) : null;
    const rel = input.op === "create" ? this.recordRel(input.path || recordSlug(input.name)) : this.recordRel(input.path);
    const abs = join(repo, rel);
    let content: string;
    let line: string | null = null;
    if (input.op === "create") {
      if (existsSync(abs)) throw new RpcError("TEAM_RECORD_EXISTS", `${rel} already exists — read it and change a line with record_update`);
      content = creatorRecordTemplate(input.name.trim());
    } else {
      if (!existsSync(abs)) throw new RpcError("TEAM_RECORD_NOT_FOUND", `${rel} is not a record — make it with op "create"`);
      const before = readFileSync(abs, "utf8");
      const edit: RecordEdit = input.op === "add" ? { op: "add", section: input.section?.trim() || null, entry: input.entry }
        : input.op === "replace" ? { op: "replace", match: input.match, entry: input.entry } : { op: "remove", match: input.match };
      const r = applyRecordEdit(before, edit, { source: amrRepoSourceLink(ctx.sessionId), added: this.today() });
      if (!r.ok) throw new RpcError("TEAM_RECORD_EDIT", `${rel}: ${r.error}`);
      // The log says the FACT: the bullet and its provenance tail are the file's grammar, and printed
      // in the activity feed they read as "· - … [source: realm:session/…; added: …]".
      content = r.content; line = r.line === null ? null : parseMemoryEntry(r.line)?.text ?? r.line;
    }
    const out = await this.d.repos.writeFile({ scope: "space", id: ctx.spaceId }, rel, content, role?.name);
    this.log(ctx.spaceId, role ? `role:${role.id}` : "realm", "updated_record", parseRecord(content)?.title ?? rel, { path: rel, op: input.op, line }, run ?? ctx);
    this.changed(ctx.spaceId);
    return { path: rel, line, changed: out.changed };
  }

  /* ═══════════════════════════════ activity ═══════════════════════════════ */

  activity(spaceId: string, limit: number, before?: number): TeamActivity[] { return this.d.store.activity(spaceId, limit, before); }

  private runFor(sessionId: string): Run | null {
    return this.d.runs.listLive().find((r) => r.sessionId === sessionId) ?? null;
  }

  private log(spaceId: string, actor: string, verb: string, object: string | null, detail: Record<string, unknown>, run?: Partial<Pick<Run, "id" | "sessionId">> | null): void {
    this.d.store.appendActivity({ spaceId, actor, verb, object, detail, runId: run?.id ?? null, sessionId: run?.sessionId ?? null });
  }

  private changed(spaceId: string): void {
    this.d.rpc.broadcast("team.changed", { spaceId });
  }

  private sessionStatus(sessionId: string): string | null {
    try { return this.d.sessions.get(sessionId).status; } catch { return null; }
  }

  private sessionUnread(sessionId: string): boolean {
    try { const s = this.d.sessions.get(sessionId); return s.lastEventSeq > s.seenSeq; } catch { return false; }
  }
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000;
const usd = (n: number): string => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string | null): string | null => {
  const l = s?.trim().split("\n").find((x) => x.trim())?.trim() ?? "";
  return l ? clip(l.replace(/^#+\s*/, ""), 200) : null;
};
