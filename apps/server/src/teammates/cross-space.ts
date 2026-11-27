import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  SPACE_TEAMS_TOOL, SpaceTeamsArgsSchema, TeamListArgsSchema, TeamMessageArgsSchema, normalizeHandle, teammateByHandle,
  type Session, type Space, type Teammate,
} from "@realm/contracts";
import type { BrowserPermissionBroker } from "../browsers/permissions";
import { askCard, refuseUnlessPersonTurn } from "../mcp/agent-gate";
import type { ProviderCallContext } from "../mcp/gateway";
import { clip, err, ok, parseArgs } from "../mcp/tool-result";
import type { TeammatesService } from "./service";

/** `space_teams`, listed beside the team tools; `team_list` and `team_message` take `space` for the same reach. */
export const SPACE_TEAMS: Tool = {
  name: SPACE_TEAMS_TOOL,
  description: [
    "Every space in this profile and its team: each space's name and id, its Lead, and each teammate's handle and whether it is idle, working or needs the person. Read-only.",
    "Only a space's Lead, in its own chat, can look past its own space. team_list with `space` reads one space's team in full; team_message with `space` messages one of its teammates.",
  ].join(" "),
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

/** The `space` argument `team_list` and `team_message` take. */
export const SPACE_ARG = {
  type: "string",
  description: "another space of this profile, by its id or name (space_teams lists them): only the Lead, in its own chat, reaches past its own space",
} as const;

export type CrossSpaceDeps = {
  team: Pick<TeammatesService, "teamList" | "teamMessage" | "list" | "turnOrigin" | "teammateOf">;
  spaces: { get(id: string): Space | null; list(profileId: string): Space[] };
  sessions: { get(id: string): Session; personStartedTurn(id: string): boolean };
  broker: Pick<BrowserPermissionBroker, "gate">;
};

/** Who is reaching past its space: the calling session, its Lead, and the space it is in. */
type Reach = { session: Session; lead: Teammate; mine: Space };

/**
 * A Lead's reach across the spaces of its profile: `space_teams`, and `team_list` and `team_message`
 * with `space`. Teammates are what the sidebar shows across spaces, so a Lead may read every team in
 * its profile with no prompt; transcripts stay space-scoped. A message to another space's teammate is
 * a write into that space: only in a turn the person started, on a card unless the Lead is on Full
 * access, and marked as that space's words so it never counts as the person's there.
 *
 * Without `space`, or with the caller's own, both tools are what they always were.
 */
export class CrossSpaceTeamTools {
  constructor(private readonly d: CrossSpaceDeps) {}

  /** `team_list({space})`: another space's team, as `team_list` shows its own. */
  teamList(ctx: ProviderCallContext, raw: unknown = {}): CallToolResult {
    const a = parseArgs(TeamListArgsSchema, raw); if ("error" in a) return a.error;
    const { space, ...rest } = a.value;
    if (space === undefined) return this.d.team.teamList(ctx, rest);
    const there = this.space(ctx, space, ""); if ("error" in there) return there.error;
    if (there.id === ctx.spaceId) return this.d.team.teamList(ctx, rest);
    const reach = this.reach(ctx, `read the team of another space ("${there.name}")`, ""); if ("error" in reach) return reach.error;
    const listed = this.d.team.teamList({ ...ctx, spaceId: there.id }, rest);
    return ok(`The team in "${there.name}" (spaceId ${there.id}):\n${textOf(listed)}`);
  }

  /** `team_message({space, to})`: a message to a teammate of another space, from its Lead, in the person's turn. */
  async teamMessage(ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
    const a = parseArgs(TeamMessageArgsSchema, raw); if ("error" in a) return a.error;
    const { space, ...rest } = a.value;
    if (space === undefined) return this.d.team.teamMessage(ctx, rest);
    const nothing = " Nothing was sent.";
    const there = this.space(ctx, space, nothing); if ("error" in there) return there.error;
    if (there.id === ctx.spaceId) return this.d.team.teamMessage(ctx, rest);
    const reach = this.reach(ctx, `message a teammate in another space ("${there.name}")`, nothing); if ("error" in reach) return reach.error;
    const turn = refuseUnlessPersonTurn({ sessions: this.d.sessions, turnOrigin: (id) => this.d.team.turnOrigin(id) }, reach.session.id, {
      rule: `Messages to another space ("${there.name}") are sent`, where: "your chat", nothing: nothing.trim(),
    });
    if (turn) return turn;
    const team = this.d.team.list(there.id);
    const target = teammateByHandle(team, rest.to);
    if (!target) {
      const handles = team.map((t) => `@${t.handle}`).join(", ") || "none";
      const who = normalizeHandle(rest.to) === "lead" ? `"${there.name}" has no Lead` : `there is no @${normalizeHandle(rest.to)} in "${there.name}"`;
      return err(`${who}. Teammates there: ${handles} (team_list with space "${there.name}" says what each does).${nothing}`);
    }
    const denied = await askCard(this.d.broker, ctx.sessionId, {
      toolKey: "team_message",
      title: `Message @${target.handle} in another space, "${there.name}": "${clip(rest.message, 200)}"`,
      input: { space: there.name, spaceId: there.id, to: target.handle, message: rest.message, ...(rest.wait ? { wait: true } : {}) },
    });
    if (denied) return denied;
    return this.d.team.teamMessage({ ...ctx, spaceId: there.id }, { ...rest, to: target.handle }, { spaceId: there.id, from: reach.mine.name, to: there.name });
  }

  /** `space_teams`: every space of the profile, its Lead, and who is on its team. */
  spaceTeams(ctx: ProviderCallContext, raw: unknown = {}): CallToolResult {
    const a = parseArgs(SpaceTeamsArgsSchema, raw); if ("error" in a) return a.error;
    const reach = this.reach(ctx, "read the teams of the other spaces in this profile", ""); if ("error" in reach) return reach.error;
    const all = this.d.spaces.list(reach.mine.profileId);
    const lines = all.map((s) => {
      const team = this.d.team.list(s.id);
      const here = s.id === reach.mine.id ? " [you are here]" : "";
      if (team.length === 0) return `- "${s.name}" — spaceId ${s.id}${here}: no teammates`;
      const lead = team.find((t) => t.lead);
      const who = team.map((t) => `@${t.handle}${t.lead ? " (Lead)" : ""} ${t.state === "needs-you" ? "needs the person" : t.state}`).join(", ");
      return `- "${s.name}" — spaceId ${s.id}${here}: ${lead ? `Lead @${lead.handle}` : "no Lead"}; ${team.length} teammate${team.length === 1 ? "" : "s"}: ${who}`;
    });
    return ok([`Teams in this profile (${all.length} spaces):`, ...lines, "team_list with `space` reads one team in full; team_message with `space` messages one of its teammates."].join("\n"));
  }

  /** A space of the caller's profile by id, then by name; the refusal names what was asked for and what there is. */
  private space(ctx: ProviderCallContext, asked: string, nothing: string): Space | { error: CallToolResult } {
    const mine = this.d.spaces.get(ctx.spaceId);
    if (!mine) return { error: err(`this session's space is gone.${nothing}`) };
    const all = this.d.spaces.list(mine.profileId);
    const name = asked.trim().toLowerCase();
    const found = all.find((s) => s.id === asked) ?? all.find((s) => s.name === asked) ?? all.find((s) => s.name.trim().toLowerCase() === name);
    if (found) return found;
    return { error: err(`there is no space "${asked}" in this profile. Spaces here: ${all.map((s) => `"${s.name}"`).join(", ")} (space_teams lists each one's team).${nothing}`) };
  }

  /** The caller, when it is a Lead in its own chat; the refusal otherwise, naming what it tried to do and where. */
  private reach(ctx: ProviderCallContext, what: string, nothing: string): Reach | { error: CallToolResult } {
    let session: Session;
    try { session = this.d.sessions.get(ctx.sessionId); } catch { return { error: err(`the calling session no longer exists.${nothing}`) }; }
    const mine = this.d.spaces.get(session.spaceId);
    if (!mine) return { error: err(`this session's space is gone.${nothing}`) };
    const me = this.d.team.teammateOf(session.id);
    if (me && !me.archived && me.lead && me.homeSessionId === session.id && me.spaceId === session.spaceId) return { session, lead: me, mine };
    const who = !me ? `this session is not a teammate's`
      : me.lead ? `you are @${me.handle}, in a task session rather than your own chat`
      : `you are @${me.handle}, not the Lead of "${mine.name}"`;
    return { error: err(`refused: only a space's Lead, in its own chat, can ${what}, and ${who}.${nothing}`) };
  }
}

const textOf = (r: CallToolResult): string => r.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
