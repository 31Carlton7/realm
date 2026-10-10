import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ReviewKindSchema, ReviewTargetSchema, TEAM_PROVIDER_NAME, type TeamReviewSummary } from "@realm/contracts";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import { err, ok, parseArgs } from "../mcp/tool-result";
import type { TeamService } from "./service";
import type { RecordTypeService } from "./record-types/service";

export { TEAM_PROVIDER_NAME };

export type TeamAgentToolsDeps = {
  team: Pick<TeamService, "isTeam" | "space" | "records" | "readForAgent" | "updateForAgent" | "submit" | "reviewStatus">;
  /** The team's kinds of record: what `record_types` answers, and the record tools' words per space. */
  types: Pick<RecordTypeService, "describe" | "descriptions">;
  mcp: { providerEnabled(spaceId: string, name: string): boolean };
  /** More tools on this provider (Phase 4's handoff and mention), answering null for a name not theirs. */
  more?: { tools: Tool[]; call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult | null> };
};

/** `type` is a kind's key or folder; `kind` is v50's name for it ("creators"), still taken. */
const RecordListArgs = z.object({ type: z.string().min(1).max(60).optional(), kind: z.string().min(1).max(60).optional() }).strict();
const RecordTypesArgs = z.object({}).strict();
const RecordReadArgs = z.object({ path: z.string().min(1).max(200) }).strict();
const RecordUpdateArgs = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name: z.string().trim().min(1).max(120), type: z.string().min(1).max(60).optional(), path: z.string().max(200).optional() }).strict(),
  z.object({ op: z.literal("add"), path: z.string().min(1).max(200), section: z.string().max(60).optional(), entry: z.string().min(1).max(2_000) }).strict(),
  z.object({ op: z.literal("replace"), path: z.string().min(1).max(200), match: z.string().min(1).max(500), entry: z.string().min(1).max(2_000) }).strict(),
  z.object({ op: z.literal("remove"), path: z.string().min(1).max(200), match: z.string().min(1).max(500) }).strict(),
]);
const SubmitArgs = z.object({
  kind: ReviewKindSchema,
  title: z.string().trim().min(1).max(200),
  record: z.string().min(1).max(200).optional(),
  items: z.array(z.object({
    files: z.array(z.string().min(1).max(1_000)).max(40).default([]),
    body: z.string().max(20_000).optional(),
    target: ReviewTargetSchema.optional(),
  }).strict()).min(1).max(30),
}).strict();
const StatusArgs = z.object({ id: z.string().min(1).max(40).optional() }).strict();

const TOOLS: Tool[] = [
  {
    name: "team_roles",
    description: "The roles on this space's team: each one's name, what it does (its brief's first line), when it runs and what it is doing now. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  { name: "record_types", description: "", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "record_list",
    description: "",
    inputSchema: { type: "object", properties: { type: { type: "string", description: "a kind's key or folder, e.g. \"creator\"" }, kind: { type: "string", description: "the same as type (an older name)" } }, additionalProperties: false },
  },
  {
    name: "record_read",
    description: "",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "record_update",
    description: "",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["create", "add", "replace", "remove"] },
        path: { type: "string", description: "" },
        name: { type: "string", description: "op create: the record's name, e.g. \"Nathan Beyenhof\"" },
        type: { type: "string", description: "op create: the kind of record (record_types lists them); needed when the team keeps more than one" },
        section: { type: "string", description: "" },
        entry: { type: "string", description: "op add/replace: the line, without the leading dash" },
        match: { type: "string", description: "op replace/remove: text that appears in exactly one line" },
      },
      required: ["op"],
      additionalProperties: false,
    },
  },
  {
    name: "review_submit",
    description: [
      "Send finished work to the team's Review, where a person approves it or asks for changes. This is how you deliver: nothing you make is sent, posted or signed by you.",
      "`kind`: slideshows | message | document | report. One item per piece — one slideshow, one email. An item's `files` are its slides or attachments in order (paths inside this space's folder; anything else is refused), and `body` is its caption or message text.",
      "`target` names where it would go (`channel`: tiktok, instagram, email; `account`: @handle or the address it sends from; `to`: who a DM or an email is for). An item aimed at an account needs `record`, and that record's Accounts line for the account must say `consent:`.",
      "Once approved, each post, DM or email waits for a person to press it, one at a time, at Realm's paced slots (3 posts a day per account, 15 DMs). You cannot post or send it, and nothing you call will.",
      "If a person asked for changes and woke you, submitting again replaces that review in place as its next version.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["slideshows", "message", "document", "report"] },
        title: { type: "string", description: "what the person will read in the list, e.g. \"6 slideshows for Nathan\"" },
        record: { type: "string", description: "the record it is for: creators/<name>.md" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              files: { type: "array", items: { type: "string" } },
              body: { type: "string" },
              target: { type: "object", properties: { channel: { type: "string" }, account: { type: "string" }, to: { type: "string" } }, additionalProperties: false },
            },
            additionalProperties: false,
          },
        },
      },
      required: ["kind", "title", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "review_status",
    description: "Where your submissions to Review stand — waiting, changes asked (with the person's note), approved, done. Give `id` for one review, or nothing for every review this session sent. Read-only.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
  },
];

/**
 * The `realm-team` provider: how a team's roles read and keep records and deliver to Review.
 *
 * Listed only in a space that is a team, and on by default there. Once listed, every tool stays listed
 * and refuses where it does not apply (no records yet, a review of another space), because a tool list
 * that changes under a running session is a session that loses its tools mid-plan (goal mode's lesson).
 */
export function createTeamAgentProvider(d: TeamAgentToolsDeps): RealmToolProvider {
  return {
    name: TEAM_PROVIDER_NAME,
    async tools(ctx: ProviderCallContext): Promise<Tool[]> {
      if (!d.mcp.providerEnabled(ctx.spaceId, TEAM_PROVIDER_NAME) || !d.team.isTeam(ctx.spaceId)) return [];
      const tools = withRecordWords(TOOLS, d.types.descriptions(ctx.spaceId));
      return d.more ? [...tools, ...d.more.tools] : tools;
    },
    async call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult> {
      if (!d.mcp.providerEnabled(ctx.spaceId, TEAM_PROVIDER_NAME))
        return err(`the ${TEAM_PROVIDER_NAME} tools are disabled for this space — mcp.setProviderEnabled turns them back on.`);
      if (!d.team.isTeam(ctx.spaceId)) return err("this space has no team — its roles and Review are made on the space's Team page");
      try {
        switch (tool) {
          case "team_roles": {
            const roles = d.team.space(ctx.spaceId).roles;
            const name = (id: string) => roles.find((x) => x.id === id)?.name;
            return ok(roles.map((r) => {
              const to = r.handsOffTo.map(name).filter(Boolean);
              return `- ${r.name} — ${r.state}${r.cron ? ` · runs ${r.cron}` : ""}${to.length ? ` · hands off to ${to.join(", ")}` : ""}: ${firstLine(r.brief)}`;
            }).join("\n") || "No roles.");
          }
          case "record_types": {
            const a = parseArgs(RecordTypesArgs, args); if ("error" in a) return a.error;
            return ok(d.types.describe(ctx.spaceId));
          }
          case "record_list": {
            const a = parseArgs(RecordListArgs, args); if ("error" in a) return a.error;
            const rows = d.team.records(ctx.spaceId, a.value.type ?? a.value.kind);
            return ok(rows.length ? rows.map((r) => `- ${r.path} — ${r.name}${r.status ? ` (${r.status})` : ""}`).join("\n") : "No records yet. Make one with record_update op \"create\".");
          }
          case "record_read": {
            const a = parseArgs(RecordReadArgs, args); if ("error" in a) return a.error;
            return ok(d.team.readForAgent(ctx, a.value.path));
          }
          case "record_update": {
            const a = parseArgs(RecordUpdateArgs, args); if ("error" in a) return a.error;
            const v = a.value;
            const out = await d.team.updateForAgent(ctx, v.op === "create" ? { op: "create", name: v.name, path: v.path ?? "", type: v.type } : v);
            const said = out.changed ? `Saved ${out.path}${out.line ? `: ${out.line}` : ""}.` : `${out.path} already said that; nothing changed.`;
            return ok(out.note ? `${said} ${out.note}` : said);
          }
          case "review_submit": {
            const a = parseArgs(SubmitArgs, args); if ("error" in a) return a.error;
            const r = d.team.submit(ctx, a.value);
            return ok(`Sent "${r.title}" to Review (${r.itemCount} item${r.itemCount === 1 ? "" : "s"}${r.version > 1 ? `, version ${r.version}` : ""}; review ${r.id}). Nothing goes out until a person approves it. Check on it with review_status.`);
          }
          case "review_status": {
            const a = parseArgs(StatusArgs, args); if ("error" in a) return a.error;
            const rows = d.team.reviewStatus(ctx.spaceId, a.value.id ?? null, ctx.sessionId);
            return ok(rows.length ? rows.map(statusLine).join("\n") : "This session has sent nothing to Review.");
          }
          default: {
            const answered = await d.more?.call(ctx, tool, args);
            if (answered) return answered;
            return err(`unknown tool "${tool}" — this provider has: ${[...TOOLS, ...(d.more?.tools ?? [])].map((t) => t.name).join(", ")}`);
          }
        }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

const STATE_WORDS: Record<string, string> = {
  waiting: "waiting for a person", changes: "changes asked", approved: "approved, not posted", done: "done", dismissed: "dismissed",
};

function statusLine(r: TeamReviewSummary): string {
  // What went out is the person's doing, press by press; the role only reads where it stands.
  const acts = r.actsTotal > 0 ? ` · ${r.actsDone} of ${r.actsTotal} sent by the person` : "";
  return `- ${r.id} "${r.title}" — ${STATE_WORDS[r.state] ?? r.state}${acts}${r.version > 1 ? ` (version ${r.version})` : ""}${r.note ? `: ${r.note}` : ""}`;
}

const firstLine = (s: string): string => s.trim().split("\n").find((l) => l.trim())?.trim().slice(0, 160) ?? "";

/** The record tools with this space's words: its folders, its sections. Only descriptions change with
 *  a team's types — the list itself, names and schemas, is the same in every team space. */
function withRecordWords(tools: Tool[], words: ReturnType<RecordTypeService["descriptions"]>): Tool[] {
  return tools.map((t) => {
    switch (t.name) {
      case "record_types": return { ...t, description: words.types };
      case "record_list": return { ...t, description: words.list };
      case "record_read": return { ...t, description: words.read };
      case "record_update": {
        const props = (t.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
        return { ...t, description: words.update, inputSchema: { ...t.inputSchema, properties: { ...props, path: { ...props.path, description: words.path }, section: { ...props.section, description: words.section } } } };
      }
      default: return t;
    }
  });
}
