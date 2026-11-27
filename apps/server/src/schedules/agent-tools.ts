import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describeSchedule, onceExpr, parseMoment, ScheduleModeSchema, type RunConstraints, type Schedule, type ScheduleMode, type Session, type UpdateScheduleInput } from "@realm/contracts";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import type { BrowserPermissionBroker } from "../browsers/permissions";
import { MODE_RANK, modeLabel, rank } from "../delegation/dispatch";
import { err, ok, parseArgs } from "../mcp/tool-result";
import { askCard, refuseUnlessPersonTurn } from "../mcp/agent-gate";
import type { ScheduleService } from "./service";

export const SCHEDULE_PROVIDER_NAME = "realm-schedule";

/**
 * The `realm-schedule` provider: how a session puts work on the clock from inside a conversation.
 *
 * Realm could already schedule work — the Schedules page has created runs on a cron since Plan 23 —
 * but only by hand, on a page, in a vocabulary (five numeric fields) nobody asks a question in. The
 * gap this closes is the ordinary sentence: "in two weeks, open a PR removing that badge." The model
 * is the thing that turns "in two weeks" into a moment, so no date parser is needed here; what was
 * missing was somewhere to put the number.
 *
 * **It schedules, and it does not execute.** `schedule_create` writes a row and returns. What fires
 * later is a RUN, which is where attempts, worktrees, restart recovery and the human gate already
 * live. The one opinion this file has is the permission: the task runs in this session's mode as it
 * stands now, never higher (`scheduledMode`). The goal is the agent's own words and the run goes while
 * nobody watches, so one approved tool call must not turn an asking conversation into unattended Full
 * access. The run starts a FRESH session: it inherits none of this conversation, which is why the
 * `goal` field's description asks for standing instructions rather than a follow-up.
 *
 * **`schedule_list` comes with it**, so an agent can also answer "did you already set that up?" —
 * asked the same thing twice, a session that cannot look would make a second schedule.
 *
 * **Changing one is gated by who made it.** Each row records the session whose agent made it
 * (`createdBySession`). Editing, pausing, resuming, running or deleting asks for a turn the person
 * started, as every write to Realm itself does. A schedule this session made is its own to change
 * with no card; anyone else's — the person's, another session's, or one older than the column —
 * shows a card unless the session is on Full access, and deleting one shows it always, because the
 * row and its history go with it. An edit never gives a task more access than the session asking
 * has, and never puts this session's words into a task that runs with more.
 */
export type ScheduleAgentToolsDeps = {
  schedules: Pick<ScheduleService, "create" | "list" | "clocks" | "get" | "update" | "remove" | "runNow">;
  mcp: { providerEnabled(spaceId: string, name: string): boolean };
  /** The calling session's row — whose agent, model, level, speed and mode the task it schedules runs on. */
  sessions?: {
    get(id: string): Pick<Session, "agentKind" | "model" | "effort" | "fastMode" | "permissionMode">;
    personStartedTurn(id: string): boolean;
  };
  /** Who started a turn the person did not, in words, for the refusal. */
  turnOrigin?: (sessionId: string) => string;
  /** Where the cards for changing a schedule go. Without it, and without `sessions`, every change is refused. */
  broker?: Pick<BrowserPermissionBroker, "gate">;
};

const CreateArgs = z.object({
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(20_000),
  at: z.string().min(1).max(64).optional(),
  cron: z.string().min(1).max(200).optional(),
}).strict();

const ListArgs = z.object({ teammateClocks: z.boolean().optional() }).strict();
const IdArgs = z.object({ id: z.string().min(1).max(64) }).strict();
const UpdateArgs = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200).optional(),
  goal: z.string().min(1).max(20_000).optional(),
  at: z.string().min(1).max(64).optional(),
  cron: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  permissionMode: ScheduleModeSchema.optional(),
}).strict();

const ID_ARG = { id: { type: "string", description: "the schedule's id, as schedule_list shows it" } };
const OWNERSHIP = "A schedule this session made is its own to change; anyone else's shows the user a card first unless this session is on Full access. Only in a turn the user started.";

const TOOLS: Tool[] = [
  {
    name: "schedule_create",
    description: [
      "Schedule work to start later in this space — once at a moment, or repeatedly on a cron.",
      "What fires is a task: a FRESH agent session with none of this conversation, so write `goal` as complete standing instructions — name the repository, the branch, the channel, the person, everything it needs — never as a follow-up to something said here.",
      "It runs in this session's permission mode as it is now, never higher: scheduled from Ask each time it asks each time (and waits for the user at each prompt), from Full access it runs in Full access.",
      "Give exactly one of `at` (once) or `cron` (repeating). Resolve a relative ask like \"in two weeks\" to an absolute moment yourself and pass it as `at`.",
      "Use this when the user asks for something to happen LATER. Do the work now when they are asking for it now, and never schedule something you could finish in this turn.",
      "Tell the user the moment it is set for, in their own terms — work that arrives unannounced is the failure this tool has to avoid.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "short name for the Schedules page, e.g. \"Remove the new badge\"" },
        goal: { type: "string", description: "what the task should do, written for an agent that has never seen this conversation" },
        at: { type: "string", description: "a single moment: `2026-09-30T13:00` (the user's local time, seconds optional), or an ISO 8601 string carrying `Z` or an offset. A date with no time is refused — pick the hour." },
        cron: { type: "string", description: "for repeating work: a 5-field expression in local time (minute hour day-of-month month day-of-week), e.g. `0 9 * * 1-5`, or `@daily` / `@weekly`" },
      },
      required: ["title", "goal"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_list",
    description: "What this space already has on the clock: each schedule's id and name, when it runs, when it last ran, whether a firing was missed, the mode its runs start in and who made it. Read it before creating a schedule the user may already have. Read-only.",
    inputSchema: {
      type: "object",
      properties: { teammateClocks: { type: "boolean", description: "also list the clocks of this space's teammates, which their own pages change" } },
      additionalProperties: false,
    },
  },
  {
    name: "schedule_update",
    description: [
      "Change a scheduled task: its title, its goal, when it runs (`at` once or `cron` repeating, never both), whether it is on, or the mode its runs start in.",
      "Its mode can be lowered, or raised as far as this session's own and no further; its goal cannot be rewritten while its runs start in more access than this session has.",
      OWNERSHIP,
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        ...ID_ARG,
        title: { type: "string" },
        goal: { type: "string", description: "the whole new goal, written for an agent that has never seen this conversation" },
        at: { type: "string", description: "a single moment, as schedule_create takes it" },
        cron: { type: "string", description: "a 5-field expression in local time, as schedule_create takes it" },
        enabled: { type: "boolean", description: "false pauses it, true resumes it" },
        permissionMode: { type: "string", enum: ScheduleModeSchema.options, description: "the mode its runs start in" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_pause",
    description: `Pause a scheduled task: it stays on the Schedules page and fires nothing until it is resumed. ${OWNERSHIP}`,
    inputSchema: { type: "object", properties: ID_ARG, required: ["id"], additionalProperties: false },
  },
  {
    name: "schedule_resume",
    description: `Resume a paused task from its next occurrence; nothing it missed while paused is run. ${OWNERSHIP}`,
    inputSchema: { type: "object", properties: ID_ARG, required: ["id"], additionalProperties: false },
  },
  {
    name: "schedule_run_now",
    description: "Start a scheduled task's run now, as the Schedules page's Run now does, without moving its next firing. The user sees a card first unless this session is on Full access. Only in a turn the user started.",
    inputSchema: { type: "object", properties: ID_ARG, required: ["id"], additionalProperties: false },
  },
  {
    name: "schedule_delete",
    description: "Delete a scheduled task. One this session made goes without a card; anyone else's shows the user a card naming it and its last run, even on Full access. Only in a turn the user started. The runs it already made stay in the Tasks lens.",
    inputSchema: { type: "object", properties: ID_ARG, required: ["id"], additionalProperties: false },
  },
];

export function createScheduleAgentProvider(d: ScheduleAgentToolsDeps): RealmToolProvider {
  return {
    name: SCHEDULE_PROVIDER_NAME,
    async tools(ctx: ProviderCallContext): Promise<Tool[]> {
      if (!d.mcp.providerEnabled(ctx.spaceId, SCHEDULE_PROVIDER_NAME)) return [];
      return TOOLS;
    },
    async call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult> {
      if (!d.mcp.providerEnabled(ctx.spaceId, SCHEDULE_PROVIDER_NAME))
        return err(`the ${SCHEDULE_PROVIDER_NAME} tools are disabled for this space — mcp.setProviderEnabled turns them back on.`);
      try {
        if (tool === "schedule_list") return listSchedules(d, ctx, args);
        if (tool === "schedule_create") return createSchedule(d, ctx, args);
        if (tool === "schedule_update") return await updateSchedule(d, ctx, args);
        if (tool === "schedule_pause" || tool === "schedule_resume") return await setEnabled(d, ctx, args, tool === "schedule_resume");
        if (tool === "schedule_run_now") return await runNow(d, ctx, args);
        if (tool === "schedule_delete") return await deleteSchedule(d, ctx, args);
        return err(`unknown tool "${tool}" — this provider has: ${TOOLS.map((t) => t.name).join(", ")}`);
      } catch (e) {
        // `ScheduleService.create` throws an `RpcError` whose message is already written for a person
        // ("that moment has already passed"); handing it straight back is what lets the agent correct
        // itself on the next call rather than reporting a failure it cannot explain.
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

function createSchedule(d: ScheduleAgentToolsDeps, ctx: ProviderCallContext, args: unknown): CallToolResult {
  const parsed = parseArgs(CreateArgs, args ?? {});
  if ("error" in parsed) return parsed.error;
  const { title, goal, at, cron } = parsed.value;
  // Refused rather than resolved by precedence. A call carrying both has two different intentions in
  // it and no way to tell which one the user said; picking either silently schedules the other away.
  if ((at === undefined) === (cron === undefined))
    return err("give exactly one of `at` (a single moment) or `cron` (a repeating expression).");

  let expr: string;
  if (at !== undefined) {
    const ms = parseMoment(at);
    if (ms === null)
      return err(`\`${at}\` is not a moment I can schedule. Write a local time like \`2026-09-30T13:00\`, or an ISO 8601 string with \`Z\` or an offset. A date alone has no time of day, and a time the clocks skip on that date does not exist.`);
    expr = onceExpr(ms);
  } else {
    expr = cron!.trim();
  }

  // Every other gate — the expression parses, it has a future occurrence, the space exists — is the
  // service's, unduplicated. A second copy here would be a second place for the rules to drift. The
  // rest is what the Schedule a task modal starts from, so a task an agent makes opens there looking
  // like one made by hand.
  const made = d.schedules.create({
    spaceId: ctx.spaceId, title, goal, cron: expr, enabled: true,
    constraints: callerConstraints(d, ctx.sessionId), newSessionPerRun: true, archiveSucceeded: false,
    permissionMode: scheduledMode(d, ctx.sessionId),
  }, ctx.sessionId);
  const when = made.nextRunAt === null ? describeSchedule(made.cron) : `${describeSchedule(made.cron)} — first run ${moment(made.nextRunAt)}`;
  return ok(`Scheduled "${made.title}": ${when}.\nIt starts a task in this space, which will appear under Scheduled tasks and in the Tasks lens when it runs.`);
}

/**
 * The task runs on the agent, model, level and speed of the session that scheduled it. Left unset, a
 * run falls back to Claude whatever was asking — a Codex conversation that said "do this every
 * Monday" would come back as somebody else's work, and one on Max with fast mode at the default and
 * slow. Null where the session cannot be read: the run's own fallback then stands, as it does for a
 * task made with no session behind it.
 */
function callerConstraints(d: ScheduleAgentToolsDeps, sessionId: string): RunConstraints | null {
  if (!d.sessions) return null;
  let caller: Pick<Session, "agentKind" | "model" | "effort" | "fastMode">;
  try { caller = d.sessions.get(sessionId); } catch { return null; }
  return { agentKind: caller.agentKind, ...(caller.model ? { model: caller.model } : {}), ...(caller.effort ? { effort: caller.effort } : {}),
    ...(caller.fastMode ? { fastMode: true } : {}) };
}

/**
 * The mode the task runs in: the calling session's, as it is when the task is made, so changing the
 * session later moves nothing. A mode outside `MODE_RANK` (a harness's own string) is `default`, as
 * delegation ranks it, and a session that cannot be read is `default` too: the cap fails toward asking.
 */
function scheduledMode(d: ScheduleAgentToolsDeps, sessionId: string): ScheduleMode {
  const mode = callerMode(d, sessionId);
  return Object.hasOwn(MODE_RANK, mode) ? (mode as ScheduleMode) : "default";
}

function listSchedules(d: ScheduleAgentToolsDeps, ctx: ProviderCallContext, args: unknown): CallToolResult {
  const parsed = parseArgs(ListArgs, args ?? {});
  if ("error" in parsed) return parsed.error;
  const rows = d.schedules.list(ctx.spaceId);
  const tasks = rows.length === 0 ? "This space has nothing scheduled." : rows.map((s) => describeRow(s, ctx.sessionId)).join("\n");
  if (!parsed.value.teammateClocks) return ok(tasks);
  const clocks = d.schedules.clocks(ctx.spaceId);
  const team = clocks.length === 0 ? "No teammate in this space is on a clock."
    : `Teammates' clocks (each teammate's page changes its own; these tools do not):\n${clocks.map(describeClock).join("\n")}`;
  return ok(`${tasks}\n\n${team}`);
}

const describeRow = (s: Schedule, sessionId: string): string =>
  `- ${s.title} [id ${s.id}] — ${describeSchedule(s.cron)} (${timing(s).join("; ")})\n` +
  `  runs in ${modeLabel(s.permissionMode ?? "default")}; ${madeBy(s, sessionId)}\n  ${s.goal}`;

const describeClock = (s: Schedule): string => `- ${s.title}'s clock [id ${s.id}] — ${describeSchedule(s.cron)} (${timing(s).join("; ")})`;

const madeBy = (s: Schedule, sessionId: string): string =>
  s.createdBySession === sessionId ? "made by this session"
    : s.createdBySession === null ? "made by the user"
      : `made by another session (${s.createdBySession})`;

const timing = (s: Schedule): string[] => {
  const parts = [
    !s.enabled ? "paused" : s.nextRunAt === null ? "nothing further to run" : `next ${moment(s.nextRunAt)}`,
    s.lastRunAt === null ? null : `last ran ${moment(s.lastRunAt)}`,
    // Named here for the same reason the page names it: a schedule that quietly did not happen is
    // the one thing an agent asked "did that run?" must not answer with silence.
    s.lastSkippedAt === null ? null : `MISSED a firing ${moment(s.lastSkippedAt)}`,
  ].filter((x) => x !== null);
  return parts;
};

/* ── changing a schedule ───────────────────────────────────────────────── */

/** The row an id names, when it is one of this space's tasks. A teammate's clock is its page's. */
function taskIn(d: ScheduleAgentToolsDeps, ctx: ProviderCallContext, id: string): { schedule: Schedule } | { error: CallToolResult } {
  const s = d.schedules.get(id);
  if (!s || s.spaceId !== ctx.spaceId)
    return { error: err(`no schedule with id ${id} in this space; schedule_list shows each one's id. Nothing changed.`) };
  if (s.roleId !== null)
    return { error: err(`refused: ${s.id} is ${s.title}'s clock, which the teammate's page changes. Nothing changed.`) };
  return { schedule: s };
}

function personTurn(d: ScheduleAgentToolsDeps, ctx: ProviderCallContext): CallToolResult | null {
  if (!d.sessions) return err("refused: Realm cannot tell who started this turn here. Nothing changed.");
  return refuseUnlessPersonTurn({ sessions: d.sessions, turnOrigin: d.turnOrigin ?? (() => "something other than the person") }, ctx.sessionId,
    { rule: "Schedules change", where: "this chat", nothing: "Nothing changed." });
}

/** The user's card, skipped on Full access unless `always`. Null when it was approved. */
async function card(d: ScheduleAgentToolsDeps, ctx: ProviderCallContext, toolKey: string, title: string,
  input: Record<string, unknown>, always = false): Promise<CallToolResult | null> {
  if (!d.broker) return err("refused: there is no way to ask the user here. Nothing changed.");
  return askCard(d.broker, ctx.sessionId, { toolKey, title, input, always });
}

/** The calling session's mode as it is now; `default` for a session that cannot be read. */
function callerMode(d: ScheduleAgentToolsDeps, sessionId: string): string {
  try { return d.sessions?.get(sessionId).permissionMode ?? "default"; } catch { return "default"; }
}

async function updateSchedule(d: ScheduleAgentToolsDeps, ctx: ProviderCallContext, args: unknown): Promise<CallToolResult> {
  const parsed = parseArgs(UpdateArgs, args ?? {});
  if ("error" in parsed) return parsed.error;
  const { id, at, cron, ...rest } = parsed.value;
  if (at !== undefined && cron !== undefined) return err("give at most one of `at` (a single moment) or `cron` (a repeating expression). Nothing changed.");
  const patch: UpdateScheduleInput = { id, ...rest };
  if (at !== undefined) {
    const ms = parseMoment(at);
    if (ms === null) return err(`\`${at}\` is not a moment I can schedule. Write a local time like \`2026-09-30T13:00\`, or an ISO 8601 string with \`Z\` or an offset. Nothing changed.`);
    patch.cron = onceExpr(ms);
  } else if (cron !== undefined) {
    patch.cron = cron.trim();
  }
  if (Object.keys(patch).length === 1) return err("name something to change: title, goal, at, cron, enabled or permissionMode. Nothing changed.");
  return change(d, ctx, patch, "schedule_update");
}

async function setEnabled(d: ScheduleAgentToolsDeps, ctx: ProviderCallContext, args: unknown, enabled: boolean): Promise<CallToolResult> {
  const parsed = parseArgs(IdArgs, args ?? {});
  if ("error" in parsed) return parsed.error;
  return change(d, ctx, { id: parsed.value.id, enabled }, enabled ? "schedule_resume" : "schedule_pause");
}

/** Every edit's gates, in order: the row is this space's task, the person started the turn, the
 *  access stays within the caller's, and anyone else's schedule is the user's to approve. */
async function change(d: ScheduleAgentToolsDeps, ctx: ProviderCallContext, patch: UpdateScheduleInput, tool: string): Promise<CallToolResult> {
  const found = taskIn(d, ctx, patch.id); if ("error" in found) return found.error;
  const before = found.schedule;
  const refused = personTurn(d, ctx); if (refused) return refused;
  const held = callerMode(d, ctx.sessionId);
  if (patch.permissionMode !== undefined && rank(patch.permissionMode) > rank(held))
    return err(`refused: you are on ${modeLabel(held)}, and nobody can give more access than they have. The user can set "${before.title}" to ${modeLabel(patch.permissionMode)} in its Permissions menu on the Schedules page. Nothing changed.`);
  const runsIn = patch.permissionMode ?? before.permissionMode ?? "default";
  if (patch.goal !== undefined && rank(runsIn) > rank(held))
    return err(`refused: "${before.title}" runs in ${modeLabel(runsIn)}, more than your ${modeLabel(held)}, so its goal cannot take your words. Lower its permissionMode in the same call, or ask the user to edit it on the Schedules page. Nothing changed.`);

  const verb = tool === "schedule_pause" ? "Pause" : tool === "schedule_resume" ? "Resume" : "Change";
  if (before.createdBySession !== ctx.sessionId) {
    const denied = await card(d, ctx, tool, `${verb} the scheduled task "${before.title}"`, { title: before.title, ...patch });
    if (denied) return denied;
  }
  const next = d.schedules.update(patch);
  const state = !next.enabled ? "paused" : next.nextRunAt === null ? "nothing further to run" : `next ${moment(next.nextRunAt)}`;
  return ok(`Done: "${next.title}" — ${describeSchedule(next.cron)} (${state}), runs in ${modeLabel(next.permissionMode ?? "default")}.`);
}

async function runNow(d: ScheduleAgentToolsDeps, ctx: ProviderCallContext, args: unknown): Promise<CallToolResult> {
  const parsed = parseArgs(IdArgs, args ?? {});
  if ("error" in parsed) return parsed.error;
  const found = taskIn(d, ctx, parsed.value.id); if ("error" in found) return found.error;
  const s = found.schedule;
  const refused = personTurn(d, ctx); if (refused) return refused;
  const denied = await card(d, ctx, "schedule_run_now", `Run the scheduled task "${s.title}" now, in ${modeLabel(s.permissionMode ?? "default")}`,
    { id: s.id, title: s.title, goal: s.goal });
  if (denied) return denied;
  const after = d.schedules.runNow(s.id);
  const next = after.nextRunAt === null ? "" : ` Its next firing is still ${moment(after.nextRunAt)}.`;
  return ok(`Started a run of "${after.title}"${after.lastRunId ? ` (run ${after.lastRunId})` : ""}; it shows in the Tasks lens.${next}`);
}

async function deleteSchedule(d: ScheduleAgentToolsDeps, ctx: ProviderCallContext, args: unknown): Promise<CallToolResult> {
  const parsed = parseArgs(IdArgs, args ?? {});
  if ("error" in parsed) return parsed.error;
  const found = taskIn(d, ctx, parsed.value.id); if ("error" in found) return found.error;
  const s = found.schedule;
  const refused = personTurn(d, ctx); if (refused) return refused;
  const last = s.lastRunAt === null ? "it has never run" : `it last ran ${moment(s.lastRunAt)}`;
  if (s.createdBySession !== ctx.sessionId) {
    const denied = await card(d, ctx, "schedule_delete", `Delete the scheduled task "${s.title}" (${describeSchedule(s.cron)}; ${last})`,
      { id: s.id, title: s.title, schedule: describeSchedule(s.cron), goal: s.goal, lastRunAt: s.lastRunAt }, true);
    if (denied) return denied;
  }
  d.schedules.remove(s.id);
  return ok(`Deleted "${s.title}". The runs it already made stay in the Tasks lens.`);
}

/** A moment in the machine's own zone, which is the zone every schedule in this file is written in. */
const moment = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
