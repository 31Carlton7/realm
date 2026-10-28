import { mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  AGENT_META, AgentKindSchema, DEFAULT_PERMISSION_MODE_KEY, isSecretPath, MID_TURN_MODE_KEY, MODEL_CATALOG_KEY, MODEL_EFFORTS_KEY, parseSpaceIcon, readEffortSupport,
  resolveMidTurnMode, SELECTABLE_AGENT_KINDS, type AgentKind, type DelegatedChild, type IconAsset, type Item, type Machine, type MethodResult, type ModelInfo,
  type QueuedPrompt, type Schedule, type Session, type Space, type StoredSessionEvent, type TurnChanges,
} from "@realm/contracts";
import { givenAttachmentName, tempAttachmentDir } from "@realm/contracts/src/temp-attachments";
import {
  MobileCalls, RECENT_LIMIT, SEND_LIMITS, type Home, type MobileErrorCode, type MobileMethod, type MobileParams, type MobileResult, type QueuedMessage,
  type ScheduledTask, type Screen, type SessionOptions, type SessionRow, type Subagent,
} from "@realm/remote";
import {
  FALLBACK_AGENT, isLive, LAST_AGENT_SETTING, modelLabel, needsYou, nestChildren, QUICK_CHAT_SETTING, quickChatIdOf, subagentState, upcomingOrder, type NeedsYouState,
} from "@realm/view";
import { resolveDefaultPermissionMode } from "../sessions/service";
import { diffPage } from "./changes";
import { agentOptions, changesFor, ChoiceRefused, probeList, type InitFacts, type OptionsInput, type ProbeRow } from "./options";
import { filePreview, PreviewRefused, sipsDownscale, type Downscale } from "./preview";
import { queuedMessage, SessionProjector } from "./rows";
import { RpcCallError, type RpcPort } from "./rpc-port";
import { frameSide, machineScreen, phoneMayWatch, SCREEN_DEADLINE_MS, screenFrame, screenOrder, simulatorScreen } from "./screens";
import { checkUploads, saveUploads, UploadRefused, type Upload } from "./uploads";
import { everyPlan, monthStart, spend } from "./usage";
import { isOpenReview, newestReviewFirst, reviewItem, reviewPictures, reviewSummary, scheduledTask } from "./work";

/**
 * mobile.v1 on the Mac (PROTOCOL.md §8): each call validated against its schema, then answered by the
 * desktop's own RPC methods — the same handlers, validation and broadcasts as the desktop gets. The
 * phone never names an RPC method; it names a mobile.v1 call, and only these exist.
 */

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

const mobileStatus = (s: Session["status"]): SessionRow["status"] => (s === "waiting_permission" ? "waiting" : s);

const isUnread = (s: Session): boolean => s.seenSeq > 0 && s.lastEventSeq > s.seenSeq;

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

/** `path` is `root` or inside it. Both are real paths: no link is left in either to lead out. */
const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

const GONE = "That message has already gone out.";

/** A picture of `screen` that did not come within SCREEN_DEADLINE_MS, as a phone is told it. */
const tooLong = (screen: Screen): string => `The Mac could not take a picture of ${screen.name} in time.`;

export class MobileApi {
  /** Each screen's capture while it is being taken, by kind and id: every call for that screen
   *  meanwhile — the viewer's, the session card's, another phone's — waits on it rather than taking
   *  its own, as the gateway answers a phone's calls as they come. */
  private readonly capturing = new Map<string, Promise<{ bytes: Buffer; capturedAt: number }>>();

  constructor(private readonly o: { macName: () => string; reportsDir: string; dev: boolean; downscale?: Downscale; realmHome: string }) {}

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
        case "session.open": return await this.open(ctx, p.id as string, p.limit as number);
        case "session.close": ctx.sessions.delete(p.id as string); return { ok: true };
        case "session.update": return await this.update(rpc, p as MobileParams<"session.update">);
        case "session.queue": return { queued: await this.queue(rpc, p.id as string) };
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
        case "usage.get": return await this.usage(rpc);
        case "reviews.list": return await this.reviews(rpc);
        case "review.get": return await this.review(rpc, p.id as string);
        case "review.decide": return await this.decide(rpc, p as MobileParams<"review.decide">);
        case "review.file": return await this.reviewFile(rpc, p.id as string, p.path as string);
        case "schedules.list": return await this.schedules(rpc);
        case "schedules.runNow": {
          const fired = await rpc.call("schedules.runNow", { id: p.id as string });
          return { task: (await this.tasks(rpc, [fired]))[0]! };
        }
        case "session.send": {
          const files = await this.uploads(p.text as string, p.attachments as Upload[]);
          await rpc.call("sessions.send", { id: p.id as string, text: p.text as string, attachments: files, delivery: p.delivery as "auto" | "queue" | "steer" });
          return { ok: true };
        }
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
        case "space.icon": return await this.spaceIcon(rpc, p.id as string);
        case "session.screens": return { screens: (await this.screens(rpc, p.id as string)).shown.sort(screenOrder) };
        case "session.screen": return await this.screen(rpc, p as MobileParams<"session.screen">);
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
          : e.code === "TEAM_REVIEW_STATE" || e.code === "SCHEDULE_BUSY" ? "FORBIDDEN"
          : e.code === "TEAM_REVIEW_INVALID" ? "INVALID_PARAMS" : "INTERNAL";
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

  /** The sessions teams' roles ran. A Mac that has no teams answers nothing for them. */
  private async roleRuns(rpc: RpcPort): Promise<Set<string>> {
    const teams = await rpc.call("team.overview", {}).catch(() => []);
    return new Set(teams.flatMap((t) => t.runSessionIds));
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
   *  row says it is in that list exactly when it is. */
  private row(s: Session, item: Pick<Item, "title" | "pinned"> | undefined, space: Space | undefined, need: ReadonlySet<string>, probe: Probe): SessionRow {
    const meta = AGENT_META[s.agentKind as AgentKind] as { label: string; icon: string } | undefined;
    return {
      id: s.id, title: item?.title || s.title, spaceId: s.spaceId, spaceName: space?.name ?? "", agent: s.agentKind, model: s.model,
      status: mobileStatus(s.status), needsYou: need.has(s.id), unread: isUnread(s), updatedAt: s.updatedAt,
      agentName: meta?.label ?? s.agentKind, agentMark: meta?.icon ?? "bot",
      modelLabel: meta ? modelLabel(s.agentKind, s.model, probe) : s.model ?? "",
      createdAt: s.createdAt, effort: s.effort, permissionMode: s.permissionMode, activityAt: s.activityAt, pinned: item?.pinned ?? false,
    };
  }

  /** What Home and a space's page list, read once: Needs you, by the sidebar's own rule (`@realm/view`)
   *  run on the lists the sidebar is seeded from, and the sessions a row lists — every session item that
   *  is not archived — newest first, each made into its row. */
  private async listing(rpc: RpcPort) {
    const [lists, probe, roleRuns] = await Promise.all([this.lists(rpc), this.probes(rpc), this.roleRuns(rpc)]);
    const spaceById = new Map(lists.spaces.map((s) => [s.id, s]));
    const rows = new Map<string, Item>();
    for (const it of lists.items) if (it.kind === "session") rows.set(it.refId, it);
    const waiting = needsYou(needsYouInput(lists));
    const need = new Set(waiting.map((r) => r.session.id));
    // The sidebar's rows (`listedSessions`): a sub-agent is its lead's business, and a team role's run is
    // its role's, so neither is a row of its own — a waiting one is still in Needs you.
    const nested = nestChildren(lists.sessions.filter((s) => rows.has(s.id)).map((s) => ({ id: s.id, spaceId: s.spaceId, session: s, createdAt: s.createdAt })));
    const listed = nested.map((n) => n.row.session).filter((s) => !roleRuns.has(s.id)).sort(newestFirst);
    const row = (s: Session, title?: string, spaceId = s.spaceId) => {
      const item = rows.get(s.id);
      return this.row(s, title === undefined ? item : { title, pinned: item?.pinned ?? false }, spaceById.get(spaceId), need, probe);
    };
    return { spaces: lists.spaces, spaceById, waiting, listed, row };
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
      model: session.model, modelLabel: modelLabel(session.agentKind, session.model, probeList(input)),
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
    const [probe, shared, last] = await Promise.all([this.probes(rpc), this.shared(rpc), rpc.call("settings.get", { key: LAST_AGENT_SETTING })]);
    const kinds: readonly AgentKind[] = SELECTABLE_AGENT_KINDS;
    const agents = kinds.map((kind) => agentOptions(kind, optionsInput(probe.find((r) => r.kind === kind) ?? null, null, shared)));
    const defaultAgent = kinds.find((k) => k === last.value) ?? FALLBACK_AGENT;
    return { agents, defaultAgent, midTurn: shared.midTurn, attachments: { ...SEND_LIMITS } };
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

  /** A message's files, checked whole and written where a desktop paste goes; a message must carry
   *  words or a file. */
  private async uploads(text: string, uploads: readonly Upload[]): Promise<{ path: string; mime: string }[]> {
    if (text.length === 0 && uploads.length === 0) throw new MobileError("INVALID_PARAMS", "A message needs words or a file.");
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

  private async open(ctx: ChannelContext, id: string, limit: number): Promise<MobileResult<"session.open">> {
    // Opened again, it keeps the sub-agents the phone has read of it: their changes are still its list's.
    const entry: OpenSession = {
      projector: new SessionProjector({ attachmentsDir: tempAttachmentDir(this.o.realmHome) }), buffer: [], queued: null,
      subagents: ctx.sessions.get(id)?.subagents ?? new Set(),
    };
    ctx.sessions.set(id, entry);
    const rpc = ctx.rpc;
    try {
      const session = await rpc.call("sessions.get", { id });
      const read = (await rpc.call("sessions.queued", { id })).queued;
      // What a broadcast carried before the read is in it; one from here on is newer than it.
      entry.queued = null;
      let after = 0;
      let total = 0;
      for (;;) {
        const page = await rpc.call("sessions.events", { id, afterSeq: after, limit: HISTORY_PAGE });
        for (const ev of page) entry.projector.apply(ev);
        total += page.length;
        if (page.length < HISTORY_PAGE || total >= HISTORY_LIMIT) break;
        after = page.at(-1)!.seq;
      }
      const [lists, probe] = await Promise.all([this.lists(rpc), this.probes(rpc)]);
      // From here to the answer nothing is awaited, so nothing can arrive between the two.
      for (const ev of entry.buffer ?? []) entry.projector.apply(ev);
      const queued = entry.queued ?? read;
      entry.buffer = null;
      entry.queued = null;
      const item = lists.items.find((it) => it.kind === "session" && it.refId === id);
      const need = new Set(needsYou(needsYouInput(lists)).map((r) => r.session.id));
      const all = entry.projector.all();
      return {
        session: this.row(session, item, lists.spaces.find((s) => s.id === session.spaceId), need, probe),
        rows: all.slice(-limit), hasMore: all.length > limit, hint: entry.projector.hint, queued: this.queuedMessages(queued),
      };
    } catch (e) {
      ctx.sessions.delete(id);
      throw e;
    }
  }

  /** The queue as a phone reads it: each file named as its user row will name it. */
  queuedMessages(queued: readonly QueuedPrompt[]): QueuedMessage[] {
    return queued.map((q) => queuedMessage(q, tempAttachmentDir(this.o.realmHome)));
  }

  private async queue(rpc: RpcPort, id: string): Promise<QueuedMessage[]> {
    return this.queuedMessages((await rpc.call("sessions.queued", { id })).queued);
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

  /** What every team has handed back and is still open, newest first: each team space's reviews, as the
   *  desktop's Review reads them (`team.overview`). */
  private async reviews(rpc: RpcPort): Promise<MobileResult<"reviews.list">> {
    const [teams, spaces] = await Promise.all([rpc.call("team.overview", {}), rpc.call("spaces.list", {})]);
    const name = spaceNames(spaces);
    return { reviews: teams.flatMap((t) => t.reviews).filter(isOpenReview).sort(newestReviewFirst).map((r) => reviewSummary(r, name(r.spaceId))) };
  }

  private async review(rpc: RpcPort, id: string): Promise<MobileResult<"review.get">> {
    const [detail, spaces] = await Promise.all([rpc.call("team.review", { id }), rpc.call("spaces.list", {})]);
    return { review: reviewSummary(detail, spaceNames(spaces)(detail.spaceId)), items: [...detail.items].sort((a, b) => a.ord - b.ord).map((it) => reviewItem(it, detail)) };
  }

  /** Approve, ask for changes, or reject, by the desktop's own calls. Asking for changes says what
   *  should change, or the role that made it has nothing to go on. */
  private async decide(rpc: RpcPort, p: MobileParams<"review.decide">): Promise<MobileResult<"review.decide">> {
    const note = p.note?.trim() ?? "";
    if (p.decision === "changes" && !note) throw new MobileError("INVALID_PARAMS", "Asking for changes needs a note saying what should change.");
    const decided = p.decision === "approve" ? await rpc.call("team.reviewApprove", { id: p.id })
      : p.decision === "changes" ? await rpc.call("team.reviewRequestChanges", { id: p.id, note })
      : await rpc.call("team.reviewReject", { id: p.id, ...(note ? { reason: note } : {}) });
    return { review: reviewSummary(decided, spaceNames(await rpc.call("spaces.list", {}))(decided.spaceId)) };
  }

  /** A preview of one of a review's pictures — and of nothing else: the path must be one its items carry,
   *  exactly as `review.get` listed it, and still inside its space's folder. */
  private async reviewFile(rpc: RpcPort, id: string, path: string): Promise<MobileResult<"review.file">> {
    const detail = await rpc.call("team.review", { id });
    const listed = new Set(detail.items.flatMap((it) => reviewPictures(it, detail.root).map((f) => f.path)));
    if (!detail.root || !listed.has(path)) throw new MobileError("FORBIDDEN", "That file is not one of this review's pictures.");
    if (isSecretPath(path)) throw new MobileError("FORBIDDEN", "That file holds a secret, so Realm does not send it to a phone.");
    return await this.preview(path, async () => {
      // The role sent a file from its space's folder; a link put in its way since could lead anywhere.
      if (!inside(await realpath(path), await realpath(detail.root!))) throw new PreviewRefused("That file is no longer in its space's folder.");
    });
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
    const [made, sent, { queued }] = await Promise.all([
      this.eventsOf(rpc, id, "files_made"), this.eventsOf(rpc, id, "user_message"), rpc.call("sessions.queued", { id }),
    ]);
    const listed = new Set<string>();
    for (const ev of made) if (ev.event.type === "files_made") for (const f of ev.event.payload.files) listed.add(f.path);
    for (const ev of sent) if (ev.event.type === "user_message") for (const a of ev.event.payload.attachments) listed.add(a.path);
    for (const q of queued) for (const a of q.attachments) listed.add(a.path);
    if (!listed.has(path)) throw new MobileError("FORBIDDEN", "That file is not one this session made or was sent.");
    // A message on the Mac can carry any file someone picked, a key among them; a phone is never sent one.
    if (isSecretPath(path)) throw new MobileError("FORBIDDEN", "That file holds a secret, so Realm does not send it to a phone.");
    // Named as its user row names it: a file a phone or a paste sent, without the prefix it was written under.
    return { ...await this.preview(path), name: givenAttachmentName(path, tempAttachmentDir(this.o.realmHome)) };
  }

  /** `filePreview`, its refusals and a file gone since it was listed said as mobile.v1 says them;
   *  `check` runs first, and refuses by throwing `PreviewRefused`. */
  private async preview(path: string, check?: () => Promise<void>): Promise<MobileResult<"session.file">> {
    try {
      await check?.();
      return await filePreview(path, { downscale: this.o.downscale });
    } catch (e) {
      if (e instanceof PreviewRefused) throw new MobileError("FORBIDDEN", e.message);
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
}
