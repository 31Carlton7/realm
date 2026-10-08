import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { SETTING_ACTIVE_SPACE, type Space } from "@realm/contracts";
import type { ProviderCallContext } from "../mcp/gateway";
import { err, ok, parseArgs } from "../mcp/tool-result";
import type { BrowserPermissionBroker } from "../browsers/permissions";
import type { RpcServer } from "../rpc/server";
import type { WorkspaceToolGroup } from "./agent-tools";

/**
 * `space_list` and `space_switch`: the spaces of the caller's profile, and moving the window to one.
 *
 * Which space the window shows is the renderer's state, not the server's — so a switch is asked of
 * the window (`space.switchRequested`) and confirmed by what the window writes back: it records the
 * space it is in under `ui.activeSpaceId`, and the tool waits a moment for that to say the asked-for
 * space. A window that does not move — the user is typing, and Realm never pulls the window out from
 * under someone typing; or no window is open — is reported as such, not as a switch.
 *
 * Only the caller's profile: another profile's spaces are another person's, or another part of this
 * one's life, and the window's own profile switch is theirs to make.
 */
export type SpacesDeps = {
  spaces: { get(id: string): Space | null; list(profileId: string): Space[] };
  settings: { get(key: string): unknown };
  broker: Pick<BrowserPermissionBroker, "gate">;
  rpc: Pick<RpcServer, "broadcast">;
  /** How long to wait for the window to say it moved, and how. A test seam. */
  clock?: { sleep(ms: number): Promise<void> };
};

/** Long enough for the renderer to switch and write the setting back; short enough to be a pause. */
const SWITCH_WAIT_MS = 3_000;
const SWITCH_POLL_MS = 100;

const SpaceSwitchArgs = z.object({
  spaceId: z.string().min(1).optional(),
  name: z.string().trim().min(1).optional(),
}).strict().refine((a) => (a.spaceId === undefined) !== (a.name === undefined), { message: "give exactly one of spaceId or name" });

const TOOLS: Tool[] = [
  {
    name: "space_list",
    description:
      "The spaces in this Realm profile — each one's name, id and folder — marking the one you run in and the one the window is showing. Use it before space_switch, or to tell the user where a piece of work lives. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "space_switch",
    description:
      "Move the Realm window to another space of this profile, as the user's own click in the sidebar would — its most recent session comes on screen. Only when the user asked to go there: it changes what they are looking at. Give `spaceId` (from space_list) or the space's exact `name`. Realm will not move the window while the user is typing; the answer says whether it moved. Asks the user for permission unless you are in Full access.",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: { type: "string", description: "the space's id, from space_list" },
        name: { type: "string", description: "the space's name, exactly as space_list shows it" },
      },
      additionalProperties: false,
    },
  },
];

export function createSpacesTools(d: SpacesDeps): WorkspaceToolGroup {
  return {
    tools: TOOLS,
    handlers: {
      space_list: async (ctx) => list(d, ctx),
      space_switch: async (ctx, raw) => switchTo(d, ctx, raw),
    },
  };
}

function list(d: SpacesDeps, ctx: ProviderCallContext): CallToolResult {
  const mine = d.spaces.get(ctx.spaceId);
  if (!mine) return err("this session's space is gone.");
  const shown = d.settings.get(SETTING_ACTIVE_SPACE);
  const lines = d.spaces.list(mine.profileId).map((s) => {
    const marks = [s.id === ctx.spaceId ? "you are here" : null, s.id === shown ? "the window is showing it" : null].filter(Boolean);
    return `- "${s.name}" — spaceId ${s.id}, folder ${s.folderPath}${marks.length ? ` [${marks.join(", ")}]` : ""}`;
  });
  return ok([`Spaces in this profile (${lines.length}):`, ...lines, "space_switch moves the window to one of them."].join("\n"));
}

async function switchTo(d: SpacesDeps, ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
  const args = parseArgs(SpaceSwitchArgs, raw); if ("error" in args) return args.error;
  const mine = d.spaces.get(ctx.spaceId);
  if (!mine) return err("this session's space is gone.");
  const all = d.spaces.list(mine.profileId);
  const { spaceId, name } = args.value;
  const target = spaceId !== undefined ? all.find((s) => s.id === spaceId) : all.find((s) => s.name === name);
  if (!target) {
    const named = spaceId !== undefined ? `id ${spaceId}` : `"${name}"`;
    return err(`there is no space ${named} in this profile. space_list lists the ones there are: ${all.map((s) => `"${s.name}"`).join(", ")}.`);
  }
  if (d.settings.get(SETTING_ACTIVE_SPACE) === target.id) return ok(`The window is already in "${target.name}".`);

  const gate = await d.broker.gate(ctx.sessionId, "space_switch", `Move the window to the space "${target.name}"`, { spaceId: target.id, name: target.name });
  if (!gate.allowed) return err(gate.reason);

  d.rpc.broadcast("space.switchRequested", { spaceId: target.id, requestedBy: ctx.sessionId });
  const sleep = d.clock?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; waited < SWITCH_WAIT_MS; waited += SWITCH_POLL_MS) {
    await sleep(SWITCH_POLL_MS);
    if (d.settings.get(SETTING_ACTIVE_SPACE) === target.id) return ok(`The window is in "${target.name}" now.`);
  }
  return err(`the window did not move to "${target.name}": the user is typing (Realm never moves the window under someone typing), or no Realm window is open. Tell the user where the work is instead, or try again once they have stopped.`);
}
