import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_META, AgentKindSchema, DEFAULT_PERMISSION_MODE_KEY, isSecretPath, MID_TURN_MODE_KEY, MODEL_CATALOG_KEY, MODEL_EFFORTS_KEY, parseSpaceIcon, readEffortSupport,
  resolveMidTurnMode, SELECTABLE_AGENT_KINDS, type AgentKind, type IconAsset, type Item, type MethodResult, type ModelInfo, type Session,
  type Space, type StoredSessionEvent, type TurnChanges,
} from "@realm/contracts";
import { givenAttachmentName, tempAttachmentDir } from "@realm/contracts/src/temp-attachments";
import {
  MobileCalls, RECENT_LIMIT, SEND_LIMITS, type Home, type MobileErrorCode, type MobileMethod, type MobileParams, type MobileResult, type Row,
  type SessionOptions, type SessionRow,
} from "@realm/remote";
import { FALLBACK_AGENT, LAST_AGENT_SETTING, modelLabel, needsYou, QUICK_CHAT_SETTING, quickChatIdOf, type NeedsYouState } from "@realm/view";
import { resolveDefaultPermissionMode } from "../sessions/service";
import { diffPage } from "./changes";
import { agentOptions, changesFor, ChoiceRefused, probeList, type InitFacts, type OptionsInput, type ProbeRow } from "./options";
import { filePreview, PreviewRefused, type Downscale } from "./preview";
import { SessionProjector } from "./rows";
import { RpcCallError, type RpcPort } from "./rpc-port";
import { checkUploads, saveUploads, UploadRefused, type Upload } from "./uploads";

/**
 * mobile.v1 on the Mac (PROTOCOL.md §8): each call validated against its schema, then answered by the
 * desktop's own RPC methods — the same handlers, validation and broadcasts as the desktop gets. The
 * phone never names an RPC method; it names a mobile.v1 call, and only these exist.
 */

export class MobileError extends Error {
  constructor(readonly code: MobileErrorCode, message: string) { super(message); }
}

/** A phone's channel: the port its calls go through, as that phone, and its open sessions — each with
 *  its own projector so rows are folded once per phone. */
export type ChannelContext = {
  phoneId: string;
  rpc: RpcPort;
  sessions: Map<string, { projector: SessionProjector; buffer: StoredSessionEvent[] | null }>;
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

export class MobileApi {
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
        case "session.seen": await rpc.call("sessions.markSeen", { id: p.id as string, seq: p.seq as number }); return { ok: true };
        case "session.create": return await this.create(rpc, p as MobileParams<"session.create">);
        case "session.changes": {
          const { checkpointId, files, totalFiles } = await this.turnChanges(rpc, p.id as string, p.checkpointId as string);
          return { checkpointId, files: files.map(({ path, oldPath, status, additions, deletions }) => ({ path, oldPath, status, additions, deletions })), totalFiles };
        }
        case "session.diff": return await this.diff(rpc, p.id as string, p.checkpointId as string, p.path as string, p.from as number);
        case "session.file": return await this.file(rpc, p.id as string, p.path as string);
        case "space.icon": return await this.spaceIcon(rpc, p.id as string);
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
        // are not there any more, as far as a phone can do anything about them.
        const code: MobileErrorCode = e.code === "NOT_FOUND" || e.code === "SESSION_NOT_LIVE" || e.code === "INVALID_PARAMS" ? e.code
          : e.code === "TREE_GONE" || e.code === "NOT_A_REPOSITORY" ? "NOT_FOUND" : "INTERNAL";
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

  /** `need` is the ids Needs you lists, so a row says it is in that list exactly when it is. */
  private row(s: Session, title: string, space: Space | undefined, need: ReadonlySet<string>, probe: Probe): SessionRow {
    const meta = AGENT_META[s.agentKind as AgentKind] as { label: string; icon: string } | undefined;
    return {
      id: s.id, title: title || s.title, spaceId: s.spaceId, spaceName: space?.name ?? "", agent: s.agentKind, model: s.model,
      status: mobileStatus(s.status), needsYou: need.has(s.id), unread: isUnread(s), updatedAt: s.updatedAt,
      agentName: meta?.label ?? s.agentKind, agentMark: meta?.icon ?? "bot",
      modelLabel: meta ? modelLabel(s.agentKind, s.model, probe) : s.model ?? "",
      createdAt: s.createdAt, effort: s.effort, permissionMode: s.permissionMode, activityAt: s.activityAt,
    };
  }

  /** What Home and a space's page list, read once: Needs you, by the sidebar's own rule (`@realm/view`)
   *  run on the lists the sidebar is seeded from, and the sessions a row lists — every session item that
   *  is not archived — newest first, each made into its row. */
  private async listing(rpc: RpcPort) {
    const [lists, probe] = await Promise.all([this.lists(rpc), this.probes(rpc)]);
    const spaceById = new Map(lists.spaces.map((s) => [s.id, s]));
    const titles = new Map<string, string>();
    for (const it of lists.items) if (it.kind === "session") titles.set(it.refId, it.title);
    const waiting = needsYou(needsYouInput(lists));
    const need = new Set(waiting.map((r) => r.session.id));
    const listed = lists.sessions.filter((s) => titles.has(s.id)).sort(newestFirst);
    const row = (s: Session, title = titles.get(s.id) ?? "", spaceId = s.spaceId) => this.row(s, title, spaceById.get(spaceId), need, probe);
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

  /** A new session in a space, on what the phone chose, sent its first message. The choices and the
   *  files are checked before anything is made, so a refusal leaves no empty session behind. */
  private async create(rpc: RpcPort, p: MobileParams<"session.create">): Promise<{ id: string }> {
    const agent = AgentKindSchema.safeParse(p.agent);
    if (!agent.success) throw new MobileError("INVALID_PARAMS", `unknown agent ${String(p.agent)}`);
    const kind = agent.data;
    const [probe, shared] = await Promise.all([this.probeOf(rpc, kind), this.shared(rpc)]);
    const input = optionsInput(probe, null, shared);
    const resting = resolveDefaultPermissionMode(kind, shared.defaultPermission);
    const chosen = changesFor(kind, { model: null, effort: null, permissionMode: resting }, p, input, resting);
    const checked = this.checked(p.text, p.attachments);
    const { session } = await rpc.call("sessions.create", {
      spaceId: p.spaceId, agentKind: kind, model: chosen.model ?? null, effort: chosen.effort ?? null, permissionMode: chosen.permissionMode ?? null,
    });
    const files = await saveUploads(this.o.realmHome, checked);
    await rpc.call("sessions.send", { id: session.id, text: p.text, attachments: files });
    return { id: session.id };
  }

  /** A message's files checked whole; a message must carry words or a file. */
  private checked(text: string, uploads: readonly Upload[]) {
    if (text.length === 0 && uploads.length === 0) throw new MobileError("INVALID_PARAMS", "A message needs words or a file.");
    return checkUploads(uploads);
  }

  /** A message's files, checked and written where a desktop paste goes. */
  private async uploads(text: string, uploads: readonly Upload[]): Promise<{ path: string; mime: string }[]> {
    return await saveUploads(this.o.realmHome, this.checked(text, uploads));
  }

  /** Subscribes first and buffers, then reads history, then replays what arrived meanwhile — so no event
   *  can fall between the history read and the live stream. */
  private async open(ctx: ChannelContext, id: string, limit: number): Promise<{ session: SessionRow; rows: Row[]; hasMore: boolean; hint: string | null }> {
    const entry = { projector: new SessionProjector({ attachmentsDir: tempAttachmentDir(this.o.realmHome) }), buffer: [] as StoredSessionEvent[] | null };
    ctx.sessions.set(id, entry);
    const rpc = ctx.rpc;
    try {
      const session = await rpc.call("sessions.get", { id });
      let after = 0;
      let total = 0;
      for (;;) {
        const page = await rpc.call("sessions.events", { id, afterSeq: after, limit: HISTORY_PAGE });
        for (const ev of page) entry.projector.apply(ev);
        total += page.length;
        if (page.length < HISTORY_PAGE || total >= HISTORY_LIMIT) break;
        after = page.at(-1)!.seq;
      }
      for (const ev of entry.buffer ?? []) entry.projector.apply(ev);
      entry.buffer = null;
      const [lists, probe] = await Promise.all([this.lists(rpc), this.probes(rpc)]);
      const title = lists.items.find((it) => it.kind === "session" && it.refId === id)?.title ?? "";
      const need = new Set(needsYou(needsYouInput(lists)).map((r) => r.session.id));
      const all = entry.projector.all();
      return {
        session: this.row(session, title, lists.spaces.find((s) => s.id === session.spaceId), need, probe),
        rows: all.slice(-limit), hasMore: all.length > limit, hint: entry.projector.hint,
      };
    } catch (e) {
      ctx.sessions.delete(id);
      throw e;
    }
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

  /** A preview of a file the session's turns made or one that was sent with a message to it — and of
   *  nothing else: the path must be one a `files_made` or a `user_message` of this session listed,
   *  exactly as it was listed. */
  private async file(rpc: RpcPort, id: string, path: string): Promise<MobileResult<"session.file">> {
    const [made, sent] = await Promise.all([this.eventsOf(rpc, id, "files_made"), this.eventsOf(rpc, id, "user_message")]);
    const listed = new Set<string>();
    for (const ev of made) if (ev.event.type === "files_made") for (const f of ev.event.payload.files) listed.add(f.path);
    for (const ev of sent) if (ev.event.type === "user_message") for (const a of ev.event.payload.attachments) listed.add(a.path);
    if (!listed.has(path)) throw new MobileError("FORBIDDEN", "That file is not one this session made or was sent.");
    // A message on the Mac can carry any file someone picked, a key among them; a phone is never sent one.
    if (isSecretPath(path)) throw new MobileError("FORBIDDEN", "That file holds a secret, so Realm does not send it to a phone.");
    try {
      // Named as its user row names it: a file a phone or a paste sent, without the prefix it was written under.
      return { ...await filePreview(path, { downscale: this.o.downscale }), name: givenAttachmentName(path, tempAttachmentDir(this.o.realmHome)) };
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
}
