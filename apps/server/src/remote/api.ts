import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  AGENT_META, AGENT_SKILL_SUPPORT, AgentKindSchema, DEFAULT_PERMISSION_MODE_KEY, defaultAccountId, documentKindFor, hasAccounts, isSecretPath, keepLiveRefs, LIBRARY_QUERY_MAX, MAC_SKILL_ID, mentionIds, mimeForPath, MID_TURN_MODE_KEY, MODEL_CATALOG_KEY, MODEL_EFFORTS_KEY, parseSpaceIcon, PERMISSION_MODES, readEffortSupport,
  resolveMidTurnMode, runnableCommands, SEARCH_GROUP_LIMIT_MAX, SELECTABLE_AGENT_KINDS, TeammateIconSchema, withStreamed, type AgentKind, type DelegatedChild, type IconAsset, type Item, type Machine, type MethodResult, type ModelInfo,
  type Goal, type PendingMove, type QueuedPrompt, type Schedule, type Session, type Skill, type Space, type StoredSessionEvent, type Teammate, type TeammateIcon, type TurnChanges,
} from "@realm/contracts";
import { givenAttachmentName, tempAttachmentDir } from "@realm/contracts/src/temp-attachments";
import {
  MobileCalls, RECENT_LIMIT, SEND_LIMITS, SESSION_OPEN_MAX, type Goal as PhoneGoal, type Home, type MentionRef, type MobileErrorCode, type MobileMethod, type MobileParams, type MobileResult, type MoveOptions, type QueuedMessage,
  type ScheduledTask, type Screen, type ScreenFrame, type SearchHit, type SessionOptions, type SessionRow, type Subagent, type Teammate as PhoneTeammate,
} from "@realm/remote";
import {
  agentsAtWork, FALLBACK_AGENT, isChild, isLive, LAST_AGENT_SETTING, LAST_MODELS_SETTING, needsYou, nestChildren, QUICK_CHAT_SETTING, quickChatIdOf, subagentState, upcomingOrder, type NeedsYouState,
} from "@realm/view";
import { resolveDefaultPermissionMode } from "../sessions/service";
import { tildify } from "../skills/discovery";
import { diffPage } from "./changes";
import { checkSpacePath, documentRow, DOCUMENTS_SEARCH_LIMIT, SECRET_REFUSAL, withheldFile } from "./documents";
import { agentOptions, changesFor, ChoiceRefused, probeList, sessionModelLabel, type InitFacts, type OptionsInput, type ProbeRow } from "./options";
import { fileData, filePreview, PreviewRefused, sipsDownscale, type Downscale } from "./preview";
import { BROWSER_FRAME_EVERY_MS, browserPane, openPanes, paneOrder, terminalOutput, terminalPane } from "./panes";
import { pendingMove, phoneTabCard, queuedMessage, SessionProjector, tilde } from "./rows";
import { RpcCallError, type RpcPort } from "./rpc-port";
import { FRAME_MAX_BYTES, FRAME_QUALITY, frameSide, jpegSize, machineScreen, phoneMayWatch, SCREEN_DEADLINE_MS, screenFrame, screenOrder, simulatorScreen } from "./screens";
import { checkUploads, saveUploads, UploadRefused, type Upload } from "./uploads";
import { everyPlan, monthStart, spend } from "./usage";
import { scheduledTask } from "./work";

/**
 * mobile.v1 on the Mac (PROTOCOL.md §8): each call validated against its schema, then answered by the
 * desktop's own RPC methods — the same handlers, validation and broadcasts as the desktop gets. The
 * phone never names an RPC method; it names a mobile.v1 call, and only these exist.
 */

/** A teammate as a phone's Team list draws it: its row in the sidebar, what it is working on, and what
 *  its Edit sheet shows. What it is doing is the session it works in now, else the newest it started,
 *  by its task — the "cto - " its title starts with is the row's name already. */
export function phoneTeammate(t: Teammate): PhoneTeammate {
  const live = t.taskSessions.find((s) => s.state !== "idle");
  const doing = live ?? (t.state === "idle" ? t.taskSessions[0] : undefined);
  const prefix = `${t.handle} - `;
  return {
    id: t.id, spaceId: t.spaceId, name: t.name, handle: t.handle, brief: t.brief, lead: t.lead, chatId: t.homeSessionId,
    icon: t.icon, state: t.state, stateSince: t.stateSince, unread: t.unread,
    activity: doing ? (doing.title.startsWith(prefix) ? doing.title.slice(prefix.length) : doing.title) : null, activityAt: doing?.updatedAt ?? null,
    agentKind: t.agentKind, model: t.model, effort: t.effort, permissionMode: t.permissionMode, group: t.group, archived: t.archived,
  };
}

/** A shape, a colour and an agent, which mobile.v1 names as strings, as the desktop's own lists have them. */
function desktopNames(icon: { shape: string; color: string } | undefined, agentKind: string | undefined): { icon?: TeammateIcon; agentKind?: AgentKind } {
  const shape = icon === undefined ? undefined : TeammateIconSchema.safeParse(icon);
  if (shape && !shape.success) throw new MobileError("INVALID_PARAMS", `unknown icon ${icon!.shape} ${icon!.color}`);
  const agent = agentKind === undefined ? undefined : AgentKindSchema.safeParse(agentKind);
  if (agent && !agent.success) throw new MobileError("INVALID_PARAMS", `unknown agent ${agentKind}`);
  return { ...(shape?.success ? { icon: shape.data } : {}), ...(agent?.success ? { agentKind: agent.data } : {}) };
}

export class MobileError extends Error {
  constructor(readonly code: MobileErrorCode, message: string) { super(message); }
}

/** A session a phone has open: its own projector, so rows are folded once per phone, and what arrives
 *  for it while `session.open` reads its history. */
export type OpenSession = {
  projector: SessionProjector;
  buffer: StoredSessionEvent[] | null;
  /** The queue as the newest `session.queue` broadcast carried it while the session opened — newer than
   *  the read `session.open` made, so the open answers with it. */
  queued: QueuedPrompt[] | null;
  /** The move that same broadcast carried, beside the queue. */
  move: PendingMove | null;
  /** Its sub-agents' sessions, as the phone last read them: a change to one is a change to this list. */
  subagents: ReadonlySet<string>;
};

/** A phone's channel: the port its calls go through, as that phone, and its open sessions. */
export type ChannelContext = {
  phoneId: string;
  rpc: RpcPort;
  sessions: Map<string, OpenSession>;
};

const HISTORY_PAGE = 2_000;
/** A transcript longer than this is shown from its newest end; Phase 2 adds paging backwards. */
const HISTORY_LIMIT = 20_000;
/** How long Home waits on the agents' probe for the names of their models. A probe already made
 *  answers at once; one never made takes as long as the slowest agent, and Home does not wait on it. */
const PROBE_WAIT_MS = 50;
/** How long a session's options wait on a probe of its agent alone, when the Mac has made none yet.
 *  Past it they answer from the curated models, so the phone's sheet never waits on a slow CLI. */
const AGENT_PROBE_WAIT_MS = 1_500;
/** How many of each space's sessions Home lists; `space.sessions` pages through the rest. */
const HOME_PER_SPACE = 5;
/** The most a space's picture may weigh to be sent (`space.icon`). */
export const ICON_MAX_BYTES = 256 * 1024;

/** The desktop's refusals of a move, which a phone shows as they are worded. */
const MOVE_REFUSALS = new Set(["SESSION_MOVE_REFUSED", "SESSION_BUSY", "SESSION_SWITCHING", "ENVIRONMENT_BUSY", "ENVIRONMENT_WRONG_SPACE", "BAD_REQUEST", "MOVE_FAILED", "MOVE_CANCELLED", "MOVE_STOPS_WORK"]);

/** The desktop's refusals of a fork, a move to another space, a switch of agent or of account, which
 *  a phone shows as they are worded: a turn still running, a switch already under way, a checkpoint
 *  that cannot be forked, an account that is not the agent's. */
const ACTION_REFUSALS = new Set(["SESSION_BUSY", "SESSION_SWITCHING", "AGENT_UNAVAILABLE", "BAD_REQUEST", "FORK_NO_SESSION", "FORK_SESSION_GONE", "CHECKPOINT_GONE", "NOT_A_REPOSITORY"]);

/** `call`'s answer, with a refusal the desktop words for the person made FORBIDDEN in its words. */
async function refusable<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (e) {
    if (e instanceof RpcCallError && ACTION_REFUSALS.has(e.code)) throw new MobileError("FORBIDDEN", e.message);
    throw e;
  }
}

/** `moving` goes out as `running`: a phone on today's build knows no other word for "busy, wait". */
const mobileStatus = (s: Session["status"]): SessionRow["status"] => (s === "waiting_permission" ? "waiting" : s === "moving" ? "running" : s);

const isUnread = (s: Session): boolean => s.seenSeq > 0 && s.lastEventSeq > s.seenSeq;

/** A session's goal as a phone reads it: the desktop's, without the session it is already under. */
export const phoneGoal = (g: Goal | null): PhoneGoal | null => (g ? {
  objective: g.objective, status: g.status, turns: g.turns, tokensUsed: g.tokensUsed, tokenBudget: g.tokenBudget,
  note: g.note, startedAt: g.startedAt, updatedAt: g.updatedAt,
} : null);

/** Home's order, and a space's page's: the conversation that moved last first (`activityAt` — never
 *  `updatedAt`, which a change of settings or a rename moves too), then the newer session, then by id,
 *  so two reads of the same lists agree and a page never repeats or skips a row. */
const newestFirst = (a: Session, b: Session): number =>
  b.activityAt - a.activityAt || b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** `p`'s answer if it comes within `ms`, else null — and null for a failure too. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([p.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** `p`'s answer if it comes within `ms`, else a failure in the words `late`. */
async function deadline<T>(p: Promise<T>, ms: number, late: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(late)), ms); });
  try {
    return await Promise.race([p, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** The public catalog's cached rows (`MODEL_CATALOG_KEY`), by key. Read from the cache alone: a
 *  refresh is the desktop picker's to make, and the phone's sheet does not wait on the network. */
function catalogOf(value: unknown): Map<string, ModelInfo> {
  const rows = value && typeof value === "object" ? (value as { rows?: unknown }).rows : null;
  return new Map(Array.isArray(rows) ? rows.filter((r): r is ModelInfo => typeof (r as ModelInfo)?.key === "string").map((r) => [r.key, r]) : []);
}

/** What realm-server knows, as one listing: every space, session and item, and the quick chat's
 *  session, which its window keeps in a setting. */
type Lists = { spaces: Space[]; sessions: Session[]; items: Item[]; quickChatId: string | null };

type Probe = MethodResult<"agents.probe">;

/**
 * Needs you's input (`@realm/view`), built from the lists the desktop's own store is seeded from:
 * `sessions.listAll` for every session's row, status, space and the time its status last moved;
 * `items.listAll` for titles and what is listed (archived rows already left out); `spaces.list`; and
 * the quick chat's setting. A server holds no window, so no profile is the window's own: every item
 * comes in through `allItems`, as another profile's would in the sidebar.
 */
export function needsYouInput(l: Lists): NeedsYouState {
  const by = <T>(f: (s: Session) => T): Record<string, T> => Object.fromEntries(l.sessions.map((s) => [s.id, f(s)]));
  return {
    spaces: l.spaces, activeProfileId: null, items: [], allItems: l.items,
    sessions: {}, allSessions: by((s) => s),
    sessionStatus: by((s) => s.status), sessionSpace: by((s) => s.spaceId), sessionUpdatedAt: by((s) => s.updatedAt),
    quickChatId: l.quickChatId,
  };
}

/** A space's or a profile's icon, read the way the desktop's `SpaceIcon` reads it. */
function iconOf(icon: string): Pick<Home["spaces"][number], "iconKind" | "glyph" | "emoji"> {
  const ref = parseSpaceIcon(icon);
  if (ref.kind === "emoji") return { iconKind: "emoji", emoji: ref.char };
  if (ref.kind === "asset") return { iconKind: "picture" };
  return { iconKind: "glyph", glyph: ref.name };
}

/** An icon asset's picture: an SVG's own text, or a data URL's bytes. */
function pictureOf(asset: IconAsset): { mime: string; data: Buffer } | null {
  if (!asset.dataText.startsWith("data:")) return asset.mime === "image/svg+xml" ? { mime: asset.mime, data: Buffer.from(asset.dataText, "utf8") } : null;
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(asset.dataText);
  if (!m) return null;
  try {
    return { mime: m[1]!, data: m[2] ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!), "utf8") };
  } catch {
    return null;
  }
}

/** The settings every agent's options read. */
type Shared = { remembered: Record<string, string[]>; catalog: Map<string, ModelInfo>; midTurn: SessionOptions["midTurn"]; defaultPermission: unknown };

/** What `agentOptions` reads for one agent: its probe, a session's handshake where there is one, and the
 *  shared settings. */
const optionsInput = (probe: ProbeRow | null, init: InitFacts | null, shared: Shared): OptionsInput =>
  ({ probe, init, remembered: shared.remembered, catalog: shared.catalog });

/** What a lead's row says of its sub-agents, as the sidebar's row says it (`agentsWaiting`): how many,
 *  how many wait on a request, and the one that has waited longest. */
/** Where a session's opening rows start: the newest `limit`, reaching back to the row of `from` where
 *  that is further, but never to more than `SESSION_OPEN_MAX` rows. A row keeps its place and takes the
 *  seq of the event that last changed it, so where none has `from` itself, the first with a later seq
 *  stands at or before where it was. */
export function openingRow(rows: readonly { seq: number }[], limit: number, from?: number): number {
  const newest = Math.max(0, rows.length - limit);
  if (from === undefined) return newest;
  const exact = rows.findIndex((r) => r.seq === from);
  const at = exact !== -1 ? exact : rows.findIndex((r) => r.seq >= from);
  if (at === -1) return newest;
  return Math.max(Math.min(at, newest), rows.length - SESSION_OPEN_MAX);
}

function subagentsOn(agents: readonly Session[]): Pick<SessionRow, "subagents" | "subagentsWaiting" | "subagentWaiting"> {
  const waiting = agents.filter((a) => a.status === "waiting_permission").sort((a, b) => a.updatedAt - b.updatedAt);
  return { subagents: agents.length, subagentsWaiting: waiting.length, ...(waiting[0] ? { subagentWaiting: waiting[0].id } : {}) };
}

/** A sub-agent, as its lead's Agents tab says it: working (or waiting, or about to start) until the
 *  tab's state says it has ended, and then how. */
function subagentOf(child: DelegatedChild, session: SessionRow, inFlight: boolean): Subagent {
  const state = subagentState(child, undefined, inFlight);
  const ended = !isLive(state);
  return {
    session, goal: child.goal, startedAt: child.startedAt,
    // When its run settled — or, for a child whose tool keeps no record, when it last did anything.
    settledAt: ended ? child.settledAt ?? child.activity?.ts ?? child.session.updatedAt : null,
    outcome: ended ? state : null, report: child.report, note: child.note ?? null,
  };
}

/** A space's name by its id, "" for one the Mac no longer has. */
const spaceNames = (spaces: readonly Space[]) => {
  const names = new Map(spaces.map((s) => [s.id, s.name]));
  return (id: string): string => names.get(id) ?? "";
};


const GONE = "That message has already gone out.";

/** A picture of `screen` that did not come within SCREEN_DEADLINE_MS, as a phone is told it. */
const tooLong = (screen: Screen): string => `The Mac could not take a picture of ${screen.name} in time.`;

export class MobileApi {
  /** Each screen's capture while it is being taken, by kind and id: every call for that screen
   *  meanwhile — the viewer's, the session card's, another phone's — waits on it rather than taking
   *  its own, as the gateway answers a phone's calls as they come. */
  private readonly capturing = new Map<string, Promise<{ bytes: Buffer; capturedAt: number }>>();
  /** Each browser pane's last picture, by pane and side, while it is under BROWSER_FRAME_EVERY_MS old
   *  or still being taken: what every call for that pane meanwhile is answered with. */
  private readonly pagePictures = new Map<string, { at: number; frame: Promise<ScreenFrame> }>();

  /** `userHome` is the Mac's home folder, which paths are shortened against; the server's own by default. */
  constructor(private readonly o: { macName: () => string; reportsDir: string; dev: boolean; downscale?: Downscale; realmHome: string; userHome?: string }) {}

  async handle(ctx: ChannelContext, method: string, params: unknown): Promise<unknown> {
    if (!Object.hasOwn(MobileCalls, method)) throw new MobileError("METHOD_NOT_FOUND", `no mobile.v1 call ${method}`);
    const m = method as MobileMethod;
    const parsed = MobileCalls[m].params.safeParse(params ?? {});
    if (!parsed.success) throw new MobileError("INVALID_PARAMS", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const p = parsed.data as Record<string, unknown>;
    const rpc = ctx.rpc;
    try {
      switch (m) {
        case "ping": return { at: Date.now() };
        case "home.get": return await this.home(rpc, (p.profileId as string | undefined) ?? null);
        case "space.sessions": return await this.spaceSessions(rpc, p.id as string, p.offset as number, p.limit as number);
        case "session.open": return await this.open(ctx, p.id as string, p.limit as number, p.from as number | undefined);
        case "search.query": return await this.search(rpc, p.query as string, (p.profileId as string | undefined) ?? null);
        case "session.close": ctx.sessions.delete(p.id as string); return { ok: true };
        case "session.update": return await this.update(rpc, p as MobileParams<"session.update">);
        case "session.queue": return await this.queue(rpc, p.id as string);
        case "session.sendQueuedNow": await rpc.call("sessions.releaseQueued", { id: p.id as string, queuedId: p.queuedId as string }); return { ok: true };
        case "session.removeQueued": await rpc.call("sessions.dequeue", { id: p.id as string, queuedId: p.queuedId as string }); return { ok: true };
        case "session.holdQueued": {
          const { held } = await rpc.call("sessions.holdQueued", { id: p.id as string, queuedId: p.queuedId as string, held: p.held as boolean });
          // A hold the queue could not take is a message already on its way: there is nothing left to edit.
          if (p.held === true && !held) throw new MobileError("NOT_FOUND", GONE);
          return { ok: true };
        }
        case "session.editQueued": return await this.editQueued(rpc, p as MobileParams<"session.editQueued">);
        case "session.subagents": return await this.subagents(ctx, p.id as string);
        case "teammates.list": return await this.teammates(rpc, p.archived === true);
        case "teammate.chat": return { id: (await rpc.call("teammates.home", { id: p.id as string })).sessionId };
        case "session.info": return await this.info(rpc, p.id as string);
        case "teammate.update": return await this.updateTeammate(rpc, p as MobileParams<"teammate.update">);
        case "teammate.create": return await this.createTeammate(rpc, p as MobileParams<"teammate.create">);
        case "teammate.archive": return { teammate: phoneTeammate(await rpc.call("teammates.archive", { id: p.id as string, archived: p.archived as boolean })) };
        case "teammates.setLead": return { teammates: (await rpc.call("teammates.setLead", { spaceId: p.spaceId as string, id: p.id as string | null })).map(phoneTeammate) };
        case "teammates.reorder": return { teammates: (await rpc.call("teammates.reorder", p as MobileParams<"teammates.reorder">)).map(phoneTeammate) };
        case "usage.get": return await this.usage(rpc);
        // Review went with the first Teams: the phone's Review screen is told there is nothing in it,
        // and a review it still holds is gone, rather than either being an error it cannot read.
        case "reviews.list": return { reviews: [] };
        case "review.get": case "review.decide": case "review.file": throw new MobileError("NOT_FOUND", "That review is no longer in Realm.");
        case "schedules.list": return await this.schedules(rpc);
        case "schedules.runNow": {
          const fired = await rpc.call("schedules.runNow", { id: p.id as string });
          return { task: (await this.tasks(rpc, [fired]))[0]! };
        }
        case "session.send": {
          const tabs = p.tabs as MobileParams<"session.send">["tabs"];
          const files = await this.uploads(p.text as string, p.attachments as Upload[], tabs?.length ?? 0);
          const named = await this.named(rpc, p.id as string, p.text as string, p.mentionRefs as MentionRef[] | undefined);
          await rpc.call("sessions.send", { id: p.id as string, text: p.text as string, attachments: files, delivery: p.delivery as "auto" | "queue" | "steer", ...named, ...(tabs?.length ? { tabs } : {}) });
          return { ok: true };
        }
        case "session.composer": return await this.composer(rpc, p.id as string);
        case "session.mentionFiles": return await this.mentionFiles(rpc, p.id as string, p.query as string);
        case "session.tabs": {
          const { tabs } = await rpc.call("tabs.list", { sessionId: p.id as string });
          const home = this.o.userHome ?? homedir();
          return { tabs: tabs.map(({ itemId, kind, title, url, path, cwd, program }) => ({
            itemId, kind, title, ...(url ? { url } : {}), ...(path ? { path } : {}), ...(cwd ? { cwd: tilde(cwd, home) } : {}), ...(program ? { program } : {}),
          })) };
        }
        case "session.tabPreview": return phoneTabCard(await rpc.call("tabs.preview", { sessionId: p.id as string, tab: p.tab as MobileParams<"session.tabPreview">["tab"] }), this.o.userHome ?? homedir());
        case "session.expandCommand": {
          const session = await rpc.call("sessions.get", { id: p.id as string });
          const { text, missing } = await rpc.call("commands.expand", { spaceId: session.spaceId, name: p.name as string, args: p.args as string });
          return { text, missing };
        }
        case "session.goal": await rpc.call("goals.start", { sessionId: p.id as string, objective: p.objective as string, tokenBudget: null }); return { ok: true };
        case "session.goalControl": return await this.goalControl(rpc, p.id as string, p.action as MobileParams<"session.goalControl">["action"]);
        case "session.options": {
          const { session, input, shared } = await this.optionsContext(rpc, p.id as string);
          return this.sessionOptions(session, input, shared);
        }
        case "session.configure": return await this.configure(rpc, p as MobileParams<"session.configure">);
        case "agents.list": return await this.agents(rpc);
        case "session.answer": {
          // The desktop's own answer shape — question id → an option's value or words of the person's
          // own, several as a list — handed on as it came: the server holds it to the request's card.
          const answers = p.answers as Record<string, string | string[]> | undefined;
          await rpc.call("sessions.respondPermission", {
            id: p.id as string, requestId: p.requestId as string, decision: p.decision as "allow" | "allow_always" | "deny",
            ...(answers ? { answers } : {}),
          });
          return { ok: true };
        }
        case "session.stop": await rpc.call("sessions.interrupt", { id: p.id as string }); return { ok: true };
        case "session.seen": await rpc.call("sessions.markSeen", { id: p.id as string, seq: this.seenUpTo(ctx, p.id as string, p.seq as number) }); return { ok: true };
        case "session.create": return await this.create(rpc, p as MobileParams<"session.create">);
        case "session.changes": {
          const { checkpointId, files, totalFiles } = await this.turnChanges(rpc, p.id as string, p.checkpointId as string);
          return { checkpointId, files: files.map(({ path, oldPath, status, additions, deletions }) => ({ path, oldPath, status, additions, deletions })), totalFiles };
        }
        case "session.diff": return await this.diff(rpc, p.id as string, p.checkpointId as string, p.path as string, p.from as number);
        case "session.file": return await this.file(rpc, p.id as string, p.path as string);
        case "session.fileData": return await this.fileData(rpc, p.id as string, p.path as string, p.from as number);
        case "space.icon": return await this.spaceIcon(rpc, p.id as string);
        case "session.screens": return { screens: (await this.screens(rpc, p.id as string)).shown.sort(screenOrder) };
        case "session.screen": return await this.screen(rpc, p as MobileParams<"session.screen">);
        case "session.panes": return await this.panes(rpc, p.id as string);
        case "session.browserFrame": return await this.browserFrame(rpc, p as MobileParams<"session.browserFrame">);
        case "session.terminal": return await this.terminal(rpc, p as MobileParams<"session.terminal">);
        case "session.moveOptions": return await this.moveOptions(rpc, p.id as string);
        case "session.move": return await this.move(rpc, p as MobileParams<"session.move">);
        case "session.cancelMove": return await rpc.call("sessions.cancelMove", { id: p.id as string });
        case "session.delete": await rpc.call("sessions.delete", { id: p.id as string }); return { ok: true };
        case "session.fork": return await this.fork(rpc, p as MobileParams<"session.fork">);
        case "session.moveToSpace": {
          await rpc.call("sessions.moveToSpace", { id: p.id as string, spaceId: p.spaceId as string });
          return { session: await this.listedRow(rpc, p.id as string) };
        }
        case "session.switchAgent": {
          const agentKind = desktopNames(undefined, p.agent as string).agentKind!;
          await refusable(rpc.call("sessions.switchAgent", { sessionId: p.id as string, agentKind, model: (p.model as string | null | undefined) ?? null }));
          return { session: await this.listedRow(rpc, p.id as string) };
        }
        case "session.accounts": return await this.accounts(rpc, p.id as string);
        case "session.setAccount": return await this.setAccount(rpc, p.id as string, p.accountId as string);
        case "session.saved": return await rpc.call("sessions.saved", { id: p.id as string });
        case "session.setSaved": return await rpc.call("sessions.setSaved", { id: p.id as string, seq: p.seq as number, saved: p.saved as boolean });
        case "saved.list": return await this.savedTurns(rpc, p.profileId as string);
        case "documents.list": return await this.documentsList(rpc, p as MobileParams<"documents.list">);
        case "documents.search": return await this.documentsSearch(rpc, p.spaceId as string, p.query as string);
        case "documents.file": {
          const abs = await this.spaceFile(rpc, p.spaceId as string, p.path as string);
          return await this.preview(abs);
        }
        case "documents.fileData": {
          const abs = await this.spaceFile(rpc, p.spaceId as string, p.path as string);
          return await this.read(() => fileData(abs, p.from as number));
        }
        case "library.files": return await this.libraryFiles(rpc, p as MobileParams<"library.files">);
        case "library.file": {
          await this.inLibrary(rpc, p.path as string);
          return { ...await this.preview(p.path as string), name: givenAttachmentName(p.path as string, tempAttachmentDir(this.o.realmHome)) };
        }
        case "library.fileData": {
          await this.inLibrary(rpc, p.path as string);
          return { ...await this.read(() => fileData(p.path as string, p.from as number)), name: givenAttachmentName(p.path as string, tempAttachmentDir(this.o.realmHome)) };
        }
        case "debug.report": {
          if (!this.o.dev) throw new MobileError("FORBIDDEN", "debug.report is for development builds");
          mkdirSync(this.o.reportsDir, { recursive: true });
          writeFileSync(join(this.o.reportsDir, `${p.name as string}-${ctx.phoneId}-${Date.now()}.json`), JSON.stringify(p.data, null, 1));
          return { ok: true };
        }
      }
    } catch (e) {
      if (e instanceof MobileError) throw e;
      if (e instanceof ChoiceRefused || e instanceof UploadRefused) throw new MobileError("INVALID_PARAMS", e.message);
      if (e instanceof RpcCallError) {
        // A turn's trees gone from the repository, or a checkout that is no longer one, are things that
        // are not there any more, as far as a phone can do anything about them. A review already decided,
        // or a task whose last run is still going, refuses what was asked, and the Mac's words say why.
        const code: MobileErrorCode = e.code === "NOT_FOUND" || e.code === "SESSION_NOT_LIVE" || e.code === "INVALID_PARAMS" ? e.code
          : e.code === "TREE_GONE" || e.code === "NOT_A_REPOSITORY" ? "NOT_FOUND"
          : e.code === "TEAM_REVIEW_STATE" || e.code === "SCHEDULE_BUSY" || e.code === "TEAMMATE_ARCHIVED" ? "FORBIDDEN"
          : e.code === "TEAM_REVIEW_INVALID" || e.code === "TEAMMATE_HANDLE_TAKEN" || e.code === "TEAMMATE_WRONG_SPACE" ? "INVALID_PARAMS" : "INTERNAL";
        throw new MobileError(code, e.message);
      }
      throw new MobileError("INTERNAL", (e as Error).message);
    }
  }

  private async lists(rpc: RpcPort): Promise<Lists> {
    const [spaces, sessions, items, quickChat] = await Promise.all([
      rpc.call("spaces.list", {}),
      rpc.call("sessions.listAll", { profileId: null }),
      rpc.call("items.listAll", {}),
      rpc.call("settings.get", { key: QUICK_CHAT_SETTING }),
    ]);
    return { spaces, sessions, items, quickChatId: quickChatIdOf(quickChat.value) };
  }

  /** What the agents' probes last said, for the names of their models — when it answers at once. */
  private async probes(rpc: RpcPort): Promise<Probe> {
    return await within(rpc.call("agents.probe", { force: false }), PROBE_WAIT_MS) ?? [];
  }

  /** One agent's probe: the Mac's last when it has one, else a probe of that agent alone, waited on
   *  briefly — `agents.probe` made fresh waits on every agent, and an ACP agent's can take half a minute. */
  private async probeOf(rpc: RpcPort, kind: AgentKind): Promise<ProbeRow | null> {
    return (await this.probes(rpc)).find((p) => p.kind === kind) ?? await within(rpc.call("agents.probeOne", { kind }), AGENT_PROBE_WAIT_MS);
  }

  /** What the session's newest handshake said that its options read. */
  private async initOf(rpc: RpcPort, id: string): Promise<InitFacts | null> {
    const ev = (await this.eventsOf(rpc, id, "init")).at(-1)?.event;
    if (ev?.type !== "init") return null;
    const { model, efforts, defaultEffort, availableModes } = ev.payload;
    return { model, efforts, defaultEffort, availableModes };
  }

  private async shared(rpc: RpcPort): Promise<Shared> {
    const [efforts, catalog, midTurn, permission] = await Promise.all([
      rpc.call("settings.get", { key: MODEL_EFFORTS_KEY }), rpc.call("settings.get", { key: MODEL_CATALOG_KEY }),
      rpc.call("settings.get", { key: MID_TURN_MODE_KEY }), rpc.call("settings.get", { key: DEFAULT_PERMISSION_MODE_KEY }),
    ]);
    return { remembered: readEffortSupport(efforts.value), catalog: catalogOf(catalog.value), midTurn: resolveMidTurnMode(midTurn.value), defaultPermission: permission.value };
  }

  /** `item` is the session's sidebar row, for its title and pin; `need` is the ids Needs you lists, so a
   *  row says it is in that list exactly when it is. `ran` is the model the session's handshake
   *  reported, where it has been read. */
  private row(s: Session, item: Pick<Item, "title" | "pinned"> | undefined, space: Space | undefined, need: ReadonlySet<string>, atWork: ReadonlySet<string>, probe: Probe, goal?: Goal | null, ran: string | null = null): SessionRow {
    const meta = AGENT_META[s.agentKind as AgentKind] as { label: string; icon: string } | undefined;
    return {
      id: s.id, title: item?.title || s.title, spaceId: s.spaceId, spaceName: space?.name ?? "", agent: s.agentKind, model: s.model,
      status: mobileStatus(s.status), needsYou: need.has(s.id), unread: isUnread(s) && !atWork.has(s.id), updatedAt: s.updatedAt,
      agentName: meta?.label ?? s.agentKind, agentMark: meta?.icon ?? "bot",
      modelLabel: meta ? sessionModelLabel(s.agentKind, s.model, probe, ran) : s.model ?? "",
      createdAt: s.createdAt, effort: s.effort, permissionMode: s.permissionMode, activityAt: s.activityAt, pinned: item?.pinned ?? false,
      ...(isChild(s) && s.dispatchedBy?.sessionId ? { leadId: s.dispatchedBy.sessionId } : {}),
      ...(s.status === "moving" ? { moving: true } : {}),
      ...(goal ? { goal: { status: goal.status, objective: goal.objective } } : {}),
    };
  }

  /** What Home and a space's page list, read once: Needs you, by the sidebar's own rule (`@realm/view`)
   *  run on the lists the sidebar is seeded from, and the sessions a row lists — every session item that
   *  is not archived — newest first, each made into its row. */
  private async listing(rpc: RpcPort) {
    const [lists, probe, { goals }] = await Promise.all([this.lists(rpc), this.probes(rpc), rpc.call("goals.list", {})]);
    const goalOf = new Map(goals.map((g) => [g.sessionId, g]));
    const spaceById = new Map(lists.spaces.map((s) => [s.id, s]));
    const rows = new Map<string, Item>();
    for (const it of lists.items) if (it.kind === "session") rows.set(it.refId, it);
    const input = needsYouInput(lists);
    const waiting = needsYou(input);
    const need = new Set(waiting.map((r) => r.session.id));
    const atWork = agentsAtWork(input);
    // The sidebar's rows (`listedSessions`): a sub-agent is its lead's business, so it is not a row of
    // its own — a waiting one is still in Needs you.
    const nested = nestChildren(lists.sessions.filter((s) => rows.has(s.id)).map((s) => ({ id: s.id, spaceId: s.spaceId, session: s, createdAt: s.createdAt })));
    const listed = nested.map((n) => n.row.session).sort(newestFirst);
    const agentsOf = new Map(nested.filter((n) => n.agents.length > 0).map((n) => [n.row.id, n.agents.map((a) => a.session)]));
    const row = (s: Session, title?: string, spaceId = s.spaceId) => {
      const item = rows.get(s.id);
      const own = this.row(s, title === undefined ? item : { title, pinned: item?.pinned ?? false }, spaceById.get(spaceId), need, atWork, probe, goalOf.get(s.id));
      const agents = agentsOf.get(s.id);
      return agents ? { ...own, ...subagentsOn(agents) } : own;
    };
    return { spaces: lists.spaces, spaceById, waiting, listed, row, sessions: lists.sessions, items: lists.items };
  }

  /** Every space's newest few and Needs you, across every profile; `recent` in the profile asked for.
   *  A profile the Mac no longer has gathers `recent` from every profile, and says so (`profileId: null`). */
  async home(rpc: RpcPort, profileId: string | null): Promise<Home> {
    const [{ spaces, spaceById, waiting, listed, row }, profiles] = await Promise.all([this.listing(rpc), rpc.call("profiles.list", {})]);
    const profileOf = (spaceId: string) => spaceById.get(spaceId)?.profileId;
    const scope = profiles.some((pr) => pr.id === profileId) ? profileId : null;
    return {
      mac: { name: this.o.macName() },
      needsYou: waiting.map((r) => row(r.session, r.title, r.spaceId)),
      spaces: spaces.map((sp) => {
        const mine = listed.filter((s) => s.spaceId === sp.id);
        return {
          id: sp.id, name: sp.name, icon: sp.icon, color: sp.color, ...iconOf(sp.icon), profileId: sp.profileId,
          sessions: mine.slice(0, HOME_PER_SPACE).map((s) => row(s)), more: Math.max(0, mine.length - HOME_PER_SPACE),
        };
      }),
      profiles: profiles.map((pr) => ({
        id: pr.id, name: pr.name, icon: pr.icon, color: pr.color, ...iconOf(pr.icon),
        needsYou: waiting.filter((r) => profileOf(r.spaceId) === pr.id).length,
      })),
      profileId: scope,
      recent: listed.filter((s) => scope === null || profileOf(s.spaceId) === scope).slice(0, RECENT_LIMIT).map((s) => row(s)),
    };
  }

  /** The desktop's search (`search.query`) as the palette lists its sessions: the ones whose title
   *  matched, then the ones where something said matched, each once, with its best message. In the
   *  profile asked for, or profile by profile in the desktop's order where none is, or none the Mac has. */
  private async search(rpc: RpcPort, query: string, profileId: string | null): Promise<MobileResult<"search.query">> {
    const [{ row, sessions, items }, profiles] = await Promise.all([this.listing(rpc), rpc.call("profiles.list", {})]);
    const scope = profiles.some((pr) => pr.id === profileId) ? [profileId!] : profiles.map((pr) => pr.id);
    const found = await Promise.all(scope.map((id) => rpc.call("search.query", { profileId: id, query, limit: SEARCH_GROUP_LIMIT_MAX })));
    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const sessionOfItem = new Map(items.filter((it) => it.kind === "session").map((it) => [it.id, it.refId]));
    const hits = new Map<string, Omit<SearchHit, "session">>();
    for (const results of found) {
      for (const hit of results.items) {
        const id = hit.itemKind === "session" ? sessionOfItem.get(hit.itemId) : undefined;
        if (id && !hits.has(id)) hits.set(id, { title: hit.snippet, message: null });
      }
    }
    for (const results of found) {
      for (const hit of results.sessions) {
        const known = hits.get(hit.sessionId);
        if (known) known.message ??= { seq: hit.seq, snippet: hit.snippet };
        else hits.set(hit.sessionId, { title: null, message: { seq: hit.seq, snippet: hit.snippet } });
      }
    }
    const out: SearchHit[] = [];
    for (const [id, hit] of hits) {
      const session = sessionById.get(id);
      if (session) out.push({ session: row(session), ...hit });
    }
    return { hits: out };
  }

  /** One page of a space's listed sessions, by Home's rule and in Home's order. */
  private async spaceSessions(rpc: RpcPort, id: string, offset: number, limit: number): Promise<MobileResult<"space.sessions">> {
    const { spaceById, listed, row } = await this.listing(rpc);
    if (!spaceById.has(id)) throw new MobileError("NOT_FOUND", "No such space.");
    const mine = listed.filter((s) => s.spaceId === id);
    return { sessions: mine.slice(offset, offset + limit).map((s) => row(s)), more: mine.length > offset + limit };
  }

  /** Everything a session's options are read from: the session, its agent's probe, its own handshake,
   *  and the settings that bear on them. */
  private async optionsContext(rpc: RpcPort, id: string): Promise<{ session: Session; input: OptionsInput; shared: Shared }> {
    const session = await rpc.call("sessions.get", { id });
    const [probe, init, shared] = await Promise.all([this.probeOf(rpc, session.agentKind), this.initOf(rpc, id), this.shared(rpc)]);
    return { session, input: optionsInput(probe, init, shared), shared };
  }

  private sessionOptions(session: Session, input: OptionsInput, shared: Shared): SessionOptions {
    return {
      agent: agentOptions(session.agentKind, input, session.model),
      model: session.model, modelLabel: sessionModelLabel(session.agentKind, session.model, probeList(input), input.init?.model ?? null),
      effort: session.effort, permissionMode: session.permissionMode, midTurn: shared.midTurn, attachments: { ...SEND_LIMITS },
    };
  }

  /** Each choice checked against the session's options, then only what changed set, the desktop's way
   *  (`sessions.setOptions`); answered with the options as they are now. */
  private async configure(rpc: RpcPort, p: MobileParams<"session.configure">): Promise<SessionOptions> {
    const { session, input, shared } = await this.optionsContext(rpc, p.id);
    const changes = changesFor(session.agentKind, session, p, input, resolveDefaultPermissionMode(session.agentKind, shared.defaultPermission));
    const now = Object.keys(changes).length > 0 ? await rpc.call("sessions.setOptions", { id: p.id, ...changes }) : session;
    return this.sessionOptions(now, input, shared);
  }

  /** Every agent a new session can be given, as the desktop's new session offers them, and the one its
   *  "+" would reach for. */
  private async agents(rpc: RpcPort): Promise<MobileResult<"agents.list">> {
    const [probe, shared, last, models] = await Promise.all([
      this.probes(rpc), this.shared(rpc), rpc.call("settings.get", { key: LAST_AGENT_SETTING }), rpc.call("settings.get", { key: LAST_MODELS_SETTING }),
    ]);
    const kinds: readonly AgentKind[] = SELECTABLE_AGENT_KINDS;
    const agents = kinds.map((kind) => agentOptions(kind, optionsInput(probe.find((r) => r.kind === kind) ?? null, null, shared)));
    const defaultAgent = kinds.find((k) => k === last.value) ?? FALLBACK_AGENT;
    // As the desktop's New teammate sheet starts: on the model last sent on, in the permission new
    // sessions start in where that is one of the sheet's three rungs.
    const held = typeof models.value === "object" && models.value !== null ? models.value : {};
    const lastModels = Object.fromEntries(Object.entries(held)
      .filter((e): e is [string, string | null] => typeof e[1] === "string" || e[1] === null));
    const rung = PERMISSION_MODES.find((m) => m.id === shared.defaultPermission);
    return { agents, defaultAgent, midTurn: shared.midTurn, attachments: { ...SEND_LIMITS }, lastModels, teammatePermission: rung?.id ?? "default" };
  }

  /** A new session in a space, on what the phone chose, sent its first message. The choices are
   *  checked and the files written before the session is made, so nothing refused or unwritten leaves
   *  an empty session behind. */
  private async create(rpc: RpcPort, p: MobileParams<"session.create">): Promise<{ id: string }> {
    const agent = AgentKindSchema.safeParse(p.agent);
    if (!agent.success) throw new MobileError("INVALID_PARAMS", `unknown agent ${String(p.agent)}`);
    const kind = agent.data;
    const [probe, shared] = await Promise.all([this.probeOf(rpc, kind), this.shared(rpc)]);
    const input = optionsInput(probe, null, shared);
    const resting = resolveDefaultPermissionMode(kind, shared.defaultPermission);
    const chosen = changesFor(kind, { model: null, effort: null, permissionMode: resting }, p, input, resting);
    const files = await this.uploads(p.text, p.attachments);
    const { session } = await rpc.call("sessions.create", {
      spaceId: p.spaceId, agentKind: kind, model: chosen.model ?? null, effort: chosen.effort ?? null, permissionMode: chosen.permissionMode ?? null,
    });
    await rpc.call("sessions.send", { id: session.id, text: p.text, attachments: files });
    return { id: session.id };
  }

  /**
   * What a message's words name, as the desktop's prompter sends it: the skills its `@id`s name, scanned
   * against the ones the session's agent can be handed, and the refs whose `@[label]` is still in the
   * words. A file must be in the session's folder, and not one that holds a secret.
   */
  private async named(rpc: RpcPort, id: string, text: string, refs: readonly MentionRef[] | undefined): Promise<{ mentions?: string[]; mentionRefs?: MentionRef[] }> {
    if (!text.includes("@")) return {};
    const session = await rpc.call("sessions.get", { id });
    const root = `${session.cwd.replace(/\/+$/, "")}/`;
    for (const ref of refs ?? []) {
      if (ref.kind === "file" && (!ref.path.startsWith(root) || ref.path.split("/").includes("..") || isSecretPath(ref.path))) {
        throw new MobileError("INVALID_PARAMS", `${ref.label} is not a file in this session's folder.`);
      }
    }
    const mentions = mentionIds(text, (await this.mentionable(rpc, session)).map((k) => k.id));
    const live = keepLiveRefs(text, refs ?? []) as MentionRef[];
    return { ...(mentions.length > 0 ? { mentions } : {}), ...(live.length > 0 ? { mentionRefs: live } : {}) };
  }

  /** The skills an `@` can hand this session's agent, as the desktop's prompter offers them: the space's
   *  enabled ones where the agent is given Realm's skills, and the `mac` skill wherever the space has it. */
  private async mentionable(rpc: RpcPort, session: Session): Promise<Skill[]> {
    const { skills } = await rpc.call("skills.list", { spaceId: session.spaceId });
    const usable = skills.filter((k) => k.valid);
    const given = AGENT_SKILL_SUPPORT[session.agentKind] === "injected" ? usable.filter((k) => k.enabled) : [];
    const mac = usable.find((k) => k.id === MAC_SKILL_ID);
    return mac && !given.includes(mac) ? [...given, mac] : given;
  }

  private async composer(rpc: RpcPort, id: string): Promise<MobileResult<"session.composer">> {
    const session = await rpc.call("sessions.get", { id });
    const [{ commands }, skills] = await Promise.all([rpc.call("commands.list", { spaceId: session.spaceId }), this.mentionable(rpc, session)]);
    return {
      commands: runnableCommands(commands).map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
      skills: skills.map((k) => ({ id: k.id, name: k.name, description: k.description })),
    };
  }

  private async mentionFiles(rpc: RpcPort, id: string, query: string): Promise<MobileResult<"session.mentionFiles">> {
    const session = await rpc.call("sessions.get", { id });
    const root = session.cwd.replace(/\/+$/, "");
    const { hits } = await rpc.call("mentions.files", { sessionId: id, query });
    return { files: hits.filter((h) => !isSecretPath(h.path)).map((h) => ({ path: `${root}/${h.path}`, rel: h.path })) };
  }

  /** A message's files, checked whole and written where a desktop paste goes; a message must carry
   *  words, a file or a tab. */
  private async uploads(text: string, uploads: readonly Upload[], tabs = 0): Promise<{ path: string; mime: string }[]> {
    if (text.length === 0 && uploads.length === 0 && tabs === 0) throw new MobileError("INVALID_PARAMS", "A message needs words, a file or a tab.");
    return await saveUploads(this.o.realmHome, checkUploads(uploads));
  }

  /** Subscribes first and buffers, then reads history, then replays what arrived meanwhile — so no event
   *  can fall between the history read and the live stream. The queue is read the same way: once, then
   *  replaced by any broadcast of it that came after. */
  /** How far a `session.seen` marks the session read. The phone names the seq of the newest row it has
   *  seen; the Mac counts unread against its last EVENT, and a turn ends on events that draw no row (its
   *  end, its usage). So where the phone has the session open and has seen its newest row, it has read
   *  everything this channel has applied, and the mark goes that far; else as far as the phone said. */
  private seenUpTo(ctx: ChannelContext, id: string, seq: number): number {
    const open = ctx.sessions.get(id);
    if (!open || open.buffer !== null) return seq;
    const newest = open.projector.all().reduce((max, row) => Math.max(max, row.seq), 0);
    return newest > 0 && seq >= newest ? Math.max(seq, open.projector.seq) : seq;
  }

  private async open(ctx: ChannelContext, id: string, limit: number, from?: number): Promise<MobileResult<"session.open">> {
    // Opened again, it keeps the sub-agents the phone has read of it: their changes are still its list's.
    const entry: OpenSession = {
      projector: new SessionProjector({ attachmentsDir: tempAttachmentDir(this.o.realmHome), home: this.o.userHome ?? homedir() }), buffer: [], queued: null, move: null,
      subagents: ctx.sessions.get(id)?.subagents ?? new Set(),
    };
    ctx.sessions.set(id, entry);
    const rpc = ctx.rpc;
    try {
      const session = await rpc.call("sessions.get", { id });
      // A Team that cannot be read leaves a message to a teammate named by its handle alone.
      entry.projector.knowTeam(await rpc.call("teammates.list", { spaceId: session.spaceId, archived: false }).catch(() => []));
      const read = await rpc.call("sessions.queued", { id });
      // What a broadcast carried before the read is in it; one from here on is newer than it.
      entry.queued = null;
      let after = 0;
      let total = 0;
      let ran: string | null = null;
      for (;;) {
        const page = await rpc.call("sessions.events", { id, afterSeq: after, limit: HISTORY_PAGE });
        for (const ev of page) {
          entry.projector.apply(ev);
          if (ev.event.type === "init") ran = ev.event.payload.model;
        }
        total += page.length;
        if (page.length < HISTORY_PAGE || total >= HISTORY_LIMIT) break;
        after = page.at(-1)!.seq;
      }
      // The reply streaming now is in no stored event yet; read after the log, so it covers it.
      const [lists, probe, streaming, { goal }] = await Promise.all([
        this.lists(rpc), this.probes(rpc), rpc.call("sessions.streaming", { id }), rpc.call("goals.get", { sessionId: id }),
      ]);
      // From here to the answer nothing is awaited, so nothing can arrive between the two.
      for (const ev of withStreamed(id, entry.buffer ?? [], streaming)) entry.projector.apply(ev);
      const queued = entry.queued ?? read.queued;
      const move = entry.queued ? entry.move : read.move ?? null;
      entry.buffer = null;
      entry.queued = null;
      entry.move = null;
      const item = lists.items.find((it) => it.kind === "session" && it.refId === id);
      const input = needsYouInput(lists);
      const need = new Set(needsYou(input).map((r) => r.session.id));
      const all = entry.projector.all();
      const first = openingRow(all, limit, from);
      return {
        session: this.row(session, item, lists.spaces.find((s) => s.id === session.spaceId), need, agentsAtWork(input), probe, goal, ran),
        rows: all.slice(first), hasMore: first > 0, hint: entry.projector.hint, queued: this.queuedMessages(queued),
        move: pendingMove(move), goal: phoneGoal(goal), todos: entry.projector.todos,
      };
    } catch (e) {
      ctx.sessions.delete(id);
      throw e;
    }
  }

  /** The goal strip's controls, as the desktop's pane wires them, with the same words for why it stopped.
   *  A resume of a goal that is running or finished is refused in the Mac's words. */
  private async goalControl(rpc: RpcPort, id: string, action: MobileParams<"session.goalControl">["action"]): Promise<MobileResult<"session.goalControl">> {
    try {
      switch (action) {
        case "pause": return { goal: phoneGoal((await rpc.call("goals.set", { sessionId: id, status: "paused", note: "You paused it." })).goal) };
        case "done": return { goal: phoneGoal((await rpc.call("goals.set", { sessionId: id, status: "complete", note: "Marked done by you." })).goal) };
        case "resume": return { goal: phoneGoal((await rpc.call("goals.resume", { sessionId: id })).goal) };
        case "drop": await rpc.call("goals.clear", { sessionId: id }); return { goal: null };
      }
    } catch (e) {
      if (e instanceof RpcCallError && e.code === "INVALID_ARGUMENT") throw new MobileError("FORBIDDEN", e.message);
      throw e;
    }
  }

  /** The queue as a phone reads it: each file named as its user row will name it. */
  queuedMessages(queued: readonly QueuedPrompt[]): QueuedMessage[] {
    return queued.map((q) => queuedMessage(q, tempAttachmentDir(this.o.realmHome)));
  }

  private async queue(rpc: RpcPort, id: string): Promise<MobileResult<"session.queue">> {
    const { queued, move } = await rpc.call("sessions.queued", { id });
    return { queued: this.queuedMessages(queued), move: pendingMove(move) };
  }

  /** Renames, pins or archives the session's own sidebar row, as the desktop's sidebar does: the item,
   *  found in its space's list, archived rows included — so one put away can be taken back. */
  private async update(rpc: RpcPort, p: MobileParams<"session.update">): Promise<MobileResult<"session.update">> {
    const session = await rpc.call("sessions.get", { id: p.id });
    const item = (await rpc.call("items.list", { spaceId: session.spaceId })).find((it) => it.kind === "session" && it.refId === p.id);
    if (!item) throw new MobileError("NOT_FOUND", "That session has no row to rename, pin or archive.");
    const title = p.title?.trim();
    if (title === "") throw new MobileError("INVALID_PARAMS", "A session needs a name.");
    const changes = { ...(title !== undefined ? { title } : {}), ...(p.pinned !== undefined ? { pinned: p.pinned } : {}), ...(p.archived !== undefined ? { archived: p.archived } : {}) };
    const now = Object.keys(changes).length > 0 ? await rpc.call("items.update", { id: item.id, ...changes }) : item;
    // Archived, it leaves every list a phone draws, so there is no row to answer with.
    if (now.archived) return { session: null };
    const { listed, row } = await this.listing(rpc);
    return { session: row(listed.find((s) => s.id === p.id) ?? session) };
  }

  /** The Move sheet's choices: the desktop's own, with the checkout the session is in named as the
   *  others are, and every path as the Mac's home would shorten it. */
  private async moveOptions(rpc: RpcPort, id: string): Promise<MoveOptions> {
    const options = await rpc.call("sessions.moveOptions", { id });
    const home = this.o.userHome ?? homedir();
    const checkout = (c: { environmentId: string; path: string; branch: string | null; kind: string }) => ({
      environmentId: c.environmentId, path: tilde(c.path, home), branch: c.branch, kind: c.kind as MoveOptions["from"]["kind"],
    });
    return {
      mac: options.machineName ?? this.o.macName(),
      from: checkout({ ...options.from, path: options.from.cwd, kind: options.from.kind ?? "checkout" }),
      busy: options.busy, blocked: options.blocked, pending: options.pending, conversation: options.conversation,
      changedFiles: options.changedFiles, leftBehind: options.leftBehind, stops: options.stops ?? [],
      checkouts: options.environments.map(checkout),
      worktree: options.worktree,
    };
  }

  /** A move asked for from the phone, as the desktop's Move sheet asks for it, the source checkout left
   *  as it was. What the Mac refuses — a teammate's chat, a sub-agent still running, a checkout another
   *  session is working in, a move that could not be made — is FORBIDDEN, in its words. */
  private async move(rpc: RpcPort, p: MobileParams<"session.move">): Promise<MobileResult<"session.move">> {
    const to = p.to.kind === "checkout" ? { kind: "environment" as const, environmentId: p.to.environmentId } : { kind: "worktree" as const };
    try {
      await rpc.call("sessions.move", { id: p.id, to, keepSourceChanges: true, when: p.when });
    } catch (e) {
      if (e instanceof RpcCallError && MOVE_REFUSALS.has(e.code)) throw new MobileError("FORBIDDEN", e.message);
      throw e;
    }
    const { listed, row } = await this.listing(rpc);
    const moved = listed.find((s) => s.id === p.id) ?? await rpc.call("sessions.get", { id: p.id });
    return { session: row(moved) };
  }

  /** A session's row as Home lists it now, or as it stands where no list does. */
  private async listedRow(rpc: RpcPort, id: string): Promise<SessionRow> {
    const { listed, row } = await this.listing(rpc);
    return row(listed.find((s) => s.id === id) ?? await rpc.call("sessions.get", { id }));
  }

  /** A fork of the session as it is now: a checkpoint taken for it this moment, then the desktop's own
   *  Fork… from that checkpoint, onto `agent` where it names another. */
  private async fork(rpc: RpcPort, p: MobileParams<"session.fork">): Promise<MobileResult<"session.fork">> {
    const s = await rpc.call("sessions.get", { id: p.id });
    const agentKind = p.agent === undefined ? undefined : desktopNames(undefined, p.agent).agentKind;
    const checkpoint = await refusable(rpc.call("checkpoints.capture", { environmentId: s.environmentId, sessionId: s.id, label: "Fork" }));
    const { session } = await refusable(rpc.call("sessions.fork", { checkpointId: checkpoint.id, ...(agentKind && agentKind !== s.agentKind ? { agentKind } : {}) }));
    return { session: await this.listedRow(rpc, session.id) };
  }

  /** The accounts of the session's agent, as its picker's Account list names them, and the one in force:
   *  the session's own, or its CLI's where it names none. */
  private async accounts(rpc: RpcPort, id: string): Promise<MobileResult<"session.accounts">> {
    const s = await rpc.call("sessions.get", { id });
    if (!hasAccounts(s.agentKind)) return { accounts: [], current: null };
    const { accounts } = await rpc.call("accounts.list", {});
    const mine = accounts.filter((a) => a.kind === s.agentKind);
    return {
      accounts: mine.map((a) => ({ id: a.id, label: a.label, email: a.email, cliDefault: a.configDir === null, signedIn: a.signedIn })),
      current: s.accountId ?? defaultAccountId(s.agentKind),
    };
  }

  /** The desktop's pick of an account: the CLI's own goes as null, as its picker sends it. */
  private async setAccount(rpc: RpcPort, id: string, accountId: string): Promise<MobileResult<"session.setAccount">> {
    const s = await rpc.call("sessions.get", { id });
    const own = hasAccounts(s.agentKind) && accountId === defaultAccountId(s.agentKind);
    await refusable(rpc.call("sessions.setAccount", { id, accountId: own ? null : accountId }));
    return { session: await this.listedRow(rpc, id) };
  }

  /** Library ▸ Saved for one profile, each turn with its space's name. */
  private async savedTurns(rpc: RpcPort, profileId: string): Promise<MobileResult<"saved.list">> {
    const [{ entries, total }, spaces] = await Promise.all([rpc.call("library.saved", { profileId }), rpc.call("spaces.list", {})]);
    const spaceName = spaceNames(spaces);
    return {
      entries: entries.map((e) => ({
        sessionId: e.sessionId, seq: e.seq, savedAt: e.savedAt, at: e.ts, text: e.text, attachments: e.attachments,
        reply: e.reply, sessionTitle: e.sessionTitle, spaceId: e.spaceId, spaceName: spaceName(e.spaceId),
      })),
      total,
    };
  }

  /** One page of a level of a space's folder: the desktop's listing, without what a phone is not shown. */
  private async documentsList(rpc: RpcPort, p: MobileParams<"documents.list">): Promise<MobileResult<"documents.list">> {
    const { root } = await rpc.call("documents.spaceRoot", { spaceId: p.spaceId });
    await this.read(() => checkSpacePath(root, p.dir));
    const { entries } = await rpc.call("documents.listInSpace", { spaceId: p.spaceId, dir: p.dir });
    const listed = entries.filter((e) => !isSecretPath(e.path));
    const end = p.offset + p.limit;
    const page = await Promise.all(listed.slice(p.offset, end).map((e) => documentRow(root, e.path, e.isDir)));
    return { folder: basename(root), entries: page.filter((r) => r !== null), total: listed.length, next: end < listed.length ? end : null };
  }

  /** The files of a space's folder the desktop's search finds, without what a phone is not shown, and
   *  the one the words name exactly where that one holds a secret. */
  private async documentsSearch(rpc: RpcPort, spaceId: string, query: string): Promise<MobileResult<"documents.search">> {
    const { root } = await rpc.call("documents.spaceRoot", { spaceId });
    const { hits } = await rpc.call("project.files", { cwd: root, query, limit: DOCUMENTS_SEARCH_LIMIT });
    const paths = hits.map((h) => h.path);
    const shown = await Promise.all(paths.map((path) => documentRow(root, path, false)));
    return { entries: shown.filter((r) => r !== null), withheld: await withheldFile(root, query, paths) };
  }

  /** The full path of a file in a space's folder, or a refusal. */
  private async spaceFile(rpc: RpcPort, spaceId: string, path: string): Promise<string> {
    const { root } = await rpc.call("documents.spaceRoot", { spaceId });
    return await this.read(() => checkSpacePath(root, path));
  }

  /** One page of the Library, one row to a file. A page may come back short of what it holds where a file
   *  in it holds a secret, so `next` is what says there is more. */
  private async libraryFiles(rpc: RpcPort, p: MobileParams<"library.files">): Promise<MobileResult<"library.files">> {
    const { entries } = await rpc.call("library.artifacts", {
      perFile: true, limit: p.limit, query: p.query, profileId: p.profileId ?? null, spaceId: p.spaceId ?? null, kind: p.origin ?? null, before: p.before ?? null,
    });
    const last = entries.at(-1);
    return {
      entries: entries.filter((e) => !isSecretPath(e.path)).map((e) => ({
        id: e.id, path: e.path, name: givenAttachmentName(e.path, tempAttachmentDir(this.o.realmHome)), origin: e.kind, at: e.ts,
        sessionId: e.sessionId, sessionTitle: e.sessionTitle, spaceId: e.spaceId, kind: documentKindFor(e.path), mime: mimeForPath(e.path),
      })),
      next: last && entries.length === p.limit ? { ts: last.ts, id: last.id } : null,
    };
  }

  /** Refuses a path the Library does not list, or one that holds a secret. */
  private async inLibrary(rpc: RpcPort, path: string): Promise<void> {
    if (isSecretPath(path)) throw new MobileError("FORBIDDEN", SECRET_REFUSAL);
    let before: { ts: number; id: string } | null = null;
    for (;;) {
      const { entries }: { entries: { path: string; ts: number; id: string }[] } = await rpc.call("library.artifacts", {
        perFile: true, limit: LIBRARY_QUERY_MAX, query: basename(path), profileId: null, spaceId: null, kind: null, before,
      });
      if (entries.some((e) => e.path === path)) return;
      const last = entries.at(-1);
      if (!last || entries.length < LIBRARY_QUERY_MAX) throw new MobileError("FORBIDDEN", "That file is not in the Library.");
      before = { ts: last.ts, id: last.id };
    }
  }

  /** New words for a queued message, which keeps its files and its place, and lets go of its hold. */
  private async editQueued(rpc: RpcPort, p: MobileParams<"session.editQueued">): Promise<{ ok: true }> {
    if (p.text.length === 0) {
      const waiting = (await rpc.call("sessions.queued", { id: p.id })).queued.find((q) => q.id === p.queuedId);
      if (waiting && waiting.attachments.length === 0) throw new MobileError("INVALID_PARAMS", "A message needs words or a file.");
    }
    const { edited } = await rpc.call("sessions.editQueued", { id: p.id, queuedId: p.queuedId, text: p.text });
    // Gone already: the phone keeps the words in its draft rather than losing them.
    if (!edited) throw new MobileError("NOT_FOUND", GONE);
    return { ok: true };
  }

  /** The session's sub-agents, newest first, each as its Agents tab says it — and, while the phone has
   *  the lead open, the ones whose changes are a change to this list. */
  private async subagents(ctx: ChannelContext, id: string): Promise<MobileResult<"session.subagents">> {
    const rpc = ctx.rpc;
    const [, { children }, { running }, { row }] = await Promise.all([
      rpc.call("sessions.get", { id }), rpc.call("delegation.children", { sessionId: id }), rpc.call("delegation.running", { sessionId: id }), this.listing(rpc),
    ]);
    const open = ctx.sessions.get(id);
    if (open) open.subagents = new Set(children.map((c) => c.session.id));
    const inFlight = new Set(running.map((r) => r.sessionId));
    const subagents = children.map((c) => subagentOf(c, row(c.session), inFlight.has(c.session.id)));
    return { subagents: subagents.sort((a, b) => b.startedAt - a.startedAt || (a.session.id < b.session.id ? 1 : a.session.id > b.session.id ? -1 : 0)) };
  }

  /** Every space's teammates, space by space in the sidebar's order, each space's in its Team list's. */
  private async teammates(rpc: RpcPort, archived: boolean): Promise<MobileResult<"teammates.list">> {
    const spaces = await rpc.call("spaces.list", {});
    const each = await Promise.all(spaces.map((sp) => rpc.call("teammates.list", { spaceId: sp.id, archived })));
    return { teammates: each.flat().map(phoneTeammate) };
  }

  /** Where a session runs, what its turns have cost as Settings ▸ Usage counts it, and the files it made
   *  or was sent, newest first, the newest mention of each — leaving out any `session.file` refuses. */
  private async info(rpc: RpcPort, id: string): Promise<MobileResult<"session.info">> {
    const s = await rpc.call("sessions.get", { id });
    const [env, summary, made, sent] = await Promise.all([
      rpc.call("environments.get", { id: s.environmentId }), rpc.call("usage.summary", { from: s.createdAt, to: Date.now(), spaceId: s.spaceId }),
      this.eventsOf(rpc, id, "files_made"), this.eventsOf(rpc, id, "user_message"),
    ]);
    const totals = summary.sessions.find((r) => r.id === id)?.totals;
    const inputTokens = totals ? totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens : 0;
    const measured = totals !== undefined && totals.unmeasuredSessions === 0 && (totals.costUsd > 0 || inputTokens + totals.outputTokens > 0);
    const files: NonNullable<MobileResult<"session.info">["files"]> = [];
    for (const ev of made) {
      if (ev.event.type === "files_made") for (const f of ev.event.payload.files) files.push({ path: f.path, name: basename(f.path), size: f.size, sent: false, at: ev.event.ts });
    }
    for (const ev of sent) {
      if (ev.event.type !== "user_message") continue;
      for (const a of ev.event.payload.attachments) files.push({ path: a.path, name: givenAttachmentName(a.path, tempAttachmentDir(this.o.realmHome)), size: null, sent: true, at: ev.event.ts });
    }
    const newest = new Map<string, (typeof files)[number]>();
    for (const f of files.sort((a, b) => b.at - a.at)) {
      if (!isSecretPath(f.path) && !newest.has(f.path)) newest.set(f.path, f);
    }
    return {
      runsOn: { machine: this.o.macName(), checkout: env.kind, folder: tildify(env.path, homedir()), branch: env.branch },
      ...(measured ? { usage: { costUsd: totals.costUsd, estimated: totals.estimatedUsd > 0, inputTokens, outputTokens: totals.outputTokens, turns: totals.turns } } : {}),
      files: [...newest.values()],
    };
  }

  /** The Edit sheet's save, answered with the teammate as the Team list now names it. */
  private async updateTeammate(rpc: RpcPort, p: MobileParams<"teammate.update">): Promise<MobileResult<"teammate.update">> {
    const { icon, agentKind, ...rest } = p;
    const edit = { ...rest, ...desktopNames(icon, agentKind) };
    return { teammate: phoneTeammate(await rpc.call("teammates.update", edit)) };
  }

  /** The New teammate sheet's Create: the Mac makes the handle from the name when the phone sent none,
   *  and makes the teammate's chat with it. */
  private async createTeammate(rpc: RpcPort, p: MobileParams<"teammate.create">): Promise<MobileResult<"teammate.create">> {
    const { icon, agentKind, ...rest } = p;
    const { agentKind: kind, ...named } = desktopNames(icon, agentKind);
    return { teammate: phoneTeammate(await rpc.call("teammates.create", { ...rest, ...named, agentKind: kind! })) };
  }

  /** Every agent's plan as Settings ▸ Usage draws it, and this calendar month's spend on the Mac's clock,
   *  its heaviest sessions by the names their rows have. */
  private async usage(rpc: RpcPort): Promise<MobileResult<"usage.get">> {
    const now = Date.now();
    const [{ limits }, summary, items] = await Promise.all([
      rpc.call("limits.get", {}), rpc.call("usage.summary", { from: monthStart(now), to: now }), rpc.call("items.listAll", {}),
    ]);
    const titles = new Map(items.filter((it) => it.kind === "session").map((it) => [it.refId, it.title]));
    return { limits: everyPlan(limits, now), spend: spend(summary, titles) };
  }

  /** Every space's scheduled tasks, in the Scheduled page's order: what runs next first. */
  private async schedules(rpc: RpcPort): Promise<MobileResult<"schedules.list">> {
    const spaces = await rpc.call("spaces.list", {});
    const each = await Promise.all(spaces.map((sp) => rpc.call("schedules.list", { spaceId: sp.id })));
    return { tasks: await this.tasks(rpc, upcomingOrder(each.flat()), spaces) };
  }

  /** Each task with its last run: the run its last firing made, and whether that run's session is read. */
  private async tasks(rpc: RpcPort, schedules: readonly Schedule[], known?: readonly Space[]): Promise<ScheduledTask[]> {
    const [spaces, sessions, runs] = await Promise.all([
      known ?? rpc.call("spaces.list", {}), rpc.call("sessions.listAll", { profileId: null }),
      Promise.all(schedules.map(async (s) => (s.lastRunId ? (await rpc.call("runs.get", { id: s.lastRunId }))?.run ?? null : null))),
    ]);
    const name = spaceNames(spaces);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const now = Date.now();
    return schedules.map((s, i) => {
      const run = runs[i]!;
      return scheduledTask(s, name(s.spaceId), run, run?.sessionId ? byId.get(run.sessionId) : undefined, now);
    });
  }

  /** Every event of one kind the session has, oldest first. */
  private async eventsOf(rpc: RpcPort, id: string, type: "turn_changes" | "files_made" | "user_message" | "init"): Promise<StoredSessionEvent[]> {
    const out: StoredSessionEvent[] = [];
    for (let after = 0; ;) {
      const page = await rpc.call("sessions.events", { id, afterSeq: after, limit: HISTORY_PAGE, types: [type] });
      out.push(...page);
      if (page.length < HISTORY_PAGE) return out;
      after = page.at(-1)!.seq;
    }
  }

  /** The turn of this session that `checkpointId` fronted, as its `turn_changes` recorded it. Another
   *  session's checkpoint is no turn of this one. */
  private async turnChanges(rpc: RpcPort, id: string, checkpointId: string): Promise<TurnChanges> {
    for (const ev of await this.eventsOf(rpc, id, "turn_changes")) {
      if (ev.event.type === "turn_changes" && ev.event.payload.checkpointId === checkpointId) return ev.event.payload;
    }
    throw new MobileError("NOT_FOUND", "No turn of this session changed files from that checkpoint.");
  }

  /** One page of a file's diff across a turn: only a file that turn's changes list, between the two
   *  trees the turn recorded — the phone names neither a tree nor any other path. */
  private async diff(rpc: RpcPort, id: string, checkpointId: string, path: string, from: number): Promise<MobileResult<"session.diff">> {
    const changes = await this.turnChanges(rpc, id, checkpointId);
    const file = changes.files.find((f) => f.path === path);
    if (!file) throw new MobileError("FORBIDDEN", "That file is not one this turn changed.");
    const patch = await rpc.call("checkpoints.turnDiff", { id: checkpointId, afterTree: changes.afterTree, path: file.path, oldPath: file.oldPath });
    return diffPage(file, patch, from);
  }

  /** A preview of a file the session's turns made, one that was sent with a message to it, or one a
   *  message waiting in its queue carries — and of nothing else: the path must be one a `files_made` or
   *  a `user_message` of this session listed, or the queue holds, exactly as it was listed. */
  private async file(rpc: RpcPort, id: string, path: string): Promise<MobileResult<"session.file">> {
    await this.mayRead(rpc, id, path);
    // Named as its user row names it: a file a phone or a paste sent, without the prefix it was written under.
    return { ...await this.preview(path), name: givenAttachmentName(path, tempAttachmentDir(this.o.realmHome)) };
  }

  /** A piece of one of the files `session.file` previews, and of no other. */
  private async fileData(rpc: RpcPort, id: string, path: string, from: number): Promise<MobileResult<"session.fileData">> {
    await this.mayRead(rpc, id, path);
    return { ...await this.read(() => fileData(path, from)), name: givenAttachmentName(path, tempAttachmentDir(this.o.realmHome)) };
  }

  /** Refuses a path no `files_made` or `user_message` of the session listed, nor its queue holds. */
  private async mayRead(rpc: RpcPort, id: string, path: string): Promise<void> {
    const [made, sent, { queued }] = await Promise.all([
      this.eventsOf(rpc, id, "files_made"), this.eventsOf(rpc, id, "user_message"), rpc.call("sessions.queued", { id }),
    ]);
    const listed = new Set<string>();
    for (const ev of made) if (ev.event.type === "files_made") for (const f of ev.event.payload.files) listed.add(f.path);
    for (const ev of sent) if (ev.event.type === "user_message") for (const a of ev.event.payload.attachments) listed.add(a.path);
    for (const q of queued) for (const a of q.attachments) listed.add(a.path);
    if (!listed.has(path)) throw new MobileError("FORBIDDEN", "That file is not one this session made or was sent.");
    // A message on the Mac can carry any file someone picked, a key among them; a phone is never sent one.
    if (isSecretPath(path)) throw new MobileError("FORBIDDEN", SECRET_REFUSAL);
  }

  /** `filePreview`, its refusals and a file gone since it was listed said as mobile.v1 says them;
   *  `check` runs first, and refuses by throwing `PreviewRefused`. */
  private async preview(path: string, check?: () => Promise<void>): Promise<MobileResult<"session.file">> {
    return this.read(async () => {
      await check?.();
      return await filePreview(path, { downscale: this.o.downscale });
    });
  }

  /** A read of a file a phone asked for, its refusals and a file gone since it was listed said as
   *  mobile.v1 says them. */
  private async read<T>(reading: () => Promise<T>): Promise<T> {
    try {
      return await reading();
    } catch (e) {
      if (e instanceof PreviewRefused) throw new MobileError("FORBIDDEN", e.message);
      if ((e as NodeJS.ErrnoException).code === "ENOTDIR") throw new MobileError("NOT_FOUND", "That file is no longer on this Mac.");
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new MobileError("NOT_FOUND", "That file is no longer on this Mac.");
      throw e;
    }
  }

  /** A space's own picture: the icon the person uploaded or had made for it, and only that. */
  private async spaceIcon(rpc: RpcPort, id: string): Promise<MobileResult<"space.icon">> {
    const space = (await rpc.call("spaces.list", {})).find((s) => s.id === id);
    if (!space) throw new MobileError("NOT_FOUND", "No such space.");
    const ref = parseSpaceIcon(space.icon);
    if (ref.kind !== "asset") throw new MobileError("NOT_FOUND", "This space's icon is not a picture.");
    const asset = (await rpc.call("iconAssets.list", { profileId: space.profileId })).find((a) => a.id === ref.id);
    const picture = asset ? pictureOf(asset) : null;
    if (!picture) throw new MobileError("NOT_FOUND", "This space's picture is gone.");
    if (picture.data.length > ICON_MAX_BYTES) throw new MobileError("NOT_FOUND", "This space's picture is too large to send to a phone.");
    return { mime: picture.mime, data: picture.data.toString("base64") };
  }

  /** Every simulator and machine in the session's space, each named as its pane is: by its sidebar
   *  row's title, which a rename changes, else by its own name. `shown` is what a phone may watch;
   *  `held`, the Mac apps it may not (`phoneMayWatch`). */
  private async screens(rpc: RpcPort, id: string): Promise<{ shown: Screen[]; held: Screen[] }> {
    const { spaceId } = await rpc.call("sessions.get", { id });
    const [sims, machines, items] = await Promise.all([
      rpc.call("simulators.list", { spaceId }), rpc.call("machines.list", { spaceId }), rpc.call("items.list", { spaceId }),
    ]);
    const titles = new Map(items.filter((it) => it.kind === "simulator" || it.kind === "machine").map((it) => [it.refId, it.title]));
    const machine = (m: Machine): Screen => machineScreen(m, machines.states.find((st) => st.machineId === m.id), titles.get(m.id) || m.name);
    return {
      shown: [
        ...sims.simulators.map((s) => simulatorScreen(s, sims.states.find((st) => st.simulatorId === s.id), titles.get(s.id) || s.name)),
        ...machines.machines.filter(phoneMayWatch).map(machine),
      ],
      held: machines.machines.filter((m) => !phoneMayWatch(m)).map(machine),
    };
  }

  /** A picture of one of the session's screens as it is now, made small: only one `session.screens`
   *  lists for that session, and only while it is live. One of another space is not found, as one
   *  that never was; a Mac app of its own space is refused, as one that is not live. */
  private async screen(rpc: RpcPort, p: MobileParams<"session.screen">): Promise<MobileResult<"session.screen">> {
    const { shown, held } = await this.screens(rpc, p.id);
    const named = (s: Screen) => s.kind === p.kind && s.id === p.screenId;
    const app = held.find(named);
    if (app) throw new MobileError("FORBIDDEN", `${app.name} is an app on the Mac, and Realm does not show a Mac app's screen on a phone.`);
    const screen = shown.find(named);
    if (!screen) throw new MobileError("NOT_FOUND", "That screen is not open in this session's space.");
    if (!screen.live) throw new MobileError("FORBIDDEN", `${screen.name} is not running on the Mac.`);
    try {
      return await deadline((async () => {
        const { bytes, capturedAt } = await this.capture(rpc, screen);
        return await screenFrame(bytes, frameSide(p.maxSide), capturedAt, this.o.downscale ?? sipsDownscale);
      })(), SCREEN_DEADLINE_MS, tooLong(screen));
    } catch (e) {
      // It is there and live, so a picture that did not come is one that did not come just now — a
      // device whose runner has stopped answering, a capture that is no picture — and the next call may
      // bring one: INTERNAL, which a phone asks again after, in the Mac's words. FORBIDDEN is for a
      // screen that is not live, which a phone stops asking for until its list changes.
      throw new MobileError("INTERNAL", (e as Error).message);
    }
  }

  /** The screen as it is now, at its own size: one capture of it at a time, shared by every call that
   *  comes while it is taken, and given up on after SCREEN_DEADLINE_MS — which lets the screen go, so
   *  the next call takes a new one rather than waiting on a capture that may never answer. */
  private capture(rpc: RpcPort, screen: Screen): Promise<{ bytes: Buffer; capturedAt: number }> {
    const key = `${screen.kind} ${screen.id}`;
    const taking = this.capturing.get(key);
    if (taking) return taking;
    const shot = deadline((async () => {
      const { data } = screen.kind === "simulator"
        ? await rpc.call("simulators.capture", { simulatorId: screen.id })
        : await rpc.call("machines.capture", { machineId: screen.id });
      if (!data) throw new Error(`${screen.name} had nothing on screen to show.`);
      return { bytes: Buffer.from(data, "base64"), capturedAt: Date.now() };
    })(), SCREEN_DEADLINE_MS, tooLong(screen)).finally(() => {
      if (this.capturing.get(key) === shot) this.capturing.delete(key);
    });
    this.capturing.set(key, shot);
    return shot;
  }

  /** The browser and terminal panes open in the session's space, each named as its pane is. A browser
   *  is live while its page is loaded in one of the Mac's windows; a terminal, while it runs. */
  private async panes(rpc: RpcPort, id: string): Promise<MobileResult<"session.panes">> {
    const { spaceId } = await rpc.call("sessions.get", { id });
    const [items, statuses, views] = await Promise.all([
      rpc.call("items.list", { spaceId }), rpc.call("terminals.list", { spaceId }), rpc.call("browsers.views", {}).catch(() => ({ browserIds: [] as string[] })),
    ]);
    const loaded = new Set(views.browserIds);
    const browsers = await Promise.all(openPanes(items, "browser").map(async (it) => {
      const url = await rpc.call("browsers.get", { browserId: it.refId }).then((b) => b.url, () => "");
      return browserPane(it, url, loaded.has(it.refId));
    }));
    const home = this.o.userHome ?? homedir();
    const terminals = openPanes(items, "terminal").map((it) => terminalPane(it, statuses.find((t) => t.terminalId === it.refId), home));
    return { browsers: browsers.sort(paneOrder((b) => b.live)), terminals: terminals.sort(paneOrder((t) => t.running)) };
  }

  /** The pane item of `kind` open in the session's space with `refId`, or NOT_FOUND, as one that never was. */
  private async paneItem(rpc: RpcPort, id: string, kind: "browser" | "terminal", refId: string) {
    const { spaceId } = await rpc.call("sessions.get", { id });
    const item = openPanes(await rpc.call("items.list", { spaceId }), kind).find((it) => it.refId === refId);
    if (!item) throw new MobileError("NOT_FOUND", `That ${kind} is not open in this session's space.`);
    return item;
  }

  /** A picture of one of the session's browser panes as it is now, its password fields covered: at
   *  most one new picture of a pane every BROWSER_FRAME_EVERY_MS, shared by every call meanwhile. */
  private async browserFrame(rpc: RpcPort, p: MobileParams<"session.browserFrame">): Promise<ScreenFrame> {
    const item = await this.paneItem(rpc, p.id, "browser", p.browserId);
    const side = frameSide(p.maxSide);
    const key = `${item.refId} ${side}`;
    const now = Date.now();
    for (const [k, v] of this.pagePictures) if (now - v.at >= BROWSER_FRAME_EVERY_MS) this.pagePictures.delete(k);
    const kept = this.pagePictures.get(key);
    if (kept) return await kept.frame;
    const name = item.title || "That page";
    const frame = deadline(this.pagePicture(rpc, item.refId, name, side), SCREEN_DEADLINE_MS, `The Mac could not take a picture of ${name} in time.`);
    this.pagePictures.set(key, { at: now, frame });
    frame.catch(() => { if (this.pagePictures.get(key)?.frame === frame) this.pagePictures.delete(key); });
    return await frame;
  }

  /** The page made into a frame no heavier than FRAME_MAX_BYTES: made again smaller and plainer,
   *  twice, as a screen's is, and not sent heavier still. */
  private async pagePicture(rpc: RpcPort, browserId: string, name: string, side: number): Promise<ScreenFrame> {
    for (const [scale, quality] of [[1, FRAME_QUALITY], [0.7, 50], [0.5, 40]] as const) {
      const shot = await rpc.call("browsers.capture", { browserId, maxSide: Math.round(side * scale), quality });
      // Main covers a password field before the picture leaves it; one it could not cover, it does
      // not picture at all, and says so. The page may change, so the phone asks again.
      if (shot.withheld) throw new MobileError("INTERNAL", shot.withheld);
      if (shot.data === null) throw new MobileError("FORBIDDEN", `${name} isn't open in a window on your Mac.`);
      const jpeg = Buffer.from(shot.data, "base64");
      if (jpeg.length > FRAME_MAX_BYTES) continue;
      const size = jpegSize(jpeg);
      if (!size) throw new MobileError("INTERNAL", "The picture of that page is not a JPEG.");
      return { mime: "image/jpeg", data: shot.data, width: size.width, height: size.height, capturedAt: Date.now() };
    }
    throw new MobileError("INTERNAL", "That page is too detailed to send to a phone, even made small.");
  }

  /** One of the session's terminals' output since the phone's cursor. A peek: a terminal restored but
   *  not started is not started for it, and nothing goes the other way. */
  private async terminal(rpc: RpcPort, p: MobileParams<"session.terminal">): Promise<MobileResult<"session.terminal">> {
    await this.paneItem(rpc, p.id, "terminal", p.terminalId);
    return terminalOutput(await rpc.call("terminals.read", { terminalId: p.terminalId, cursor: p.cursor, peek: true }), p.cursor);
  }
}
