import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { HexColorSchema, SETTING_ACTIVE_SPACE, SPACE_ICONS, sessionEvent, type SessionEvent, type Space } from "@realm/contracts";
import type { ProviderCallContext } from "../mcp/gateway";
import { err, ok, parseArgs } from "../mcp/tool-result";
import type { BrowserPermissionBroker } from "../browsers/permissions";
import type { RpcServer } from "../rpc/server";
import type { WorkspaceToolGroup } from "./agent-tools";

/**
 * `space_list`, `space_switch` and `space_create`: the spaces of the caller's profile, moving the
 * window to one, and making one.
 *
 * Which space the window shows is the renderer's state, not the server's — so a switch is asked of
 * the window (`space.switchRequested`) and confirmed by what the window writes back: it records the
 * space it is in under `ui.activeSpaceId`, and the tool waits a moment for that to say the asked-for
 * space. A window that does not move — the user is typing, and Realm never pulls the window out from
 * under someone typing; or no window is open — is reported as such, not as a switch.
 *
 * Only the caller's profile: another profile's spaces are another person's, or another part of this
 * one's life, and the window's own profile switch is theirs to make.
 *
 * A space is made the way the New space sheet makes one: `SpacesStore.create` with the sheet's
 * defaults, so it gets the folder Realm allocates under its home, and a folder of the user's becomes
 * the space's first project, as the sheet's folder row does. Unlike the sheet it opens no session in
 * it and moves no window unless asked.
 */
export type SpacesDeps = {
  spaces: { get(id: string): Space | null; list(profileId: string): Space[]; create(input: { profileId: string; name: string; icon: string; color?: string }): Space };
  projects: { create(input: { spaceId: string; name: string; rootPath: string; defaultBranch: string }): unknown };
  sessions: {
    personStartedTurn(sessionId: string): boolean;
    publishServerEvent(sessionId: string, ev: SessionEvent): void;
  };
  /** Who started the caller's turn, in words, for a refusal that says whose it was. */
  turnOrigin(sessionId: string): string;
  /** Which turn the caller is in — the seq of the message that started it. A new turn, a new count. */
  turnOf(sessionId: string): number | null;
  /** The user's home, for `~` and the folders under it a space may not work in; and Realm's own home. */
  userHome: string;
  realmHome: string;
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

/** How many spaces one turn may make. Each is a row on the person's rail; a loop should stop at a few. */
export const SPACE_CREATE_PER_TURN = 3;

const SpaceCreateArgs = z.object({
  name: z.string().trim().min(1).max(120),
  folder: z.string().trim().min(1).optional(),
  icon: z.string().refine((i) => (SPACE_ICONS as readonly string[]).includes(i) || /^emoji:.+/.test(i), { message: "one of the space icon names, or emoji:<emoji>" }).optional(),
  color: HexColorSchema.optional(),
  switchTo: z.boolean().default(false),
}).strict();

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
  {
    name: "space_create",
    description:
      `Make a new space in this Realm profile, as the user's own New space sheet would — only when the user asked for one. It gets its own folder under Realm's home; give \`folder\` (an existing folder, \`~\` allowed) to make that folder the space's first project, as the sheet's folder row does. \`switchTo: true\` also moves the window there. Limits: only in a turn the user started (not a teammate's message or a schedule); at most ${SPACE_CREATE_PER_TURN} per turn; a name the profile already has makes nothing and gives that space's id; a folder in a system or secrets location (/, /System, /Library, ~/Library, ~/.ssh, ~/.config, ~/.claude, ~/.codex, ~/.cursor, Realm's home) is refused. It cannot rename, delete or archive a space. Asks the user for permission unless you are in Full access.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "the space's name, as the sidebar will show it" },
        folder: { type: "string", description: "an existing folder to work in, absolute or ~/…; omit and Realm makes one" },
        icon: { type: "string", description: `one of: ${SPACE_ICONS.join(", ")}; or emoji:<emoji>. Default folder` },
        color: { type: "string", description: "#rrggbb; default the next colour along, as the sheet picks" },
        switchTo: { type: "boolean", description: "move the window to the new space (default false)" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

export function createSpacesTools(d: SpacesDeps): WorkspaceToolGroup {
  /** Per caller: the turn it is counting, and how many spaces that turn has made. */
  const made = new Map<string, { turn: number | null; count: number }>();
  return {
    tools: TOOLS,
    handlers: {
      space_list: async (ctx) => list(d, ctx),
      space_switch: async (ctx, raw) => switchTo(d, ctx, raw),
      space_create: async (ctx, raw) => create(d, ctx, raw, made),
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

  return moveWindow(d, ctx, target);
}

async function moveWindow(d: SpacesDeps, ctx: ProviderCallContext, target: Space): Promise<CallToolResult> {
  d.rpc.broadcast("space.switchRequested", { spaceId: target.id, requestedBy: ctx.sessionId });
  const sleep = d.clock?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; waited < SWITCH_WAIT_MS; waited += SWITCH_POLL_MS) {
    await sleep(SWITCH_POLL_MS);
    if (d.settings.get(SETTING_ACTIVE_SPACE) === target.id) return ok(`The window is in "${target.name}" now.`);
  }
  return err(`the window did not move to "${target.name}": the user is typing (Realm never moves the window under someone typing), or no Realm window is open. Tell the user where the work is instead, or try again once they have stopped.`);
}

async function create(d: SpacesDeps, ctx: ProviderCallContext, raw: unknown, made: Map<string, { turn: number | null; count: number }>): Promise<CallToolResult> {
  const args = parseArgs(SpaceCreateArgs, raw); if ("error" in args) return args.error;
  const { name, folder, icon, color, switchTo: move } = args.value;
  const mine = d.spaces.get(ctx.spaceId);
  if (!mine) return err("this session's space is gone.");
  if (!d.sessions.personStartedTurn(ctx.sessionId)) {
    return err(`refused: this turn was started by ${d.turnOrigin(ctx.sessionId)}, not by the person. Spaces are made only in a turn the person started; ask them to say it in this chat. Nothing was made.`);
  }
  const turn = d.turnOf(ctx.sessionId);
  const tally = made.get(ctx.sessionId);
  const used = tally && tally.turn === turn ? tally.count : 0;
  if (used >= SPACE_CREATE_PER_TURN) {
    return err(`refused: this turn has already made ${SPACE_CREATE_PER_TURN} spaces, the most one turn may make. Ask the user whether they want more. Nothing was made.`);
  }
  // The sheet lets two spaces share a name; an agent asked twice should not leave the rail with twins.
  const twin = d.spaces.list(mine.profileId).find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
  if (twin) return ok(`There is already a space "${twin.name}" in this profile (spaceId ${twin.id}, folder ${twin.folderPath}), so nothing was made. space_switch moves the window to it.`);

  let root: string | null = null;
  if (folder !== undefined) {
    const picked = pickFolder(d, folder);
    if ("error" in picked) return err(`${picked.error} Nothing was made.`);
    root = picked.path;
  }

  const title = `Make a space "${name}"${root ? ` working in ${root}` : ""}${move ? ", and move the window there" : ""}`;
  const gate = await d.broker.gate(ctx.sessionId, "space_create", title, { name, ...(root ? { folder: root } : {}), ...(icon ? { icon } : {}), ...(color ? { color } : {}), switchTo: move });
  if (!gate.allowed) return err(gate.reason);

  const space = d.spaces.create({ profileId: mine.profileId, name, icon: icon ?? "folder", color });
  made.set(ctx.sessionId, { turn, count: used + 1 });
  if (root) {
    d.projects.create({ spaceId: space.id, name: basename(root) || root, rootPath: root, defaultBranch: "main" });
    d.rpc.broadcast("items.changed", { spaceId: space.id });
  }
  d.rpc.broadcast("spaces.changed", {});
  d.sessions.publishServerEvent(ctx.sessionId, sessionEvent("space_made", { spaceId: space.id, name: space.name, note: `Made the space ${space.name}` }));

  const where = root ? `It works in ${root} (its first project); its own folder is ${space.folderPath}.` : `Its folder is ${space.folderPath}.`;
  const summary = `Made the space "${space.name}" — spaceId ${space.id}. ${where}`;
  if (!move) return ok(`${summary} The window stays where it is: space_switch moves it there, and team_message can tell a teammate about it.`);
  const moved = await moveWindow(d, ctx, space);
  const said = moved.content.map((c) => (c as { text: string }).text).join("\n");
  return moved.isError ? err(`${summary} But ${said}`) : ok(`${summary} ${said} team_message can tell a teammate about it.`);
}

/**
 * The folder an agent named, as the sheet's folder picker would hand it over: an existing directory,
 * `~` expanded, symlinks and `..` resolved — and never one of the places a space must not work in.
 * The sheet never makes the folder it is handed, so neither does this.
 */
function pickFolder(d: SpacesDeps, raw: string): { path: string } | { error: string } {
  const expanded = raw === "~" ? d.userHome : raw.startsWith("~/") ? join(d.userHome, raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) return { error: `"${raw}" is not an absolute path; give the whole path, or one starting with ~/.` };
  const abs = resolve(expanded);
  if (!existsSync(abs)) return { error: `there is no folder at ${abs}. Name a folder that is there, or leave folder out and Realm makes the space one of its own.` };
  const real = realpathSync(abs);
  if (!statSync(real).isDirectory()) return { error: `${real} is a file, not a folder.` };
  const refusal = refusedFolder(d, real);
  if (refusal) return { error: `refused: ${real === abs ? real : `${abs} is ${real}, which`} ${refusal}` };
  return { path: real };
}

/** Why a space may not work in `real`, or null. Each root is resolved too: /var and /tmp are links on a Mac. */
function refusedFolder(d: SpacesDeps, real: string): string | null {
  const canon = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const within = (root: string) => { const r = relative(canon(root), real); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
  if (real === canon("/")) return "is the root of the disk, which is not a project.";
  if (real === canon(d.realmHome)) return "is Realm's own home, which holds every space's folder and its database.";
  for (const root of ["/System", "/Library", join(d.userHome, "Library")]) if (within(root)) return `is inside ${root}, which belongs to macOS and its apps.`;
  for (const dir of [".ssh", ".config"]) if (within(join(d.userHome, dir))) return `is inside ~/${dir}, which holds keys and credentials.`;
  for (const dir of [".claude", ".codex", ".cursor"]) if (within(join(d.userHome, dir))) return `is inside ~/${dir}, an agent's own settings, which Realm never works in.`;
  return null;
}
