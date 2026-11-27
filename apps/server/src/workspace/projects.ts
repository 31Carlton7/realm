import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Environment, Project, Space } from "@realm/contracts";
import type { ProviderCallContext } from "../mcp/gateway";
import { err, ok, parseArgs } from "../mcp/tool-result";
import { askCard, refuseUnlessPersonTurn, type AgentWriteGateDeps } from "../mcp/agent-gate";
import type { BrowserPermissionBroker } from "../browsers/permissions";
import type { RpcServer } from "../rpc/server";
import type { WorkspaceToolGroup } from "./agent-tools";
import { pickFolder } from "./spaces";

/**
 * `project_list`, `project_link` and `project_unlink`: the folders and repositories a space works in,
 * as the workspace selector's "Add folder" and the space's folder row attach them.
 *
 * Any space of the caller's profile, named by `spaceId`; the caller's own when none is given. Another
 * profile's spaces are another person's, as `space_list` has it.
 *
 * A link is what `projects.open` makes: the project row and its checkout, so the folder is in the
 * workspace selector at once. The folder goes through `pickFolder`, the check `space_create` uses, so
 * `~/.ssh` and the like are refused here as there. An unlink is `projects.delete`: the project goes,
 * and the checkout stays, because sessions may still be working in it.
 */
export type ProjectsDeps = AgentWriteGateDeps & {
  spaces: { get(id: string): Space | null };
  projects: { list(spaceId: string): Project[]; get(id: string): Project | null; findByRoot(rootPath: string, spaceId?: string): Project | null; delete(id: string): void };
  /** `projects.open` for a folder already checked: the project and its checkout, found or made. */
  open(input: { path: string; spaceId: string }): { project: Project; environment: Environment };
  userHome: string;
  realmHome: string;
  broker: Pick<BrowserPermissionBroker, "gate">;
  rpc: Pick<RpcServer, "broadcast">;
};

const ListArgs = z.object({ spaceId: z.string().min(1).optional() }).strict();
const LinkArgs = z.object({ path: z.string().trim().min(1), spaceId: z.string().min(1).optional() }).strict();
const UnlinkArgs = z.object({ projectId: z.string().min(1) }).strict();

const SPACE_ARG = { spaceId: { type: "string", description: "a space of this profile, from space_list; default the one you run in" } };

const TOOLS: Tool[] = [
  {
    name: "project_list",
    description: "The folders and repositories a space works in (its projects): each one's name, id and path. Read-only.",
    inputSchema: { type: "object", properties: SPACE_ARG, additionalProperties: false },
  },
  {
    name: "project_link",
    description: "Attach a folder or repository to a space as a project, as the workspace selector's Add folder does, so its sessions can work in it. Give `path`, absolute or ~/…; it must already exist, and system or secrets locations (/, /System, /Library, ~/Library, ~/.ssh, ~/.config, ~/.aws, ~/.gnupg, ~/.kube, ~/.docker, ~/.claude, ~/.codex, ~/.cursor, Realm's home) are refused. Only in a turn the user started; asks the user first unless you are in Full access.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "the folder, absolute or ~/…" }, ...SPACE_ARG },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "project_unlink",
    description: "Detach a project from its space, by the id project_list shows. The folder on disk and the sessions' checkout of it stay. Only in a turn the user started, and the user is always asked first, Full access included.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"], additionalProperties: false },
  },
];

export function createProjectTools(d: ProjectsDeps): WorkspaceToolGroup {
  return {
    tools: TOOLS,
    handlers: {
      project_list: async (ctx, raw) => list(d, ctx, raw),
      project_link: async (ctx, raw) => link(d, ctx, raw),
      project_unlink: async (ctx, raw) => unlink(d, ctx, raw),
    },
  };
}

/** The space a call names, when it is in the caller's profile. */
function spaceFor(d: ProjectsDeps, ctx: ProviderCallContext, spaceId: string | undefined): { space: Space } | { error: CallToolResult } {
  const mine = d.spaces.get(ctx.spaceId);
  if (!mine) return { error: err("this session's space is gone.") };
  if (spaceId === undefined || spaceId === mine.id) return { space: mine };
  const other = d.spaces.get(spaceId);
  if (!other || other.profileId !== mine.profileId) return { error: err(`there is no space ${spaceId} in this profile; space_list lists the ones there are.`) };
  return { space: other };
}

function list(d: ProjectsDeps, ctx: ProviderCallContext, raw: unknown): CallToolResult {
  const args = parseArgs(ListArgs, raw ?? {}); if ("error" in args) return args.error;
  const found = spaceFor(d, ctx, args.value.spaceId); if ("error" in found) return found.error;
  const { space } = found;
  const rows = d.projects.list(space.id);
  if (rows.length === 0) return ok(`"${space.name}" has no projects; it works in its own folder, ${space.folderPath}.`);
  return ok([`Projects in "${space.name}" (${rows.length}):`, ...rows.map((p) => `- ${p.name} — projectId ${p.id}, ${p.rootPath}`)].join("\n"));
}

async function link(d: ProjectsDeps, ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
  const args = parseArgs(LinkArgs, raw ?? {}); if ("error" in args) return args.error;
  const found = spaceFor(d, ctx, args.value.spaceId); if ("error" in found) return found.error;
  const { space } = found;
  const notTheirs = refuseUnlessPersonTurn(d, ctx.sessionId, { rule: "Projects are linked", where: "this chat", nothing: "Nothing was linked." });
  if (notTheirs) return notTheirs;
  const picked = pickFolder(d, args.value.path);
  if ("error" in picked) return err(`${picked.error} Nothing was linked.`);
  const twin = d.projects.findByRoot(picked.path, space.id);
  if (twin) return ok(`"${space.name}" already has ${picked.path} as the project ${twin.name} (projectId ${twin.id}). Nothing changed.`);

  const denied = await askCard(d.broker, ctx.sessionId, { toolKey: "project_link", title: `Link ${picked.path} to the space "${space.name}"`, input: { path: picked.path, space: space.name } });
  if (denied) return denied;
  const { project } = d.open({ path: picked.path, spaceId: space.id });
  d.rpc.broadcast("items.changed", { spaceId: space.id });
  // The checkout is what the workspace selector lists, and the window refreshes it on its own event.
  d.rpc.broadcast("environments.changed", { spaceId: space.id });
  return ok(`Linked ${project.rootPath} to "${space.name}" as the project ${project.name} (projectId ${project.id}). Its sessions can pick it in the workspace selector.`);
}

async function unlink(d: ProjectsDeps, ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
  const args = parseArgs(UnlinkArgs, raw ?? {}); if ("error" in args) return args.error;
  const project = d.projects.get(args.value.projectId);
  const found = project ? spaceFor(d, ctx, project.spaceId) : null;
  if (!project || !found || "error" in found) return err(`there is no project ${args.value.projectId} in this profile; project_list shows each one's id. Nothing changed.`);
  const { space } = found;
  const notTheirs = refuseUnlessPersonTurn(d, ctx.sessionId, { rule: "Projects are unlinked", where: "this chat", nothing: "Nothing changed." });
  if (notTheirs) return notTheirs;
  const denied = await askCard(d.broker, ctx.sessionId, { toolKey: "project_unlink", title: `Unlink the project ${project.name} (${project.rootPath}) from "${space.name}"`,
    input: { projectId: project.id, path: project.rootPath, space: space.name }, always: true });
  if (denied) return denied;
  d.projects.delete(project.id);
  d.rpc.broadcast("items.changed", { spaceId: space.id });
  return ok(`Unlinked ${project.name} from "${space.name}". The folder ${project.rootPath} is untouched, and sessions already working in it carry on.`);
}
