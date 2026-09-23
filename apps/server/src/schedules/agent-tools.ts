import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describeSchedule, onceExpr, parseMoment, type Schedule } from "@realm/contracts";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import { err, ok, parseArgs } from "../mcp/tool-result";
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
 * later is a RUN, which is where attempts, worktrees, restart recovery, the human gate and the
 * refusal of `bypassPermissions` already live — so nothing in this file has an opinion about any of
 * them. The one thing a caller must understand is that the run starts a FRESH session: it inherits
 * none of this conversation, which is why the `goal` field's description asks for standing
 * instructions rather than a follow-up.
 *
 * **Two tools, and the third is deliberately absent.** `schedule_create` and `schedule_list`, so an
 * agent can also answer "did you already set that up?" — asked the same thing twice, a session that
 * cannot look would make a second schedule. There is no delete: the schedules in a space are not all
 * this session's, nothing records which agent made which, and an agent that can remove unattended
 * work it did not create is a sharper tool than "remind me in two weeks" needs. Cancelling is the
 * user's, on the Schedules page, where the row and its history are.
 */
export type ScheduleAgentToolsDeps = {
  schedules: Pick<ScheduleService, "create" | "list">;
  mcp: { providerEnabled(spaceId: string, name: string): boolean };
};

const CreateArgs = z.object({
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(20_000),
  at: z.string().min(1).max(64).optional(),
  cron: z.string().min(1).max(200).optional(),
}).strict();

const TOOLS: Tool[] = [
  {
    name: "schedule_create",
    description: [
      "Schedule work to start later in this space — once at a moment, or repeatedly on a cron.",
      "What fires is a task: a FRESH agent session with none of this conversation, so write `goal` as complete standing instructions — name the repository, the branch, the channel, the person, everything it needs — never as a follow-up to something said here.",
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
    description: "What this space already has on the clock: each schedule's name, when it runs, when it last ran and whether a firing was missed. Read it before creating a schedule the user may already have. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
        if (tool === "schedule_list") return listSchedules(d, ctx);
        if (tool === "schedule_create") return createSchedule(d, ctx, args);
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
  // service's, unduplicated. A second copy here would be a second place for the rules to drift.
  const made = d.schedules.create({ spaceId: ctx.spaceId, title, goal, cron: expr, enabled: true, constraints: null });
  const when = made.nextRunAt === null ? describeSchedule(made.cron) : `${describeSchedule(made.cron)} — first run ${moment(made.nextRunAt)}`;
  return ok(`Scheduled "${made.title}": ${when}.\nIt starts a task in this space, which will appear under Scheduled tasks and in the Tasks lens when it runs.`);
}

function listSchedules(d: ScheduleAgentToolsDeps, ctx: ProviderCallContext): CallToolResult {
  const rows = d.schedules.list(ctx.spaceId);
  if (rows.length === 0) return ok("This space has nothing scheduled.");
  return ok(rows.map(describeRow).join("\n"));
}

const describeRow = (s: Schedule): string => {
  const parts = [
    !s.enabled ? "paused" : s.nextRunAt === null ? "nothing further to run" : `next ${moment(s.nextRunAt)}`,
    s.lastRunAt === null ? null : `last ran ${moment(s.lastRunAt)}`,
    // Named here for the same reason the page names it: a schedule that quietly did not happen is
    // the one thing an agent asked "did that run?" must not answer with silence.
    s.lastSkippedAt === null ? null : `MISSED a firing ${moment(s.lastSkippedAt)}`,
  ].filter((x) => x !== null);
  return `- ${s.title} — ${describeSchedule(s.cron)} (${parts.join("; ")})\n  ${s.goal}`;
};

/** A moment in the machine's own zone, which is the zone every schedule in this file is written in. */
const moment = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
