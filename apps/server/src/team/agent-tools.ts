import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { DELIVERABLE_FORMATS, DeliverableFormatSchema, ItemMetaSchema, ProposedActionSchema, ReviewLabelSchema, ReviewTargetSchema, TEAM_PROVIDER_NAME, type TeamReviewSummary } from "@realm/contracts";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import { err, ok, parseArgs } from "../mcp/tool-result";
import type { TeamService } from "./service";

export { TEAM_PROVIDER_NAME };

export type TeamAgentToolsDeps = {
  team: Pick<TeamService, "isTeam" | "space" | "records" | "readForAgent" | "updateForAgent" | "submit" | "reviewStatus" | "review">;
  mcp: { providerEnabled(spaceId: string, name: string): boolean };
  /** More tools on this provider (Phase 4's handoff and mention), answering null for a name not theirs. */
  more?: { tools: Tool[]; call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult | null> };
};

const RecordListArgs = z.object({ kind: z.literal("creators").optional() }).strict();
const RecordReadArgs = z.object({ path: z.string().min(1).max(200) }).strict();
const RecordUpdateArgs = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name: z.string().trim().min(1).max(120), path: z.string().max(200).optional() }).strict(),
  z.object({ op: z.literal("add"), path: z.string().min(1).max(200), section: z.string().max(60).optional(), entry: z.string().min(1).max(2_000) }).strict(),
  z.object({ op: z.literal("replace"), path: z.string().min(1).max(200), match: z.string().min(1).max(500), entry: z.string().min(1).max(2_000) }).strict(),
  z.object({ op: z.literal("remove"), path: z.string().min(1).max(200), match: z.string().min(1).max(500) }).strict(),
]);
const SubmitArgs = z.object({
  /** Free words for the batch; `kind` is the old name for the same thing, still taken. */
  label: ReviewLabelSchema.optional(),
  kind: ReviewLabelSchema.optional(),
  title: z.string().trim().min(1).max(200),
  record: z.string().min(1).max(200).optional(),
  items: z.array(z.object({
    files: z.array(z.string().min(1).max(1_000)).max(40).default([]),
    body: z.string().max(20_000).optional(),
    format: DeliverableFormatSchema.optional(),
    meta: ItemMetaSchema.optional(),
    action: ProposedActionSchema.optional(),
    /** The old way to say where it goes; read as the action it implies. */
    target: ReviewTargetSchema.optional(),
  }).strict()).min(1).max(30),
}).strict().refine((a) => !(a.label && a.kind && a.label !== a.kind), { message: "give `label` or `kind`, not two different ones" });
const StatusArgs = z.object({ id: z.string().min(1).max(40).optional() }).strict();

const TOOLS: Tool[] = [
  {
    name: "team_roles",
    description: "The roles on this space's team: each one's name, what it does (its brief's first line), when it runs and what it is doing now. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "record_list",
    description: "The team's records — one Markdown file per person the team works with (creators/<name>.md in the team's memory) — with each one's name and status. Read-only.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["creators"] } }, additionalProperties: false },
  },
  {
    name: "record_read",
    description: "One record, whole: its head (Status, Contact, Sends from), then ## Deal, ## Accounts, ## Deadlines, ## Content. Read it before you act for that person. `path` is `creators/<name>.md` or just `<name>`.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "record_update",
    description: [
      "Change one line of a record, or make a new one. `op`: `create` (with `name`) makes creators/<name>.md from the template;",
      "`add` puts `entry` at the end of `section` (Deal, Accounts, Deadlines, Content — made if missing; omit it for the head);",
      "`replace` swaps the one line holding `match` for `entry`; `remove` deletes it.",
      "Write an entry as `Key: value` where it is a fact with a name (\"Rate: $5 per video\"). An account line is `TikTok @handle · vault: <where its sign-in is kept> · consent: <where the creator agreed>` — the sign-in's NAME, never a password or key, which is refused.",
      "Each line is stamped with this session and today's date, and committed under your role's name.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["create", "add", "replace", "remove"] },
        path: { type: "string", description: "creators/<name>.md, or <name>" },
        name: { type: "string", description: "op create: the person's name, e.g. \"Nathan Beyenhof\"" },
        section: { type: "string", description: "op add: Deal, Accounts, Deadlines or Content; omit for the head" },
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
      "`label`: a few words for what the batch is (\"slideshows\", \"replies\", \"release notes\"); `kind` is the same field's old name. One item per piece — one slideshow, one email, one report. An item's `files` are its pictures, PDF, Markdown, CSV, diff or attachments in order (paths inside this space's folder; anything else is refused), and `body` is its text: a caption, a message, or the deliverable itself.",
      `\`format\` says how Review draws it (${DELIVERABLE_FORMATS.join(", ")}); leave it out and Realm infers it from the files and the text. \`meta\` is up to 20 short key/values the person should see (\"Subject\", \"Due\", \"Version\").`,
      "`action` is the outward act it proposes, if any: `connector` (`channel:tiktok`, `channel:instagram`, `channel:email` for the team's own accounts), `verb` (post, dm, email, send), `account` (the @handle or address it goes out as) and `to` (who a DM or an email is for). `target` {channel, account, to} is the old way to say the same. Realm checks the record's `consent:` for that account, the disclosure and the pacing, reports them to the person, and enforces them when anything would go out. Never put a password, key or token in any field; it is refused.",
      "Once approved, each post, DM or email waits for a person to press it, one at a time, at Realm's paced slots (3 posts a day per account, 15 DMs). You cannot post or send it, and nothing you call will.",
      "If a person asked for changes and woke you, submitting again replaces that review in place as its next version.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "a few words for what the batch is, e.g. \"slideshows\" or \"replies\"" },
        kind: { type: "string", description: "the old name for `label`" },
        title: { type: "string", description: "what the person will read in the list, e.g. \"6 slideshows for Nathan\"" },
        record: { type: "string", description: "the record it is for: creators/<name>.md" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              files: { type: "array", items: { type: "string" } },
              body: { type: "string" },
              format: { type: "string", enum: [...DELIVERABLE_FORMATS] },
              meta: { type: "object", additionalProperties: { type: "string" } },
              action: {
                type: "object",
                properties: { connector: { type: "string" }, tool: { type: "string" }, args: { type: "object" }, verb: { type: "string" }, account: { type: "string" }, to: { type: "string" } },
                required: ["connector"], additionalProperties: false,
              },
              target: { type: "object", properties: { channel: { type: "string" }, account: { type: "string" }, to: { type: "string" } }, additionalProperties: false },
            },
            additionalProperties: false,
          },
        },
      },
      required: ["title", "items"],
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
      return d.more ? [...TOOLS, ...d.more.tools] : TOOLS;
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
          case "record_list": {
            const a = parseArgs(RecordListArgs, args); if ("error" in a) return a.error;
            const rows = d.team.records(ctx.spaceId);
            return ok(rows.length ? rows.map((r) => `- ${r.path} — ${r.name}${r.status ? ` (${r.status})` : ""}`).join("\n") : "No records yet. Make one with record_update op \"create\".");
          }
          case "record_read": {
            const a = parseArgs(RecordReadArgs, args); if ("error" in a) return a.error;
            return ok(d.team.readForAgent(ctx, a.value.path));
          }
          case "record_update": {
            const a = parseArgs(RecordUpdateArgs, args); if ("error" in a) return a.error;
            const v = a.value;
            const out = await d.team.updateForAgent(ctx, v.op === "create" ? { op: "create", name: v.name, path: v.path ?? "" } : v);
            return ok(out.changed ? `Saved ${out.path}${out.line ? `: ${out.line}` : ""}.` : `${out.path} already said that; nothing changed.`);
          }
          case "review_submit": {
            const a = parseArgs(SubmitArgs, args); if ("error" in a) return a.error;
            const { label, ...rest } = a.value;
            const r = d.team.submit(ctx, { ...rest, kind: label ?? rest.kind });
            // What Realm checked is the role's to read now, while it can still fix it: a missing consent
            // line is reported here and enforced only when something would go out.
            const failing = d.team.review(r.id).checks.filter((c) => c.ok === false).map((c) => `${c.title} — ${c.detail}`);
            return ok(`Sent "${r.title}" to Review (${r.itemCount} item${r.itemCount === 1 ? "" : "s"}${r.version > 1 ? `, version ${r.version}` : ""}; review ${r.id}). Nothing goes out until a person approves it. Check on it with review_status.`
              + (failing.length ? `\nBefore it can go, Realm found: ${failing.join("; ")}.` : ""));
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
  // The person's own words in what was approved are the role's to know before it writes the next one.
  const n = r.editedItems ?? [];
  const edited = n.length > 0 ? ` · the person edited item${n.length === 1 ? "" : "s"} ${n.join(", ")}${r.state === "approved" || r.state === "done" ? " before approving" : ""}` : "";
  return `- ${r.id} "${r.title}" — ${STATE_WORDS[r.state] ?? r.state}${acts}${edited}${r.version > 1 ? ` (version ${r.version})` : ""}${r.note ? `: ${r.note}` : ""}`;
}

const firstLine = (s: string): string => s.trim().split("\n").find((l) => l.trim())?.trim().slice(0, 160) ?? "";
